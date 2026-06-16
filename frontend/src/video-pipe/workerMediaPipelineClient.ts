import type {
  BrowserTransportMode,
  DecodedFramePlan,
  MetadataTransportMessage,
  SelectedVideoSourceDescriptor,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
} from "../contracts/models";

export type WorkerMediaPipelineMode = "main-thread" | "media-worker";

export interface WorkerMediaPipelineClientOptions {
  startupTimeoutMs?: number;
}

const DefaultWorkerStartupTimeoutMs = 45_000;

export type WorkerFrameMetadata = {
  sequenceNumber: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
};

type WorkerGpuPowerPreference = "high-performance" | "low-power";

export type WorkerDecodedFrameEnvelope = {
  frame: DecodedFramePlan;
  metadata?: WorkerFrameMetadata;
  receivedAtUnixTimeMs?: number;
};

export interface WorkerOffscreenRenderTarget {
  canvas: OffscreenCanvas;
  canvasWidth: number;
  canvasHeight: number;
}

export interface WorkerMatrixRenderTarget {
  canvasId: string;
  port: MessagePort;
}

export type WorkerMediaPipelineEvent =
  | {
    type: "connected";
    activeTransport: BrowserTransportMode;
    webTransportReady: boolean;
    transportMs: number;
  }
  | {
    type: "source";
    source: SelectedVideoSourceDescriptor;
  }
  | {
    type: "metadata";
    message: MetadataTransportMessage;
  }
  | {
    type: "decoded";
    frames: WorkerDecodedFrameEnvelope[];
    bytesReceived: number;
    messagesReceived: number;
    decodeMs: number;
    backlogFrameCount: number;
  }
  | {
    type: "rendered";
    metadata?: WorkerFrameMetadata;
    receivedAtUnixTimeMs?: number;
    bytesReceived: number;
    messagesReceived: number;
    decodeMs: number;
    renderMs: number;
    renderStageMs?: {
      importExternalTexture: number;
      bindGroup: number;
      uniform: number;
      encode: number;
      submit: number;
    };
    backlogFrameCount: number;
    droppedBeforeRender: number;
    decodeBackend: string;
    renderBackend: "webgpu" | "canvas2d-fallback";
    renderedSequenceNumber: number;
    overlayPrimitiveCount: number;
    width: number;
    height: number;
    gpuPresentation?: string;
    gpuUploadSource?: string;
    gpuAdapterVendor?: string;
    gpuAdapterArchitecture?: string;
    matrixPresentMode?: string;
    matrixPresentPath?: string;
    matrixFlushCount?: number;
    matrixPresentCount?: number;
    matrixDrawCount?: number;
    matrixExternalImportCount?: number;
    matrixBindGroupCount?: number;
    matrixVideoFrameCopyCount?: number;
    matrixLastDirtySlotCount?: number;
  }
  | {
    type: "progress";
    bytesReceived: number;
    messagesReceived: number;
    receiveIntervalsMs: number[];
    backlogFrameCount: number;
    lastMessageAtUnixTimeMs?: number;
  }
  | {
    type: "drop";
    count: number;
    reason: string;
    lastMessageAtUnixTimeMs?: number;
  }
  | {
    type: "sequence-gap";
    gapFrameCount: number;
  }
  | {
    type: "end";
    bytesReceived: number;
    messagesReceived: number;
  };

type WorkerRequest =
  | {
    type: "start";
    endpoint: TransportEndpointDescriptor;
    initialCodec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
    targetLatencyMs: number;
    metadataEnabled?: boolean;
    offscreenRenderTarget?: {
      canvas: OffscreenCanvas;
      canvasWidth: number;
      canvasHeight: number;
    };
    matrixRenderTarget?: WorkerMatrixRenderTarget;
    splitRenderWorker?: boolean;
    gpuPowerPreference?: WorkerGpuPowerPreference;
    workerTextureMode?: "auto" | "external" | "copy" | "bitmap";
    predecodeFrameAdmission?: boolean;
  }
  | { type: "set-metadata-enabled"; enabled: boolean }
  | { type: "stop" };

type WorkerResponse = WorkerMediaPipelineEvent | { type: "error"; message: string };

export function shouldUseWorkerMediaPipeline(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return false;
  }

  const mode = new URLSearchParams(window.location.search).get("mediaWorker")?.toLowerCase();
  if (["0", "false", "off", "main", "main-thread"].includes(mode ?? "")) {
    return false;
  }

  return true;
}

