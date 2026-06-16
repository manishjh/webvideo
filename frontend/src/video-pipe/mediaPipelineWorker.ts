import {
  EncodedChunkAssembler,
  VideoDecodeCoordinator,
  WebTransportIngestClient,
} from "../contracts/services";
import {
  resolveLiveHardDecodeBacklogFrames,
  resolveLiveStaleFrameDropThresholdMs,
} from "./liveLatencyPolicy";
import type {
  DecodedFramePlan,
  MetadataTransportMessage,
  SelectedVideoSourceDescriptor,
  TimedMetadataBatch,
  TimedMetadataRecord,
  TransportEndpointDescriptor,
  TransportConnectionHandle,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../contracts/models";

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
  }
  | { type: "set-metadata-enabled"; enabled: boolean }
  | { type: "stop" };

type FrameMetadata = {
  sequenceNumber: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
};

type DecodedFrameEnvelope = {
  frame: DecodedFramePlan;
  metadata?: FrameMetadata;
  receivedAtUnixTimeMs?: number;
};

type WorkerResponse =
  | {
    type: "connected";
    activeTransport: "webtransport-quic" | "http-seeded-fallback";
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
    frames: DecodedFrameEnvelope[];
    bytesReceived: number;
    messagesReceived: number;
    decodeMs: number;
    backlogFrameCount: number;
  }
  | {
    type: "rendered";
    metadata?: FrameMetadata;
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
  }
  | {
    type: "error";
    message: string;
  };

let abortController: AbortController | undefined;
let metadataEnabled = true;

type WorkerVideoFrameLike = {
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
  createCommandEncoder: () => GpuCommandEncoderLike;
  importExternalTexture?: (descriptor: Record<string, unknown>) => unknown;
  queue: {
    writeBuffer: (buffer: unknown, offset: number, data: BufferSource) => void;
    submit: (commands: unknown[]) => void;
  };
};

type GpuPipelineLike = {
  getBindGroupLayout?: (index: number) => unknown;
};

type GpuCommandEncoderLike = {
  beginRenderPass: (descriptor: Record<string, unknown>) => GpuRenderPassEncoderLike;
  finish: () => unknown;
};

type GpuRenderPassEncoderLike = {
  setPipeline: (pipeline: unknown) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};

type GpuCanvasContextLike = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => {
    createView: () => unknown;
  };
};

type GpuBufferLike = {
  destroy?: () => void;
};

type OffscreenRenderResult = {
  renderMs: number;
  importExternalTextureMs: number;
  bindGroupMs: number;
  uniformMs: number;
  encodeMs: number;
  submitMs: number;
  renderBackend: "webgpu" | "canvas2d-fallback";
  gpuPresentation?: string;
  gpuUploadSource?: string;
  gpuAdapterVendor?: string;
  gpuAdapterArchitecture?: string;
};

const OverlayTextMaxChars = 32;
const OverlayUniformFloatCount = 8 + OverlayTextMaxChars;
const OverlayUniformByteLength = OverlayUniformFloatCount * Float32Array.BYTES_PER_ELEMENT;

