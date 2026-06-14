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
  StageTimingEvent,
  StreamDiscontinuity,
  SurfaceConfigurationPlan,
  TelemetrySnapshot,
  TimedMetadataBatch,
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

type WebTransportWireEndFrame = {
  kind: "end";
};

type WebTransportWireFrame =
  | WebTransportWireVideoFrame
  | WebTransportWireMetadataFrame
  | WebTransportWireEndFrame;

interface WebTransportReadResult {
  videoMessages: VideoTransportMessage[];
  metadataMessages: MetadataTransportMessage[];
  bytesReceived: number;
  messagesReceived: number;
}

export type StreamingTransportFrame =
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
  device: WebGpuDeviceLike;
  format: string;
  outputTexture: WebGpuTextureLike;
  pipeline: unknown;
  externalTexturePipeline?: unknown;
  sampler: unknown;
  overlayBuffer: unknown;
  adapterInfo?: WebGpuAdapterInfoLike;
  lastSampleAtMs?: number;
  diagnosticSampleAttempted?: boolean;
  diagnosticSampleInFlight?: boolean;
};

type WebGpuCanvasPresentation = "webgpu-canvas" | "canvas2d-visible-copy";

const MoqVideoObjectFrameHeaderLength = 88;
const MoqVideoObjectFrameMagic = 0x4c514f4d;
const MoqVideoObjectFrameVersion = 1;
const MoqVideoObjectFrameKindVideo = 1;

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
  getCurrentTexture: () => { createView: () => unknown };
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
    writeTexture: (
      destination: Record<string, unknown>,
      data: BufferSource,
      dataLayout: Record<string, number>,
      size: Record<string, number>,
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

function appendBinaryChunk(existing: Uint8Array | undefined, chunk: Uint8Array): Uint8Array {
  if (!existing || existing.byteLength === 0) {
    return chunk;
  }

  const joined = new Uint8Array(existing.byteLength + chunk.byteLength);
  joined.set(existing, 0);
  joined.set(chunk, existing.byteLength);
  return joined;
}

function readMoqStreamingFrames(
  state: InternalTransportState,
  decoder: TextDecoder,
): StreamingTransportFrame[] {
  const pending = state.pendingBinary ?? new Uint8Array(0);
  const frames: StreamingTransportFrame[] = [];
  let offset = 0;

  while (pending.byteLength - offset >= MoqVideoObjectFrameHeaderLength) {
    const view = new DataView(pending.buffer, pending.byteOffset + offset, pending.byteLength - offset);
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
    if (pending.byteLength - offset < frameLength) {
      break;
    }

    let cursor = offset + MoqVideoObjectFrameHeaderLength;
    const streamId = decoder.decode(pending.subarray(cursor, cursor + streamIdLength));
    cursor += streamIdLength;
    const codecConfigVersion = decoder.decode(pending.subarray(cursor, cursor + codecConfigVersionLength));
    cursor += codecConfigVersionLength;
    const payload = pending.slice(cursor, cursor + payloadLength);
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

    offset = cursor;
  }

  state.pendingBinary = offset === pending.byteLength ? new Uint8Array(0) : pending.slice(offset);
  return frames;
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

function drawMetadataOverlay(
  context: CanvasRenderingContext2D,
  batch: TimedMetadataBatch,
  frameWidth: number,
  frameHeight: number,
  overlayColor: string,
): void {
  for (const [index, record] of batch.records.entries()) {
    const x = parseNormalizedCoordinate(record.tags.x, 0.08 + index * 0.1);
    const y = parseNormalizedCoordinate(record.tags.y, 0.12 + index * 0.08);
    const w = parseNormalizedCoordinate(record.tags.w, 0.18);
    const h = parseNormalizedCoordinate(record.tags.h, 0.14);
    const left = x * frameWidth;
    const top = y * frameHeight;
    const width = Math.max(24, w * frameWidth);
    const height = Math.max(20, h * frameHeight);

    context.strokeStyle = overlayColor;
    context.lineWidth = 4;
    context.strokeRect(left, top, width, height);

    const label = record.tags.label ?? record.eventType;
    context.fillStyle = "rgba(0, 0, 0, 0.68)";
    context.fillRect(left, Math.max(0, top - 26), Math.max(84, label.length * 10), 24);
    context.fillStyle = "#ffffff";
    context.font = "16px IBM Plex Sans, sans-serif";
    context.fillText(label, left + 8, Math.max(16, top - 10));
  }
}

function paintFrameOnCanvas(
  canvas: HTMLCanvasElement,
  configuration: SurfaceConfigurationPlan,
  request: RenderFrameRequest,
  renderBackend: RenderBackend = "canvas2d-fallback",
): void {
  canvas.width = configuration.canvasWidth;
  canvas.height = configuration.canvasHeight;
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

  context.fillStyle = "rgba(5, 10, 20, 0.62)";
  context.fillRect(24, 24, 420, 92);
  context.fillStyle = "#ffffff";
  context.font = "600 30px IBM Plex Sans, sans-serif";
  context.fillText(`Camera ${frame.streamId}`, 40, 60);
  context.font = "18px IBM Plex Sans, sans-serif";
  context.fillText(`Sequence ${frame.sequenceNumber}`, 40, 88);
  context.fillText(`PTS ${frame.presentationTimestampUs}`, 190, 88);

  for (const batch of request.activeMetadata) {
    drawMetadataOverlay(context, batch, width, height, palette.overlay);
  }

  if (request.debugOverlayEnabled) {
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(width - 256, height - 58, 224, 34);
    context.fillStyle = "#fef2df";
    context.font = "16px IBM Plex Mono, monospace";
    context.fillText(`overlay=${countOverlayPrimitives(request.activeMetadata)}`, width - 240, height - 36);
  }

  canvas.dataset.lastSequence = String(frame.sequenceNumber);
  canvas.dataset.overlayCount = String(countOverlayPrimitives(request.activeMetadata));
  canvas.dataset.decodeBackend = frame.decodeBackend;
  canvas.dataset.renderBackend = renderBackend;
  if (renderBackend === "webgpu") {
    canvas.dataset.gpuPresentation = "canvas2d-visible-copy";
  } else {
    delete canvas.dataset.gpuPresentation;
    delete canvas.dataset.gpuUploadSource;
  }
}

const webGpuVideoShader = `
struct Overlay {
  rect: vec4f,
};

@group(0) @binding(0) var videoTexture: texture_2d<f32>;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;

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

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  var color = textureSample(videoTexture, videoSampler, input.uv);
  let rect = overlay.rect;
  let right = rect.x + rect.z;
  let bottom = rect.y + rect.w;
  let inside = input.uv.x >= rect.x && input.uv.x <= right && input.uv.y >= rect.y && input.uv.y <= bottom;
  let borderWidth = 0.008;
  let border = inside && (
    abs(input.uv.x - rect.x) < borderWidth ||
    abs(input.uv.x - right) < borderWidth ||
    abs(input.uv.y - rect.y) < borderWidth ||
    abs(input.uv.y - bottom) < borderWidth
  );

  if (border) {
    return vec4f(1.0, 0.84, 0.12, 1.0);
  }

  return vec4f(color.rgb, 1.0);
}
`;

const webGpuExternalVideoShader = `
struct Overlay {
  rect: vec4f,
};

@group(0) @binding(0) var videoTexture: texture_external;
@group(0) @binding(1) var videoSampler: sampler;
@group(0) @binding(2) var<uniform> overlay: Overlay;

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

@fragment
fn fragmentMain(input: VertexOut) -> @location(0) vec4f {
  var color = textureSampleBaseClampToEdge(videoTexture, videoSampler, input.uv);
  let rect = overlay.rect;
  let right = rect.x + rect.z;
  let bottom = rect.y + rect.w;
  let inside = input.uv.x >= rect.x && input.uv.x <= right && input.uv.y >= rect.y && input.uv.y <= bottom;
  let borderWidth = 0.008;
  let border = inside && (
    abs(input.uv.x - rect.x) < borderWidth ||
    abs(input.uv.x - right) < borderWidth ||
    abs(input.uv.y - rect.y) < borderWidth ||
    abs(input.uv.y - bottom) < borderWidth
  );

  if (border) {
    return vec4f(1.0, 0.84, 0.12, 1.0);
  }

  return vec4f(color.rgb, 1.0);
}
`;

function getFirstOverlayRect(activeMetadata: TimedMetadataBatch[]): Float32Array {
  const record = activeMetadata.flatMap((batch) => batch.records)[0];
  if (!record) {
    return new Float32Array([-1, -1, 0, 0]);
  }

  return new Float32Array([
    parseNormalizedCoordinate(record.tags.x, 0.08),
    parseNormalizedCoordinate(record.tags.y, 0.12),
    parseNormalizedCoordinate(record.tags.w, 0.18),
    parseNormalizedCoordinate(record.tags.h, 0.14),
  ]);
}

async function createWebGpuRenderState(
  canvas: HTMLCanvasElement,
  configuration: SurfaceConfigurationPlan,
): Promise<WebGpuRenderState | undefined> {
  const gpu = getWebGpuNavigator();
  if (!gpu) {
    return undefined;
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) {
    return undefined;
  }

  const adapterInfo = adapter.info;
  canvas.dataset.gpuAdapterVendor = adapterInfo?.vendor ?? "";
  canvas.dataset.gpuAdapterArchitecture = adapterInfo?.architecture ?? "";
  if (!isHardwareWebGpuAdapter(adapterInfo)) {
    canvas.dataset.webGpuDisabledReason = "software-adapter";
    return undefined;
  }

  delete canvas.dataset.webGpuDisabledReason;
  const device = await adapter.requestDevice();
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
  const bufferUsage = getGpuBufferUsage();
  const overlayBuffer = device.createBuffer({
    size: 16,
    usage: bufferUsage.uniform | bufferUsage.copyDst,
  });
  const textureUsage = getGpuTextureUsage();
  const outputTexture = device.createTexture({
    size: { width: configuration.canvasWidth, height: configuration.canvasHeight },
    format,
    usage: textureUsage.renderAttachment | textureUsage.copySrc | textureUsage.textureBinding,
  });

  canvas.width = configuration.canvasWidth;
  canvas.height = configuration.canvasHeight;
  canvas.hidden = false;
  canvas.style.display = "block";

  let context: WebGpuCanvasContextLike | undefined;
  const candidate = canvas.getContext("webgpu") as WebGpuCanvasContextLike | null;
  if (candidate) {
    candidate.configure({
      device,
      format,
      alphaMode: "premultiplied",
      usage: textureUsage.renderAttachment | textureUsage.copyDst,
    });
    context = candidate;
  }

  return {
    canvas,
    context,
    device,
    format,
    outputTexture,
    pipeline,
    externalTexturePipeline,
    sampler,
    overlayBuffer,
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
    state.canvas.dataset.webGpuStep = step;
  };

  const sourceWidth = (frame as { width?: number; displayWidth?: number }).width
    ?? (frame as { displayWidth?: number }).displayWidth
    ?? request.frame.width;
  const sourceHeight = (frame as { height?: number; displayHeight?: number }).height
    ?? (frame as { displayHeight?: number }).displayHeight
    ?? request.frame.height;
  const textureUsage = getGpuTextureUsage();
  const bufferUsage = getGpuBufferUsage();
  const nowMs = performance.now();
  const shouldSample = !state.diagnosticSampleAttempted && !state.diagnosticSampleInFlight;

  let activePipeline = state.pipeline;
  let sourceResource: unknown | undefined;
  let sourceTexture: WebGpuTextureLike | undefined;
  let gpuSource: unknown = frame;
  let shouldCloseGpuSource = false;
  const canImportExternalTexture = Boolean(isNativeVideoFrame(frame)
    && isHardwareWebGpuAdapter(state.adapterInfo)
    && typeof state.device.importExternalTexture === "function"
    && state.externalTexturePipeline);

  if (canImportExternalTexture) {
    try {
      markStep("import-external-texture");
      sourceResource = state.device.importExternalTexture?.({ source: frame });
      activePipeline = state.externalTexturePipeline ?? state.pipeline;
      state.canvas.dataset.gpuUploadSource = "external-texture";
      delete state.canvas.dataset.gpuExternalTextureError;
    } catch (error) {
      state.canvas.dataset.gpuExternalTextureError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!sourceResource) {
    markStep("create-source-texture");
    sourceTexture = state.device.createTexture({
      size: { width: sourceWidth, height: sourceHeight },
      format: "rgba8unorm",
      usage: textureUsage.textureBinding | textureUsage.copyDst | textureUsage.renderAttachment,
    });
    markStep("create-image-source");
    gpuSource = !isNativeVideoFrame(frame) && typeof createImageBitmap === "function"
      ? await createImageBitmap(frame as ImageBitmapSource)
      : frame;
    shouldCloseGpuSource = gpuSource !== frame;

    markStep("prepare-upload-canvas");
    const uploadCanvas = document.createElement("canvas");
    uploadCanvas.width = sourceWidth;
    uploadCanvas.height = sourceHeight;
    const uploadContext = uploadCanvas.getContext("2d");
    if (!uploadContext) {
      throw new Error("WebGPU upload requires a 2D upload canvas in this browser.");
    }

    markStep("draw-upload-canvas");
    uploadContext.drawImage(gpuSource as CanvasImageSource, 0, 0, sourceWidth, sourceHeight);
    if (isNativeVideoFrame(frame)) {
      markStep("write-texture-upload");
      const imageData = uploadContext.getImageData(0, 0, sourceWidth, sourceHeight);
      state.device.queue.writeTexture(
        { texture: sourceTexture },
        imageData.data,
        {
          bytesPerRow: sourceWidth * 4,
          rowsPerImage: sourceHeight,
        },
        { width: sourceWidth, height: sourceHeight },
      );
      state.canvas.dataset.gpuUploadSource = "write-texture-upload";
    } else {
      try {
        markStep("copy-external-image");
        state.device.queue.copyExternalImageToTexture(
          { source: uploadCanvas },
          { texture: sourceTexture },
          { width: sourceWidth, height: sourceHeight },
        );
        state.canvas.dataset.gpuUploadSource = "canvas-upload";
      } catch {
        markStep("write-texture-upload");
        const imageData = uploadContext.getImageData(0, 0, sourceWidth, sourceHeight);
        state.device.queue.writeTexture(
          { texture: sourceTexture },
          imageData.data,
          {
            bytesPerRow: sourceWidth * 4,
            rowsPerImage: sourceHeight,
          },
          { width: sourceWidth, height: sourceHeight },
        );
        state.canvas.dataset.gpuUploadSource = "write-texture-upload";
      }
    }
    sourceResource = sourceTexture.createView();
  }

  const overlayRect = getFirstOverlayRect(request.activeMetadata);
  const overlayUniform = new Float32Array(4);
  overlayUniform.set(overlayRect);
  markStep("write-overlay-buffer");
  state.device.queue.writeBuffer(state.overlayBuffer, 0, overlayUniform.buffer);

  markStep("create-bind-group");
  const bindGroup = state.device.createBindGroup({
    layout: (activePipeline as { getBindGroupLayout?: (index: number) => unknown }).getBindGroupLayout?.(0),
    entries: [
      {
        binding: 0,
        resource: sourceResource,
      },
      {
        binding: 1,
        resource: state.sampler,
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
  const commandEncoder = state.device.createCommandEncoder();
  markStep("begin-render-pass");
  const pass = commandEncoder.beginRenderPass({
    colorAttachments: [
      {
        view: state.outputTexture.createView(),
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
    markStep("present-webgpu-canvas");
    commandEncoder.copyTextureToTexture(
      { texture: state.outputTexture },
      { texture: state.context.getCurrentTexture() },
      { width: state.canvas.width, height: state.canvas.height },
    );
    presentation = "webgpu-canvas";
  }
  markStep("finish-command-buffer");
  const commandBuffer = commandEncoder.finish();
  markStep("submit-command-buffer");
  state.device.queue.submit([commandBuffer]);
  if (shouldSample) {
    state.diagnosticSampleAttempted = true;
    state.diagnosticSampleInFlight = true;
    state.lastSampleAtMs = nowMs;
    void sampleWebGpuOutput(state, bufferUsage).finally(() => {
      state.diagnosticSampleInFlight = false;
    });
  }
  markStep("cleanup");
  sourceTexture?.destroy?.();
  if (shouldCloseGpuSource) {
    (gpuSource as { close?: () => void }).close?.();
  }

  state.canvas.dataset.lastSequence = String(request.frame.sequenceNumber);
  state.canvas.dataset.overlayCount = String(countOverlayPrimitives(request.activeMetadata));
  state.canvas.dataset.decodeBackend = request.frame.decodeBackend;
  state.canvas.dataset.renderBackend = "webgpu";
  state.canvas.dataset.gpuPresentation = presentation;
  state.canvas.dataset.gpuAdapterVendor = state.adapterInfo?.vendor ?? "";
  state.canvas.dataset.gpuAdapterArchitecture = state.adapterInfo?.architecture ?? "";
  delete state.canvas.dataset.webGpuError;
  markStep("rendered");
  return presentation;
}

async function sampleWebGpuOutput(state: WebGpuRenderState, bufferUsage: Record<string, number>): Promise<void> {
  const sampleBuffer = state.device.createBuffer({
    size: 256,
    usage: bufferUsage.copyDst | bufferUsage.mapRead,
  });

  try {
    const commandEncoder = state.device.createCommandEncoder();
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
    state.device.queue.submit([commandEncoder.finish()]);
    await state.device.queue.onSubmittedWorkDone?.();
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
          if (moqFrames && (state.pendingBinary?.byteLength ?? 0) > 0) {
            throw new Error("Continuous WebTransport MoQ object ended with a truncated frame.");
          }

          break;
        }

        const chunk = result.value;
        state.handle.webTransportBytesReceived += chunk.byteLength;
        if (moqFrames) {
          state.pendingBinary = appendBinaryChunk(state.pendingBinary, chunk);
          for (const frame of readMoqStreamingFrames(state, decoder)) {
            yield frame;
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
    this.decoder?.close?.();
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
        const payload = new Uint8Array(chunk.payload);
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
        this.decoder?.close?.();
        this.decoder = undefined;
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

  public dispose(): void {
    this.decoder?.close?.();
    this.decoder = undefined;
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
  }
}

export class OverlayTimelineStore {
  private readonly batchesByStream = new Map<string, TimedMetadataBatch[]>();

  /**
   * Planned flow: store metadata batches in a bounded timeline keyed by presentation time.
   */
  public ingestBatch(
    batch: TimedMetadataBatch,
  ): Promise<void> {
    const existing = this.batchesByStream.get(batch.streamId) ?? [];
    existing.push(batch);
    existing.sort((left, right) => left.batchStartTimestampUs - right.batchStartTimestampUs);
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
          canvas.dataset.webGpuError = error instanceof Error ? error.message : String(error);
          paintFrameOnCanvas(canvas, this.state.configuredSurface, request);
        }
      } else {
        paintFrameOnCanvas(canvas, this.state.configuredSurface, request);
      }
    }

    const result: RenderFrameResult = {
      sessionId: request.sessionId,
      renderedSequenceNumber: request.frame.sequenceNumber,
      overlayPrimitiveCount: countOverlayPrimitives(request.activeMetadata),
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
