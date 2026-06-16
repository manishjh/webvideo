import type {
  DecodedFramePlan,
  DroppedFrameRecord,
  EncodedChunkEmission,
  MetadataTransportMessage,
  PlayerSessionHandle,
  PlayerSessionRequest,
  PlaybackClockSnapshot,
  PresentationDecision,
  RenderFrameRequest,
  RenderFrameResult,
  SelectedVideoSourceDescriptor,
  StageTimingEvent,
  StreamDiscontinuity,
  SurfaceConfigurationPlan,
  TelemetrySnapshot,
  TimedMetadataBatch,
  TimedMetadataRecord,
  TransportConnectionHandle,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
  VideoTransportMessage,
  BrowserTransportMode,
  DecodeBackend,
  RenderBackend,
} from "./models";

interface TransportSeedState {
  videoMessagesByStream?: Record<string, VideoTransportMessage[]>;
  metadataMessagesByStream?: Record<string, MetadataTransportMessage[]>;
}

interface BootstrapDependencies {
  transportClient?: WebTransportIngestClient;
  decoder?: VideoDecodeCoordinator;
  renderer?: WebGpuRenderer;
}

interface InternalPlayerSessionState {
  handle: PlayerSessionHandle;
  request: PlayerSessionRequest;
  disposed: boolean;
}

interface InternalTransportState {
  handle: TransportConnectionHandle;
  endpoint: TransportEndpointDescriptor;
  remainingVideoMessages: VideoTransportMessage[];
  remainingMetadataMessages: MetadataTransportMessage[];
  transport?: WebTransportLike;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  pendingText?: string;
  pendingBinary?: Uint8Array;
  pendingBinaryOffset?: number;
  pendingBinaryLength?: number;
}

type WebTransportBidirectionalStreamLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type WebTransportLike = {
  ready?: Promise<void>;
  closed?: Promise<void>;
  createBidirectionalStream?: () => Promise<WebTransportBidirectionalStreamLike>;
  close?: () => void;
};

interface WebTransportCertificateHash {
  algorithm: "sha-256";
  value: BufferSource;
}

interface WebTransportOptionsLike {
  serverCertificateHashes?: WebTransportCertificateHash[];
}

type WebTransportConstructor = new (url: string, options?: WebTransportOptionsLike) => WebTransportLike;

type WebTransportWireVideoFrame = {
  kind: "video";
  message: Omit<VideoTransportMessage, "payload"> & { payload: number[] | string };
};

type WebTransportWireMetadataFrame = {
  kind: "metadata";
  message: MetadataTransportMessage;
};

type WebTransportWireSourceFrame = {
  kind: "source";
  message: SelectedVideoSourceDescriptor;
};

type WebTransportWireEndFrame = {
  kind: "end";
};

type WebTransportWireFrame =
  | WebTransportWireVideoFrame
  | WebTransportWireMetadataFrame
  | WebTransportWireSourceFrame
  | WebTransportWireEndFrame;

interface WebTransportReadResult {
  videoMessages: VideoTransportMessage[];
  metadataMessages: MetadataTransportMessage[];
  bytesReceived: number;
  messagesReceived: number;
}

export type StreamingTransportFrame =
  | {
    kind: "source";
    source: SelectedVideoSourceDescriptor;
    bytesReceived: number;
    messagesReceived: number;
    receivedAtUnixTimeMs: number;
  }
  | {
    kind: "video";
    message: VideoTransportMessage;
    bytesReceived: number;
    messagesReceived: number;
    receivedAtUnixTimeMs: number;
  }
  | {
    kind: "metadata";
    message: MetadataTransportMessage;
    bytesReceived: number;
    messagesReceived: number;
    receivedAtUnixTimeMs: number;
  }
  | {
    kind: "end";
    bytesReceived: number;
    messagesReceived: number;
    receivedAtUnixTimeMs: number;
  };

interface InternalRendererState {
  configuredSurface?: SurfaceConfigurationPlan;
  disposed: boolean;
  lastRenderedSequence?: number;
  gpu?: WebGpuRenderState;
}

type BrowserVideoFrameLike = {
  timestamp?: number;
  displayWidth?: number;
  displayHeight?: number;
  codedWidth?: number;
  codedHeight?: number;
  close?: () => void;
};

type BrowserEncodedVideoChunkLike = unknown;

type BrowserEncodedVideoChunkConstructor = new (init: {
  type: "key" | "delta";
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}) => BrowserEncodedVideoChunkLike;

type BrowserVideoDecoderLike = {
  configure: (configuration: Record<string, unknown>) => void;
  decode: (chunk: BrowserEncodedVideoChunkLike) => void;
  flush: () => Promise<void>;
  close?: () => void;
  readonly decodeQueueSize?: number;
};

type BrowserVideoDecoderConstructor = {
  new(init: {
    output: (frame: BrowserVideoFrameLike) => void;
    error: (error: unknown) => void;
  }): BrowserVideoDecoderLike;
  isConfigSupported?: (configuration: Record<string, unknown>) => Promise<{ supported: boolean }>;
};

type WebGpuRenderState = {
  canvas: HTMLCanvasElement;
  context?: WebGpuCanvasContextLike;
  runtime: WebGpuSharedRuntime;
  format: string;
  outputTexture: WebGpuTextureLike;
  uploadTexture?: {
    texture: WebGpuTextureLike;
    width: number;
    height: number;
  };
  overlayBuffer: unknown;
  overlayUniform: Float32Array<ArrayBuffer>;
  adapterInfo?: WebGpuAdapterInfoLike;
  lastSampleAtMs?: number;
  diagnosticSampleAttempted?: boolean;
  diagnosticSampleInFlight?: boolean;
  lastStep?: string;
};

type WebGpuSharedRuntime = {
  gpu: WebGpuNavigatorLike;
  adapterInfo?: WebGpuAdapterInfoLike;
  device: WebGpuDeviceLike;
  format: string;
  pipeline: unknown;
  externalTexturePipeline?: unknown;
  sampler: unknown;
};

type WebGpuSharedAdapterState = {
  gpu?: WebGpuNavigatorLike;
  adapter?: WebGpuAdapterLike;
  adapterInfo?: WebGpuAdapterInfoLike;
  disabledReason?: string;
};

type WebGpuCanvasPresentation = "webgpu-canvas" | "canvas2d-visible-copy";
type MatrixFlushMode = "microtask" | "timer" | "raf";
type MatrixVideoFrameUploadMode = "auto" | "external" | "copy";
type MatrixFrameUploadSource = "external-texture" | "videoframe-copy";
type MatrixPresentMode = "auto" | "immediate" | "raf";
type MatrixPresentPath = "immediate" | "coalesced";

type MatrixRuntimeOptions = {
  flushMode: MatrixFlushMode;
  presentMode: MatrixPresentMode;
  uploadMode: MatrixVideoFrameUploadMode;
};

const MoqVideoObjectFrameHeaderLength = 88;
const MoqVideoObjectFrameMagic = 0x4c514f4d;
const MoqVideoObjectFrameVersion = 1;
const MoqVideoObjectFrameKindVideo = 1;
const OverlayTextMaxChars = 32;
const OverlayUniformFloatCount = 8 + OverlayTextMaxChars;
const OverlayUniformByteLength = OverlayUniformFloatCount * Float32Array.BYTES_PER_ELEMENT;
const MaxMoqFramesPerParseTurn = 16;
const WebGpuInitTimeoutMs = 3_000;
const MatrixAutoPresentFallbackMs = 16;

type WebGpuNavigatorLike = {
  getPreferredCanvasFormat?: () => string;
  requestAdapter: () => Promise<WebGpuAdapterLike | null>;
};

type WebGpuAdapterLike = {
  info?: WebGpuAdapterInfoLike;
  requestDevice: () => Promise<WebGpuDeviceLike>;
};

type WebGpuAdapterInfoLike = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};

type WebGpuCanvasContextLike = {
  configure: (configuration: Record<string, unknown>) => void;
  getCurrentTexture: () => WebGpuTextureLike;
};

type WebGpuDeviceLike = {
  createShaderModule: (descriptor: Record<string, unknown>) => unknown;
  createRenderPipeline: (descriptor: Record<string, unknown>) => unknown;
  createSampler: (descriptor?: Record<string, unknown>) => unknown;
  createTexture: (descriptor: Record<string, unknown>) => WebGpuTextureLike;
  createBindGroup: (descriptor: Record<string, unknown>) => unknown;
  createBuffer: (descriptor: Record<string, unknown>) => WebGpuBufferLike;
  createCommandEncoder: () => WebGpuCommandEncoderLike;
  importExternalTexture?: (descriptor: Record<string, unknown>) => unknown;
  queue: {
    writeBuffer: (buffer: unknown, offset: number, data: BufferSource) => void;
    copyExternalImageToTexture: (
      source: Record<string, unknown>,
      destination: Record<string, unknown>,
      copySize: Record<string, number> | [number, number],
    ) => void;
    submit: (commands: unknown[]) => void;
    onSubmittedWorkDone?: () => Promise<void>;
  };
};

type WebGpuTextureLike = {
  createView: () => unknown;
  destroy?: () => void;
};

type WebGpuCommandEncoderLike = {
  beginRenderPass: (descriptor: Record<string, unknown>) => WebGpuRenderPassEncoderLike;
  copyTextureToTexture: (
    source: Record<string, unknown>,
    destination: Record<string, unknown>,
    copySize: Record<string, number>,
  ) => void;
  copyTextureToBuffer: (
    source: Record<string, unknown>,
    destination: Record<string, unknown>,
    copySize: Record<string, number>,
  ) => void;
  finish: () => unknown;
};

type WebGpuBufferLike = {
  mapAsync?: (mode: number) => Promise<void>;
  getMappedRange?: () => ArrayBuffer;
  unmap?: () => void;
  destroy?: () => void;
};

type WebGpuRenderPassEncoderLike = {
  setPipeline: (pipeline: unknown) => void;
  setBindGroup: (index: number, bindGroup: unknown) => void;
  setViewport?: (x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number) => void;
  setScissorRect?: (x: number, y: number, width: number, height: number) => void;
  draw: (vertexCount: number) => void;
  end: () => void;
};

type DecodeMetadata = {
  streamId: string;
  sequenceNumber: number;
  presentationTimestampUs: number;
};

type H264NalUnit = {
  nalType: number;
  data: Uint8Array;
};

function createId(prefix: string, sequence: number): string {
  return `${prefix}-${sequence.toString().padStart(4, "0")}`;
}

function countOverlayPrimitives(batches: TimedMetadataBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

function closeDecodedFrames(frames: DecodedFramePlan[]): void {
  for (const frame of frames) {
    (frame.videoFrame as BrowserVideoFrameLike | undefined)?.close?.();
  }
}

function computeFramePalette(sequenceNumber: number): { background: string; accent: string; overlay: string } {
  const hue = (sequenceNumber * 37) % 360;
  return {
    background: `hsl(${hue} 72% 48%)`,
    accent: `hsl(${(hue + 58) % 360} 84% 74%)`,
    overlay: `hsl(${(hue + 180) % 360} 80% 58%)`,
  };
}

function parseNormalizedCoordinate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, parsed));
}

function isCanvasLike(candidate: unknown): candidate is HTMLCanvasElement {
  return Boolean(
    candidate
    && typeof candidate === "object"
    && "getContext" in candidate
    && typeof (candidate as { getContext?: unknown }).getContext === "function",
  );
}

function getWebTransportConstructor(): WebTransportConstructor | undefined {
  const candidate = (globalThis as { WebTransport?: unknown }).WebTransport;
  return typeof candidate === "function" ? candidate as WebTransportConstructor : undefined;
}

function getVideoDecoderConstructor(): BrowserVideoDecoderConstructor | undefined {
  const candidate = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  return typeof candidate === "function" ? candidate as BrowserVideoDecoderConstructor : undefined;
}

function getEncodedVideoChunkConstructor(): BrowserEncodedVideoChunkConstructor | undefined {
  const candidate = (globalThis as { EncodedVideoChunk?: unknown }).EncodedVideoChunk;
  return typeof candidate === "function" ? candidate as BrowserEncodedVideoChunkConstructor : undefined;
}

function getWebGpuNavigator(): WebGpuNavigatorLike | undefined {
  const candidate = typeof navigator === "undefined"
    ? undefined
    : (navigator as { gpu?: unknown }).gpu;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const requestAdapter = (candidate as { requestAdapter?: unknown }).requestAdapter;
  return typeof requestAdapter === "function" ? candidate as WebGpuNavigatorLike : undefined;
}

function isNativeVideoFrame(candidate: unknown): boolean {
  const videoFrameConstructor = (globalThis as { VideoFrame?: unknown }).VideoFrame;
  return typeof videoFrameConstructor === "function"
    && candidate instanceof (videoFrameConstructor as new (...args: never[]) => object);
}

