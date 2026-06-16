import type {
  DecodedFramePlan,
  TimedMetadataBatch,
  TimedMetadataRecord,
} from "../contracts/models";
import type {
  OffscreenMatrixOptions,
  OffscreenMatrixRenderResult,
  OffscreenMatrixSlotLayout,
  OffscreenMatrixWorkerRequest,
  OffscreenMatrixWorkerResponse,
} from "./offscreenMatrixWorkerProtocol";

type VideoFrameLike = {
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  close?: () => void;
};

type GpuLike = {
  getPreferredCanvasFormat?: () => string;
  requestAdapter: (options?: Record<string, unknown>) => Promise<GpuAdapterLike | null>;
};

type GpuAdapterLike = {
  info?: {
    vendor?: string;
    architecture?: string;
    description?: string;
  };
  requestDevice: () => Promise<GpuDeviceLike>;
};

type GpuDeviceLike = {
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => GpuPipelineLike;
  createSampler: (descriptor?: Record<string, unknown>) => unknown;
  createBindGroup: (descriptor: Record<string, unknown>) => unknown;
  createBuffer: (descriptor: Record<string, unknown>) => GpuBufferLike;
  createTexture: (descriptor: Record<string, unknown>) => GpuTextureLike;
  createCommandEncoder: () => GpuCommandEncoderLike;
  importExternalTexture?: (descriptor: Record<string, unknown>) => unknown;
  queue: {
    copyExternalImageToTexture?: (source: Record<string, unknown>, destination: Record<string, unknown>, size: Record<string, unknown>) => void;
    writeBuffer: (buffer: unknown, offset: number, data: BufferSource) => void;
    submit: (commands: unknown[]) => void;
  };
};

type GpuPipelineLike = {
  getBindGroupLayout?: (index: number) => unknown;
};

type GpuCommandEncoderLike = {
  beginRenderPass: (descriptor: Record<string, unknown>) => GpuRenderPassEncoderLike;
  copyTextureToTexture: (source: Record<string, unknown>, destination: Record<string, unknown>, size: Record<string, unknown>) => void;
  finish: () => unknown;
};

type GpuRenderPassEncoderLike = {
  setPipeline: (pipeline: unknown) => void;
  setViewport?: (x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number) => void;
  setScissorRect?: (x: number, y: number, width: number, height: number) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};

type GpuCanvasContextLike = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => GpuTextureLike;
};

type GpuBufferLike = {
  destroy?: () => void;
};

type GpuTextureLike = {
  createView: () => unknown;
  destroy?: () => void;
};

interface SlotFrame {
  frame: VideoFrameLike;
  sequenceNumber: number;
  decodeBackend: string;
  activeMetadata: TimedMetadataBatch[];
  width: number;
  height: number;
  gpuUploadSource: "external-texture" | "videoframe-copy";
}

interface Slot {
  layout: OffscreenMatrixSlotLayout;
  currentFrame?: SlotFrame;
  overlayBuffer?: GpuBufferLike;
  overlayUniform?: Float32Array<ArrayBuffer>;
  bindGroup?: unknown;
  redrawNeeded: boolean;
}

interface MatrixState {
  canvas: OffscreenCanvas;
  context: GpuCanvasContextLike;
  device: GpuDeviceLike;
  externalPipeline: GpuPipelineLike;
  texturePipeline: GpuPipelineLike;
  sampler: unknown;
  adapterInfo?: GpuAdapterLike["info"];
  format: string;
  width: number;
  height: number;
  needsClear: boolean;
  flushCount: number;
  presentCount: number;
  drawCount: number;
  externalImportCount: number;
  bindGroupCount: number;
  videoFrameCopyCount: number;
  lastDirtySlotCount: number;
}

const OverlayTextMaxChars = 32;
const OverlayUniformFloatCount = 8 + OverlayTextMaxChars;
const OverlayUniformByteLength = OverlayUniformFloatCount * Float32Array.BYTES_PER_ELEMENT;
const GpuPresentation = "worker-offscreen-matrix-canvas";