export class WorkerMediaPipelineClient {
  public readonly pipelineMode = "media-worker" as const;
  private readonly worker: Worker;
  private disposed = false;
  private startupTimeoutId?: ReturnType<typeof setTimeout>;
  private complete?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };

  public constructor(
    private readonly onEvent: (event: WorkerMediaPipelineEvent) => void,
    private readonly options: WorkerMediaPipelineClientOptions = {},
  ) {
    this.worker = new Worker(new URL("./mediaPipelineWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "Media pipeline worker failed."));
    };
    this.worker.onmessageerror = () => {
      this.fail(new Error("Media pipeline worker returned an unreadable message."));
    };
  }

  public start(
    endpoint: TransportEndpointDescriptor,
    initialCodec: VideoCodecConfiguration & { profile?: string; frameRate?: number },
    targetLatencyMs: number,
    abortSignal: AbortSignal,
    offscreenRenderTarget?: WorkerOffscreenRenderTarget,
    metadataEnabled = true,
    matrixRenderTarget?: WorkerMatrixRenderTarget,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Media pipeline worker has been disposed."));
    }

    const abort = (): void => {
      this.dispose();
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    return new Promise<void>((resolve, reject) => {
      this.startupTimeoutId = setTimeout(() => {
        this.fail(new Error(`Media pipeline worker did not decode a frame within ${this.startupTimeoutMs()} ms.`));
        this.dispose();
      }, this.startupTimeoutMs());
      this.complete = {
        resolve: () => {
          abortSignal.removeEventListener("abort", abort);
          this.clearStartupTimeout();
          resolve();
        },
        reject: (error) => {
          abortSignal.removeEventListener("abort", abort);
          this.clearStartupTimeout();
          reject(error);
        },
      };
      const request = {
        type: "start",
        endpoint,
        initialCodec,
        targetLatencyMs,
        metadataEnabled,
        offscreenRenderTarget,
        matrixRenderTarget,
        splitRenderWorker: shouldUseSplitRenderWorker(),
        gpuPowerPreference: resolveWorkerGpuPowerPreference(),
        workerTextureMode: resolveWorkerTextureMode(),
        predecodeFrameAdmission: shouldUsePredecodeFrameAdmission(),
      } satisfies WorkerRequest;
      const transfer = [
        ...(offscreenRenderTarget ? [offscreenRenderTarget.canvas] : []),
        ...(matrixRenderTarget ? [matrixRenderTarget.port] : []),
      ];
      this.worker.postMessage(request, transfer);
    });
  }

  public setMetadataEnabled(enabled: boolean): void {
    if (this.disposed) {
      return;
    }

    this.worker.postMessage({
      type: "set-metadata-enabled",
      enabled,
    } satisfies WorkerRequest);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    try {
      this.worker.postMessage({ type: "stop" } satisfies WorkerRequest);
    } catch {
      // The worker can already be gone after a decode or transport failure.
    }
    this.worker.terminate();
    this.clearStartupTimeout();
    this.complete?.resolve();
    this.complete = undefined;
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === "error") {
      this.fail(new Error(message.message));
      return;
    }

    this.onEvent(message);
    if ((message.type === "decoded" && message.frames.length > 0) || message.type === "rendered") {
      this.clearStartupTimeout();
    }
    if (message.type === "end") {
      this.complete?.resolve();
      this.complete = undefined;
    }
  }

  private fail(error: Error): void {
    this.clearStartupTimeout();
    this.complete?.reject(error);
    this.complete = undefined;
  }

  private startupTimeoutMs(): number {
    const value = this.options.startupTimeoutMs;
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DefaultWorkerStartupTimeoutMs;
  }

  private clearStartupTimeout(): void {
    if (this.startupTimeoutId === undefined) {
      return;
    }

    clearTimeout(this.startupTimeoutId);
    this.startupTimeoutId = undefined;
  }
}

function resolveWorkerGpuPowerPreference(): WorkerGpuPowerPreference {
  if (typeof window === "undefined") {
    return "high-performance";
  }

  const mode = (
    new URLSearchParams(window.location.search).get("webgpuPower")
    ?? new URLSearchParams(window.location.search).get("gpuPower")
    ?? ""
  ).toLowerCase();
  return ["low", "low-power", "integrated", "intel"].includes(mode)
    ? "low-power"
    : "high-performance";
}

function shouldUseSplitRenderWorker(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const mode = new URLSearchParams(window.location.search).get("splitRenderWorker")?.toLowerCase();
  return ["1", "true", "on", "split"].includes(mode ?? "");
}

function resolveWorkerTextureMode(): "auto" | "external" | "copy" | "bitmap" {
  if (typeof window === "undefined") {
    return "auto";
  }

  const mode = new URLSearchParams(window.location.search).get("workerTexture")?.toLowerCase();
  if (["copy", "retained", "videoframe-copy"].includes(mode ?? "")) {
    return "copy";
  }

  if (["bitmap", "downscale", "resized", "resize"].includes(mode ?? "")) {
    return "bitmap";
  }

  if (["external", "direct", "zero-copy"].includes(mode ?? "")) {
    return "external";
  }

  return "auto";
}

function shouldUsePredecodeFrameAdmission(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const mode = new URLSearchParams(window.location.search).get("predecodeFrameAdmission")?.toLowerCase();
  return ["1", "true", "yes", "on", "nonreference"].includes(mode ?? "");
}