const offscreenExternalVideoShader = `
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
  if (index < 4u) {
    return u32(overlay.chars0[index] + 0.5);
  }
  if (index < 8u) {
    return u32(overlay.chars1[index - 4u] + 0.5);
  }
  if (index < 12u) {
    return u32(overlay.chars2[index - 8u] + 0.5);
  }
  if (index < 16u) {
    return u32(overlay.chars3[index - 12u] + 0.5);
  }
  if (index < 20u) {
    return u32(overlay.chars4[index - 16u] + 0.5);
  }
  if (index < 24u) {
    return u32(overlay.chars5[index - 20u] + 0.5);
  }
  if (index < 28u) {
    return u32(overlay.chars6[index - 24u] + 0.5);
  }
  if (index < 32u) {
    return u32(overlay.chars7[index - 28u] + 0.5);
  }
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
  let inside = uv.x >= rect.x && uv.x <= right && uv.y >= rect.y && uv.y <= bottom;
  let borderWidth = 0.006;
  let border = inside && (
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

class OffscreenWebGpuVideoRenderer {
  private constructor(
    private readonly canvas: OffscreenCanvas,
    private readonly context: GpuCanvasContextLike,
    private readonly device: GpuDeviceLike,
    private readonly pipeline: GpuPipelineLike,
    private readonly sampler: unknown,
    private readonly overlayBuffer: GpuBufferLike,
    private readonly overlayUniform: Float32Array<ArrayBuffer>,
    private readonly format: string,
    private readonly adapterInfo: GpuAdapterLike["info"],
  ) {}

  public static async create(target: NonNullable<Extract<WorkerRequest, { type: "start" }>["offscreenRenderTarget"]>): Promise<OffscreenWebGpuVideoRenderer> {
    const gpu = (globalThis.navigator as { gpu?: GpuLike } | undefined)?.gpu;
    if (!gpu) {
      throw new Error("worker-offscreen-webgpu-unavailable");
    }

    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      throw new Error("worker-offscreen-webgpu-no-adapter");
    }

    const adapterInfo = adapter.info;
    const vendor = adapterInfo?.vendor?.toLowerCase() ?? "";
    const architecture = adapterInfo?.architecture?.toLowerCase() ?? "";
    const description = adapterInfo?.description?.toLowerCase() ?? "";
    if (vendor === "google" || architecture === "swiftshader" || description.includes("swiftshader")) {
      throw new Error("worker-offscreen-webgpu-software-adapter");
    }

    const device = await adapter.requestDevice();
    if (typeof device.importExternalTexture !== "function") {
      throw new Error("worker-offscreen-webgpu-external-texture-unavailable");
    }

    target.canvas.width = Math.max(1, Math.floor(target.canvasWidth));
    target.canvas.height = Math.max(1, Math.floor(target.canvasHeight));
    const context = target.canvas.getContext("webgpu") as GpuCanvasContextLike | null;
    if (!context) {
      throw new Error("worker-offscreen-webgpu-context-unavailable");
    }

    const format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
    context.configure({
      device,
      format,
      alphaMode: "opaque",
    });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: device.createShaderModule({ code: offscreenExternalVideoShader }),
        entryPoint: "vertexMain",
      },
      fragment: {
        module: device.createShaderModule({ code: offscreenExternalVideoShader }),
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
    const overlayBuffer = device.createBuffer({
      size: OverlayUniformByteLength,
      usage: getGpuBufferUsage().uniform | getGpuBufferUsage().copyDst,
    });
    return new OffscreenWebGpuVideoRenderer(
      target.canvas,
      context,
      device,
      pipeline,
      sampler,
      overlayBuffer,
      new Float32Array(new ArrayBuffer(OverlayUniformByteLength)),
      format,
      adapterInfo,
    );
  }

  public render(frame: DecodedFramePlan, activeMetadata: readonly TimedMetadataBatch[]): OffscreenRenderResult {
    const videoFrame = frame.videoFrame as WorkerVideoFrameLike | undefined;
    if (!videoFrame || !isNativeVideoFrame(videoFrame)) {
      throw new Error("worker-offscreen-render-requires-videoframe");
    }

    const renderStart = performance.now();
    const externalTexture = this.device.importExternalTexture?.({ source: videoFrame });
    if (!externalTexture) {
      throw new Error("worker-offscreen-import-external-texture-failed");
    }
    const importEnd = performance.now();

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout?.(0),
      entries: [
        {
          binding: 0,
          resource: externalTexture,
        },
        {
          binding: 1,
          resource: this.sampler,
        },
        {
          binding: 2,
          resource: {
            buffer: this.overlayBuffer,
          },
        },
      ],
    });
    const bindEnd = performance.now();
    writeOverlayUniform(activeMetadata, this.overlayUniform);
    this.device.queue.writeBuffer(this.overlayBuffer, 0, this.overlayUniform);
    const uniformEnd = performance.now();
    const commandEncoder = this.device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.03, b: 0.04, a: 1 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    const commandBuffer = commandEncoder.finish();
    const encodeEnd = performance.now();
    this.device.queue.submit([commandBuffer]);
    const submitEnd = performance.now();
    videoFrame.close?.();
    return {
      renderMs: submitEnd - renderStart,
      importExternalTextureMs: importEnd - renderStart,
      bindGroupMs: bindEnd - importEnd,
      uniformMs: uniformEnd - bindEnd,
      encodeMs: encodeEnd - uniformEnd,
      submitMs: submitEnd - encodeEnd,
      renderBackend: "webgpu",
      gpuPresentation: "worker-offscreen-webgpu-canvas",
      gpuUploadSource: "external-texture",
      gpuAdapterVendor: this.adapterInfo?.vendor,
      gpuAdapterArchitecture: this.adapterInfo?.architecture,
    };
  }

  public dispose(): void {
    this.overlayBuffer.destroy?.();
    this.canvas.width = this.canvas.width;
  }
}

class WorkerOverlayTimeline {
  private readonly batchesByStream = new Map<string, TimedMetadataBatch[]>();
  private readonly retentionUs = 5_000_000;
  private readonly maxBatchesPerStream = 256;

  public ingest(message: MetadataTransportMessage): void {
    const batch: TimedMetadataBatch = {
      streamId: message.streamId,
      batchStartTimestampUs: message.batchStartTimestampUs,
      batchEndTimestampUs: message.batchEndTimestampUs,
      records: message.records,
    };
    const batches = this.batchesByStream.get(batch.streamId) ?? [];
    batches.push(batch);
    const oldestAllowedTimestampUs = batch.batchEndTimestampUs - this.retentionUs;
    while (
      batches.length > 0
      && (
        (batches[0]?.batchEndTimestampUs ?? 0) < oldestAllowedTimestampUs
        || batches.length > this.maxBatchesPerStream
      )
    ) {
      batches.shift();
    }
    this.batchesByStream.set(batch.streamId, batches);
  }

  public query(streamId: string, presentationTimestampUs: number): TimedMetadataBatch[] {
    return (this.batchesByStream.get(streamId) ?? []).filter((batch) => {
      return batch.batchStartTimestampUs <= presentationTimestampUs && batch.batchEndTimestampUs > presentationTimestampUs;
    });
  }

  public clear(streamId?: string): void {
    if (streamId) {
      this.batchesByStream.delete(streamId);
      return;
    }

    this.batchesByStream.clear();
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

  if (parsed > 1) {
    return Math.max(0, Math.min(1, parsed / 100));
  }

  return Math.max(0, Math.min(1, parsed));
}

function countOverlayPrimitives(activeMetadata: readonly TimedMetadataBatch[]): number {
  return activeMetadata.reduce((total, batch) => total + batch.records.length, 0);
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

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  (globalThis as unknown as Worker).postMessage(response, transfer);
}

function collectTransferables(frames: readonly DecodedFrameEnvelope[]): Transferable[] {
  const transferables: Transferable[] = [];
  for (const envelope of frames) {
    const frame = envelope.frame.videoFrame;
    if (frame && typeof frame === "object") {
      transferables.push(frame as Transferable);
    }
  }

  return transferables;
}

async function runPipeline(request: Extract<WorkerRequest, { type: "start" }>, abortSignal: AbortSignal): Promise<void> {
  const transport = new WebTransportIngestClient();
  const transportStart = performance.now();
  let connection: TransportConnectionHandle | undefined;
  const offscreenRenderer = request.offscreenRenderTarget
    ? await OffscreenWebGpuVideoRenderer.create(request.offscreenRenderTarget)
    : undefined;

  let activeCodec = request.initialCodec;
  let activeSourceFrameRate = activeCodec.frameRate;
  let assembler = new EncodedChunkAssembler();
  let decoder: VideoDecodeCoordinator;
  let waitingForKeyFrame = true;
  let lastDecodedSequenceNumber: number | undefined;
  let lastReceivedVideoSequenceNumber: number | undefined;
  const pendingMetadataBySequence = new Map<number, FrameMetadata>();
  const pendingReceiveTimesBySequence = new Map<number, number>();
  const overlayTimeline = new WorkerOverlayTimeline();
  let drainScheduled = false;
  let drainGeneration = 0;
  let pendingDecodeMs = 0;

  const createDecoder = (): VideoDecodeCoordinator => new VideoDecodeCoordinator(() => {
    scheduleDrain();
  });
  decoder = createDecoder();

  const clearScheduledDrain = (): void => {
    drainGeneration += 1;
    drainScheduled = false;
    pendingDecodeMs = 0;
  };

  const resetDecodeState = async (): Promise<void> => {
    clearScheduledDrain();
    decoder.dispose();
    assembler = new EncodedChunkAssembler();
    decoder = createDecoder();
    await decoder.configureDecoder(activeCodec);
    waitingForKeyFrame = true;
    pendingMetadataBySequence.clear();
    pendingReceiveTimesBySequence.clear();
  };

  const drainDecoded = (decodeMs: number): number => {
    if (!connection) {
      return 0;
    }

    const frames = decoder.drainDecodedFrames();
    if (frames.length === 0) {
      return 0;
    }

    if (offscreenRenderer) {
      const frame = frames[frames.length - 1];
      const droppedFrames = frames.slice(0, -1);
      for (const droppedFrame of droppedFrames) {
        closeFrame(droppedFrame);
        pendingMetadataBySequence.delete(droppedFrame.sequenceNumber);
        pendingReceiveTimesBySequence.delete(droppedFrame.sequenceNumber);
      }

      const metadata = pendingMetadataBySequence.get(frame.sequenceNumber);
      const receivedAtUnixTimeMs = pendingReceiveTimesBySequence.get(frame.sequenceNumber);
      pendingMetadataBySequence.delete(frame.sequenceNumber);
      pendingReceiveTimesBySequence.delete(frame.sequenceNumber);
      const activeMetadata = metadataEnabled ? overlayTimeline.query(frame.streamId, frame.presentationTimestampUs) : [];
      const renderResult = offscreenRenderer.render(frame, activeMetadata);
      post({
        type: "rendered",
        metadata,
        receivedAtUnixTimeMs,
        bytesReceived: connection.webTransportBytesReceived,
        messagesReceived: connection.webTransportMessagesReceived,
        decodeMs,
        renderMs: renderResult.renderMs,
        renderStageMs: {
          importExternalTexture: renderResult.importExternalTextureMs,
          bindGroup: renderResult.bindGroupMs,
          uniform: renderResult.uniformMs,
          encode: renderResult.encodeMs,
          submit: renderResult.submitMs,
        },
        backlogFrameCount: decoder.liveBacklogFrameCount(),
        droppedBeforeRender: droppedFrames.length,
        decodeBackend: frame.decodeBackend,
        renderBackend: renderResult.renderBackend,
        renderedSequenceNumber: frame.sequenceNumber,
        overlayPrimitiveCount: countOverlayPrimitives(activeMetadata),
        width: frame.width,
        height: frame.height,
        gpuPresentation: renderResult.gpuPresentation,
        gpuUploadSource: renderResult.gpuUploadSource,
        gpuAdapterVendor: renderResult.gpuAdapterVendor,
        gpuAdapterArchitecture: renderResult.gpuAdapterArchitecture,
      });
      return frames.length;
    }

    const envelopes = frames.map((frame) => {
      const metadata = pendingMetadataBySequence.get(frame.sequenceNumber);
      const receivedAtUnixTimeMs = pendingReceiveTimesBySequence.get(frame.sequenceNumber);
      pendingMetadataBySequence.delete(frame.sequenceNumber);
      pendingReceiveTimesBySequence.delete(frame.sequenceNumber);
      return {
        frame,
        metadata,
        receivedAtUnixTimeMs,
      } satisfies DecodedFrameEnvelope;
    });
    post({
      type: "decoded",
      frames: envelopes,
      bytesReceived: connection.webTransportBytesReceived,
      messagesReceived: connection.webTransportMessagesReceived,
      decodeMs,
      backlogFrameCount: decoder.liveBacklogFrameCount(),
    }, collectTransferables(envelopes));
    return frames.length;
  };

  function scheduleDrain(decodeMs = 0): void {
    pendingDecodeMs = Math.max(pendingDecodeMs, decodeMs);
    if (drainScheduled) {
      return;
    }

    drainScheduled = true;
    const generation = drainGeneration;
    scheduleMicrotask(() => {
      if (generation !== drainGeneration) {
        return;
      }

      drainScheduled = false;
      try {
        const decodedFrameCount = drainDecoded(pendingDecodeMs);
        if (decodedFrameCount > 0) {
          pendingDecodeMs = 0;
        }
      } catch (error) {
        pendingDecodeMs = 0;
        if (offscreenRenderer) {
          post({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          abortController?.abort();
          return;
        }
        void resetDecodeState().then(() => {
          post({
            type: "drop",
            count: 1,
            reason: "decode-error-reset",
          });
        }).catch((error: unknown) => {
          post({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    });
  }

  try {
    metadataEnabled = request.metadataEnabled !== false;
    connection = await transport.connectStreaming(request.endpoint, abortSignal);
    post({
      type: "connected",
      activeTransport: connection.activeTransport,
      webTransportReady: connection.webTransportReady,
      transportMs: performance.now() - transportStart,
    });

    await decoder.configureDecoder(activeCodec);

    for await (const frame of transport.readStreamingFrames(connection, abortSignal)) {
      abortSignal.throwIfAborted();
      connection.webTransportBytesReceived = frame.bytesReceived;
      connection.webTransportMessagesReceived = frame.messagesReceived;

      if (frame.kind === "end") {
        post({
          type: "end",
          bytesReceived: frame.bytesReceived,
          messagesReceived: frame.messagesReceived,
        });
        return;
      }

      if (frame.kind === "source") {
        activeCodec = {
          ...activeCodec,
          codec: frame.source.codec.codec,
          codedWidth: frame.source.codec.codedWidth,
          codedHeight: frame.source.codec.codedHeight,
          description: frame.source.codec.description,
          profile: frame.source.codec.profile,
          frameRate: frame.source.codec.frameRate,
        };
        activeSourceFrameRate = frame.source.codec.frameRate;
        overlayTimeline.clear(frame.source.streamId);
        await resetDecodeState();
        post({ type: "source", source: frame.source });
        continue;
      }

      if (frame.kind === "metadata") {
        overlayTimeline.ingest(frame.message);
        post({ type: "metadata", message: frame.message });
        continue;
      }

      const message = frame.message;
      const frameAgeMs = Date.now() - (message.sourceTimestampUnixTimeMs ?? message.serverTimestampUnixTimeMs ?? Date.now());
      if (!message.keyFrame && frameAgeMs > resolveLiveStaleFrameDropThresholdMs(request.targetLatencyMs)) {
        waitingForKeyFrame = true;
        post({
          type: "drop",
          count: 1,
          reason: "stale-before-decode",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
        continue;
      }

      if (lastReceivedVideoSequenceNumber !== undefined && message.sequenceNumber > lastReceivedVideoSequenceNumber + 1) {
        post({
          type: "sequence-gap",
          gapFrameCount: message.sequenceNumber - lastReceivedVideoSequenceNumber - 1,
        });
      }
      lastReceivedVideoSequenceNumber = message.sequenceNumber;

      const hasSequenceGap = lastDecodedSequenceNumber !== undefined
        && message.sequenceNumber !== lastDecodedSequenceNumber + 1;
      if ((waitingForKeyFrame || hasSequenceGap) && !message.keyFrame) {
        waitingForKeyFrame = true;
        post({
          type: "drop",
          count: 1,
          reason: "waiting-for-keyframe",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
        continue;
      }

      if ((waitingForKeyFrame || hasSequenceGap) && message.keyFrame) {
        await resetDecodeState();
        waitingForKeyFrame = false;
      }

      const decodeStart = performance.now();
      try {
        if (decoder.liveBacklogFrameCount() > resolveLiveHardDecodeBacklogFrames({
          frameRate: activeSourceFrameRate,
          maxFrames: 12,
          targetLatencyMs: request.targetLatencyMs,
        })) {
          await resetDecodeState();
          post({
            type: "drop",
            count: 1,
            reason: "decode-backlog-reset",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
          if (!message.keyFrame) {
            continue;
          }

          waitingForKeyFrame = false;
        }

        pendingMetadataBySequence.set(message.sequenceNumber, toFrameMetadata(message));
        pendingReceiveTimesBySequence.set(message.sequenceNumber, frame.receivedAtUnixTimeMs);
        const chunks = await assembler.applyTransportMessage(message);
        for (const chunk of chunks) {
          await decoder.enqueueChunk(chunk);
        }
        scheduleDrain(performance.now() - decodeStart);
        lastDecodedSequenceNumber = message.sequenceNumber;
      } catch (error) {
        await resetDecodeState();
        if (offscreenRenderer) {
          post({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        post({
          type: "drop",
          count: 1,
          reason: "decode-error-reset",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
      }
    }
  } finally {
    clearScheduledDrain();
    decoder.dispose();
    offscreenRenderer?.dispose();
    if (connection) {
      await transport.closeConnection(connection);
    }
  }
}

function isNativeVideoFrame(candidate: unknown): boolean {
  const videoFrameConstructor = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  return typeof videoFrameConstructor === "function" && candidate instanceof videoFrameConstructor;
}

function closeFrame(frame: DecodedFramePlan): void {
  (frame.videoFrame as WorkerVideoFrameLike | undefined)?.close?.();
}

function toFrameMetadata(message: VideoTransportMessage): FrameMetadata {
  return {
    sequenceNumber: message.sequenceNumber,
    sourceTimestampUnixTimeMs: message.sourceTimestampUnixTimeMs,
    serverTimestampUnixTimeMs: message.serverTimestampUnixTimeMs,
    moqTrackAlias: message.moqTrackAlias,
    moqGroupId: message.moqGroupId,
    moqObjectId: message.moqObjectId,
    moqSubgroupId: message.moqSubgroupId,
    moqPublisherPriority: message.moqPublisherPriority,
  };
}

function scheduleMicrotask(task: () => void): void {
  if (typeof globalThis.queueMicrotask === "function") {
    globalThis.queueMicrotask(task);
    return;
  }

  void Promise.resolve().then(task);
}

(globalThis as unknown as Worker).onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "stop") {
    abortController?.abort();
    return;
  }

  if (event.data.type === "set-metadata-enabled") {
    metadataEnabled = event.data.enabled;
    return;
  }

  abortController?.abort();
  abortController = new AbortController();
  void runPipeline(event.data, abortController.signal).catch((error: unknown) => {
    if (!abortController?.signal.aborted) {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