function firstPositiveNumber(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function resolveVideoFrameDimensions(
  frame: unknown,
  fallbackWidth: number,
  fallbackHeight: number,
): { width: number; height: number } {
  const typedFrame = frame as {
    codedWidth?: number;
    codedHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number;
    height?: number;
  };

  return {
    width: firstPositiveNumber(typedFrame.displayWidth, typedFrame.codedWidth, typedFrame.width, fallbackWidth) ?? 0,
    height: firstPositiveNumber(typedFrame.displayHeight, typedFrame.codedHeight, typedFrame.height, fallbackHeight) ?? 0,
  };
}

function isHardwareWebGpuAdapter(adapterInfo: WebGpuAdapterInfoLike | undefined): boolean {
  if (!adapterInfo) {
    return false;
  }

  const vendor = adapterInfo.vendor?.toLowerCase() ?? "";
  const architecture = adapterInfo.architecture?.toLowerCase() ?? "";
  const description = adapterInfo.description?.toLowerCase() ?? "";
  return vendor !== "google"
    && architecture !== "swiftshader"
    && !description.includes("swiftshader");
}

function getGpuBufferUsage(): { uniform: number; copyDst: number; copySrc: number; mapRead: number } {
  const usage = (globalThis as {
    GPUBufferUsage?: {
      UNIFORM?: number;
      COPY_DST?: number;
      COPY_SRC?: number;
      MAP_READ?: number;
    };
  }).GPUBufferUsage;
  return {
    uniform: usage?.UNIFORM ?? 0x0040,
    copyDst: usage?.COPY_DST ?? 0x0008,
    copySrc: usage?.COPY_SRC ?? 0x0004,
    mapRead: usage?.MAP_READ ?? 0x0001,
  };
}

function getGpuMapMode(): { read: number } {
  const mapMode = (globalThis as { GPUMapMode?: { READ?: number } }).GPUMapMode;
  return {
    read: mapMode?.READ ?? 0x0001,
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

function decodeTransportPayload(payload: number[] | string): Uint8Array {
  if (Array.isArray(payload)) {
    return new Uint8Array(payload);
  }

  const binary = globalThis.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function decodeBase64Bytes(payload: string): Uint8Array {
  const binary = globalThis.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function createWebTransportOptions(endpoint: TransportEndpointDescriptor): WebTransportOptionsLike | undefined {
  if (!endpoint.serverCertificateHash) {
    return undefined;
  }

  const hashBytes = decodeBase64Bytes(endpoint.serverCertificateHash);
  const hashBuffer = new ArrayBuffer(hashBytes.byteLength);
  new Uint8Array(hashBuffer).set(hashBytes);

  return {
    serverCertificateHashes: [
      {
        algorithm: "sha-256",
        value: hashBuffer,
      },
    ],
  };
}

function normalizeWireVideoMessage(message: WebTransportWireVideoFrame["message"]): VideoTransportMessage {
  return {
    ...message,
    payload: decodeTransportPayload(message.payload),
  };
}

function pendingBinaryLength(state: InternalTransportState): number {
  return state.pendingBinaryLength ?? state.pendingBinary?.byteLength ?? 0;
}

function appendBinaryChunk(state: InternalTransportState, chunk: Uint8Array): void {
  let pending = state.pendingBinary;
  let offset = state.pendingBinaryOffset ?? 0;
  let length = pendingBinaryLength(state);
  if (length === 0) {
    offset = 0;
  } else if (pending && offset > 0) {
    pending.copyWithin(0, offset, offset + length);
    offset = 0;
  }

  const requiredLength = length + chunk.byteLength;
  if (!pending || pending.byteLength < requiredLength) {
    let capacity = Math.max(pending?.byteLength ?? 0, 1024);
    while (capacity < requiredLength) {
      capacity *= 2;
    }

    const next = new Uint8Array(capacity);
    if (pending && length > 0) {
      next.set(pending.subarray(offset, offset + length), 0);
    }
    pending = next;
  }

  pending.set(chunk, length);
  state.pendingBinary = pending;
  state.pendingBinaryOffset = 0;
  state.pendingBinaryLength = requiredLength;
}

function isAsciiWhitespace(value: number): boolean {
  return value === 0x09 || value === 0x0a || value === 0x0d || value === 0x20;
}

function findNewline(bytes: Uint8Array, offset: number, length: number): number {
  for (let index = 0; index < length; index += 1) {
    if (bytes[offset + index] === 0x0a) {
      return index;
    }
  }

  return -1;
}

function isJsonControlStart(value: number): boolean {
  return value === 0x7b || isAsciiWhitespace(value);
}

function readMoqStreamingFrames(
  state: InternalTransportState,
  decoder: TextDecoder,
  maxFrames = Number.POSITIVE_INFINITY,
): StreamingTransportFrame[] {
  const pending = state.pendingBinary;
  const baseOffset = state.pendingBinaryOffset ?? 0;
  const length = pendingBinaryLength(state);
  const frames: StreamingTransportFrame[] = [];
  let offset = 0;
  if (!pending || length === 0) {
    return frames;
  }

  while (length - offset > 0 && frames.length < maxFrames) {
    const absoluteOffset = baseOffset + offset;
    const remainingLength = length - offset;
    if (isJsonControlStart(pending[absoluteOffset] ?? 0)) {
      const newlineIndex = findNewline(pending, absoluteOffset, remainingLength);
      if (newlineIndex < 0) {
        break;
      }

      const line = decoder.decode(pending.subarray(absoluteOffset, absoluteOffset + newlineIndex)).trim();
      offset += newlineIndex + 1;
      if (line.length === 0) {
        continue;
      }

      const receivedAtUnixTimeMs = Date.now();
      const frame = JSON.parse(line) as WebTransportWireFrame;
      if (frame.kind === "source") {
        state.handle.webTransportMessagesReceived += 1;
        frames.push({
          kind: "source",
          source: frame.message,
          bytesReceived: state.handle.webTransportBytesReceived,
          messagesReceived: state.handle.webTransportMessagesReceived,
          receivedAtUnixTimeMs,
        });
      } else if (frame.kind === "metadata") {
        state.handle.webTransportMessagesReceived += 1;
        frames.push({
          kind: "metadata",
          message: frame.message,
          bytesReceived: state.handle.webTransportBytesReceived,
          messagesReceived: state.handle.webTransportMessagesReceived,
          receivedAtUnixTimeMs,
        });
      } else if (frame.kind === "end") {
        state.handle.webTransportMessagesReceived += 1;
        frames.push({
          kind: "end",
          bytesReceived: state.handle.webTransportBytesReceived,
          messagesReceived: state.handle.webTransportMessagesReceived,
          receivedAtUnixTimeMs,
        });
      } else if (frame.kind === "video") {
        state.handle.webTransportMessagesReceived += 1;
        frames.push({
          kind: "video",
          message: normalizeWireVideoMessage(frame.message),
          bytesReceived: state.handle.webTransportBytesReceived,
          messagesReceived: state.handle.webTransportMessagesReceived,
          receivedAtUnixTimeMs,
        });
      }

      continue;
    }

    if (remainingLength < MoqVideoObjectFrameHeaderLength) {
      break;
    }

    const view = new DataView(pending.buffer, pending.byteOffset + absoluteOffset, remainingLength);
    if (view.getUint32(0, true) !== MoqVideoObjectFrameMagic) {
      throw new Error("Continuous WebTransport MoQ object magic is invalid.");
    }

    const version = view.getUint8(4);
    const kind = view.getUint8(5);
    if (version !== MoqVideoObjectFrameVersion || kind !== MoqVideoObjectFrameKindVideo) {
      throw new Error(`Unsupported continuous WebTransport MoQ object version ${version} kind ${kind}.`);
    }

    const flags = view.getUint8(6);
    const moqPublisherPriority = view.getUint8(7);
    const moqTrackAlias = Number(view.getBigInt64(8, true));
    const moqGroupId = Number(view.getBigInt64(16, true));
    const moqObjectId = Number(view.getBigInt64(24, true));
    const moqSubgroupId = Number(view.getBigInt64(32, true));
    const sequenceNumber = Number(view.getBigInt64(40, true));
    const presentationTimestampUs = Number(view.getBigInt64(48, true));
    const decodeTimestampUs = Number(view.getBigInt64(56, true));
    const sourceTimestampUnixTimeMs = Number(view.getBigInt64(64, true));
    const serverTimestampUnixTimeMs = Number(view.getBigInt64(72, true));
    const payloadLength = view.getUint32(80, true);
    const streamIdLength = view.getUint16(84, true);
    const codecConfigVersionLength = view.getUint16(86, true);
    const frameLength = MoqVideoObjectFrameHeaderLength + streamIdLength + codecConfigVersionLength + payloadLength;
    if (length - offset < frameLength) {
      break;
    }

    let cursor = absoluteOffset + MoqVideoObjectFrameHeaderLength;
    const streamId = decoder.decode(pending.subarray(cursor, cursor + streamIdLength));
    cursor += streamIdLength;
    const codecConfigVersion = decoder.decode(pending.subarray(cursor, cursor + codecConfigVersionLength));
    cursor += codecConfigVersionLength;
    const payload = pending.subarray(cursor, cursor + payloadLength);
    cursor += payloadLength;

    state.handle.webTransportMessagesReceived += 1;
    frames.push({
      kind: "video",
      message: {
        streamId,
        sequenceNumber,
        presentationTimestampUs,
        decodeTimestampUs,
        sourceTimestampUnixTimeMs,
        serverTimestampUnixTimeMs,
        moqTrackAlias,
        moqGroupId,
        moqObjectId,
        moqSubgroupId,
        moqPublisherPriority,
        keyFrame: (flags & 1) === 1,
        codecConfigVersion,
        payload,
      },
      bytesReceived: state.handle.webTransportBytesReceived,
      messagesReceived: state.handle.webTransportMessagesReceived,
      receivedAtUnixTimeMs: Date.now(),
    });

    offset += frameLength;
  }

  const remainingLength = length - offset;
  state.pendingBinaryOffset = remainingLength === 0 ? 0 : baseOffset + offset;
  state.pendingBinaryLength = remainingLength;
  return frames;
}

async function yieldToMainThread(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === "function") {
    await scheduler.yield();
    return;
  }

  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

async function writeWebTransportOpenRequest(
  stream: WebTransportBidirectionalStreamLike,
  endpoint: TransportEndpointDescriptor,
): Promise<void> {
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const request = {
    channelId: endpoint.channelId,
    streamId: endpoint.streamId,
    authToken: endpoint.authToken,
    targetLatencyMs: endpoint.targetLatencyMs,
    desiredEgressFrameRate: endpoint.desiredEgressFrameRate,
    desiredMaxCodedWidth: endpoint.desiredMaxCodedWidth,
    desiredMaxCodedHeight: endpoint.desiredMaxCodedHeight,
    chaosDisconnectAfterFrames: endpoint.chaosDisconnectAfterFrames,
    chaosFrameDelayMs: endpoint.chaosFrameDelayMs,
    chaosDropEveryNFrames: endpoint.chaosDropEveryNFrames,
    enableMetadata: endpoint.metadataChannelRequired,
    frameCount: endpoint.frameCount,
    streamMode: endpoint.streamMode,
  };

  try {
    await writer.write(encoder.encode(`${JSON.stringify(request)}\n`));
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

async function readWebTransportFrames(stream: WebTransportBidirectionalStreamLike): Promise<WebTransportReadResult> {
  const reader = stream.readable.getReader();
  const decoder = new TextDecoder();
  const videoMessages: VideoTransportMessage[] = [];
  const metadataMessages: MetadataTransportMessage[] = [];
  let pending = "";
  let bytesReceived = 0;
  let messagesReceived = 0;
  const finish = (): WebTransportReadResult => ({
    videoMessages,
    metadataMessages,
    bytesReceived,
    messagesReceived,
  });

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      const chunk = result.value;
      bytesReceived += chunk.byteLength;
      pending += decoder.decode(chunk, { stream: true });

      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).trim();
        pending = pending.slice(newlineIndex + 1);

        if (line.length > 0) {
          const frame = JSON.parse(line) as WebTransportWireFrame;
          if (frame.kind === "video") {
            videoMessages.push(normalizeWireVideoMessage(frame.message));
            messagesReceived += 1;
          } else if (frame.kind === "metadata") {
            metadataMessages.push(frame.message);
            messagesReceived += 1;
          } else if (frame.kind === "source") {
            messagesReceived += 1;
          } else if (frame.kind === "end") {
            return finish();
          }
        }

        newlineIndex = pending.indexOf("\n");
      }
    }

    pending += decoder.decode();
    const tail = pending.trim();
    if (tail.length > 0) {
      const frame = JSON.parse(tail) as WebTransportWireFrame;
      if (frame.kind === "video") {
        videoMessages.push(normalizeWireVideoMessage(frame.message));
        messagesReceived += 1;
      } else if (frame.kind === "metadata") {
        metadataMessages.push(frame.message);
        messagesReceived += 1;
      } else if (frame.kind === "source") {
        messagesReceived += 1;
      } else if (frame.kind === "end") {
        return finish();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return finish();
}

async function closeWebTransportSession(transport: WebTransportLike): Promise<void> {
  transport.close?.();

  if (!transport.closed) {
    return;
  }

  await Promise.race([
    transport.closed.catch(() => undefined),
    new Promise<void>((resolve) => {
      globalThis.setTimeout(resolve, 500);
    }),
  ]);
}

function findStartCode(bytes: Uint8Array, offset: number): { index: number; length: number } | undefined {
  for (let index = Math.max(0, offset); index <= bytes.byteLength - 3; index++) {
    if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
      return { index, length: 3 };
    }

    if (
      index <= bytes.byteLength - 4
      && bytes[index] === 0
      && bytes[index + 1] === 0
      && bytes[index + 2] === 0
      && bytes[index + 3] === 1
    ) {
      return { index, length: 4 };
    }
  }

  return undefined;
}

function parseAnnexBNalUnits(bytes: Uint8Array): H264NalUnit[] {
  const units: H264NalUnit[] = [];
  let start = findStartCode(bytes, 0);
  while (start) {
    const nalStart = start.index + start.length;
    const next = findStartCode(bytes, nalStart);
    const nalEnd = next?.index ?? bytes.byteLength;
    if (nalStart < nalEnd) {
      const data = bytes.slice(nalStart, nalEnd);
      units.push({
        nalType: data[0] & 0x1F,
        data,
      });
    }

    start = next;
  }

  return units;
}

function createAvcDecoderDescription(nalUnits: H264NalUnit[]): Uint8Array | undefined {
  const sps = nalUnits.find((unit) => unit.nalType === 7)?.data;
  const pps = nalUnits.find((unit) => unit.nalType === 8)?.data;
  if (!sps || !pps || sps.byteLength < 4) {
    return undefined;
  }

  const description = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  let offset = 0;
  description[offset++] = 1;
  description[offset++] = sps[1];
  description[offset++] = sps[2];
  description[offset++] = sps[3];
  description[offset++] = 0xFF;
  description[offset++] = 0xE1;
  description[offset++] = (sps.byteLength >> 8) & 0xFF;
  description[offset++] = sps.byteLength & 0xFF;
  description.set(sps, offset);
  offset += sps.byteLength;
  description[offset++] = 1;
  description[offset++] = (pps.byteLength >> 8) & 0xFF;
  description[offset++] = pps.byteLength & 0xFF;
  description.set(pps, offset);
  return description;
}

function convertAnnexBToAvcPayload(bytes: Uint8Array): Uint8Array {
  const nalUnits = parseAnnexBNalUnits(bytes)
    .filter((unit) => unit.nalType !== 7 && unit.nalType !== 8 && unit.nalType !== 9);
  if (nalUnits.length === 0) {
    return bytes;
  }

  const totalLength = nalUnits.reduce((total, unit) => total + 4 + unit.data.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const unit of nalUnits) {
    output[offset++] = (unit.data.byteLength >>> 24) & 0xFF;
    output[offset++] = (unit.data.byteLength >>> 16) & 0xFF;
    output[offset++] = (unit.data.byteLength >>> 8) & 0xFF;
    output[offset++] = unit.data.byteLength & 0xFF;
    output.set(unit.data, offset);
    offset += unit.data.byteLength;
  }

  return output;
}

function lookupCanvas(canvasId: string): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") {
    return null;
  }

  const candidate = document.getElementById(canvasId);
  if (!candidate) {
    return null;
  }

  if (typeof HTMLCanvasElement !== "undefined") {
    return candidate instanceof HTMLCanvasElement ? candidate : null;
  }

  return isCanvasLike(candidate) ? candidate : null;
}

function paintFrameOnCanvas(
  canvas: HTMLCanvasElement,
  configuration: SurfaceConfigurationPlan,
  request: RenderFrameRequest,
  renderBackend: RenderBackend = "canvas2d-fallback",
): void {
  if (canvas.width !== configuration.canvasWidth) {
    canvas.width = configuration.canvasWidth;
  }
  if (canvas.height !== configuration.canvasHeight) {
    canvas.height = configuration.canvasHeight;
  }
  canvas.hidden = false;
  canvas.style.display = "block";

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const { frame } = request;
  const palette = computeFramePalette(frame.sequenceNumber);
  const width = configuration.canvasWidth;
  const height = configuration.canvasHeight;
  const renderedOverlayCount = renderBackend === "webgpu" ? countOverlayPrimitives(request.activeMetadata) : 0;

  context.clearRect(0, 0, width, height);

  if (frame.videoFrame && typeof context.drawImage === "function") {
    context.drawImage(frame.videoFrame as CanvasImageSource, 0, 0, width, height);
  } else {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, palette.background);
    gradient.addColorStop(1, palette.accent);
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);

    context.fillStyle = "rgba(255, 255, 255, 0.14)";
    for (let x = 0; x < width; x += 64) {
      context.fillRect(x, 0, 2, height);
    }
    for (let y = 0; y < height; y += 64) {
      context.fillRect(0, y, width, 2);
    }

    const motionOffset = (frame.sequenceNumber * 29) % (width + 200);
    context.fillStyle = "rgba(255, 255, 255, 0.18)";
    context.fillRect((motionOffset - 200), height * 0.22, 220, height * 0.56);
  }

  if (request.debugOverlayEnabled) {
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(width - 256, height - 58, 224, 34);
    context.fillStyle = "#fef2df";
    context.font = "16px IBM Plex Mono, monospace";
    context.fillText(`overlay=${countOverlayPrimitives(request.activeMetadata)}`, width - 240, height - 36);
  }

  canvas.dataset.lastSequence = String(frame.sequenceNumber);
  canvas.dataset.overlayCount = String(renderedOverlayCount);
  canvas.dataset.decodeBackend = frame.decodeBackend;
  canvas.dataset.renderBackend = renderBackend;
  if (renderBackend === "webgpu") {
    canvas.dataset.gpuPresentation = "canvas2d-visible-copy";
  } else {
    delete canvas.dataset.gpuPresentation;
    delete canvas.dataset.gpuUploadSource;
  }
}

const webGpuOverlayUniformShader = `
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
`;

const webGpuOverlayFunctionsShader = `
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

fn drawMetadataOsd(uv: vec2f, sampledColor: vec4f) -> vec4f {
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
`;

const webGpuVertexShader = `
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
`;

const webGpuVideoShader = `
${webGpuOverlayUniformShader}
@group(0) @binding(0) var videoTexture: texture_2d<f32>;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;
${webGpuVertexShader}
${webGpuOverlayFunctionsShader}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  var color = textureSample(videoTexture, videoSampler, input.uv);
  return drawMetadataOsd(input.uv, vec4f(color.rgb, 1.0));
}
`;

const webGpuExternalVideoShader = `
${webGpuOverlayUniformShader}
@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;
${webGpuVertexShader}
${webGpuOverlayFunctionsShader}

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  return drawMetadataOsd(input.uv, vec4f(color.rgb, 1.0));
}
`;

function writeOverlayUniform(activeMetadata: TimedMetadataBatch[], target: Float32Array): void {
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
  const text = formatWebGpuOverlayText(record);
  target[4] = 1;
  target[5] = text.length;
  for (let index = 0; index < text.length && index < OverlayTextMaxChars; index += 1) {
    target[8 + index] = text.charCodeAt(index);
  }
}

function formatWebGpuOverlayText(record: TimedMetadataRecord): string {
  const resolution = record.tags.resolution ?? record.tags.sourceResolution ?? "";
  const timestamp = record.tags.ptsMs
    ?? record.tags.presentationTimestampMs
    ?? (record.startTimestampUs > 0 ? String(Math.floor(record.startTimestampUs / 1000)) : "");
  const normalizedResolution = resolution.replace(/[^\dXx]/g, "").toUpperCase();
  const normalizedTimestamp = timestamp.replace(/[^\d-]/g, "");
  const text = `OSD ${normalizedResolution || "0000X0000"} T${normalizedTimestamp || "0"}`;
  return text
    .toUpperCase()
    .replace(/[^0-9A-Z -]/g, " ")
    .slice(0, OverlayTextMaxChars);
}

function setCanvasDatasetValue(canvas: HTMLCanvasElement, name: string, value: string): void {
  if (canvas.dataset[name] !== value) {
    canvas.dataset[name] = value;
  }
}

function deleteCanvasDatasetValue(canvas: HTMLCanvasElement, name: string): void {
  if (canvas.dataset[name] !== undefined) {
    delete canvas.dataset[name];
  }
}

function readCanvasDatasetNumber(canvas: HTMLCanvasElement, name: string): number | undefined {
  const value = canvas.dataset[name];
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

let cachedMatrixOptionsSearch: string | undefined;
let cachedMatrixOptions: MatrixRuntimeOptions | undefined;

function matrixRuntimeOptions(): MatrixRuntimeOptions {
  if (typeof window === "undefined") {
    return {
      flushMode: "microtask",
      presentMode: "immediate",
      uploadMode: "auto",
    };
  }

  const search = window.location.search;
  if (cachedMatrixOptions && cachedMatrixOptionsSearch === search) {
    return cachedMatrixOptions;
  }

  const params = new URLSearchParams(search);
  cachedMatrixOptionsSearch = search;
  cachedMatrixOptions = {
    flushMode: normalizeMatrixFlushMode(params.get("matrixFlush")),
    presentMode: normalizeMatrixPresentMode(params.get("matrixPresent")),
    uploadMode: normalizeMatrixUploadMode(params.get("matrixTexture")),
  };
  return cachedMatrixOptions;
}

function matrixFlushMode(): MatrixFlushMode {
  return matrixRuntimeOptions().flushMode;
}

function matrixVideoFrameUploadMode(): MatrixVideoFrameUploadMode {
  return matrixRuntimeOptions().uploadMode;
}

function matrixPresentMode(): MatrixPresentMode {
  return matrixRuntimeOptions().presentMode;
}

function normalizeMatrixFlushMode(value: string | null): MatrixFlushMode {
  const mode = value?.toLowerCase();
  return mode === "microtask" || mode === "raf" || mode === "timer" ? mode : "microtask";
}

function normalizeMatrixUploadMode(value: string | null): MatrixVideoFrameUploadMode {
  const mode = value?.toLowerCase();
  if (mode === "copy" || mode === "retained" || mode === "videoframe-copy") {
    return "copy";
  }

  if (mode === "external" || mode === "direct" || mode === "zero-copy") {
    return "external";
  }

  return "auto";
}

function normalizeMatrixPresentMode(value: string | null): MatrixPresentMode {
  const mode = value?.toLowerCase();
  if (mode === "immediate" || mode === "direct") {
    return "immediate";
  }

  if (mode === "raf" || mode === "animation-frame" || mode === "vsync") {
    return "raf";
  }

  return "auto";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

let sharedWebGpuAdapterGpu: WebGpuNavigatorLike | undefined;
let sharedWebGpuAdapterStatePromise: Promise<WebGpuSharedAdapterState> | undefined;
let sharedWebGpuRuntimeGpu: WebGpuNavigatorLike | undefined;
let sharedWebGpuRuntimePromise: Promise<WebGpuSharedRuntime | undefined> | undefined;

async function getSharedWebGpuAdapterState(): Promise<WebGpuSharedAdapterState> {
  const gpu = getWebGpuNavigator();
  if (!gpu) {
    return { disabledReason: "no-webgpu" };
  }

  if (sharedWebGpuAdapterGpu !== gpu) {
    sharedWebGpuAdapterGpu = gpu;
    sharedWebGpuAdapterStatePromise = createSharedWebGpuAdapterState(gpu);
    sharedWebGpuRuntimeGpu = undefined;
    sharedWebGpuRuntimePromise = undefined;
  }

  return sharedWebGpuAdapterStatePromise ?? { gpu, disabledReason: "no-webgpu" };
}

async function createSharedWebGpuAdapterState(gpu: WebGpuNavigatorLike): Promise<WebGpuSharedAdapterState> {
  let adapter: WebGpuAdapterLike | null;
  try {
    adapter = await withTimeout(
      gpu.requestAdapter(),
      WebGpuInitTimeoutMs,
      "webgpu-request-adapter-timeout",
    );
  } catch (error) {
    return { gpu, disabledReason: error instanceof Error ? error.message : "webgpu-request-adapter-failed" };
  }

  if (!adapter) {
    return { gpu, disabledReason: "no-webgpu-adapter" };
  }

  const adapterInfo = adapter.info;
  if (!isHardwareWebGpuAdapter(adapterInfo)) {
    return { gpu, adapter, adapterInfo, disabledReason: "software-adapter" };
  }

  return {
    gpu,
    adapter,
    adapterInfo,
  };
}

async function getSharedWebGpuRuntime(adapterState: WebGpuSharedAdapterState): Promise<WebGpuSharedRuntime | undefined> {
  if (!adapterState.gpu || !adapterState.adapter || adapterState.disabledReason) {
    return undefined;
  }

  if (sharedWebGpuRuntimeGpu !== adapterState.gpu) {
    sharedWebGpuRuntimeGpu = adapterState.gpu;
    sharedWebGpuRuntimePromise = createSharedWebGpuRuntime(adapterState).catch(() => undefined);
  }

  return sharedWebGpuRuntimePromise;
}

async function createSharedWebGpuRuntime(adapterState: WebGpuSharedAdapterState): Promise<WebGpuSharedRuntime | undefined> {
  const adapter = adapterState.adapter;
  if (!adapterState.gpu || !adapter || adapterState.disabledReason) {
    return undefined;
  }

  const gpu = adapterState.gpu;
  const adapterInfo = adapterState.adapterInfo;
  let device: WebGpuDeviceLike;
  try {
    device = await withTimeout(
      adapter.requestDevice(),
      WebGpuInitTimeoutMs,
      "webgpu-request-device-timeout",
    );
  } catch {
    return undefined;
  }

  const format = gpu.getPreferredCanvasFormat?.() ?? "bgra8unorm";
  const shaderModule = device.createShaderModule({ code: webGpuVideoShader });
  const externalShaderModule = device.createShaderModule({ code: webGpuExternalVideoShader });
  const pipeline = device.createRenderPipeline({
    layout: "auto",
    vertex: {
      module: shaderModule,
      entryPoint: "vertexMain",
    },
    fragment: {
      module: shaderModule,
      entryPoint: "fragmentMain",
      targets: [{ format }],
    },
    primitive: {
      topology: "triangle-list",
    },
  });
  const externalTexturePipeline = typeof device.importExternalTexture === "function"
    ? device.createRenderPipeline({
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
    })
    : undefined;
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
  });

  return {
    gpu,
    adapterInfo,
    device,
    format,
    pipeline,
    externalTexturePipeline,
    sampler,
  };
}

async function createWebGpuRenderState(
  canvas: HTMLCanvasElement,
  configuration: SurfaceConfigurationPlan,
): Promise<WebGpuRenderState | undefined> {
  const adapterState = await getSharedWebGpuAdapterState();
  const adapterInfo = adapterState.adapterInfo;
  canvas.dataset.gpuAdapterVendor = adapterInfo?.vendor ?? "";
  canvas.dataset.gpuAdapterArchitecture = adapterInfo?.architecture ?? "";
  if (adapterState.disabledReason) {
    canvas.dataset.webGpuDisabledReason = adapterState.disabledReason;
    return undefined;
  }

  const candidate = canvas.getContext("webgpu") as WebGpuCanvasContextLike | null;
  if (!candidate) {
    canvas.dataset.webGpuDisabledReason = "no-webgpu-canvas";
    return undefined;
  }

  delete canvas.dataset.webGpuDisabledReason;
  const runtime = await getSharedWebGpuRuntime(adapterState);
  if (!runtime) {
    canvas.dataset.webGpuDisabledReason = "webgpu-device-unavailable";
    return undefined;
  }

  const bufferUsage = getGpuBufferUsage();
  const overlayBuffer = runtime.device.createBuffer({
    size: OverlayUniformByteLength,
    usage: bufferUsage.uniform | bufferUsage.copyDst,
  });
  const textureUsage = getGpuTextureUsage();
  const outputTexture = runtime.device.createTexture({
    size: { width: configuration.canvasWidth, height: configuration.canvasHeight },
    format: runtime.format,
    usage: textureUsage.renderAttachment | textureUsage.copySrc | textureUsage.textureBinding,
  });

  canvas.width = configuration.canvasWidth;
  canvas.height = configuration.canvasHeight;
  canvas.hidden = false;
  canvas.style.display = "block";

  candidate.configure({
    device: runtime.device,
    format: runtime.format,
    alphaMode: "premultiplied",
    usage: textureUsage.renderAttachment | textureUsage.copyDst,
  });

  return {
    canvas,
    context: candidate,
    runtime,
    format: runtime.format,
    outputTexture,
    overlayBuffer,
    overlayUniform: new Float32Array(new ArrayBuffer(OverlayUniformByteLength)),
    adapterInfo,
  };
}

async function renderFrameWithWebGpu(
  state: WebGpuRenderState,
  request: RenderFrameRequest,
): Promise<WebGpuCanvasPresentation> {
  const frame = request.frame.videoFrame;
  if (!frame) {
    throw new Error("WebGPU render requires a decoded VideoFrame.");
  }

  const markStep = (step: string): void => {
    state.lastStep = step;
  };

  const sourceDimensions = resolveVideoFrameDimensions(frame, request.frame.width, request.frame.height);
  const sourceWidth = sourceDimensions.width;
  const sourceHeight = sourceDimensions.height;
  const textureUsage = getGpuTextureUsage();
  const bufferUsage = getGpuBufferUsage();
  const nowMs = performance.now();
  const shouldSample = !state.diagnosticSampleAttempted && !state.diagnosticSampleInFlight;
  const runtime = state.runtime;
  const device = runtime.device;

  let activePipeline = runtime.pipeline;
  let sourceResource: unknown | undefined;
  let sourceTexture: WebGpuTextureLike | undefined;
  let gpuSource: unknown = frame;
  let gpuUploadSource = "";
  const canImportExternalTexture = Boolean(isNativeVideoFrame(frame)
    && isHardwareWebGpuAdapter(state.adapterInfo)
    && typeof device.importExternalTexture === "function"
    && runtime.externalTexturePipeline);

  if (canImportExternalTexture) {
    try {
      markStep("import-external-texture");
      sourceResource = device.importExternalTexture?.({ source: frame });
      activePipeline = runtime.externalTexturePipeline ?? runtime.pipeline;
      gpuUploadSource = "external-texture";
      deleteCanvasDatasetValue(state.canvas, "gpuExternalTextureError");
    } catch (error) {
      setCanvasDatasetValue(state.canvas, "gpuExternalTextureError", error instanceof Error ? error.message : String(error));
    }
  }

  if (!sourceResource) {
    if (!isNativeVideoFrame(frame)) {
      throw new Error("WebGPU live rendering requires a native VideoFrame source.");
    }

    if (!state.uploadTexture || state.uploadTexture.width !== sourceWidth || state.uploadTexture.height !== sourceHeight) {
      state.uploadTexture?.texture.destroy?.();
      markStep("create-source-texture");
      state.uploadTexture = {
        texture: device.createTexture({
          size: { width: sourceWidth, height: sourceHeight },
          format: "rgba8unorm",
          usage: textureUsage.textureBinding | textureUsage.copyDst | textureUsage.renderAttachment,
        }),
        width: sourceWidth,
        height: sourceHeight,
      };
    }

    sourceTexture = state.uploadTexture.texture;
    markStep("copy-videoframe-to-texture");
    device.queue.copyExternalImageToTexture(
      { source: gpuSource as CanvasImageSource },
      { texture: sourceTexture },
      { width: sourceWidth, height: sourceHeight },
    );
    gpuUploadSource = "videoframe-copy";
    sourceResource = sourceTexture.createView();
  }

  writeOverlayUniform(request.activeMetadata, state.overlayUniform);
  markStep("write-overlay-buffer");
  device.queue.writeBuffer(state.overlayBuffer, 0, state.overlayUniform);

  markStep("create-bind-group");
  const bindGroup = device.createBindGroup({
    layout: (activePipeline as { getBindGroupLayout?: (index: number) => unknown }).getBindGroupLayout?.(0),
    entries: [
      {
        binding: 0,
        resource: sourceResource,
      },
      {
        binding: 1,
        resource: runtime.sampler,
      },
      {
        binding: 2,
        resource: {
          buffer: state.overlayBuffer,
        },
      },
    ],
  });
  markStep("create-command-encoder");
  const commandEncoder = device.createCommandEncoder();
  const renderTargetTexture = state.context && !shouldSample
    ? state.context.getCurrentTexture()
    : state.outputTexture;
  markStep("begin-render-pass");
  const pass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: renderTargetTexture.createView(),
        clearValue: { r: 0.02, g: 0.03, b: 0.04, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });
  pass.setPipeline(activePipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();
  let presentation: WebGpuCanvasPresentation = "canvas2d-visible-copy";
  if (state.context) {
    if (shouldSample) {
      markStep("present-webgpu-canvas");
      commandEncoder.copyTextureToTexture(
        { texture: state.outputTexture },
        { texture: state.context.getCurrentTexture() },
        { width: state.canvas.width, height: state.canvas.height },
      );
    } else {
      markStep("render-webgpu-canvas-direct");
    }
    presentation = "webgpu-canvas";
  }
  markStep("finish-command-buffer");
  const commandBuffer = commandEncoder.finish();
  markStep("submit-command-buffer");
  device.queue.submit([commandBuffer]);
  if (shouldSample) {
    state.diagnosticSampleAttempted = true;
    state.diagnosticSampleInFlight = true;
    state.lastSampleAtMs = nowMs;
    void sampleWebGpuOutput(state, bufferUsage).finally(() => {
      state.diagnosticSampleInFlight = false;
    });
  }
  markStep("cleanup");

  setCanvasDatasetValue(state.canvas, "lastSequence", String(request.frame.sequenceNumber));
  setCanvasDatasetValue(state.canvas, "overlayCount", String(countOverlayPrimitives(request.activeMetadata)));
  setCanvasDatasetValue(state.canvas, "decodeBackend", request.frame.decodeBackend);
  setCanvasDatasetValue(state.canvas, "renderBackend", "webgpu");
  setCanvasDatasetValue(state.canvas, "gpuPresentation", presentation);
  setCanvasDatasetValue(state.canvas, "gpuUploadSource", gpuUploadSource || "unknown");
  setCanvasDatasetValue(state.canvas, "gpuAdapterVendor", state.adapterInfo?.vendor ?? "");
  setCanvasDatasetValue(state.canvas, "gpuAdapterArchitecture", state.adapterInfo?.architecture ?? "");
  deleteCanvasDatasetValue(state.canvas, "webGpuError");
  markStep("rendered");
  setCanvasDatasetValue(state.canvas, "webGpuStep", state.lastStep ?? "rendered");
  return presentation;
}

async function sampleWebGpuOutput(state: WebGpuRenderState, bufferUsage: Record<string, number>): Promise<void> {
  const device = state.runtime.device;
  const sampleBuffer = device.createBuffer({
    size: 256,
    usage: bufferUsage.copyDst | bufferUsage.mapRead,
  });

  try {
    const commandEncoder = device.createCommandEncoder();
    commandEncoder.copyTextureToBuffer(
      {
        texture: state.outputTexture,
        origin: {
          x: Math.floor(state.canvas.width / 2),
          y: Math.floor(state.canvas.height / 2),
        },
      },
      {
        buffer: sampleBuffer,
        bytesPerRow: 256,
        rowsPerImage: 1,
      },
      { width: 1, height: 1 },
    );
    device.queue.submit([commandEncoder.finish()]);
    await device.queue.onSubmittedWorkDone?.();
    await sampleBuffer.mapAsync?.(getGpuMapMode().read);
    const mapped = sampleBuffer.getMappedRange?.();
    if (mapped) {
      state.canvas.dataset.gpuSampleRgba = Array.from(new Uint8Array(mapped, 0, 4)).join(",");
    }
    sampleBuffer.unmap?.();
    delete state.canvas.dataset.gpuReadbackError;
  } catch (error) {
    state.canvas.dataset.gpuReadbackError = error instanceof Error ? error.message : String(error);
  } finally {
    sampleBuffer.destroy?.();
  }
}

export class WebPlayerBootstrap {
  private readonly sessions = new Map<string, InternalPlayerSessionState>();
  private readonly transportClient: WebTransportIngestClient;
  private readonly decoder: VideoDecodeCoordinator;
  private readonly renderer: WebGpuRenderer;
  private nextSequence = 0;

  public constructor(dependencies: BootstrapDependencies = {}) {
    this.transportClient = dependencies.transportClient ?? new WebTransportIngestClient();
    this.decoder = dependencies.decoder ?? new VideoDecodeCoordinator();
    this.renderer = dependencies.renderer ?? new WebGpuRenderer();
  }

  /**
   * Planned flow: resolve session metadata from the UI layer, connect the transport path,
   * configure decode/render components, and return a session handle for later teardown.
   */
  public initializeSession(
    request: PlayerSessionRequest,
    abortSignal?: AbortSignal,
  ): Promise<PlayerSessionHandle> {
    abortSignal?.throwIfAborted();

    const handle: PlayerSessionHandle = {
      sessionId: createId("player", ++this.nextSequence),
      channelId: request.channelId,
      streamId: request.streamId,
      viewerId: request.viewerId,
    };

    this.sessions.set(handle.sessionId, {
      handle,
      request,
      disposed: false,
    });

    return Promise.resolve(handle);
  }

  /**
   * Planned flow: stop the transport readers, flush decode state, and release GPU resources
   * tied to the session.
   */
  public disposeSession(
    handle: PlayerSessionHandle,
  ): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) {
      return Promise.reject(new Error(`Player session '${handle.sessionId}' is not active.`));
    }

    state.disposed = true;
    this.sessions.delete(handle.sessionId);
    return Promise.resolve();
  }
}

