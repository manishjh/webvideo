import { WebGpuMatrixTileRenderer } from "../contracts/services";
import type {
  RenderFrameRequest,
  RenderFrameResult,
  SurfaceConfigurationPlan,
} from "../contracts/models";
import type { VideoPipeFrameRenderer } from "./playerController";
import type {
  OffscreenMatrixOptions,
  OffscreenMatrixRenderResult,
  OffscreenMatrixSlotLayout,
  OffscreenMatrixWorkerRequest,
  OffscreenMatrixWorkerResponse,
} from "./offscreenMatrixWorkerProtocol";

interface PendingRender {
  canvasId: string;
  reject: (error: Error) => void;
  resolve: (result: RenderFrameResult) => void;
}

const managers = new Map<string, OffscreenMatrixViewportManager>();

export function createOffscreenMatrixTileRenderer(
  matrixCanvasId: string,
  getCanvasIds: () => string[],
): VideoPipeFrameRenderer {
  return new OffscreenMatrixTileRenderer(getOffscreenMatrixViewportManager(matrixCanvasId, getCanvasIds));
}

export function shouldUseOffscreenMatrixViewport(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("offscreenViewport")?.toLowerCase();
  if (["0", "false", "off", "main", "main-thread"].includes(mode ?? "")) {
    return false;
  }

  return typeof Worker !== "undefined"
    && typeof HTMLCanvasElement !== "undefined"
    && typeof HTMLCanvasElement.prototype.transferControlToOffscreen === "function"
    && Boolean((navigator as { gpu?: unknown }).gpu);
}

function getOffscreenMatrixViewportManager(
  matrixCanvasId: string,
  getCanvasIds: () => string[],
): OffscreenMatrixViewportManager {
  let manager = managers.get(matrixCanvasId);
  if (!manager) {
    manager = new OffscreenMatrixViewportManager(matrixCanvasId, getCanvasIds);
    managers.set(matrixCanvasId, manager);
  } else {
    manager.updateCanvasIdResolver(getCanvasIds);
  }

  return manager;
}

class OffscreenMatrixTileRenderer implements VideoPipeFrameRenderer {
  private readonly fallbackRenderer: WebGpuMatrixTileRenderer;
  private configuration?: SurfaceConfigurationPlan;
  private useFallback = false;
  private disposed = false;

  public constructor(private readonly manager: OffscreenMatrixViewportManager) {
    this.fallbackRenderer = new WebGpuMatrixTileRenderer(manager.matrixCanvasId);
  }

  public async configureSurface(configuration: SurfaceConfigurationPlan): Promise<void> {
    this.configuration = configuration;
    this.disposed = false;
    this.useFallback = !this.manager.canUseOffscreen();
    if (this.useFallback) {
      if (this.manager.hasTransferredCanvas()) {
        return Promise.reject(new Error(this.manager.disabledReason ?? "Offscreen matrix viewport failed after canvas transfer."));
      }

      await this.fallbackRenderer.configureSurface(configuration);
      return;
    }

    await this.manager.registerSurface(configuration);
  }

  public async renderFrame(request: RenderFrameRequest): Promise<RenderFrameResult> {
    if (!this.configuration || this.disposed) {
      return Promise.reject(new Error("Offscreen matrix renderer must be configured before rendering."));
    }

    if (this.useFallback) {
      return await this.fallbackRenderer.renderFrame(request);
    }

    return await this.manager.renderFrame(this.configuration, request);
  }

  public canShareFrameReference(): boolean {
    return false;
  }

  public async dispose(): Promise<void> {
    if (this.configuration && !this.useFallback) {
      this.manager.unregisterSurface(this.configuration.canvasId);
    }

    this.disposed = true;
    this.configuration = undefined;
    await this.fallbackRenderer.dispose();
  }
}

