import type {
  DecodedFramePlan,
  RenderBackend,
  TimedMetadataBatch,
} from "../contracts/models";

export interface OffscreenMatrixSlotLayout {
  canvasId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OffscreenMatrixOptions {
  uploadMode: "auto" | "external" | "copy";
  presentMode: "immediate";
  retainMode?: "auto" | "backing" | "swapchain";
  powerPreference?: "high-performance" | "low-power";
}

export type OffscreenMatrixWorkerRequest =
  | {
    type: "init";
    canvas: OffscreenCanvas;
    canvasWidth: number;
    canvasHeight: number;
    slots: OffscreenMatrixSlotLayout[];
    options: OffscreenMatrixOptions;
  }
  | {
    type: "connect-render-port";
    canvasId: string;
    port: MessagePort;
  }
  | {
    type: "layout";
    canvasWidth: number;
    canvasHeight: number;
    slots: OffscreenMatrixSlotLayout[];
  }
  | {
    type: "render";
    requestId: number;
    canvasId: string;
    frame: DecodedFramePlan;
    activeMetadata: TimedMetadataBatch[];
  }
  | {
    type: "unregister";
    canvasId: string;
  }
  | {
    type: "stop";
  };

export interface OffscreenMatrixRenderResult {
  renderedSequenceNumber: number;
  overlayPrimitiveCount: number;
  renderBackend: RenderBackend;
  matrixPresentMode: string;
  matrixPresentPath: string;
  matrixFlushCount: number;
  matrixPresentCount: number;
  matrixDrawCount: number;
  matrixExternalImportCount: number;
  matrixBindGroupCount: number;
  matrixVideoFrameCopyCount: number;
  matrixLastDirtySlotCount: number;
  renderMs?: number;
  importExternalTextureMs?: number;
  bindGroupMs?: number;
  uniformMs?: number;
  encodeMs?: number;
  submitMs?: number;
  gpuPresentation: string;
  gpuUploadSource: string;
  gpuAdapterVendor?: string;
  gpuAdapterArchitecture?: string;
  matrixFallbackReason?: string;
  webGpuDisabledReason?: string;
}

export type OffscreenMatrixRenderPortRequest =
  | {
    type: "render";
    requestId: number;
    frame: DecodedFramePlan;
    activeMetadata: TimedMetadataBatch[];
  }
  | {
    type: "stop";
  };

export type OffscreenMatrixRenderPortResponse =
  | {
    type: "rendered";
    requestId: number;
    result: OffscreenMatrixRenderResult;
  }
  | {
    type: "error";
    requestId?: number;
    message: string;
  };

export type OffscreenMatrixWorkerResponse =
  | {
    type: "ready";
    gpuAdapterVendor?: string;
    gpuAdapterArchitecture?: string;
  }
  | {
    type: "rendered";
    requestId: number;
    canvasId: string;
    result: OffscreenMatrixRenderResult;
  }
  | {
    type: "error";
    requestId?: number;
    canvasId?: string;
    message: string;
  };