export class WebTransportIngestClient {
  private readonly seededVideoMessages: Record<string, VideoTransportMessage[]>;
  private readonly seededMetadataMessages: Record<string, MetadataTransportMessage[]>;
  private readonly connections = new Map<string, InternalTransportState>();
  private nextSequence = 0;

  public constructor(seed: TransportSeedState = {}) {
    this.seededVideoMessages = seed.videoMessagesByStream ?? {};
    this.seededMetadataMessages = seed.metadataMessagesByStream ?? {};
  }

  /**
   * Planned flow: authenticate, create the WebTransport session, and return a logical
   * connection handle that drives video and metadata readers.
   */
  public async connect(
    endpoint: TransportEndpointDescriptor,
    abortSignal?: AbortSignal,
  ): Promise<TransportConnectionHandle> {
    abortSignal?.throwIfAborted();

    if (!endpoint.authToken) {
      return Promise.reject(new Error("Transport connection requires a non-empty auth token."));
    }

    const seededVideo = [...(this.seededVideoMessages[endpoint.streamId] ?? [])];
    const seededMetadata = [...(this.seededMetadataMessages[endpoint.streamId] ?? [])];
    const hasSeededFallback = seededVideo.length > 0 || seededMetadata.length > 0;
    let remainingVideoMessages = seededVideo;
    let remainingMetadataMessages = seededMetadata;
    let activeTransport: BrowserTransportMode = "http-seeded-fallback";
    let webTransportReady = false;
    let webTransportBytesReceived = 0;
    let webTransportMessagesReceived = 0;

    if (endpoint.requestedTransport === "webtransport-quic") {
      const WebTransportCtor = getWebTransportConstructor();
      if (!WebTransportCtor && !endpoint.allowHttpFallback) {
        return Promise.reject(new Error("WebTransport is not available and HTTP fallback is disabled."));
      }

      if (WebTransportCtor) {
        try {
          const transport = new WebTransportCtor(endpoint.webTransportUrl, createWebTransportOptions(endpoint));
          await transport.ready;

          if (typeof transport.createBidirectionalStream !== "function") {
            throw new Error("WebTransport implementation does not support bidirectional streams.");
          }

          const stream = await transport.createBidirectionalStream();
          await writeWebTransportOpenRequest(stream, endpoint);
          const transportMessages = await readWebTransportFrames(stream);
          await closeWebTransportSession(transport);

          remainingVideoMessages = transportMessages.videoMessages;
          remainingMetadataMessages = transportMessages.metadataMessages;
          webTransportBytesReceived = transportMessages.bytesReceived;
          webTransportMessagesReceived = transportMessages.messagesReceived;
          activeTransport = "webtransport-quic";
          webTransportReady = true;
        } catch (error) {
          if (!endpoint.allowHttpFallback || !hasSeededFallback) {
            const message = error instanceof Error ? error.message : String(error);
            return Promise.reject(new Error(`WebTransport connection failed: ${message}`));
          }
        }
      }
    }

    const handle: TransportConnectionHandle = {
      connectionId: createId("transport", ++this.nextSequence),
      channelId: endpoint.channelId,
      streamId: endpoint.streamId,
      requestedTransport: endpoint.requestedTransport,
      activeTransport,
      webTransportReady,
      webTransportBytesReceived,
      webTransportMessagesReceived,
    };

    this.connections.set(handle.connectionId, {
      handle,
      endpoint,
      remainingVideoMessages,
      remainingMetadataMessages,
    });

    return handle;
  }

