import { WebGpuMatrixTileRenderer, WebGpuRenderer } from "../contracts/services";
import type { VideoPipeFrameRenderer } from "./playerController";
import {
  createOffscreenMatrixTileRenderer,
  shouldUseOffscreenMatrixViewport,
} from "./offscreenMatrixRenderer";
import { SharedVideoTileRenderer } from "./sharedTileRenderer";

export interface SharedVideoViewportRendererOptions {
  getCanvasIds: () => string[];
  isMetadataEnabledForCanvasId?: (canvasId: string) => boolean;
  matrixCanvasId: string;
  matrixCompositor: boolean;
}

export function createSharedVideoViewportRenderer(
  options: SharedVideoViewportRendererOptions,
): VideoPipeFrameRenderer {
  return new SharedVideoTileRenderer(
    options.getCanvasIds,
    options.matrixCompositor
      ? () => shouldUseOffscreenMatrixViewport()
        ? createOffscreenMatrixTileRenderer(options.matrixCanvasId, options.getCanvasIds)
        : new WebGpuMatrixTileRenderer(options.matrixCanvasId)
      : () => new WebGpuRenderer(),
    options.isMetadataEnabledForCanvasId,
  );
}