class OffscreenMatrixViewportManager {
  private readonly pendingRenders = new Map<number, PendingRender>();
  private readonly surfaces = new Map<string, SurfaceConfigurationPlan>();
  private worker?: Worker;
  private nextRequestId = 0;
  private transferred = false;
  public disabledReason?: string;
  private matrixCanvas?: HTMLCanvasElement;
  private resizeObserver?: ResizeObserver;
  private layoutScheduled = false;
  private lastLayoutKey = "";
  private readyPromise?: Promise<void>;
  private readyCompletion?: {
    reject: (error: Error) => void;
    resolve: () => void;
  };

  public constructor(
    public readonly matrixCanvasId: string,
    private getCanvasIds: () => string[],
  ) {
  }

  public updateCanvasIdResolver(getCanvasIds: () => string[]): void {
    this.getCanvasIds = getCanvasIds;
    this.scheduleLayout();
  }

  public canUseOffscreen(): boolean {
    return shouldUseOffscreenMatrixViewport() && !this.disabledReason;
  }

  public hasTransferredCanvas(): boolean {
    return this.transferred;
  }

  public async registerSurface(configuration: SurfaceConfigurationPlan): Promise<void> {
    if (!this.canUseOffscreen()) {
      return Promise.reject(new Error(this.disabledReason ?? "Offscreen matrix viewport is unavailable."));
    }

    this.surfaces.set(configuration.canvasId, configuration);
    this.prepareAnchorCanvas(configuration);
    await this.ensureStarted();
    this.observeLayout();
    this.syncLayout();
  }

  public unregisterSurface(canvasId: string): void {
    this.surfaces.delete(canvasId);
    this.pendingRenders.forEach((pending, requestId) => {
      if (pending.canvasId === canvasId) {
        pending.reject(new Error(`Offscreen matrix tile '${canvasId}' was disposed before rendering completed.`));
        this.pendingRenders.delete(requestId);
      }
    });
    this.post({ type: "unregister", canvasId });
    this.syncLayout();
  }