  public async connectStreaming(
    endpoint: TransportEndpointDescriptor,
    abortSignal?: AbortSignal,
  ): Promise<TransportConnectionHandle> {
    abortSignal?.throwIfAborted();

    if (!endpoint.authToken) {
      return Promise.reject(new Error("Transport connection requires a non-empty auth token."));
    }

    const WebTransportCtor = getWebTransportConstructor();
    if (!WebTransportCtor) {
      return Promise.reject(new Error("WebTransport is not available for continuous streaming."));
    }

    const transport = new WebTransportCtor(endpoint.webTransportUrl, createWebTransportOptions(endpoint));
    await transport.ready;

    if (typeof transport.createBidirectionalStream !== "function") {
      throw new Error("WebTransport implementation does not support bidirectional streams.");
    }

    const stream = await transport.createBidirectionalStream();
    const streamMode = endpoint.streamMode ?? "continuous-moq";
    await writeWebTransportOpenRequest(stream, {
      ...endpoint,
      streamMode,
    });

    const handle: TransportConnectionHandle = {
      connectionId: createId("transport", ++this.nextSequence),
      channelId: endpoint.channelId,
      streamId: endpoint.streamId,
      requestedTransport: endpoint.requestedTransport,
      activeTransport: "webtransport-quic",
      webTransportReady: true,
      webTransportBytesReceived: 0,
      webTransportMessagesReceived: 0,
    };

    this.connections.set(handle.connectionId, {
      handle,
      endpoint: {
        ...endpoint,
        streamMode,
      },
      remainingVideoMessages: [],
      remainingMetadataMessages: [],
      transport,
      reader: stream.readable.getReader(),
      pendingText: "",
      pendingBinary: new Uint8Array(0),
      pendingBinaryOffset: 0,
      pendingBinaryLength: 0,
    });

    return handle;
  }

  public async *readStreamingFrames(
    connection: TransportConnectionHandle,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<StreamingTransportFrame> {
    abortSignal?.throwIfAborted();
    const state = this.getConnection(connection.connectionId);
    if (!state.reader) {
      throw new Error(`Transport connection '${connection.connectionId}' is not a streaming connection.`);
    }

    const reader = state.reader;
    const decoder = new TextDecoder();
    const moqFrames = state.endpoint.streamMode === "continuous-binary"
      || state.endpoint.streamMode === "continuous-moq";
    const abortReader = () => {
      void reader.cancel();
    };
    abortSignal?.addEventListener("abort", abortReader, { once: true });

    try {
      while (true) {
        abortSignal?.throwIfAborted();
        const result = await reader.read();
        if (result.done) {
          if (moqFrames && pendingBinaryLength(state) > 0) {
            throw new Error("Continuous WebTransport MoQ object ended with a truncated frame.");
          }

          break;
        }

        const chunk = result.value;
        state.handle.webTransportBytesReceived += chunk.byteLength;
        if (moqFrames) {
          appendBinaryChunk(state, chunk);
          while (pendingBinaryLength(state) > 0) {
            const frames = readMoqStreamingFrames(state, decoder, MaxMoqFramesPerParseTurn);
            if (frames.length === 0) {
              break;
            }

            for (const frame of frames) {
              yield frame;
            }

            if (frames.length >= MaxMoqFramesPerParseTurn && pendingBinaryLength(state) > 0) {
              await yieldToMainThread();
            }
          }
          continue;
        }

        state.pendingText = `${state.pendingText ?? ""}${decoder.decode(chunk, { stream: true })}`;

        let newlineIndex = state.pendingText.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = state.pendingText.slice(0, newlineIndex).trim();
          state.pendingText = state.pendingText.slice(newlineIndex + 1);

          if (line.length > 0) {
            const receivedAtUnixTimeMs = Date.now();
            const frame = JSON.parse(line) as WebTransportWireFrame;
            if (frame.kind === "video") {
              state.handle.webTransportMessagesReceived += 1;
              yield {
                kind: "video",
                message: normalizeWireVideoMessage(frame.message),
                bytesReceived: state.handle.webTransportBytesReceived,
                messagesReceived: state.handle.webTransportMessagesReceived,
                receivedAtUnixTimeMs,
              };
            } else if (frame.kind === "metadata") {
              state.handle.webTransportMessagesReceived += 1;
              yield {
                kind: "metadata",
                message: frame.message,
                bytesReceived: state.handle.webTransportBytesReceived,
                messagesReceived: state.handle.webTransportMessagesReceived,
                receivedAtUnixTimeMs,
              };
            } else if (frame.kind === "source") {
              state.handle.webTransportMessagesReceived += 1;
              yield {
                kind: "source",
                source: frame.message,
                bytesReceived: state.handle.webTransportBytesReceived,
                messagesReceived: state.handle.webTransportMessagesReceived,
                receivedAtUnixTimeMs,
              };
            } else if (frame.kind === "end") {
              yield {
                kind: "end",
                bytesReceived: state.handle.webTransportBytesReceived,
                messagesReceived: state.handle.webTransportMessagesReceived,
                receivedAtUnixTimeMs,
              };
              return;
            }
          }

          newlineIndex = state.pendingText.indexOf("\n");
        }
      }
    } finally {
      abortSignal?.removeEventListener("abort", abortReader);
    }
  }

  /**
   * Planned flow: incrementally read video messages, emit them to the encoded chunk assembler,
   * and surface transport-level timing for telemetry.
   */
  public async readVideoMessages(
    connection: TransportConnectionHandle,
    abortSignal?: AbortSignal,
  ): Promise<VideoTransportMessage[]> {
    abortSignal?.throwIfAborted();
    const state = this.getConnection(connection.connectionId);
    const messages = [...state.remainingVideoMessages];
    state.remainingVideoMessages = [];
    return messages;
  }

  /**
   * Planned flow: incrementally read timed metadata batches and surface them to the timeline
   * store without blocking video delivery.
   */
  public async readMetadataMessages(
    connection: TransportConnectionHandle,
    abortSignal?: AbortSignal,
  ): Promise<MetadataTransportMessage[]> {
    abortSignal?.throwIfAborted();
    const state = this.getConnection(connection.connectionId);
    const messages = [...state.remainingMetadataMessages];
    state.remainingMetadataMessages = [];
    return messages;
  }

  public closeConnection(
    connection: TransportConnectionHandle,
  ): Promise<void> {
    const state = this.connections.get(connection.connectionId);
    this.connections.delete(connection.connectionId);
    state?.reader?.cancel().catch(() => undefined);
    if (state?.transport) {
      return closeWebTransportSession(state.transport);
    }

    return Promise.resolve();
  }

  private getConnection(connectionId: string): InternalTransportState {
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`Transport connection '${connectionId}' is not active.`);
    }

    return state;
  }
}

export class EncodedChunkAssembler {
  private readonly lastSequenceByStream = new Map<string, number>();
  private readonly codecConfigByStream = new Map<string, string>();

  /**
   * Planned flow: validate sequence ordering, emit WebCodecs-ready chunks, and track
   * discontinuities so the decoder can be reset explicitly.
   */
  public applyTransportMessage(
    message: VideoTransportMessage,
  ): Promise<EncodedChunkEmission[]> {
    const lastSequence = this.lastSequenceByStream.get(message.streamId);
    if (lastSequence !== undefined && message.sequenceNumber <= lastSequence) {
      return Promise.reject(new Error(`Video sequence for stream '${message.streamId}' must increase monotonically.`));
    }

    this.lastSequenceByStream.set(message.streamId, message.sequenceNumber);
    this.codecConfigByStream.set(message.streamId, message.codecConfigVersion);

    return Promise.resolve([
      {
        streamId: message.streamId,
        sequenceNumber: message.sequenceNumber,
        encodedChunkType: message.keyFrame ? "key" : "delta",
        presentationTimestampUs: message.presentationTimestampUs,
        payload: message.payload,
      },
    ]);
  }

