import type {
  DecodedFramePlan,
  RenderFrameRequest,
  RenderFrameResult,
  SurfaceConfigurationPlan,
} from "../contracts/models";
import type { VideoPipeFrameRenderer } from "./playerController";

export class SharedVideoTileRenderer implements VideoPipeFrameRenderer {
  private readonly renderers = new Map<string, VideoPipeFrameRenderer>();
  private readonly getCanvasIds: () => string[];
  private readonly createRenderer: () => VideoPipeFrameRenderer;
  private configuration?: SurfaceConfigurationPlan;
  private activeCanvasIds: string[] = [];
  private activeCanvasKey = "";
  private disposed = false;

  public constructor(getCanvasIds: () => string[], createRenderer: () => VideoPipeFrameRenderer) {
    this.getCanvasIds = getCanvasIds;
    this.createRenderer = createRenderer;
  }

  public async configureSurface(configuration: SurfaceConfigurationPlan): Promise<void> {
    this.configuration = configuration;
    this.disposed = false;
    await this.syncRenderers(this.resolveCanvasIds());
  }

  public async renderFrame(request: RenderFrameRequest): Promise<RenderFrameResult> {
    if (!this.configuration || this.disposed) {
      return Promise.reject(new Error("Shared video renderer must be configured before rendering."));
    }

    const canvasIds = await this.syncRenderersIfNeeded();
    if (canvasIds.length === 0) {
      closeDecodedFrame(request.frame);
      return {
        sessionId: request.sessionId,
        renderedSequenceNumber: request.frame.sequenceNumber,
        overlayPrimitiveCount: request.activeMetadata.reduce((total, batch) => total + batch.records.length, 0),
        renderBackend: "canvas2d-fallback",
      };
    }

    const sourceFrame = request.frame.videoFrame as { clone?: () => unknown } | undefined;
    const canShareFrameReference = sourceFrame !== undefined
      && canvasIds.every((canvasId) => this.renderers.get(canvasId)?.canShareFrameReference?.() === true);
    const targetCanvasIds = sourceFrame && typeof sourceFrame.clone !== "function" && !canShareFrameReference && canvasIds.length > 1
      ? canvasIds.slice(-1)
      : canvasIds;
    const renderRequests = targetCanvasIds.map((canvasId, index) => ({
      renderer: this.renderers.get(canvasId),
      request: {
        ...request,
        sessionId: `${request.sessionId}:${canvasId}`,
        frame: canShareFrameReference || index === targetCanvasIds.length - 1
          ? request.frame
          : cloneDecodedFrame(request.frame),
      },
    }));

    if (renderRequests.length === 1) {
      const [{ renderer, request: nextRequest }] = renderRequests;
      if (!renderer) {
        return Promise.reject(new Error("Shared video renderer lost a tile renderer during fanout."));
      }

      const result = await renderer.renderFrame(nextRequest);
      return {
        ...result,
        sessionId: request.sessionId,
      };
    }

    const settled = await Promise.allSettled(renderRequests.map(({ renderer, request: nextRequest }) => {
      if (!renderer) {
        return Promise.reject(new Error("Shared video renderer lost a tile renderer during fanout."));
      }

      return renderer.renderFrame(nextRequest);
    }));
    const firstRejected = settled.find((result) => result.status === "rejected");
    if (firstRejected) {
      closeDecodedFramesOnce(renderRequests
        .filter((_, index) => settled[index]?.status === "rejected")
        .map(({ request: nextRequest }) => nextRequest.frame));

      return Promise.reject(firstRejected.status === "rejected"
        ? firstRejected.reason
        : new Error("Shared video renderer fanout failed."));
    }

    const firstResult = settled[0];
    if (firstResult?.status === "fulfilled") {
      return {
        ...firstResult.value,
        sessionId: request.sessionId,
      };
    }

    return {
      sessionId: request.sessionId,
      renderedSequenceNumber: request.frame.sequenceNumber,
      overlayPrimitiveCount: request.activeMetadata.reduce((total, batch) => total + batch.records.length, 0),
      renderBackend: "canvas2d-fallback",
    };
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    const renderers = [...this.renderers.values()];
    this.renderers.clear();
    this.activeCanvasIds = [];
    this.activeCanvasKey = "";
    await Promise.all(renderers.map((renderer) => renderer.dispose()));
  }

  private async syncRenderersIfNeeded(): Promise<string[]> {
    const canvasIds = this.resolveCanvasIds();
    const canvasKey = canvasIds.join("\n");
    if (canvasKey === this.activeCanvasKey) {
      return this.activeCanvasIds;
    }

    return await this.syncRenderers(canvasIds);
  }

  private resolveCanvasIds(): string[] {
    return [...new Set(this.getCanvasIds())];
  }

  private async syncRenderers(canvasIds: string[]): Promise<string[]> {
    if (!this.configuration) {
      return [];
    }

    this.activeCanvasIds = canvasIds;
    this.activeCanvasKey = canvasIds.join("\n");
    const activeCanvasIds = new Set(canvasIds);
    const staleCanvasIds = [...this.renderers.keys()].filter((canvasId) => !activeCanvasIds.has(canvasId));
    await Promise.all(staleCanvasIds.map(async (canvasId) => {
      const renderer = this.renderers.get(canvasId);
      this.renderers.delete(canvasId);
      await renderer?.dispose();
    }));

    for (const canvasId of canvasIds) {
      if (this.renderers.has(canvasId)) {
        continue;
      }

      const renderer = this.createRenderer();
      await renderer.configureSurface({
        ...this.configuration,
        canvasId,
      });
      this.renderers.set(canvasId, renderer);
    }

    return canvasIds;
  }
}

export { SharedVideoTileRenderer as VmsSharedTileRenderer };

function cloneDecodedFrame(frame: DecodedFramePlan): DecodedFramePlan {
  const cloneable = frame.videoFrame as { clone?: () => unknown } | undefined;
  if (cloneable?.clone) {
    return {
      ...frame,
      videoFrame: cloneable.clone(),
    };
  }

  return { ...frame };
}

function closeDecodedFrame(frame: DecodedFramePlan): void {
  (frame.videoFrame as { close?: () => void } | undefined)?.close?.();
}

function closeDecodedFramesOnce(frames: DecodedFramePlan[]): void {
  const closedFrames = new Set<unknown>();
  for (const frame of frames) {
    const videoFrame = frame.videoFrame;
    if (videoFrame && closedFrames.has(videoFrame)) {
      continue;
    }

    closedFrames.add(videoFrame);
    closeDecodedFrame(frame);
  }
}