const externalVideoShader = `
struct Overlay {
  rect: vec4f,
  info: vec4f,
  chars0: vec4f,
  chars1: vec4f,
  chars2: vec4f,
  chars3: vec4f,
  chars4: vec4f,
  chars5: vec4f,
  chars6: vec4f,
  chars7: vec4f,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0)
  );
  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 0.0),
    vec2f(0.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(1.0, 0.0)
  );

  var output: VertexOut;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;

fn overlayChar(index: u32) -> u32 {
  if (index < 4u) { return u32(overlay.chars0[index] + 0.5); }
  if (index < 8u) { return u32(overlay.chars1[index - 4u] + 0.5); }
  if (index < 12u) { return u32(overlay.chars2[index - 8u] + 0.5); }
  if (index < 16u) { return u32(overlay.chars3[index - 12u] + 0.5); }
  if (index < 20u) { return u32(overlay.chars4[index - 16u] + 0.5); }
  if (index < 24u) { return u32(overlay.chars5[index - 20u] + 0.5); }
  if (index < 28u) { return u32(overlay.chars6[index - 24u] + 0.5); }
  if (index < 32u) { return u32(overlay.chars7[index - 28u] + 0.5); }
  return 32u;
}

fn glyphRow(code: u32, row: u32) -> u32 {
  if (code == 48u || code == 79u) {
    let rows = array<u32, 7>(14u, 17u, 19u, 21u, 25u, 17u, 14u);
    return rows[row];
  }
  if (code == 49u) {
    let rows = array<u32, 7>(4u, 12u, 4u, 4u, 4u, 4u, 14u);
    return rows[row];
  }
  if (code == 50u) {
    let rows = array<u32, 7>(14u, 17u, 1u, 2u, 4u, 8u, 31u);
    return rows[row];
  }
  if (code == 51u) {
    let rows = array<u32, 7>(30u, 1u, 1u, 14u, 1u, 1u, 30u);
    return rows[row];
  }
  if (code == 52u) {
    let rows = array<u32, 7>(18u, 18u, 18u, 31u, 2u, 2u, 2u);
    return rows[row];
  }
  if (code == 53u || code == 83u) {
    let rows = array<u32, 7>(31u, 16u, 30u, 1u, 1u, 17u, 14u);
    return rows[row];
  }
  if (code == 54u) {
    let rows = array<u32, 7>(6u, 8u, 16u, 30u, 17u, 17u, 14u);
    return rows[row];
  }
  if (code == 55u) {
    let rows = array<u32, 7>(31u, 1u, 2u, 4u, 8u, 8u, 8u);
    return rows[row];
  }
  if (code == 56u) {
    let rows = array<u32, 7>(14u, 17u, 17u, 14u, 17u, 17u, 14u);
    return rows[row];
  }
  if (code == 57u) {
    let rows = array<u32, 7>(14u, 17u, 17u, 15u, 1u, 2u, 28u);
    return rows[row];
  }
  if (code == 68u) {
    let rows = array<u32, 7>(30u, 17u, 17u, 17u, 17u, 17u, 30u);
    return rows[row];
  }
  if (code == 84u) {
    let rows = array<u32, 7>(31u, 4u, 4u, 4u, 4u, 4u, 4u);
    return rows[row];
  }
  if (code == 88u) {
    let rows = array<u32, 7>(17u, 17u, 10u, 4u, 10u, 17u, 17u);
    return rows[row];
  }
  if (code == 45u) {
    let rows = array<u32, 7>(0u, 0u, 0u, 31u, 0u, 0u, 0u);
    return rows[row];
  }
  return 0u;
}

fn drawOsd(uv: vec2f, sampledColor: vec4f) -> vec4f {
  if (overlay.info.x < 0.5) {
    return sampledColor;
  }

  let rect = overlay.rect;
  let right = rect.x + rect.z;
  let bottom = rect.y + rect.w;
  let borderWidth = 0.004;
  let inRect = uv.x >= rect.x && uv.x <= right && uv.y >= rect.y && uv.y <= bottom;
  let border = inRect && (
    abs(uv.x - rect.x) < borderWidth ||
    abs(uv.x - right) < borderWidth ||
    abs(uv.y - rect.y) < borderWidth ||
    abs(uv.y - bottom) < borderWidth
  );

  var labelY = rect.y - 0.075;
  if (labelY < 0.01) {
    labelY = min(0.91, bottom + 0.018);
  }
  let textLength = min(u32(overlay.info.y + 0.5), 32u);
  let cellSize = vec2f(0.013, 0.027);
  let labelOrigin = vec2f(clamp(rect.x, 0.01, 0.58), labelY);
  let labelPadding = vec2f(0.006, 0.006);
  let labelSize = vec2f(cellSize.x * f32(max(textLength, 1u)) + labelPadding.x * 2.0, cellSize.y + labelPadding.y * 2.0);
  let inLabel = uv.x >= labelOrigin.x
    && uv.x <= labelOrigin.x + labelSize.x
    && uv.y >= labelOrigin.y
    && uv.y <= labelOrigin.y + labelSize.y;

  if (inLabel) {
    let textOrigin = labelOrigin + labelPadding;
    let local = uv - textOrigin;
    if (local.x >= 0.0 && local.y >= 0.0 && local.y < cellSize.y) {
      let charIndex = u32(floor(local.x / cellSize.x));
      if (charIndex < textLength) {
        let charLocalX = local.x - f32(charIndex) * cellSize.x;
        let glyphColumn = u32(floor(charLocalX / (cellSize.x / 6.0)));
        let glyphRowIndex = u32(floor(local.y / (cellSize.y / 8.0)));
        if (glyphColumn < 5u && glyphRowIndex < 7u) {
          let rowBits = glyphRow(overlayChar(charIndex), glyphRowIndex);
          let bitIndex = 4u - glyphColumn;
          if (((rowBits >> bitIndex) & 1u) == 1u) {
            return vec4f(1.0, 0.92, 0.24, 1.0);
          }
        }
      }
    }
    return vec4f(0.02, 0.05, 0.09, 0.86);
  }

  if (border) {
    return vec4f(1.0, 0.84, 0.12, 1.0);
  }

  return sampledColor;
}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  let color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return drawOsd(input.uv, vec4f(color.rgb, 1.0));
}
`;