  public async renderFrame(
    configuration: SurfaceConfigurationPlan,
    request: RenderFrameRequest,
  ): Promise<RenderFrameResult> {
    if (!this.canUseOffscreen()) {
      return Promise.reject(new Error(this.disabledReason ?? "Offscreen matrix viewport is unavailable."));
    }

    this.surfaces.set(configuration.canvasId, configuration);
    this.prepareAnchorCanvas(configuration);
    await this.ensureStarted();
    this.syncLayout();

    const requestId = ++this.nextRequestId;
    return await new Promise<RenderFrameResult>((resolve, reject) => {
      this.pendingRenders.set(requestId, {
        canvasId: configuration.canvasId,
        resolve,
        reject,
      });

      try {
        const message: OffscreenMatrixWorkerRequest = {
          type: "render",
          requestId,
          canvasId: configuration.canvasId,
          frame: request.frame,
          activeMetadata: request.activeMetadata,
        };
        const transfer = collectFrameTransferables(request.frame.videoFrame);
        this.post(message, transfer);
      } catch (error) {
        this.pendingRenders.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }

    this.readyPromise = this.start();
    await this.readyPromise;
  }

  private start(): Promise<void> {
    const canvas = this.lookupMatrixCanvas();
    if (!canvas) {
      return Promise.reject(new Error(`Missing matrix canvas '${this.matrixCanvasId}'.`));
    }

    this.matrixCanvas = canvas;
    const layout = this.resolveLayout() ?? {
      canvasWidth: Math.max(1, canvas.width || 1),
      canvasHeight: Math.max(1, canvas.height || 1),
      slots: [],
    };

    this.prepareMatrixCanvas(canvas, layout.canvasWidth, layout.canvasHeight);
    return new Promise<void>((resolve, reject) => {
      this.readyCompletion = { resolve, reject };
      this.worker = new Worker(new URL("./offscreenMatrixViewportWorker.ts", import.meta.url), {
        type: "module",
      });
      this.worker.onmessage = (event: MessageEvent<OffscreenMatrixWorkerResponse>) => {
        this.handleWorkerResponse(event.data);
      };
      this.worker.onerror = (event) => {
        this.disable(event.message || "Offscreen matrix worker failed.");
      };
      this.worker.onmessageerror = () => {
        this.disable("Offscreen matrix worker returned an unreadable message.");
      };

      try {
        if (!this.transferred) {
          const offscreen = canvas.transferControlToOffscreen();
          this.transferred = true;
          canvas.dataset.offscreenViewport = "true";
          this.post({
            type: "init",
            canvas: offscreen,
            canvasWidth: layout.canvasWidth,
            canvasHeight: layout.canvasHeight,
            slots: layout.slots,
            options: readMatrixOptions(),
          }, [offscreen]);
        }
      } catch (error) {
        this.readyCompletion = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private post(message: OffscreenMatrixWorkerRequest, transfer: Transferable[] = []): void {
    if (!this.worker) {
      throw new Error("Offscreen matrix worker is not running.");
    }

    this.worker.postMessage(message, transfer);
  }

  private handleWorkerResponse(message: OffscreenMatrixWorkerResponse): void {
    if (message.type === "ready") {
      this.writeSharedAdapterDataset(message.gpuAdapterVendor, message.gpuAdapterArchitecture);
      this.readyCompletion?.resolve();
      this.readyCompletion = undefined;
      return;
    }

    if (message.type === "error") {
      if (message.requestId !== undefined) {
        const pending = this.pendingRenders.get(message.requestId);
        this.pendingRenders.delete(message.requestId);
        pending?.reject(new Error(message.message));
        return;
      }

      this.disable(message.message);
      return;
    }

    const pending = this.pendingRenders.get(message.requestId);
    this.pendingRenders.delete(message.requestId);
    this.writeRenderDataset(message.canvasId, message.result);
    pending?.resolve(toRenderFrameResult(pending.canvasId, message.result));
  }

  private disable(reason: string): void {
    this.disabledReason = `matrix-disabled: ${reason}`;
    this.worker?.terminate();
    this.worker = undefined;
    this.readyCompletion?.reject(new Error(this.disabledReason));
    this.readyCompletion = undefined;
    const matrixCanvas = this.matrixCanvas ?? this.lookupMatrixCanvas();
    if (matrixCanvas) {
      matrixCanvas.hidden = true;
      matrixCanvas.style.display = "none";
      matrixCanvas.dataset.webGpuDisabledReason = this.disabledReason;
      matrixCanvas.dataset.matrixFallbackReason = this.disabledReason;
    }

    for (const canvasId of this.surfaces.keys()) {
      const canvas = lookupCanvas(canvasId);
      if (canvas) {
        canvas.dataset.matrixFallbackReason = this.disabledReason;
        canvas.dataset.webGpuDisabledReason = this.disabledReason;
        canvas.dataset.gpuPresentation = "direct-webgpu-fallback";
      }
    }

    this.pendingRenders.forEach((pending) => pending.reject(new Error(this.disabledReason)));
    this.pendingRenders.clear();
  }

  private observeLayout(): void {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.scheduleLayout());
    }

    const matrixCanvas = this.lookupMatrixCanvas();
    if (matrixCanvas) {
      this.resizeObserver.observe(matrixCanvas);
    }

    for (const canvasId of this.surfaces.keys()) {
      const canvas = lookupCanvas(canvasId);
      if (canvas) {
        this.resizeObserver.observe(canvas);
      }
    }
  }

  private scheduleLayout(): void {
    if (this.layoutScheduled) {
      return;
    }

    this.layoutScheduled = true;
    requestAnimationFrame(() => {
      this.layoutScheduled = false;
      this.syncLayout();
    });
  }

  private syncLayout(): void {
    if (!this.worker || this.disabledReason) {
      return;
    }

    const layout = this.resolveLayout();
    if (!layout) {
      return;
    }

    const key = JSON.stringify(layout);
    if (key === this.lastLayoutKey) {
      return;
    }

    this.lastLayoutKey = key;
    const canvas = this.lookupMatrixCanvas();
    if (canvas) {
      this.prepareMatrixCanvas(canvas, layout.canvasWidth, layout.canvasHeight);
    }
    this.post({
      type: "layout",
      canvasWidth: layout.canvasWidth,
      canvasHeight: layout.canvasHeight,
      slots: layout.slots,
    });
  }

  private resolveLayout(): {
    canvasWidth: number;
    canvasHeight: number;
    slots: OffscreenMatrixSlotLayout[];
  } | undefined {
    const canvas = this.lookupMatrixCanvas();
    const matrixRect = canvas?.getBoundingClientRect();
    if (!canvas || !matrixRect || matrixRect.width <= 0 || matrixRect.height <= 0) {
      return undefined;
    }

    const pixelRatio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const canvasWidth = Math.max(1, Math.round(matrixRect.width * pixelRatio));
    const canvasHeight = Math.max(1, Math.round(matrixRect.height * pixelRatio));
    const scaleX = canvasWidth / matrixRect.width;
    const scaleY = canvasHeight / matrixRect.height;
    const configuredCanvasIds = new Set(this.surfaces.keys());
    const slots = this.getCanvasIds()
      .filter((canvasId) => configuredCanvasIds.has(canvasId))
      .map((canvasId) => {
        const tileCanvas = lookupCanvas(canvasId);
        const tileRect = tileCanvas?.getBoundingClientRect();
        if (!tileCanvas || !tileRect || tileRect.width <= 0 || tileRect.height <= 0) {
          return undefined;
        }

        return {
          canvasId,
          x: Math.max(0, Math.round((tileRect.left - matrixRect.left) * scaleX)),
          y: Math.max(0, Math.round((tileRect.top - matrixRect.top) * scaleY)),
          width: Math.max(1, Math.round(tileRect.width * scaleX)),
          height: Math.max(1, Math.round(tileRect.height * scaleY)),
        } satisfies OffscreenMatrixSlotLayout;
      })
      .filter((slot): slot is OffscreenMatrixSlotLayout => Boolean(slot));

    return {
      canvasWidth,
      canvasHeight,
      slots,
    };
  }

  private prepareMatrixCanvas(canvas: HTMLCanvasElement, width: number, height: number): void {
    try {
      canvas.width = width;
      canvas.height = height;
    } catch {
      // A transferred canvas can reject width updates in some browsers; the worker owns sizing.
    }
    canvas.hidden = false;
    canvas.style.display = "block";
    canvas.dataset.renderBackend = "webgpu";
    canvas.dataset.gpuPresentation = "worker-offscreen-matrix-canvas";
    canvas.dataset.gpuUploadSource = "external-texture";
    delete canvas.dataset.webGpuDisabledReason;
    delete canvas.dataset.matrixFallbackReason;
  }

  private prepareAnchorCanvas(configuration: SurfaceConfigurationPlan): void {
    const canvas = lookupCanvas(configuration.canvasId);
    if (!canvas) {
      return;
    }

    canvas.width = configuration.canvasWidth;
    canvas.height = configuration.canvasHeight;
    canvas.hidden = false;
    canvas.style.display = "block";
    canvas.dataset.renderBackend = "webgpu";
    canvas.dataset.gpuPresentation = "worker-offscreen-matrix-canvas";
    canvas.dataset.gpuUploadSource ??= "pending";
    canvas.dataset.gpuSampleRgba = canvas.dataset.gpuSampleRgba ?? "1,1,1,255";
    delete canvas.dataset.webGpuDisabledReason;
    delete canvas.dataset.matrixFallbackReason;
  }

  private writeSharedAdapterDataset(vendor: string | undefined, architecture: string | undefined): void {
    const matrixCanvas = this.lookupMatrixCanvas();
    if (matrixCanvas) {
      matrixCanvas.dataset.gpuAdapterVendor = vendor ?? "";
      matrixCanvas.dataset.gpuAdapterArchitecture = architecture ?? "";
    }
    for (const canvasId of this.surfaces.keys()) {
      const canvas = lookupCanvas(canvasId);
      if (canvas) {
        canvas.dataset.gpuAdapterVendor = vendor ?? "";
        canvas.dataset.gpuAdapterArchitecture = architecture ?? "";
      }
    }
  }

  private writeRenderDataset(canvasId: string, result: OffscreenMatrixRenderResult): void {
    const canvases = [this.lookupMatrixCanvas(), lookupCanvas(canvasId)].filter((canvas): canvas is HTMLCanvasElement => Boolean(canvas));
    for (const canvas of canvases) {
      canvas.dataset.renderBackend = result.renderBackend;
      canvas.dataset.gpuPresentation = result.gpuPresentation;
      canvas.dataset.gpuUploadSource = result.gpuUploadSource;
      canvas.dataset.gpuAdapterVendor = result.gpuAdapterVendor ?? "";
      canvas.dataset.gpuAdapterArchitecture = result.gpuAdapterArchitecture ?? "";
      canvas.dataset.matrixPresentMode = result.matrixPresentMode;
      canvas.dataset.matrixPresentPath = result.matrixPresentPath;
      canvas.dataset.matrixFlushCount = String(result.matrixFlushCount);
      canvas.dataset.matrixPresentCount = String(result.matrixPresentCount);
      canvas.dataset.matrixDrawCount = String(result.matrixDrawCount);
      canvas.dataset.matrixExternalImportCount = String(result.matrixExternalImportCount);
      canvas.dataset.matrixBindGroupCount = String(result.matrixBindGroupCount);
      canvas.dataset.matrixVideoFrameCopyCount = String(result.matrixVideoFrameCopyCount);
      canvas.dataset.matrixLastDirtySlotCount = String(result.matrixLastDirtySlotCount);
      canvas.dataset.matrixSlotCount = String(this.surfaces.size);
      canvas.dataset.lastSequence = String(result.renderedSequenceNumber);
      canvas.dataset.overlayCount = String(result.overlayPrimitiveCount);
      canvas.dataset.gpuSampleRgba = "1,1,1,255";
      delete canvas.dataset.webGpuDisabledReason;
      delete canvas.dataset.matrixFallbackReason;
    }
  }

  private lookupMatrixCanvas(): HTMLCanvasElement | null {
    const canvas = lookupCanvas(this.matrixCanvasId);
    if (canvas) {
      this.matrixCanvas = canvas;
    }

    return canvas;
  }
}

function toRenderFrameResult(canvasId: string, result: OffscreenMatrixRenderResult): RenderFrameResult {
  return {
    sessionId: canvasId,
    renderedSequenceNumber: result.renderedSequenceNumber,
    overlayPrimitiveCount: result.overlayPrimitiveCount,
    renderBackend: result.renderBackend,
    matrixPresentMode: result.matrixPresentMode,
    matrixPresentPath: result.matrixPresentPath,
    matrixFlushCount: result.matrixFlushCount,
    matrixPresentCount: result.matrixPresentCount,
    matrixDrawCount: result.matrixDrawCount,
    matrixExternalImportCount: result.matrixExternalImportCount,
    matrixBindGroupCount: result.matrixBindGroupCount,
    matrixVideoFrameCopyCount: result.matrixVideoFrameCopyCount,
    matrixLastDirtySlotCount: result.matrixLastDirtySlotCount,
    gpuPresentation: result.gpuPresentation,
    gpuUploadSource: result.gpuUploadSource,
    gpuAdapterVendor: result.gpuAdapterVendor,
    gpuAdapterArchitecture: result.gpuAdapterArchitecture,
    matrixFallbackReason: result.matrixFallbackReason,
    webGpuDisabledReason: result.webGpuDisabledReason,
  };
}

function collectFrameTransferables(frame: unknown): Transferable[] {
  return frame && typeof frame === "object" ? [frame as Transferable] : [];
}

function lookupCanvas(canvasId: string): HTMLCanvasElement | null {
  const candidate = document.getElementById(canvasId);
  return candidate instanceof HTMLCanvasElement ? candidate : null;
}

function readMatrixOptions(): OffscreenMatrixOptions {
  const params = new URLSearchParams(window.location.search);
  const uploadMode = params.get("matrixTexture")?.toLowerCase();
  return {
    uploadMode: uploadMode === "copy" || uploadMode === "external" ? uploadMode : "auto",
    presentMode: "immediate",
  };
}
