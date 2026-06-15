import { WebGpuMatrixTileRenderer, WebGpuRenderer } from "../contracts/services";
import type { VideoPipeFrameRenderer } from "./playerController";
import { SharedVideoTileRenderer } from "./sharedTileRenderer";

export interface SharedVideoViewportRendererOptions {
  getCanvasIds: () => string[];
  matrixCanvasId: string;
  matrixCompositor: boolean;
}

export function createSharedVideoViewportRenderer(
  options: SharedVideoViewportRendererOptions,
): VideoPipeFrameRenderer {
  return new SharedVideoTileRenderer(
    options.getCanvasIds,
    options.matrixCompositor
      ? () => new WebGpuMatrixTileRenderer(options.matrixCanvasId)
      : () => new WebGpuRenderer(),
  );
}