class OffscreenMatrixRenderer {
  private readonly slots = new Map<string, Slot>();
  private state?: MatrixState;
  private options: OffscreenMatrixOptions = {
    uploadMode: "auto",
    presentMode: "immediate",
  };

  public async initialize(request: Extract<OffscreenMatrixWorkerRequest, { type: "init" }>): Promise<void> {
    this.options = request.options;
    const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
    if (!gpu) {
      throw new Error("offscreen-matrix-webgpu-unavailable");
    }

    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("offscreen-matrix-no-adapter");
    }

    const adapterInfo = adapter.info;

    const device = await adapter.requestDevice();
    if (typeof device.importExternalTexture !== "function") {
      throw new Error("offscreen-matrix-external-texture-unavailable");
    }

    const context = request.canvas.getContext("webgpu") as GpuCanvasContextLike | null;
    if (!context) {
      throw new Error("offscreen-matrix-context-unavailable");
    }

    const format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    const externalShaderModule = device.createShaderModule({ code: externalVideoShader });
    const externalPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: externalShaderModule,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: externalShaderModule,
        entryPoint: "fragmentMain",
        targets: [{ format }],
      },
      primitive: {
        topology: "triangle-list",
      },
    });
    const sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });

    this.state = {
      canvas: request.canvas,
      context,
      device,
      externalPipeline,
      texturePipeline: externalPipeline,
      sampler,
      adapterInfo,
      format,
      width: 0,
      height: 0,
      needsClear: true,
      flushCount: 0,
      presentCount: 0,
      drawCount: 0,
      externalImportCount: 0,
      bindGroupCount: 0,
      videoFrameCopyCount: 0,
      lastDirtySlotCount: 0,
    };
    this.updateLayout(request.canvasWidth, request.canvasHeight, request.slots);
    post({
      type: "ready",
      gpuAdapterVendor: adapterInfo?.vendor,
      gpuAdapterArchitecture: adapterInfo?.architecture,
    });
  }

  public updateLayout(canvasWidth: number, canvasHeight: number, layouts: OffscreenMatrixSlotLayout[]): void {
    const state = this.requireState();
    const nextWidth = Math.max(1, Math.floor(canvasWidth));
    const nextHeight = Math.max(1, Math.floor(canvasHeight));
    if (state.width !== nextWidth || state.height !== nextHeight) {
      state.width = nextWidth;
      state.height = nextHeight;
      state.canvas.width = nextWidth;
      state.canvas.height = nextHeight;
      state.context.configure({
        device: state.device,
        format: state.format,
        alphaMode: "premultiplied",
        usage: getGpuTextureUsage().renderAttachment,
      });
      state.needsClear = true;
    }

    const liveIds = new Set(layouts.map((layout) => layout.canvasId));
    for (const [canvasId, slot] of this.slots) {
      if (!liveIds.has(canvasId)) {
        this.closeSlot(slot);
        this.slots.delete(canvasId);
      }
    }

    for (const layout of layouts) {
      const existing = this.slots.get(layout.canvasId);
      if (existing) {
        if (
          existing.layout.x !== layout.x
          || existing.layout.y !== layout.y
          || existing.layout.width !== layout.width
          || existing.layout.height !== layout.height
        ) {
          existing.layout = layout;
          existing.redrawNeeded = true;
          state.needsClear = true;
        }
        continue;
      }

      this.slots.set(layout.canvasId, {
        layout,
        redrawNeeded: true,
      });
      state.needsClear = true;
    }
  }

  public unregister(canvasId: string): void {
    const slot = this.slots.get(canvasId);
    if (!slot) {
      return;
    }

    this.closeSlot(slot);
    this.slots.delete(canvasId);
    if (this.state) {
      this.state.needsClear = true;
    }
  }

  public render(canvasId: string, frame: DecodedFramePlan, activeMetadata: TimedMetadataBatch[]): OffscreenMatrixRenderResult {
    const state = this.requireState();
    const slot = this.slots.get(canvasId);
    if (!slot) {
      throw new Error(`Offscreen matrix slot '${canvasId}' is not configured.`);
    }

    const videoFrame = frame.videoFrame as VideoFrameLike | undefined;
    if (!videoFrame || !isNativeVideoFrame(videoFrame)) {
      throw new Error("Offscreen matrix renderer requires a native VideoFrame.");
    }

    const dimensions = resolveVideoFrameDimensions(videoFrame, frame.width, frame.height);
    if (dimensions.width <= 0 || dimensions.height <= 0) {
      throw new Error("Offscreen matrix renderer received an empty VideoFrame.");
    }

    this.closeSlotCurrentFrame(slot);
    slot.currentFrame = {
      frame: videoFrame,
      sequenceNumber: frame.sequenceNumber,
      decodeBackend: frame.decodeBackend,
      activeMetadata,
      width: dimensions.width,
      height: dimensions.height,
      gpuUploadSource: "external-texture",
    };
    slot.redrawNeeded = true;
    this.flush(state);
    return this.createResult(state, slot);
  }

  private flush(state: MatrixState): void {
    const drawableSlots = [...this.slots.values()].filter((slot) => Boolean(slot.currentFrame));
    const dirtySlots = drawableSlots.filter((slot) => state.needsClear || slot.redrawNeeded);
    state.flushCount += 1;
    state.lastDirtySlotCount = dirtySlots.length;

    if (drawableSlots.length === 0) {
      state.needsClear = false;
      return;
    }

    const commandEncoder = state.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: state.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });

    for (const slot of drawableSlots) {
      this.drawSlot(state, pass, slot);
    }

    pass.end();
    state.presentCount += 1;
    state.device.queue.submit([commandEncoder.finish()]);
    state.needsClear = false;
  }

  private drawSlot(state: MatrixState, pass: GpuRenderPassEncoderLike, slot: Slot): void {
    const frame = slot.currentFrame;
    if (!frame) {
      return;
    }

    this.ensureSlotResources(state, slot);
    if (!slot.overlayBuffer || !slot.overlayUniform) {
      throw new Error("Offscreen matrix OSD resources are unavailable.");
    }

    writeOverlayUniform(frame.activeMetadata, slot.overlayUniform);
    state.device.queue.writeBuffer(slot.overlayBuffer, 0, slot.overlayUniform);
    const externalTexture = state.device.importExternalTexture?.({ source: frame.frame });
    if (!externalTexture) {
      throw new Error("Offscreen matrix external texture import failed.");
    }

    state.externalImportCount += 1;
    state.bindGroupCount += 1;
    const bindGroup = state.device.createBindGroup({
      layout: state.externalPipeline.getBindGroupLayout?.(0),
      entries: [
        {
          binding: 0,
          resource: externalTexture,
        },
        {
          binding: 1,
          resource: state.sampler,
        },
        {
          binding: 2,
          resource: {
            buffer: slot.overlayBuffer,
          },
        },
      ],
    });
    const x = Math.max(0, Math.floor(slot.layout.x));
    const y = Math.max(0, Math.floor(slot.layout.y));
    const width = Math.max(1, Math.floor(slot.layout.width));
    const height = Math.max(1, Math.floor(slot.layout.height));
    pass.setPipeline(state.externalPipeline);
    pass.setViewport?.(x, y, width, height, 0, 1);
    pass.setScissorRect?.(x, y, width, height);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    state.drawCount += 1;
    slot.redrawNeeded = false;
  }

  private ensureSlotResources(state: MatrixState, slot: Slot): void {
    if (!slot.overlayBuffer) {
      const bufferUsage = getGpuBufferUsage();
      slot.overlayBuffer = state.device.createBuffer({
        size: OverlayUniformByteLength,
        usage: bufferUsage.uniform | bufferUsage.copyDst,
      });
    }

    if (!slot.overlayUniform) {
      slot.overlayUniform = new Float32Array(new ArrayBuffer(OverlayUniformByteLength));
    }
  }

  private createResult(state: MatrixState, slot: Slot): OffscreenMatrixRenderResult {
    const frame = slot.currentFrame;
    return {
      renderedSequenceNumber: frame?.sequenceNumber ?? 0,
      overlayPrimitiveCount: countOverlayPrimitives(frame?.activeMetadata ?? []),
      renderBackend: "webgpu",
      matrixPresentMode: this.options.presentMode,
      matrixPresentPath: "direct",
      matrixFlushCount: state.flushCount,
      matrixPresentCount: state.presentCount,
      matrixDrawCount: state.drawCount,
      matrixExternalImportCount: state.externalImportCount,
      matrixBindGroupCount: state.bindGroupCount,
      matrixVideoFrameCopyCount: state.videoFrameCopyCount,
      matrixLastDirtySlotCount: state.lastDirtySlotCount,
      gpuPresentation: GpuPresentation,
      gpuUploadSource: frame?.gpuUploadSource ?? "external-texture",
      gpuAdapterVendor: state.adapterInfo?.vendor,
      gpuAdapterArchitecture: state.adapterInfo?.architecture,
    };
  }

  private closeSlot(slot: Slot): void {
    this.closeSlotCurrentFrame(slot);
    slot.overlayBuffer?.destroy?.();
  }

  private closeSlotCurrentFrame(slot: Slot): void {
    slot.currentFrame?.frame.close?.();
    slot.currentFrame = undefined;
    slot.bindGroup = undefined;
  }

  private requireState(): MatrixState {
    if (!this.state) {
      throw new Error("Offscreen matrix renderer is not initialized.");
    }

    return this.state;
  }
}