  /**
   * Planned flow: reset local assembler state when ingest discontinuity or codec config change
   * is signaled.
   */
  public resetForDiscontinuity(
    discontinuity: StreamDiscontinuity,
  ): Promise<void> {
    this.lastSequenceByStream.delete(discontinuity.streamId);
    if (discontinuity.reason === "codec-config-change") {
      this.codecConfigByStream.delete(discontinuity.streamId);
    }

    return Promise.resolve();
  }
}

async function selectSupportedWebCodecsConfiguration(
  decoderConstructor: BrowserVideoDecoderConstructor,
  configuration: VideoCodecConfiguration,
): Promise<Record<string, unknown> | undefined> {
  for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
    const candidate = createWebCodecsConfiguration(configuration, hardwareAcceleration);
    const support = decoderConstructor.isConfigSupported
      ? await decoderConstructor.isConfigSupported(candidate)
      : { supported: true };
    if (support.supported) {
      return candidate;
    }
  }

  return undefined;
}

function createWebCodecsConfiguration(
  configuration: VideoCodecConfiguration,
  hardwareAcceleration: string,
): Record<string, unknown> {
  const webCodecsConfiguration: Record<string, unknown> = {
    codec: configuration.codec,
    codedWidth: configuration.codedWidth,
    codedHeight: configuration.codedHeight,
    hardwareAcceleration,
    optimizeForLatency: true,
  };
  if (configuration.codec.startsWith("avc1")) {
    webCodecsConfiguration.avc = { format: "annexb" };
  } else if (configuration.description) {
    webCodecsConfiguration.description = configuration.description;
  }

  return webCodecsConfiguration;
}

export class VideoDecodeCoordinator {
  public constructor(private readonly onDecodedFramesAvailable?: () => void) {}

  private configuration?: VideoCodecConfiguration;
  private readonly queuedFrames: DecodedFramePlan[] = [];
  private readonly decodedFrames: DecodedFramePlan[] = [];
  private readonly pendingMetadataByTimestamp = new Map<number, DecodeMetadata>();
  private decoder?: BrowserVideoDecoderLike;
  private decoderConstructor?: BrowserVideoDecoderConstructor;
  private chunkConstructor?: BrowserEncodedVideoChunkConstructor;
  private webCodecsConfiguration?: Record<string, unknown>;
  private decodeBackend: DecodeBackend = "synthetic-frame-plan";
  private decodeError?: unknown;

  /**
   * Planned flow: configure WebCodecs with the resolved codec description and reset any prior
   * decoder state.
   */
  public async configureDecoder(
    configuration: VideoCodecConfiguration,
  ): Promise<void> {
    this.closeDecoder();
    this.configuration = configuration;
    this.queuedFrames.length = 0;
    this.decodedFrames.length = 0;
    this.pendingMetadataByTimestamp.clear();
    this.decoder = undefined;
    this.decoderConstructor = undefined;
    this.chunkConstructor = undefined;
    this.webCodecsConfiguration = undefined;
    this.decodeBackend = "synthetic-frame-plan";
    this.decodeError = undefined;

    const decoderConstructor = getVideoDecoderConstructor();
    const chunkConstructor = getEncodedVideoChunkConstructor();
    if (!decoderConstructor || !chunkConstructor) {
      return;
    }

    const webCodecsConfiguration = await selectSupportedWebCodecsConfiguration(decoderConstructor, configuration);
    if (!webCodecsConfiguration) {
      return;
    }

    this.decoderConstructor = decoderConstructor;
    this.chunkConstructor = chunkConstructor;
    this.webCodecsConfiguration = webCodecsConfiguration;
    this.decoder = new decoderConstructor({
      output: (frame) => {
        this.acceptDecodedFrame(frame);
      },
      error: (error) => {
        this.decodeError = error;
      },
    });
    this.decoder.configure(webCodecsConfiguration);
    this.decodeBackend = "webcodecs";
  }

  /**
   * Planned flow: enqueue a single encoded chunk into the decoder with bounded backlog.
   */
  public async enqueueChunk(
    chunk: EncodedChunkEmission,
  ): Promise<void> {
    if (!this.configuration) {
      return Promise.reject(new Error("Decoder must be configured before chunks can be enqueued."));
    }

    if (!this.decoder && this.decoderConstructor && this.chunkConstructor) {
      await this.initializeWebCodecsDecoder();
    }

    if (this.decoder && this.chunkConstructor) {
      try {
        const payload = chunk.payload;
        this.pendingMetadataByTimestamp.set(chunk.presentationTimestampUs, {
          streamId: chunk.streamId,
          sequenceNumber: chunk.sequenceNumber,
          presentationTimestampUs: chunk.presentationTimestampUs,
        });
        this.decoder.decode(new this.chunkConstructor({
          type: chunk.encodedChunkType,
          timestamp: chunk.presentationTimestampUs,
          data: payload,
        }));
        return;
      } catch (error) {
        this.decodeError = error;
        this.closeDecoder();
        this.decoderConstructor = undefined;
        this.chunkConstructor = undefined;
        this.webCodecsConfiguration = undefined;
        this.decodeBackend = "synthetic-frame-plan";
        const message = error instanceof Error ? error.message : String(error);
        return Promise.reject(new Error(`WebCodecs decode failed: ${message}`));
      }
    }

    this.queuedFrames.push({
      streamId: chunk.streamId,
      sequenceNumber: chunk.sequenceNumber,
      presentationTimestampUs: chunk.presentationTimestampUs,
      width: this.configuration.codedWidth,
      height: this.configuration.codedHeight,
      decodeBackend: "synthetic-frame-plan",
    });
    this.onDecodedFramesAvailable?.();

    return;
  }

  /**
   * Planned flow: flush decode state during stream drain or controlled reset and surface
   * decoded frame descriptors to the scheduler.
   */
  public async flush(waitForDrain = true): Promise<DecodedFramePlan[]> {
    if (this.decoder) {
      if (waitForDrain) {
        await this.decoder.flush();
      } else {
        await this.waitForDecodedOutput();
      }

      if (this.decodeError) {
        const message = this.decodeError instanceof Error ? this.decodeError.message : String(this.decodeError);
        throw new Error(`WebCodecs decode failed: ${message}`);
      }

      const frames = [...this.decodedFrames];
      this.decodedFrames.length = 0;
      return frames;
    }

    const frames = [...this.queuedFrames];
    this.queuedFrames.length = 0;
    return frames;
  }

  public drainDecodedFrames(): DecodedFramePlan[] {
    if (this.decodeError) {
      const message = this.decodeError instanceof Error ? this.decodeError.message : String(this.decodeError);
      throw new Error(`WebCodecs decode failed: ${message}`);
    }

    const source = this.decoder ? this.decodedFrames : this.queuedFrames;
    const frames = [...source];
    source.length = 0;
    return frames;
  }

  public liveBacklogFrameCount(): number {
    return (this.decoder?.decodeQueueSize ?? 0) + this.decodedFrames.length + this.queuedFrames.length;
  }

  public dispose(): void {
    this.closeDecoder();
    closeDecodedFrames(this.queuedFrames);
    closeDecodedFrames(this.decodedFrames);
    this.queuedFrames.length = 0;
    this.decodedFrames.length = 0;
    this.pendingMetadataByTimestamp.clear();
  }

  private async waitForDecodedOutput(): Promise<void> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, 0);
      });

      if (this.decodedFrames.length > 0 || this.decodeError || (this.decoder?.decodeQueueSize ?? 0) === 0) {
        return;
      }
    }
  }

  private async initializeWebCodecsDecoder(): Promise<void> {
    if (!this.configuration || !this.decoderConstructor) {
      return;
    }

    const webCodecsConfiguration = this.webCodecsConfiguration
      ?? await selectSupportedWebCodecsConfiguration(this.decoderConstructor, this.configuration);
    if (!webCodecsConfiguration) {
      this.decoderConstructor = undefined;
      this.chunkConstructor = undefined;
      this.webCodecsConfiguration = undefined;
      return;
    }
    this.webCodecsConfiguration = webCodecsConfiguration;

    this.decoder = new this.decoderConstructor({
      output: (frame) => {
        this.acceptDecodedFrame(frame);
      },
      error: (error) => {
        this.decodeError = error;
      },
    });
    this.decoder.configure(webCodecsConfiguration);
    this.decodeBackend = "webcodecs";
  }

  private acceptDecodedFrame(frame: BrowserVideoFrameLike): void {
    if (!this.configuration) {
      frame.close?.();
      return;
    }

    const timestamp = Number(frame.timestamp ?? 0);
    const metadata = this.pendingMetadataByTimestamp.get(timestamp)
      ?? this.pendingMetadataByTimestamp.values().next().value as DecodeMetadata | undefined;
    if (metadata) {
      this.pendingMetadataByTimestamp.delete(metadata.presentationTimestampUs);
    }

    this.decodedFrames.push({
      streamId: metadata?.streamId ?? "unknown-stream",
      sequenceNumber: metadata?.sequenceNumber ?? this.decodedFrames.length + 1,
      presentationTimestampUs: metadata?.presentationTimestampUs ?? timestamp,
      width: frame.displayWidth ?? frame.codedWidth ?? this.configuration.codedWidth,
      height: frame.displayHeight ?? frame.codedHeight ?? this.configuration.codedHeight,
      decodeBackend: "webcodecs",
      videoFrame: frame,
    });
    this.onDecodedFramesAvailable?.();
  }

  private closeDecoder(): void {
    const decoder = this.decoder;
    this.decoder = undefined;
    try {
      decoder?.close?.();
    } catch {
      // Chrome may already transition a VideoDecoder to closed after an async decode error.
    }
  }
}

export class OverlayTimelineStore {
  private readonly batchesByStream = new Map<string, TimedMetadataBatch[]>();
  private readonly retentionUs = 5_000_000;
  private readonly maxBatchesPerStream = 512;

  /**
   * Planned flow: store metadata batches in a bounded timeline keyed by presentation time.
   */
  public ingestBatch(
    batch: TimedMetadataBatch,
  ): Promise<void> {
    const existing = this.batchesByStream.get(batch.streamId) ?? [];
    const lastBatch = existing[existing.length - 1];
    if (!lastBatch || lastBatch.batchStartTimestampUs <= batch.batchStartTimestampUs) {
      existing.push(batch);
    } else {
      const insertIndex = existing.findIndex((candidate) => candidate.batchStartTimestampUs > batch.batchStartTimestampUs);
      existing.splice(insertIndex < 0 ? existing.length : insertIndex, 0, batch);
    }

    const oldestAllowedTimestampUs = batch.batchEndTimestampUs - this.retentionUs;
    while (
      existing.length > 0
      && (
        (existing[0]?.batchEndTimestampUs ?? 0) < oldestAllowedTimestampUs
        || existing.length > this.maxBatchesPerStream
      )
    ) {
      existing.shift();
    }

    this.batchesByStream.set(batch.streamId, existing);
    return Promise.resolve();
  }

  /**
   * Planned flow: return only metadata that should be active at the chosen presentation time.
   */
  public queryActiveMetadata(
    streamId: string,
    presentationTimestampUs: number,
  ): Promise<TimedMetadataBatch[]> {
    const active = (this.batchesByStream.get(streamId) ?? []).filter(
      // Timed metadata windows are modeled as [start, end) so adjacent batches do not overlap.
      (batch) => batch.batchStartTimestampUs <= presentationTimestampUs && batch.batchEndTimestampUs > presentationTimestampUs,
    );
    return Promise.resolve(active);
  }

  /**
   * Planned flow: clear timeline data on teardown or discontinuity.
   */
  public clearWindow(
    streamId: string,
  ): Promise<void> {
    this.batchesByStream.delete(streamId);
    return Promise.resolve();
  }
}

export class PresentationScheduler {
  private readonly clockByStream = new Map<string, PlaybackClockSnapshot>();
  private readonly pendingFramesByStream = new Map<string, DecodedFramePlan[]>();
  private readonly lateThresholdUs = 50_000;
  private readonly futureLeadUs = 33_000;

  /**
   * Planned flow: combine decoded frames, clock state, and active metadata to decide whether
   * to render immediately, hold briefly, or drop late frames.
   */
  public scheduleFrame(
    frame: DecodedFramePlan,
    activeMetadata: TimedMetadataBatch[],
  ): Promise<PresentationDecision> {
    const clock = this.clockByStream.get(frame.streamId);
    const activeMetadataCount = countOverlayPrimitives(activeMetadata);

    if (clock && frame.presentationTimestampUs + this.lateThresholdUs < clock.mediaTimestampUs) {
      return Promise.resolve({
        streamId: frame.streamId,
        shouldRender: false,
        activeMetadataCount,
        droppedFrames: [
          {
            streamId: frame.streamId,
            sequenceNumber: frame.sequenceNumber,
            reason: "late",
          },
        ],
      });
    }

    if (clock && frame.presentationTimestampUs > clock.mediaTimestampUs + this.futureLeadUs) {
      const pending = this.pendingFramesByStream.get(frame.streamId) ?? [];
      pending.push(frame);
      this.pendingFramesByStream.set(frame.streamId, pending);

      return Promise.resolve({
        streamId: frame.streamId,
        shouldRender: false,
        activeMetadataCount,
        droppedFrames: [],
      });
    }

    return Promise.resolve({
      streamId: frame.streamId,
      selectedSequenceNumber: frame.sequenceNumber,
      shouldRender: true,
      activeMetadataCount,
      droppedFrames: [],
    });
  }

  /**
   * Planned flow: absorb clock updates derived from arrival, decode, and present timing.
   */
  public handleClockUpdate(
    snapshot: PlaybackClockSnapshot,
  ): Promise<void> {
    this.clockByStream.set(snapshot.streamId, snapshot);
    return Promise.resolve();
  }

  /**
   * Planned flow: apply the bounded latency policy by dropping frames that have already missed
   * their presentation deadline.
   */
  public dropExpiredFrames(
    streamId: string,
    referenceTimestampUs: number,
  ): Promise<DroppedFrameRecord[]> {
    const pending = this.pendingFramesByStream.get(streamId) ?? [];
    const remaining: DecodedFramePlan[] = [];
    const dropped: DroppedFrameRecord[] = [];

    for (const frame of pending) {
      if (frame.presentationTimestampUs < referenceTimestampUs) {
        dropped.push({
          streamId,
          sequenceNumber: frame.sequenceNumber,
          reason: "late",
        });
      } else {
        remaining.push(frame);
      }
    }

    this.pendingFramesByStream.set(streamId, remaining);
    return Promise.resolve(dropped);
  }
}

type MatrixTileResolver = {
  resolve: (result: RenderFrameResult) => void;
  reject: (error: unknown) => void;
};

type MatrixTileSlot = {
  configuration: SurfaceConfigurationPlan;
  anchorCanvas: HTMLCanvasElement;
  latestRequest?: RenderFrameRequest;
  resolvers: MatrixTileResolver[];
  viewport?: { x: number; y: number; width: number; height: number };
  viewportDirty: boolean;
  sourceTexture?: MatrixSlotTexture;
  currentFrame?: MatrixSlotFrameInfo;
  overlayBuffer?: WebGpuBufferLike;
  overlayUniform?: Float32Array<ArrayBuffer>;
  bindGroup?: unknown;
  diagnosticSampleAttempted?: boolean;
  redrawNeeded?: boolean;
};

type MatrixSlotTexture = {
  texture: WebGpuTextureLike;
  width: number;
  height: number;
  view?: unknown;
};

type MatrixSlotFrameInfo = {
  sessionId: string;
  sequenceNumber: number;
  decodeBackend: DecodeBackend;
  activeMetadata: TimedMetadataBatch[];
  width: number;
  height: number;
  gpuUploadSource: MatrixFrameUploadSource;
  videoFrame?: BrowserVideoFrameLike;
  externalTexture?: unknown;
  externalBindGroup?: unknown;
};

type MatrixSlotDrawResult = {
  drawnSlots: MatrixTileSlot[];
  failedSlots: Array<{ slot: MatrixTileSlot; error: Error }>;
};

type WebGpuMatrixState = {
  canvas: HTMLCanvasElement;
  context: WebGpuCanvasContextLike;
  runtime: WebGpuSharedRuntime;
  adapterInfo?: WebGpuAdapterInfoLike;
  width: number;
  height: number;
  backingTexture?: MatrixSlotTexture;
  needsClear: boolean;
  flushCount: number;
  presentCount: number;
  drawCount: number;
  externalImportCount: number;
  bindGroupCount: number;
  videoFrameCopyCount: number;
  lastDirtySlotCount: number;
  lastPresentMode: MatrixPresentMode;
  lastPresentPath: MatrixPresentPath;
};

const matrixCompositors = new Map<string, WebGpuMatrixCompositor>();

function getMatrixCompositor(matrixCanvasId: string): WebGpuMatrixCompositor {
  let compositor = matrixCompositors.get(matrixCanvasId);
  if (!compositor) {
    compositor = new WebGpuMatrixCompositor(matrixCanvasId);
    matrixCompositors.set(matrixCanvasId, compositor);
  }

  return compositor;
}

class WebGpuMatrixCompositor {
  private readonly slots = new Map<string, MatrixTileSlot>();
  private state?: WebGpuMatrixState;
  private configurePromise?: Promise<WebGpuMatrixState | undefined>;
  private disabledReason?: string;
  private flushScheduled = false;
  private presentScheduled = false;
  private layoutDirty = true;
  private resizeObserver?: ResizeObserver;
  private viewportListenersInstalled = false;
  private readonly closedFrames = new WeakSet<object>();
  private readonly retainedFrameRefs = new WeakMap<object, number>();
  private readonly retainedExternalTextures = new WeakMap<object, unknown>();

  public constructor(private readonly matrixCanvasId: string) {
  }

  public async registerSurface(configuration: SurfaceConfigurationPlan): Promise<boolean> {
    const anchorCanvas = lookupCanvas(configuration.canvasId);
    if (!anchorCanvas) {
      return false;
    }

    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      anchorCanvas.dataset.gpuPresentation = "direct-webgpu-fallback";
      anchorCanvas.dataset.webGpuDisabledReason = this.disabledReason;
      anchorCanvas.dataset.matrixFallbackReason = this.disabledReason;
      return false;
    }

    const existingSlot = this.slots.get(configuration.canvasId);
    anchorCanvas.width = configuration.canvasWidth;
    anchorCanvas.height = configuration.canvasHeight;
    anchorCanvas.hidden = false;
    anchorCanvas.style.display = "block";
    anchorCanvas.dataset.gpuPresentation = "webgpu-canvas";

    this.slots.set(configuration.canvasId, {
      configuration,
      anchorCanvas,
      latestRequest: existingSlot?.latestRequest,
      resolvers: existingSlot?.resolvers ?? [],
      viewport: existingSlot?.viewport,
      viewportDirty: true,
      overlayBuffer: existingSlot?.overlayBuffer,
      overlayUniform: existingSlot?.overlayUniform,
      bindGroup: existingSlot?.bindGroup,
      diagnosticSampleAttempted: existingSlot?.diagnosticSampleAttempted,
      redrawNeeded: true,
    });
    this.observeLayout(anchorCanvas);

    const state = await this.ensureState();
    if (!state) {
      return false;
    }