let renderer: OffscreenMatrixRenderer | undefined;

(globalThis as unknown as Worker).onmessage = (event: MessageEvent<OffscreenMatrixWorkerRequest>) => {
  void handleMessage(event.data);
};

async function handleMessage(message: OffscreenMatrixWorkerRequest): Promise<void> {
  try {
    if (message.type === "init") {
      renderer = new OffscreenMatrixRenderer();
      await renderer.initialize(message);
      return;
    }

    if (message.type === "layout") {
      renderer?.updateLayout(message.canvasWidth, message.canvasHeight, message.slots);
      return;
    }

    if (message.type === "render") {
      const result = renderer?.render(message.canvasId, message.frame, message.activeMetadata);
      if (!result) {
        throw new Error("Offscreen matrix worker has not been initialized.");
      }
      post({
        type: "rendered",
        requestId: message.requestId,
        canvasId: message.canvasId,
        result,
      });
      return;
    }

    if (message.type === "unregister") {
      renderer?.unregister(message.canvasId);
      return;
    }

    if (message.type === "stop") {
      renderer = undefined;
    }
  } catch (error) {
    post({
      type: "error",
      requestId: "requestId" in message ? message.requestId : undefined,
      canvasId: "canvasId" in message ? message.canvasId : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeOverlayUniform(activeMetadata: readonly TimedMetadataBatch[], target: Float32Array<ArrayBuffer>): void {
  target.fill(0);
  let record: TimedMetadataRecord | undefined;
  for (const batch of activeMetadata) {
    record = batch.records[0];
    if (record) {
      break;
    }
  }

  if (!record) {
    target[0] = -1;
    target[1] = -1;
    target[2] = 0;
    target[3] = 0;
    target[4] = 0;
    return;
  }

  target[0] = parseNormalizedCoordinate(record.tags.x, 0.08);
  target[1] = parseNormalizedCoordinate(record.tags.y, 0.12);
  target[2] = parseNormalizedCoordinate(record.tags.w, 0.18);
  target[3] = parseNormalizedCoordinate(record.tags.h, 0.14);
  const text = formatOverlayText(record);
  target[4] = 1;
  target[5] = text.length;
  for (let index = 0; index < text.length && index < OverlayTextMaxChars; index += 1) {
    target[8 + index] = text.charCodeAt(index);
  }
}

function formatOverlayText(record: TimedMetadataRecord): string {
  const resolution = record.tags.resolution ?? record.tags.sourceResolution ?? "";
  const timestamp = record.tags.ptsMs
    ?? record.tags.presentationTimestampMs
    ?? (record.startTimestampUs > 0 ? String(Math.floor(record.startTimestampUs / 1000)) : "");
  const normalizedResolution = resolution.replace(/[^\dXx]/g, "").toUpperCase();
  const normalizedTimestamp = timestamp.replace(/[^\d-]/g, "");
  return `OSD ${normalizedResolution || "0000X0000"} T${normalizedTimestamp || "0"}`
    .toUpperCase()
    .replace(/[^0-9A-Z -]/g, " ")
    .slice(0, OverlayTextMaxChars);
}

function parseNormalizedCoordinate(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return parsed > 1 ? Math.max(0, Math.min(1, parsed / 100)) : Math.max(0, Math.min(1, parsed));
}

function countOverlayPrimitives(activeMetadata: readonly TimedMetadataBatch[]): number {
  return activeMetadata.reduce((total, batch) => total + batch.records.length, 0);
}

function resolveVideoFrameDimensions(
  frame: VideoFrameLike,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  return {
    width: firstPositiveNumber(frame.displayWidth, frame.codedWidth, fallbackWidth) ?? 0,
    height: firstPositiveNumber(frame.displayHeight, frame.codedHeight, fallbackHeight) ?? 0,
  };
}

function firstPositiveNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function isNativeVideoFrame(candidate: unknown): boolean {
  const videoFrameConstructor = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  return typeof videoFrameConstructor === "function" && candidate instanceof videoFrameConstructor;
}

function getGpuBufferUsage(): { uniform: number; copyDst: number } {
  const usage = (globalThis as {
    GPUBufferUsage?: {
      UNIFORM?: number;
      COPY_DST?: number;
    };
  }).GPUBufferUsage;
  return {
    uniform: usage?.UNIFORM ?? 0x0040,
    copyDst: usage?.COPY_DST ?? 0x0008,
  };
}

function getGpuTextureUsage(): { textureBinding: number; copyDst: number; copySrc: number; renderAttachment: number } {
  const usage = (globalThis as {
    GPUTextureUsage?: {
      TEXTURE_BINDING?: number;
      COPY_DST?: number;
      COPY_SRC?: number;
      RENDER_ATTACHMENT?: number;
    };
  }).GPUTextureUsage;
  return {
    textureBinding: usage?.TEXTURE_BINDING ?? 0x0004,
    copyDst: usage?.COPY_DST ?? 0x0002,
    copySrc: usage?.COPY_SRC ?? 0x0001,
    renderAttachment: usage?.RENDER_ATTACHMENT ?? 0x0010,
  };
}

function post(response: OffscreenMatrixWorkerResponse): void {
  (globalThis as unknown as Worker).postMessage(response);
}