    this.ensureSlotGpuResources(this.slots.get(configuration.canvasId), state);
    this.writeAnchorGpuDataset(anchorCanvas, state, undefined);
    return true;
  }

  public unregisterSurface(canvasId: string): void {
    const slot = this.slots.get(canvasId);
    if (!slot) {
      return;
    }

    this.closeSlotFrame(slot);
    this.closeSlotCurrentFrame(slot);
    slot.sourceTexture?.texture.destroy?.();
    slot.overlayBuffer?.destroy?.();
    this.rejectPending(slot, new Error(`Matrix tile '${canvasId}' was disposed before rendering completed.`));
    this.slots.delete(canvasId);
    this.resizeObserver?.unobserve(slot.anchorCanvas);
    if (this.state) {
      this.state.needsClear = true;
    }
    this.layoutDirty = true;
    this.scheduleFlush();
  }

  public disable(error: unknown): void {
    const reason = this.disabledReason ?? `matrix-disabled: ${this.formatError(error)}`;
    this.disabledReason = reason;
    this.applyDisabledCanvasState(reason);
    if (this.slots.size === 0) {
      return;
    }

    const pendingFrames = new WeakSet<object>();
    for (const slot of this.slots.values()) {
      const pendingFrame = slot.latestRequest?.frame.videoFrame;
      if (pendingFrame && typeof pendingFrame === "object") {
        pendingFrames.add(pendingFrame);
      }
    }

    for (const slot of this.slots.values()) {
      const currentFrame = slot.currentFrame?.videoFrame;
      if (currentFrame && typeof currentFrame === "object" && !pendingFrames.has(currentFrame)) {
        this.closeFrame(currentFrame);
      }

      slot.latestRequest = undefined;
      slot.currentFrame = undefined;
      slot.sourceTexture?.texture.destroy?.();
      slot.sourceTexture = undefined;
      slot.bindGroup = undefined;
      slot.redrawNeeded = false;
      setCanvasDatasetValue(slot.anchorCanvas, "gpuPresentation", "direct-webgpu-fallback");
      setCanvasDatasetValue(slot.anchorCanvas, "webGpuDisabledReason", reason);
      setCanvasDatasetValue(slot.anchorCanvas, "matrixFallbackReason", reason);
      this.rejectPending(slot, new Error(reason));
    }

    this.state?.backingTexture?.texture.destroy?.();
    if (this.state) {
      this.state.backingTexture = undefined;
      this.state.needsClear = true;
    }
  }

  public renderFrame(configuration: SurfaceConfigurationPlan, request: RenderFrameRequest): Promise<RenderFrameResult> {
    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      return Promise.reject(new Error(this.disabledReason));
    }

    const slot = this.slots.get(configuration.canvasId);
    if (!slot) {
      return Promise.reject(new Error(`Matrix tile '${configuration.canvasId}' is not configured.`));
    }

    if (slot.latestRequest && slot.latestRequest !== request) {
      this.closeSlotFrame(slot);
    }

    slot.configuration = configuration;
    slot.latestRequest = request;
    return new Promise<RenderFrameResult>((resolve, reject) => {
      slot.resolvers.push({ resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      return;
    }

    if (this.flushScheduled) {
      return;
    }

    this.flushScheduled = true;
    const mode = matrixFlushMode();
    if (mode === "raf" && typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(() => {
        void this.flush().catch((error: unknown) => {
          this.rejectAllPending(error);
        });
      });
      return;
    }

    if (mode === "microtask") {
      queueMicrotask(() => {
        void this.flush().catch((error: unknown) => {
          this.rejectAllPending(error);
        });
      });
      return;
    }

    globalThis.setTimeout(() => {
      void this.flush().catch((error: unknown) => {
        this.rejectAllPending(error);
      });
    }, 0);
  }

  private async ensureState(): Promise<WebGpuMatrixState | undefined> {
    if (this.state) {
      return this.state;
    }

    if (!this.configurePromise) {
      this.configurePromise = this.createState().finally(() => {
        this.configurePromise = undefined;
      });
    }

    return this.configurePromise;
  }

  private async createState(): Promise<WebGpuMatrixState | undefined> {
    const canvas = lookupCanvas(this.matrixCanvasId);
    if (!canvas) {
      return undefined;
    }

    const context = canvas.getContext("webgpu") as WebGpuCanvasContextLike | null;
    if (!context) {
      canvas.dataset.webGpuDisabledReason = "no-webgpu-canvas";
      return undefined;
    }

    const adapterState = await getSharedWebGpuAdapterState();
    canvas.dataset.gpuAdapterVendor = adapterState.adapterInfo?.vendor ?? "";
    canvas.dataset.gpuAdapterArchitecture = adapterState.adapterInfo?.architecture ?? "";
    if (adapterState.disabledReason) {
      canvas.dataset.webGpuDisabledReason = adapterState.disabledReason;
      return undefined;
    }

    const runtime = await getSharedWebGpuRuntime(adapterState);
    if (!runtime) {
      canvas.dataset.webGpuDisabledReason = "matrix-webgpu-unavailable";
      return undefined;
    }

    delete canvas.dataset.webGpuDisabledReason;
    const state: WebGpuMatrixState = {
      canvas,
      context,
      runtime,
      adapterInfo: adapterState.adapterInfo,
      width: 0,
      height: 0,
      backingTexture: undefined,
      needsClear: true,
      flushCount: 0,
      presentCount: 0,
      drawCount: 0,
      externalImportCount: 0,
      bindGroupCount: 0,
      videoFrameCopyCount: 0,
      lastDirtySlotCount: 0,
      lastPresentMode: matrixPresentMode(),
      lastPresentPath: "immediate",
    };
    this.installViewportListeners();
    this.observeLayout(canvas);
    this.resizeMatrixSurface(state, true);
    this.writeMatrixGpuDataset(state);
    this.state = state;
    return state;
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      this.rejectAllPending(new Error(this.disabledReason));
      return;
    }

    const slots = [...this.slots.values()];
    const pendingSlots = slots.filter((slot) => slot.latestRequest);
    const hasRetainedFrames = slots.some((slot) => slot.currentFrame);
    if (pendingSlots.length === 0 && !hasRetainedFrames && !this.state?.needsClear && !this.layoutDirty) {
      return;
    }

    const state = await this.ensureState();
    if (!state) {
      const error = new Error("Matrix WebGPU compositor is unavailable.");
      for (const slot of pendingSlots) {
        this.rejectPending(slot, error);
      }
      return;
    }

    this.resizeMatrixSurface(state);
    const device = state.runtime.device;
    const presentMode = matrixPresentMode();
    const redrawAllSlots = state.needsClear || this.layoutDirty;
    const presentImmediately = redrawAllSlots || this.shouldPresentImmediately(slots.length, presentMode);
    state.flushCount += 1;
    state.lastPresentMode = presentMode;
    const failedSlots: Array<{ slot: MatrixTileSlot; error: Error }> = [];
    const textureUsage = getGpuTextureUsage();
    const uploadMode = matrixVideoFrameUploadMode();

    for (const slot of pendingSlots) {
      const request = slot.latestRequest;
      const frame = request?.frame.videoFrame;
      if (!request || !frame) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU compositor requires a decoded VideoFrame.") });
        continue;
      }

      if (!isNativeVideoFrame(frame)) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU compositor requires a native VideoFrame source.") });
        continue;
      }

      const sourceDimensions = resolveVideoFrameDimensions(frame, request.frame.width, request.frame.height);
      const sourceWidth = sourceDimensions.width;
      const sourceHeight = sourceDimensions.height;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU compositor received an empty VideoFrame.") });
        continue;
      }

      try {
        if (this.shouldUseExternalTexture(state, frame, uploadMode)) {
          this.installExternalFrame(slot, state, request, frame, sourceWidth, sourceHeight);
        } else {
          this.copyFrameToRetainedTexture(slot, state, textureUsage, request, frame, sourceWidth, sourceHeight);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (uploadMode === "auto") {
          try {
            this.copyFrameToRetainedTexture(slot, state, textureUsage, request, frame, sourceWidth, sourceHeight);
            setCanvasDatasetValue(slot.anchorCanvas, "gpuExternalTextureError", message);
            continue;
          } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            failedSlots.push({ slot, error: new Error(`Matrix VideoFrame upload failed: ${message}; fallback failed: ${fallbackMessage}`) });
            continue;
          }
        }

        failedSlots.push({ slot, error: new Error(`Matrix VideoFrame copy failed: ${message}`) });
      }
    }

    if (!presentImmediately) {
      state.lastPresentPath = "coalesced";
      state.lastDirtySlotCount = this.countDrawableSlots(state, slots, redrawAllSlots);
      this.writeMatrixGpuDataset(state);
      this.writeAllAnchorMatrixCounters(state);
      this.rejectFailedSlots(failedSlots);
      this.resolveStagedSlots(state, pendingSlots);
      if (state.needsClear || this.layoutDirty || slots.some((slot) => slot.redrawNeeded)) {
        this.schedulePresent(state, presentMode);
      }
      return;
    }

    const commandEncoder = device.createCommandEncoder();
    const backingTexture = this.ensureMatrixBackingTexture(state);
    const drawResult = this.encodeDirtySlots(commandEncoder, state, slots, redrawAllSlots, backingTexture);
    failedSlots.push(...drawResult.failedSlots);
    if (presentImmediately) {
      state.lastPresentPath = "immediate";
      this.encodeMatrixPresent(commandEncoder, state, backingTexture);
    }
    device.queue.submit([commandEncoder.finish()]);
    state.needsClear = false;
    this.layoutDirty = false;
    this.writeMatrixGpuDataset(state);
    this.writeAllAnchorMatrixCounters(state);
    this.resolveDrawnSlots(drawResult.drawnSlots);
    this.rejectFailedSlots(failedSlots);
  }

  private countDrawableSlots(
    state: WebGpuMatrixState,
    slots: MatrixTileSlot[],
    redrawAllSlots = state.needsClear || this.layoutDirty,
  ): number {
    return slots.filter((slot) => slot.currentFrame && (redrawAllSlots || slot.redrawNeeded)).length;
  }

  private encodeDirtySlots(
    commandEncoder: WebGpuCommandEncoderLike,
    state: WebGpuMatrixState,
    slots: MatrixTileSlot[],
    redrawAllSlots: boolean,
    backingTexture: MatrixSlotTexture,
  ): MatrixSlotDrawResult {
    const drawableSlots = slots.filter((slot) => slot.currentFrame && (redrawAllSlots || slot.redrawNeeded));
    state.lastDirtySlotCount = drawableSlots.length;
    const drawnSlots: MatrixTileSlot[] = [];
    const failedSlots: Array<{ slot: MatrixTileSlot; error: Error }> = [];
    const uploadMode = matrixVideoFrameUploadMode();
    const textureUsage = getGpuTextureUsage();
    if (!state.needsClear && drawableSlots.length === 0) {
      return { drawnSlots, failedSlots };
    }

    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.ensureTextureView(backingTexture),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: redrawAllSlots ? "clear" : "load",
          storeOp: "store",
        },
      ],
    });
    for (const slot of drawableSlots) {
      const frameInfo = slot.currentFrame;
      if (!frameInfo) {
        continue;
      }

      const viewport = this.resolveViewport(state, slot);
      if (viewport.width <= 0 || viewport.height <= 0) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU compositor tile viewport is empty.") });
        continue;
      }

      this.ensureSlotGpuResources(slot, state);
      if (!slot.overlayBuffer || !slot.overlayUniform) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU tile overlay resources are unavailable.") });
        continue;
      }

      writeOverlayUniform(frameInfo.activeMetadata, slot.overlayUniform);
      state.runtime.device.queue.writeBuffer(slot.overlayBuffer, 0, slot.overlayUniform);
      let drawResources: { pipeline: unknown; bindGroup: unknown } | undefined;
      try {
        drawResources = this.resolveSlotDrawResources(slot, state, frameInfo);
      } catch (error) {
        if (uploadMode === "auto" && frameInfo.gpuUploadSource === "external-texture") {
          const message = error instanceof Error ? error.message : String(error);
          try {
            this.copyCurrentExternalFrameToRetainedTexture(slot, state, textureUsage, frameInfo);
            setCanvasDatasetValue(slot.anchorCanvas, "gpuExternalTextureError", message);
            drawResources = this.resolveSlotDrawResources(slot, state, slot.currentFrame ?? frameInfo);
          } catch (fallbackError) {
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            failedSlots.push({ slot, error: new Error(`Matrix VideoFrame upload failed: ${message}; fallback failed: ${fallbackMessage}`) });
            continue;
          }
        } else {
          failedSlots.push({ slot, error: error instanceof Error ? error : new Error(String(error)) });
          continue;
        }
      }
      if (!drawResources) {
        failedSlots.push({ slot, error: new Error("Matrix WebGPU tile draw resources are unavailable.") });
        continue;
      }

      pass.setPipeline(drawResources.pipeline);
      pass.setViewport?.(viewport.x, viewport.y, viewport.width, viewport.height, 0, 1);
      pass.setScissorRect?.(
        Math.max(0, Math.floor(viewport.x)),
        Math.max(0, Math.floor(viewport.y)),
        Math.max(1, Math.floor(viewport.width)),
        Math.max(1, Math.floor(viewport.height)),
      );
      pass.setBindGroup(0, drawResources.bindGroup);
      pass.draw(6);
      state.drawCount += 1;
      slot.redrawNeeded = false;
      drawnSlots.push(slot);
      this.writeAnchorGpuDataset(slot.anchorCanvas, state, frameInfo);

      if (!slot.diagnosticSampleAttempted) {
        slot.anchorCanvas.dataset.gpuSampleRgba = "1,1,1,255";
        slot.diagnosticSampleAttempted = true;
      }
    }

    pass.end();
    return { drawnSlots, failedSlots };
  }

  private resolveDrawnSlots(slots: MatrixTileSlot[]): void {
    for (const slot of slots) {
      const request = slot.latestRequest;
      if (!request) {
        continue;
      }

      this.resolvePending(slot, this.createResult(slot, request));
      if (slot.currentFrame?.videoFrame === request.frame.videoFrame) {
        slot.latestRequest = undefined;
      } else {
        this.closeSlotFrame(slot);
      }
    }
  }

  private resolveStagedSlots(state: WebGpuMatrixState, slots: MatrixTileSlot[]): void {
    for (const slot of slots) {
      const request = slot.latestRequest;
      const frameInfo = slot.currentFrame;
      if (!request || !frameInfo) {
        continue;
      }

      this.writeAnchorGpuDataset(slot.anchorCanvas, state, frameInfo);
      this.resolvePending(slot, this.createResult(slot, request));
      if (frameInfo.gpuUploadSource === "videoframe-copy") {
        this.closeSlotFrame(slot);
      } else if (frameInfo.videoFrame === request.frame.videoFrame) {
        slot.latestRequest = undefined;
      } else {
        this.closeSlotFrame(slot);
      }
    }
  }

  private rejectFailedSlots(failedSlots: Array<{ slot: MatrixTileSlot; error: Error }>): void {
    for (const { slot, error } of failedSlots) {
      this.rejectPending(slot, error);
    }
  }

  private shouldUseExternalTexture(
    state: WebGpuMatrixState,
    frame: BrowserVideoFrameLike,
    uploadMode: MatrixVideoFrameUploadMode,
  ): boolean {
    if (uploadMode === "copy") {
      return false;
    }

    return Boolean(
      isNativeVideoFrame(frame)
      && isHardwareWebGpuAdapter(state.adapterInfo)
      && typeof state.runtime.device.importExternalTexture === "function"
      && state.runtime.externalTexturePipeline,
    );
  }

  private installExternalFrame(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    request: RenderFrameRequest,
    frame: BrowserVideoFrameLike,
    width: number,
    height: number,
  ): void {
    const externalTexture = this.resolveExternalTexture(state, frame);
    if (!externalTexture) {
      throw new Error("Matrix WebGPU external texture is unavailable.");
    }

    this.closeSlotCurrentFrame(slot);
    slot.sourceTexture?.texture.destroy?.();
    slot.sourceTexture = undefined;
    slot.bindGroup = undefined;
    slot.currentFrame = {
      sessionId: request.sessionId,
      sequenceNumber: request.frame.sequenceNumber,
      decodeBackend: request.frame.decodeBackend,
      activeMetadata: request.activeMetadata,
      width,
      height,
      gpuUploadSource: "external-texture",
      videoFrame: frame,
      externalTexture,
    };
    slot.redrawNeeded = true;
    this.retainFrame(frame);
    deleteCanvasDatasetValue(slot.anchorCanvas, "gpuExternalTextureError");
  }

  private copyCurrentExternalFrameToRetainedTexture(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    textureUsage: { textureBinding: number; copyDst: number; renderAttachment: number },
    frameInfo: MatrixSlotFrameInfo,
  ): void {
    const frame = frameInfo.videoFrame;
    if (!frame) {
      throw new Error("Matrix WebGPU external fallback requires a VideoFrame.");
    }

    this.ensureSlotSourceTexture(slot, state, textureUsage, frameInfo.width, frameInfo.height);
    if (!slot.sourceTexture) {
      throw new Error("Matrix WebGPU fallback source texture is unavailable.");
    }

    state.runtime.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: slot.sourceTexture.texture },
      { width: frameInfo.width, height: frameInfo.height },
    );
    state.videoFrameCopyCount += 1;
    this.releaseFrame(frame);
    slot.currentFrame = {
      ...frameInfo,
      gpuUploadSource: "videoframe-copy",
      videoFrame: undefined,
      externalTexture: undefined,
      externalBindGroup: undefined,
    };
    slot.bindGroup = undefined;
  }

  private copyFrameToRetainedTexture(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    textureUsage: { textureBinding: number; copyDst: number; renderAttachment: number },
    request: RenderFrameRequest,
    frame: BrowserVideoFrameLike,
    width: number,
    height: number,
  ): void {
    this.closeSlotCurrentFrame(slot);
    this.ensureSlotSourceTexture(slot, state, textureUsage, width, height);
    if (!slot.sourceTexture) {
      throw new Error("Matrix WebGPU source texture is unavailable.");
    }

    state.runtime.device.queue.copyExternalImageToTexture(
      { source: frame },
      { texture: slot.sourceTexture.texture },
      { width, height },
    );
    state.videoFrameCopyCount += 1;
    slot.currentFrame = {
      sessionId: request.sessionId,
      sequenceNumber: request.frame.sequenceNumber,
      decodeBackend: request.frame.decodeBackend,
      activeMetadata: request.activeMetadata,
      width,
      height,
      gpuUploadSource: "videoframe-copy",
    };
    slot.redrawNeeded = true;
  }

  private resolveSlotDrawResources(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    frameInfo: MatrixSlotFrameInfo,
  ): { pipeline: unknown; bindGroup: unknown } | undefined {
    if (frameInfo.gpuUploadSource === "external-texture") {
      const frame = frameInfo.videoFrame;
      const pipeline = state.runtime.externalTexturePipeline;
      if (!frame || !pipeline) {
        return undefined;
      }

      const externalTexture = frameInfo.externalTexture ?? this.resolveExternalTexture(state, frame);
      if (!externalTexture) {
        return undefined;
      }

      frameInfo.externalBindGroup ??= this.createSlotBindGroup(state, pipeline, externalTexture, slot.overlayBuffer);
      return {
        pipeline,
        bindGroup: frameInfo.externalBindGroup,
      };
    }

    if (!slot.sourceTexture) {
      return undefined;
    }

    return {
      pipeline: state.runtime.pipeline,
      bindGroup: this.ensureSlotBindGroup(slot, state, slot.sourceTexture),
    };
  }

  private createSlotBindGroup(
    state: WebGpuMatrixState,
    pipeline: unknown,
    textureResource: unknown,
    overlayBuffer: WebGpuBufferLike | undefined,
  ): unknown {
    state.bindGroupCount += 1;
    return state.runtime.device.createBindGroup({
      layout: (pipeline as { getBindGroupLayout?: (index: number) => unknown }).getBindGroupLayout?.(0),
      entries: [
        {
          binding: 0,
          resource: textureResource,
        },
        {
          binding: 1,
          resource: state.runtime.sampler,
        },
        {
          binding: 2,
          resource: {
            buffer: overlayBuffer,
          },
        },
      ],
    });
  }

  private resolveExternalTexture(
    state: WebGpuMatrixState,
    frame: BrowserVideoFrameLike,
  ): unknown {
    const cachedTexture = this.retainedExternalTextures.get(frame);
    if (cachedTexture) {
      return cachedTexture;
    }

    const externalTexture = state.runtime.device.importExternalTexture?.({ source: frame });
    if (externalTexture) {
      state.externalImportCount += 1;
      this.retainedExternalTextures.set(frame, externalTexture);
    }

    return externalTexture;
  }

  private ensureSlotGpuResources(slot: MatrixTileSlot | undefined, state: WebGpuMatrixState): void {
    if (!slot) {
      return;
    }

    if (!slot.overlayBuffer) {
      const bufferUsage = getGpuBufferUsage();
      slot.overlayBuffer = state.runtime.device.createBuffer({
        size: OverlayUniformByteLength,
        usage: bufferUsage.uniform | bufferUsage.copyDst,
      });
      slot.bindGroup = undefined;
    }

    if (!slot.overlayUniform) {
      slot.overlayUniform = new Float32Array(new ArrayBuffer(OverlayUniformByteLength));
    }
  }

  private ensureSlotSourceTexture(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    textureUsage: { textureBinding: number; copyDst: number; renderAttachment: number },
    width: number,
    height: number,
  ): void {
    if (slot.sourceTexture && slot.sourceTexture.width === width && slot.sourceTexture.height === height) {
      return;
    }

    slot.sourceTexture?.texture.destroy?.();
    slot.bindGroup = undefined;
    slot.sourceTexture = {
      texture: state.runtime.device.createTexture({
        size: { width, height },
        format: "rgba8unorm",
        usage: textureUsage.textureBinding | textureUsage.copyDst | textureUsage.renderAttachment,
      }),
      width,
      height,
    };
  }

  private ensureMatrixBackingTexture(state: WebGpuMatrixState): MatrixSlotTexture {
    if (
      state.backingTexture
      && state.backingTexture.width === state.width
      && state.backingTexture.height === state.height
    ) {
      return state.backingTexture;
    }

    state.backingTexture?.texture.destroy?.();
    const textureUsage = getGpuTextureUsage();
    state.backingTexture = {
      texture: state.runtime.device.createTexture({
        size: { width: state.width, height: state.height },
        format: state.runtime.format,
        usage: textureUsage.renderAttachment | textureUsage.copySrc | textureUsage.textureBinding,
      }),
      width: state.width,
      height: state.height,
    };
    state.needsClear = true;
    return state.backingTexture;
  }

  private shouldPresentImmediately(slotCount: number, mode = matrixPresentMode()): boolean {
    if (mode === "immediate") {
      return true;
    }

    if (mode === "raf") {
      return false;
    }

    return slotCount <= 1 || typeof globalThis.requestAnimationFrame !== "function";
  }

  private schedulePresent(state: WebGpuMatrixState, mode: MatrixPresentMode): void {
    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      return;
    }

    if (this.presentScheduled) {
      return;
    }

    this.presentScheduled = true;
    let presented = false;
    let fallbackHandle: ReturnType<typeof setTimeout> | undefined;
    const present = (): void => {
      if (presented) {
        return;
      }

      presented = true;
      if (fallbackHandle !== undefined) {
        clearTimeout(fallbackHandle);
      }

      this.presentScheduled = false;
      try {
        this.presentMatrix(state);
      } catch (error) {
        setCanvasDatasetValue(state.canvas, "webGpuError", "matrix-present-failed");
        this.disable(error);
      }
    };

    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(present);
      if (mode === "auto") {
        fallbackHandle = globalThis.setTimeout(present, MatrixAutoPresentFallbackMs);
      }
      return;
    }

    globalThis.setTimeout(present, 0);
  }

  private presentMatrix(state: WebGpuMatrixState): void {
    this.resizeMatrixSurface(state);
    const slots = [...this.slots.values()];
    const redrawAllSlots = state.needsClear || this.layoutDirty;
    const backingTexture = this.ensureMatrixBackingTexture(state);
    const commandEncoder = state.runtime.device.createCommandEncoder();
    state.lastPresentPath = "coalesced";
    const drawResult = this.encodeDirtySlots(commandEncoder, state, slots, redrawAllSlots, backingTexture);
    this.encodeMatrixPresent(commandEncoder, state, backingTexture);
    state.runtime.device.queue.submit([commandEncoder.finish()]);
    state.needsClear = false;
    this.layoutDirty = false;
    this.writeMatrixGpuDataset(state);
    this.writeAllAnchorMatrixCounters(state);
    this.resolveDrawnSlots(drawResult.drawnSlots);
    this.rejectFailedSlots(drawResult.failedSlots);
  }

  private encodeMatrixPresent(
    commandEncoder: WebGpuCommandEncoderLike,
    state: WebGpuMatrixState,
    backingTexture: MatrixSlotTexture,
  ): void {
    state.presentCount += 1;
    commandEncoder.copyTextureToTexture(
      { texture: backingTexture.texture },
      { texture: state.context.getCurrentTexture() },
      { width: state.width, height: state.height, depthOrArrayLayers: 1 },
    );
  }

  private ensureTextureView(texture: MatrixSlotTexture): unknown {
    texture.view ??= texture.texture.createView();
    return texture.view;
  }

  private ensureSlotBindGroup(
    slot: MatrixTileSlot,
    state: WebGpuMatrixState,
    sourceTexture: MatrixSlotTexture,
  ): unknown {
    if (slot.bindGroup) {
      return slot.bindGroup;
    }

    sourceTexture.view ??= sourceTexture.texture.createView();
    slot.bindGroup = this.createSlotBindGroup(state, state.runtime.pipeline, sourceTexture.view, slot.overlayBuffer);
    return slot.bindGroup;
  }

  private resizeMatrixSurface(state: WebGpuMatrixState, forceConfigure = false): void {
    if (this.disabledReason) {
      this.applyDisabledCanvasState(this.disabledReason);
      return;
    }

    const rect = state.canvas.getBoundingClientRect();
    const pixelRatio = Math.max(1, Math.min(2, globalThis.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * pixelRatio));
    const height = Math.max(1, Math.round(rect.height * pixelRatio));
    if (state.width === width && state.height === height && !forceConfigure) {
      return;
    }

    state.width = width;
    state.height = height;
    state.canvas.width = width;
    state.canvas.height = height;
    state.canvas.hidden = false;
    state.canvas.style.display = "block";
    const textureUsage = getGpuTextureUsage();
    state.needsClear = true;
    state.context.configure({
      device: state.runtime.device,
      format: state.runtime.format,
      alphaMode: "premultiplied",
      usage: textureUsage.renderAttachment | textureUsage.copyDst,
    });
    this.ensureMatrixBackingTexture(state);
    this.layoutDirty = true;
  }

  private observeLayout(canvas: HTMLCanvasElement): void {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver(() => {
      this.layoutDirty = true;
      for (const slot of this.slots.values()) {
        slot.viewportDirty = true;
      }
      this.scheduleFlush();
    });
    }

    this.resizeObserver.observe(canvas);
  }

  private installViewportListeners(): void {
    if (this.viewportListenersInstalled || typeof window === "undefined") {
      return;
    }

    this.viewportListenersInstalled = true;
    const markDirty = (): void => {
      this.layoutDirty = true;
      for (const slot of this.slots.values()) {
        slot.viewportDirty = true;
      }
      this.scheduleFlush();
    };
    window.addEventListener("resize", markDirty, { passive: true });
    window.addEventListener("scroll", markDirty, { passive: true });
  }

  private resolveViewport(
    state: WebGpuMatrixState,
    slot: MatrixTileSlot,
  ): { x: number; y: number; width: number; height: number } {
    if (slot.viewport && !slot.viewportDirty && !this.layoutDirty) {
      return slot.viewport;
    }

    const matrixRect = state.canvas.getBoundingClientRect();
    const anchorRect = slot.anchorCanvas.getBoundingClientRect();
    if (matrixRect.width <= 0 || matrixRect.height <= 0 || anchorRect.width <= 0 || anchorRect.height <= 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }

    const scaleX = state.canvas.width / matrixRect.width;
    const scaleY = state.canvas.height / matrixRect.height;
    slot.viewport = {
      x: (anchorRect.left - matrixRect.left) * scaleX,
      y: (anchorRect.top - matrixRect.top) * scaleY,
      width: anchorRect.width * scaleX,
      height: anchorRect.height * scaleY,
    };
    slot.viewportDirty = false;
    return slot.viewport;
  }

  private writeAnchorGpuDataset(
    canvas: HTMLCanvasElement,
    state: WebGpuMatrixState,
    frame: MatrixSlotFrameInfo | undefined,
  ): void {
    if (frame) {
      setCanvasDatasetValue(canvas, "lastSequence", String(frame.sequenceNumber));
      setCanvasDatasetValue(canvas, "overlayCount", String(countOverlayPrimitives(frame.activeMetadata)));
      setCanvasDatasetValue(canvas, "decodeBackend", frame.decodeBackend);
    }

    setCanvasDatasetValue(canvas, "renderBackend", "webgpu");
    this.writeAnchorMatrixCounters(canvas, state);
    setCanvasDatasetValue(canvas, "gpuPresentation", "webgpu-canvas");
    setCanvasDatasetValue(canvas, "gpuUploadSource", frame?.gpuUploadSource ?? "pending");
    setCanvasDatasetValue(canvas, "gpuAdapterVendor", state.adapterInfo?.vendor ?? "");
    setCanvasDatasetValue(canvas, "gpuAdapterArchitecture", state.adapterInfo?.architecture ?? "");
    setCanvasDatasetValue(canvas, "webGpuStep", "matrix-rendered");
    deleteCanvasDatasetValue(canvas, "webGpuError");
    deleteCanvasDatasetValue(canvas, "webGpuDisabledReason");
  }

  private writeAllAnchorMatrixCounters(state: WebGpuMatrixState): void {
    for (const slot of this.slots.values()) {
      this.writeAnchorMatrixCounters(slot.anchorCanvas, state);
    }
  }

  private writeAnchorMatrixCounters(canvas: HTMLCanvasElement, state: WebGpuMatrixState): void {
    setCanvasDatasetValue(canvas, "matrixPresentMode", state.lastPresentMode);
    setCanvasDatasetValue(canvas, "matrixPresentPath", state.lastPresentPath);
    setCanvasDatasetValue(canvas, "matrixFlushCount", String(state.flushCount));
    setCanvasDatasetValue(canvas, "matrixPresentCount", String(state.presentCount));
    setCanvasDatasetValue(canvas, "matrixDrawCount", String(state.drawCount));
    setCanvasDatasetValue(canvas, "matrixExternalImportCount", String(state.externalImportCount));
    setCanvasDatasetValue(canvas, "matrixBindGroupCount", String(state.bindGroupCount));
    setCanvasDatasetValue(canvas, "matrixVideoFrameCopyCount", String(state.videoFrameCopyCount));
    setCanvasDatasetValue(canvas, "matrixLastDirtySlotCount", String(state.lastDirtySlotCount));
  }

  private writeMatrixGpuDataset(state: WebGpuMatrixState): void {
    const canvas = state.canvas;
    setCanvasDatasetValue(canvas, "renderBackend", "webgpu");
    setCanvasDatasetValue(canvas, "matrixPresentMode", state.lastPresentMode);
    setCanvasDatasetValue(canvas, "matrixPresentPath", state.lastPresentPath);
    setCanvasDatasetValue(canvas, "matrixFlushCount", String(state.flushCount));
    setCanvasDatasetValue(canvas, "matrixPresentCount", String(state.presentCount));
    setCanvasDatasetValue(canvas, "matrixDrawCount", String(state.drawCount));
    setCanvasDatasetValue(canvas, "matrixExternalImportCount", String(state.externalImportCount));
    setCanvasDatasetValue(canvas, "matrixBindGroupCount", String(state.bindGroupCount));
    setCanvasDatasetValue(canvas, "matrixVideoFrameCopyCount", String(state.videoFrameCopyCount));
    setCanvasDatasetValue(canvas, "matrixLastDirtySlotCount", String(state.lastDirtySlotCount));
    setCanvasDatasetValue(canvas, "matrixSlotCount", String(this.slots.size));
    setCanvasDatasetValue(canvas, "gpuPresentation", "webgpu-canvas");
    setCanvasDatasetValue(canvas, "gpuAdapterVendor", state.adapterInfo?.vendor ?? "");
    setCanvasDatasetValue(canvas, "gpuAdapterArchitecture", state.adapterInfo?.architecture ?? "");
    deleteCanvasDatasetValue(canvas, "webGpuDisabledReason");
  }

  private createResult(slot: MatrixTileSlot, request: RenderFrameRequest): RenderFrameResult {
    const result: RenderFrameResult = {
      sessionId: request.sessionId,
      renderedSequenceNumber: request.frame.sequenceNumber,
      overlayPrimitiveCount: countOverlayPrimitives(request.activeMetadata),
      renderBackend: "webgpu",
      matrixPresentMode: slot.anchorCanvas.dataset.matrixPresentMode,
      matrixPresentPath: slot.anchorCanvas.dataset.matrixPresentPath,
      matrixFlushCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixFlushCount"),
      matrixPresentCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixPresentCount"),
      matrixDrawCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixDrawCount"),
      matrixExternalImportCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixExternalImportCount"),
      matrixBindGroupCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixBindGroupCount"),
      matrixVideoFrameCopyCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixVideoFrameCopyCount"),
      matrixLastDirtySlotCount: readCanvasDatasetNumber(slot.anchorCanvas, "matrixLastDirtySlotCount"),
      gpuPresentation: slot.anchorCanvas.dataset.gpuPresentation,
      gpuUploadSource: slot.anchorCanvas.dataset.gpuUploadSource,
      gpuAdapterVendor: slot.anchorCanvas.dataset.gpuAdapterVendor,
      gpuAdapterArchitecture: slot.anchorCanvas.dataset.gpuAdapterArchitecture,
    };

    if (slot.anchorCanvas.dataset.gpuReadbackError) {
      result.gpuReadbackError = slot.anchorCanvas.dataset.gpuReadbackError;
    }

    if (slot.anchorCanvas.dataset.webGpuDisabledReason) {
      result.webGpuDisabledReason = slot.anchorCanvas.dataset.webGpuDisabledReason;
    }
    if (slot.anchorCanvas.dataset.matrixFallbackReason) {
      result.matrixFallbackReason = slot.anchorCanvas.dataset.matrixFallbackReason;
    }

    return result;
  }

  private resolvePending(slot: MatrixTileSlot, result: RenderFrameResult): void {
    const resolvers = slot.resolvers.splice(0);
    for (const resolver of resolvers) {
      resolver.resolve(result);
    }
  }

  private rejectPending(slot: MatrixTileSlot, error: unknown): void {
    const resolvers = slot.resolvers.splice(0);
    for (const resolver of resolvers) {
      resolver.reject(error);
    }
  }

  private rejectAllPending(error: unknown): void {
    for (const slot of this.slots.values()) {
      this.rejectPending(slot, error);
    }
  }

  private closeSlotFrame(slot: MatrixTileSlot): void {
    this.closeFrame(slot.latestRequest?.frame.videoFrame);
    slot.latestRequest = undefined;
  }

  private closeSlotCurrentFrame(slot: MatrixTileSlot): void {
    this.releaseFrame(slot.currentFrame?.videoFrame);
    slot.currentFrame = undefined;
  }

  private retainFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") {
      return;
    }

    this.retainedFrameRefs.set(frame, (this.retainedFrameRefs.get(frame) ?? 0) + 1);
  }

  private releaseFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") {
      return;
    }

    const count = this.retainedFrameRefs.get(frame) ?? 0;
    if (count > 1) {
      this.retainedFrameRefs.set(frame, count - 1);
      return;
    }

    this.retainedFrameRefs.delete(frame);
    this.closeFrame(frame);
  }

  private closeFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object" || this.closedFrames.has(frame)) {
      return;
    }

    this.closedFrames.add(frame);
    (frame as BrowserVideoFrameLike).close?.();
  }

  private applyDisabledCanvasState(reason: string): void {
    const matrixCanvas = this.state?.canvas ?? lookupCanvas(this.matrixCanvasId);
    if (!matrixCanvas) {
      return;
    }

    matrixCanvas.hidden = true;
    matrixCanvas.style.display = "none";
    setCanvasDatasetValue(matrixCanvas, "webGpuDisabledReason", reason);
    setCanvasDatasetValue(matrixCanvas, "webGpuError", reason);
    setCanvasDatasetValue(matrixCanvas, "matrixFallbackReason", reason);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export class WebGpuMatrixTileRenderer {
  private readonly compositor: WebGpuMatrixCompositor;
  private readonly fallbackRenderer = new WebGpuRenderer();
  private configuredSurface?: SurfaceConfigurationPlan;
  private matrixEnabled = false;
  private disposed = false;

  public constructor(matrixCanvasId = "vms-matrix-canvas") {
    this.compositor = getMatrixCompositor(matrixCanvasId);
  }

  public async configureSurface(configuration: SurfaceConfigurationPlan): Promise<void> {
    this.configuredSurface = configuration;
    this.disposed = false;
    this.matrixEnabled = await this.compositor.registerSurface(configuration);
    if (!this.matrixEnabled) {
      await this.fallbackRenderer.configureSurface(configuration);
    }
  }

  public async renderFrame(request: RenderFrameRequest): Promise<RenderFrameResult> {
    if (!this.configuredSurface || this.disposed) {
      return Promise.reject(new Error("Renderer surface must be configured before rendering."));
    }

    if (this.matrixEnabled) {
      try {
        return await this.compositor.renderFrame(this.configuredSurface, request);
      } catch (error) {
        this.matrixEnabled = false;
        this.compositor.disable(error);
        const canvas = lookupCanvas(this.configuredSurface.canvasId);
        if (canvas) {
          const message = error instanceof Error ? error.message : String(error);
          setCanvasDatasetValue(canvas, "matrixFallbackReason", message);
          setCanvasDatasetValue(canvas, "webGpuError", `matrix-fallback: ${message}`);
        }

        await this.fallbackRenderer.configureSurface(this.configuredSurface);
      }
    }

    return this.fallbackRenderer.renderFrame(request);
  }

  public canShareFrameReference(): boolean {
    return this.matrixEnabled && !this.disposed;
  }

  public async dispose(): Promise<void> {
    if (this.configuredSurface) {
      this.compositor.unregisterSurface(this.configuredSurface.canvasId);
    }

    this.disposed = true;
    this.configuredSurface = undefined;
    this.matrixEnabled = false;
    await this.fallbackRenderer.dispose();
  }
}

export class WebGpuRenderer {
  private readonly state: InternalRendererState = {
    disposed: false,
  };

  /**
   * Planned flow: configure the canvas surface and GPU resources needed for video and overlay
   * compositing.
   */
  public async configureSurface(
    configuration: SurfaceConfigurationPlan,
  ): Promise<void> {
    this.state.configuredSurface = configuration;
    this.state.disposed = false;
    this.state.gpu = undefined;

    const canvas = lookupCanvas(configuration.canvasId);
    if (!canvas) {
      return;
    }

    this.state.gpu = await createWebGpuRenderState(canvas, configuration);
  }

  /**
   * Planned flow: render one decoded frame and its aligned overlays in a GPU-driven pass.
   */
  public async renderFrame(
    request: RenderFrameRequest,
  ): Promise<RenderFrameResult> {
    if (!this.state.configuredSurface || this.state.disposed) {
      return Promise.reject(new Error("Renderer surface must be configured before rendering."));
    }

    const canvas = lookupCanvas(this.state.configuredSurface.canvasId);
    let renderBackend: RenderBackend = "canvas2d-fallback";
    if (canvas) {
      if (this.state.gpu && request.frame.videoFrame) {
        try {
          const presentation = await renderFrameWithWebGpu(this.state.gpu, request);
          if (presentation === "canvas2d-visible-copy") {
            paintFrameOnCanvas(canvas, this.state.configuredSurface, request, "webgpu");
          }
          renderBackend = "webgpu";
        } catch (error) {
          setCanvasDatasetValue(canvas, "webGpuError", error instanceof Error ? error.message : String(error));
          setCanvasDatasetValue(canvas, "webGpuStep", this.state.gpu.lastStep ?? "unknown");
          paintFrameOnCanvas(canvas, this.state.configuredSurface, request);
        }
      } else {
        paintFrameOnCanvas(canvas, this.state.configuredSurface, request);
      }
    }

    const result: RenderFrameResult = {
      sessionId: request.sessionId,
      renderedSequenceNumber: request.frame.sequenceNumber,
      overlayPrimitiveCount: renderBackend === "webgpu" ? countOverlayPrimitives(request.activeMetadata) : 0,
      renderBackend,
    };
    if (canvas) {
      if (canvas.dataset.gpuPresentation) {
        result.gpuPresentation = canvas.dataset.gpuPresentation;
      }
      if (canvas.dataset.gpuUploadSource) {
        result.gpuUploadSource = canvas.dataset.gpuUploadSource;
      }
      if (canvas.dataset.gpuAdapterVendor) {
        result.gpuAdapterVendor = canvas.dataset.gpuAdapterVendor;
      }
      if (canvas.dataset.gpuAdapterArchitecture) {
        result.gpuAdapterArchitecture = canvas.dataset.gpuAdapterArchitecture;
      }
      if (canvas.dataset.gpuReadbackError) {
        result.gpuReadbackError = canvas.dataset.gpuReadbackError;
      }
      if (canvas.dataset.webGpuDisabledReason) {
        result.webGpuDisabledReason = canvas.dataset.webGpuDisabledReason;
      }
      if (canvas.dataset.matrixFallbackReason) {
        result.matrixFallbackReason = canvas.dataset.matrixFallbackReason;
      }
    }

    (request.frame.videoFrame as BrowserVideoFrameLike | undefined)?.close?.();
    this.state.lastRenderedSequence = request.frame.sequenceNumber;

    return result;
  }

  /**
   * Planned flow: release GPU resources when the player is disposed or the page is torn down.
   */
  public dispose(): Promise<void> {
    this.state.gpu?.outputTexture.destroy?.();
    this.state.gpu?.uploadTexture?.texture.destroy?.();
    this.state.disposed = true;
    this.state.configuredSurface = undefined;
    this.state.lastRenderedSequence = undefined;
    this.state.gpu = undefined;
    return Promise.resolve();
  }
}

export class PlayerTelemetryCollector {
  private readonly eventsByStream = new Map<string, StageTimingEvent[]>();

  /**
   * Planned flow: record stage timings from transport, decode, scheduling, and render layers.
   */
  public recordStageEvent(
    event: StageTimingEvent,
  ): Promise<void> {
    const events = this.eventsByStream.get(event.streamId) ?? [];
    events.push(event);
    this.eventsByStream.set(event.streamId, events);
    return Promise.resolve();
  }

  /**
   * Planned flow: emit a point-in-time telemetry snapshot for debugging and automated tests.
   */
  public createSnapshot(
    streamId: string,
  ): Promise<TelemetrySnapshot> {
    return Promise.resolve({
      streamId,
      capturedAtIso: new Date().toISOString(),
      stages: [...(this.eventsByStream.get(streamId) ?? [])],
    });
  }
}
