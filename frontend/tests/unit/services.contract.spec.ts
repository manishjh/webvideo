import { describe, expect, it, vi } from "vitest";
import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PlayerTelemetryCollector,
  PresentationScheduler,
  type StreamingTransportFrame,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebGpuMatrixTileRenderer,
  WebPlayerBootstrap,
  WebTransportIngestClient,
} from "../../src/contracts/services";
import type {
  DecodedFramePlan,
  EncodedChunkEmission,
  PlayerSessionHandle,
  PlayerSessionRequest,
  PlaybackClockSnapshot,
  RenderFrameRequest,
  StageTimingEvent,
  StreamDiscontinuity,
  SurfaceConfigurationPlan,
  TimedMetadataBatch,
  TransportConnectionHandle,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../../src/contracts/models";

function createPlayerRequest(): PlayerSessionRequest {
  return {
    channelId: "channel-001",
    streamId: "camera-001",
    viewerId: "viewer-001",
    targetLatencyMs: 150,
    enableMetadata: true,
  };
}

function createSessionHandle(): PlayerSessionHandle {
  return {
    sessionId: "session-001",
    channelId: "channel-001",
    streamId: "camera-001",
    viewerId: "viewer-001",
  };
}

function createEndpoint(): TransportEndpointDescriptor {
  return {
    channelId: "channel-001",
    streamId: "camera-001",
    webTransportUrl: "https://localhost:9443/live/channel-001",
    authToken: "token",
    metadataChannelRequired: true,
    requestedTransport: "webtransport-quic",
    allowHttpFallback: true,
    targetLatencyMs: 150,
    desiredEgressFrameRate: 24,
    desiredMaxCodedWidth: 1920,
    desiredMaxCodedHeight: 1080,
  };
}

function createConnection(): TransportConnectionHandle {
  return {
    connectionId: "connection-001",
    channelId: "channel-001",
    streamId: "camera-001",
    requestedTransport: "webtransport-quic",
    activeTransport: "http-seeded-fallback",
    webTransportReady: false,
    webTransportBytesReceived: 0,
    webTransportMessagesReceived: 0,
  };
}

function createVideoMessage(): VideoTransportMessage {
  return {
    streamId: "camera-001",
    sequenceNumber: 101,
    presentationTimestampUs: 2_000_000,
    decodeTimestampUs: 2_000_000,
    keyFrame: true,
    codecConfigVersion: "cfg-001",
    payload: new Uint8Array(),
  };
}

function createChunk(): EncodedChunkEmission {
  return {
    streamId: "camera-001",
    sequenceNumber: 101,
    encodedChunkType: "key",
    presentationTimestampUs: 2_000_000,
    payload: new Uint8Array(),
  };
}

function createDiscontinuity(): StreamDiscontinuity {
  return {
    streamId: "camera-001",
    reason: "packet-loss",
    sequenceNumber: 101,
  };
}

function createDecoderConfig(): VideoCodecConfiguration {
  return {
    codec: "avc1",
    codedWidth: 1280,
    codedHeight: 720,
  };
}

function createFrame(): DecodedFramePlan {
  return {
    streamId: "camera-001",
    sequenceNumber: 101,
    presentationTimestampUs: 2_000_000,
    width: 1280,
    height: 720,
    decodeBackend: "synthetic-frame-plan",
  };
}

function createMetadataBatch(): TimedMetadataBatch {
  return {
    streamId: "camera-001",
    batchStartTimestampUs: 2_000_000,
    batchEndTimestampUs: 2_033_333,
    records: [
      {
        eventId: "evt-1",
        eventType: "box2d",
        startTimestampUs: 2_000_000,
        endTimestampUs: 2_033_333,
        coordinateSpace: "normalized-video",
        tags: { label: "ball" },
      },
    ],
  };
}

function createClockSnapshot(): PlaybackClockSnapshot {
  return {
    streamId: "camera-001",
    mediaTimestampUs: 2_000_000,
    monotonicNowMs: 1000,
    clockSkewMs: 3,
  };
}

function createSurfaceConfiguration(): SurfaceConfigurationPlan {
  return {
    canvasId: "player-canvas",
    canvasWidth: 1280,
    canvasHeight: 720,
    outputColorSpace: "srgb",
  };
}

function createRenderRequest(): RenderFrameRequest {
  return {
    sessionId: "session-001",
    frame: createFrame(),
    activeMetadata: [createMetadataBatch()],
    debugOverlayEnabled: true,
  };
}

function createStageTimingEvent(): StageTimingEvent {
  return {
    streamId: "camera-001",
    stageName: "decode.enqueue",
    latencyMs: 1.2,
    queueDepth: 2,
  };
}

function installDocumentStub(documentStub: Document): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    writable: true,
    value: documentStub,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "document", descriptor);
      return;
    }

    Reflect.deleteProperty(globalThis, "document");
  };
}

function installWebTransportStub(
  frames: Array<string | Uint8Array>,
  options: { errorAfterFrames?: boolean } = {},
): {
  restore: () => void;
  writes: string[];
  urls: string[];
} {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebTransport");
  const writes: string[] = [];
  const urls: string[] = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  class FakeWebTransport {
    public readonly ready = Promise.resolve();

    public constructor(url: string) {
      urls.push(url);
    }

    public createBidirectionalStream(): Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
    }> {
      let frameIndex = 0;
      const readable = new ReadableStream<Uint8Array>({
        pull(controller): void {
          if (frameIndex < frames.length) {
            const frame = frames[frameIndex];
            controller.enqueue(typeof frame === "string" ? encoder.encode(`${frame}\n`) : frame);
            frameIndex += 1;
            return;
          }

          if (options.errorAfterFrames) {
            controller.error(new Error("Connection lost."));
            return;
          }

          controller.close();
        },
      });
      const writable = new WritableStream<Uint8Array>({
        write(chunk): void {
          writes.push(decoder.decode(chunk));
        },
      });

      return Promise.resolve({ readable, writable });
    }

    public close(): void {
      // The stub closes when the readable stream drains.
    }
  }

  Object.defineProperty(globalThis, "WebTransport", {
    configurable: true,
    writable: true,
    value: FakeWebTransport,
  });

  return {
    writes,
    urls,
    restore: () => {
      if (descriptor) {
        Object.defineProperty(globalThis, "WebTransport", descriptor);
        return;
      }

      Reflect.deleteProperty(globalThis, "WebTransport");
    },
  };
}

function createMoqVideoObjectFrame(message: VideoTransportMessage, groupId = 1000, objectId = 0): Uint8Array {
  const encoder = new TextEncoder();
  const streamId = encoder.encode(message.streamId);
  const codecConfigVersion = encoder.encode(message.codecConfigVersion);
  const headerLength = 88;
  const bytes = new Uint8Array(headerLength + streamId.byteLength + codecConfigVersion.byteLength + message.payload.byteLength);
  const view = new DataView(bytes.buffer);
  bytes[0] = "M".charCodeAt(0);
  bytes[1] = "O".charCodeAt(0);
  bytes[2] = "Q".charCodeAt(0);
  bytes[3] = "L".charCodeAt(0);
  view.setUint8(4, 1);
  view.setUint8(5, 1);
  view.setUint8(6, message.keyFrame ? 1 : 0);
  view.setUint8(7, 0);
  view.setBigInt64(8, 1n, true);
  view.setBigInt64(16, BigInt(groupId), true);
  view.setBigInt64(24, BigInt(objectId), true);
  view.setBigInt64(32, 0n, true);
  view.setBigInt64(40, BigInt(message.sequenceNumber), true);
  view.setBigInt64(48, BigInt(message.presentationTimestampUs), true);
  view.setBigInt64(56, BigInt(message.decodeTimestampUs ?? message.presentationTimestampUs), true);
  view.setBigInt64(64, BigInt(message.sourceTimestampUnixTimeMs ?? 0), true);
  view.setBigInt64(72, BigInt(message.serverTimestampUnixTimeMs ?? 0), true);
  view.setUint32(80, message.payload.byteLength, true);
  view.setUint16(84, streamId.byteLength, true);
  view.setUint16(86, codecConfigVersion.byteLength, true);
  let offset = headerLength;
  bytes.set(streamId, offset);
  offset += streamId.byteLength;
  bytes.set(codecConfigVersion, offset);
  offset += codecConfigVersion.byteLength;
  bytes.set(message.payload, offset);
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

async function drainStreamingFrames(
  transport: WebTransportIngestClient,
  connection: TransportConnectionHandle,
): Promise<StreamingTransportFrame[]> {
  const frames: StreamingTransportFrame[] = [];
  for await (const frame of transport.readStreamingFrames(connection)) {
    frames.push(frame);
  }

  return frames;
}

function installFailingWebTransportStub(): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebTransport");

  class FailingWebTransport {
    public readonly ready = Promise.reject(new Error("webtransport unavailable"));

    public constructor(_url: string) {
    }
  }

  Object.defineProperty(globalThis, "WebTransport", {
    configurable: true,
    writable: true,
    value: FailingWebTransport,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(globalThis, "WebTransport", descriptor);
      return;
    }

    Reflect.deleteProperty(globalThis, "WebTransport");
  };
}

function createCanvasStub(): {
  canvas: HTMLCanvasElement;
  operations: string[];
} {
  const operations: string[] = [];
  const gradient = {
    addColorStop(offset: number, color: string): void {
      operations.push(`gradient-stop:${offset}:${color}`);
    },
  } as CanvasGradient;

  const context = {
    clearRect(...args: number[]): void {
      operations.push(`clearRect:${args.join(",")}`);
    },
    createLinearGradient(...args: number[]): CanvasGradient {
      operations.push(`createLinearGradient:${args.join(",")}`);
      return gradient;
    },
    fillRect(...args: number[]): void {
      operations.push(`fillRect:${args.join(",")}`);
    },
    drawImage(_source: CanvasImageSource, ...args: number[]): void {
      operations.push(`drawImage:${args.join(",")}`);
    },
    getImageData(width: number, height: number): ImageData {
      operations.push(`getImageData:${width},${height}`);
      return { data: new Uint8ClampedArray(width * height * 4) } as ImageData;
    },
    strokeRect(...args: number[]): void {
      operations.push(`strokeRect:${args.join(",")}`);
    },
    fillText(text: string, ...args: number[]): void {
      operations.push(`fillText:${text}:${args.join(",")}`);
    },
    fillStyle: "",
    strokeStyle: "",
    font: "",
    lineWidth: 0,
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    id: "player-canvas",
    width: 0,
    height: 0,
    hidden: true,
    style: { display: "none" },
    dataset: {} as Record<string, string>,
    getContext(contextId: string): CanvasRenderingContext2D | null {
      operations.push(`getContext:${contextId}`);
      return contextId === "2d" ? context : null;
    },
  } as unknown as HTMLCanvasElement;

  return {
    canvas,
    operations,
  };
}

function installWebCodecsStub(options: {
  isConfigSupported?: (configuration: Record<string, unknown>) => boolean;
  asyncErrorMessage?: string;
  closeThrows?: boolean;
} = {}): {
  restore: () => void;
  decodedChunks: Array<{ type: string; timestamp: number; byteLength: number }>;
  configurations: Array<Record<string, unknown>>;
  flushCalls: () => number;
  closedFrames: number[];
} {
  const videoDecoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  const encodedVideoChunkDescriptor = Object.getOwnPropertyDescriptor(globalThis, "EncodedVideoChunk");
  const decodedChunks: Array<{ type: string; timestamp: number; byteLength: number }> = [];
  const configurations: Array<Record<string, unknown>> = [];
  const closedFrames: number[] = [];
  let flushCount = 0;

  class FakeEncodedVideoChunk {
    public readonly type: string;
    public readonly timestamp: number;
    public readonly data: Uint8Array;

    public constructor(init: { type: string; timestamp: number; data: Uint8Array }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.data = init.data;
    }
  }

  class FakeVideoFrame {
    public readonly timestamp: number;
    public readonly displayWidth = 1280;
    public readonly displayHeight = 720;

    public constructor(timestamp: number) {
      this.timestamp = timestamp;
    }

    public close(): void {
      closedFrames.push(this.timestamp);
    }
  }

  class FakeVideoDecoder {
    private readonly output: (frame: FakeVideoFrame) => void;
    private readonly error: (error: Error) => void;

    public static isConfigSupported(configuration: Record<string, unknown>): Promise<{ supported: boolean }> {
      configurations.push(configuration);
      return Promise.resolve({ supported: options.isConfigSupported?.(configuration) ?? true });
    }

    public constructor(init: { output: (frame: FakeVideoFrame) => void; error: (error: Error) => void }) {
      this.output = init.output;
      this.error = init.error;
    }

    public configure(): void {
      // The fake decoder accepts every test configuration.
    }

    public decode(chunk: FakeEncodedVideoChunk): void {
      decodedChunks.push({
        type: chunk.type,
        timestamp: chunk.timestamp,
        byteLength: chunk.data.byteLength,
      });
      if (options.asyncErrorMessage) {
        this.error(new Error(options.asyncErrorMessage));
        return;
      }

      this.output(new FakeVideoFrame(chunk.timestamp));
    }

    public flush(): Promise<void> {
      flushCount += 1;
      return Promise.resolve();
    }

    public close(): void {
      if (options.closeThrows) {
        throw new Error("Cannot call 'close' on a closed codec.");
      }
    }
  }

  Object.defineProperty(globalThis, "EncodedVideoChunk", {
    configurable: true,
    writable: true,
    value: FakeEncodedVideoChunk,
  });
  Object.defineProperty(globalThis, "VideoDecoder", {
    configurable: true,
    writable: true,
    value: FakeVideoDecoder,
  });

  return {
    configurations,
    decodedChunks,
    closedFrames,
    flushCalls: () => flushCount,
    restore: () => {
      if (encodedVideoChunkDescriptor) {
        Object.defineProperty(globalThis, "EncodedVideoChunk", encodedVideoChunkDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "EncodedVideoChunk");
      }

      if (videoDecoderDescriptor) {
        Object.defineProperty(globalThis, "VideoDecoder", videoDecoderDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoDecoder");
      }
    },
  };
}

function installWebGpuStub(options: {
  adapterInfo?: { vendor?: string; architecture?: string };
  importExternalTexture?: boolean;
  importExternalTextureError?: string;
  rejectReadback?: boolean;
  requestAdapterNeverResolves?: boolean;
} = {}): {
  restore: () => void;
  operations: string[];
} {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const operations: string[] = [];
  const fakeDevice = {
    createShaderModule(descriptor?: Record<string, unknown>): unknown {
      operations.push("createShaderModule");
      const code = typeof descriptor?.code === "string" ? descriptor.code : "";
      if (/\bmeta\s*:/.test(code) || /\boverlay\.meta\b/.test(code)) {
        throw new Error("WGSL reserved identifier 'meta'");
      }
      return {};
    },
    createRenderPipeline(): unknown {
      operations.push("createRenderPipeline");
      return {};
    },
    createSampler(): unknown {
      operations.push("createSampler");
      return {};
    },
    createTexture(): unknown {
      operations.push("createTexture");
      return {
        createView(): unknown {
          operations.push("sourceTexture.createView");
          return {};
        },
        destroy(): void {
          operations.push("sourceTexture.destroy");
        },
      };
    },
    createBindGroup(): unknown {
      operations.push("createBindGroup");
      return {};
    },
    createBuffer(): unknown {
      operations.push("createBuffer");
      return {
        mapAsync(): Promise<void> {
          operations.push("mapAsync");
          if (options.rejectReadback) {
            return Promise.reject(new Error("readback failed"));
          }

          return Promise.resolve();
        },
        getMappedRange(): ArrayBuffer {
          operations.push("getMappedRange");
          return new Uint8Array([24, 48, 96, 255]).buffer;
        },
        unmap(): void {
          operations.push("unmap");
        },
        destroy(): void {
          operations.push("sampleBuffer.destroy");
        },
      };
    },
    createCommandEncoder(): unknown {
      operations.push("createCommandEncoder");
      return {
        beginRenderPass(descriptor?: { colorAttachments?: Array<{ loadOp?: string }> }): unknown {
          operations.push("beginRenderPass");
          if (descriptor?.colorAttachments?.[0]?.loadOp) {
            operations.push(`loadOp:${descriptor.colorAttachments[0].loadOp}`);
          }
          return {
            setPipeline(): void {
              operations.push("setPipeline");
            },
            setBindGroup(): void {
              operations.push("setBindGroup");
            },
            setViewport(): void {
              operations.push("setViewport");
            },
            setScissorRect(): void {
              operations.push("setScissorRect");
            },
            draw(): void {
              operations.push("draw");
            },
            end(): void {
              operations.push("endRenderPass");
            },
          };
        },
        copyTextureToTexture(): void {
          operations.push("copyTextureToTexture");
        },
        copyTextureToBuffer(): void {
          operations.push("copyTextureToBuffer");
        },
        finish(): unknown {
          operations.push("finish");
          return {};
        },
      };
    },
    importExternalTexture: options.importExternalTexture
      ? (): unknown => {
        operations.push("importExternalTexture");
        if (options.importExternalTextureError) {
          throw new Error(options.importExternalTextureError);
        }

        return {};
      }
      : undefined,
    queue: {
      writeBuffer(): void {
        operations.push("writeBuffer");
      },
      copyExternalImageToTexture(): void {
        operations.push("copyExternalImageToTexture");
      },
      submit(): void {
        operations.push("submit");
      },
      onSubmittedWorkDone(): Promise<void> {
        operations.push("onSubmittedWorkDone");
        return Promise.resolve();
      },
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      gpu: {
        getPreferredCanvasFormat(): string {
          operations.push("getPreferredCanvasFormat");
          return "rgba8unorm";
        },
        requestAdapter(): Promise<{ requestDevice: () => Promise<typeof fakeDevice> }> {
          operations.push("requestAdapter");
          if (options.requestAdapterNeverResolves) {
            return new Promise(() => undefined);
          }

          return Promise.resolve({
            info: options.adapterInfo,
            requestDevice(): Promise<typeof fakeDevice> {
              operations.push("requestDevice");
              return Promise.resolve(fakeDevice);
            },
          } as { info?: typeof options.adapterInfo; requestDevice: () => Promise<typeof fakeDevice> });
        },
      },
    },
  });

  return {
    operations,
    restore: () => {
      if (descriptor) {
        Object.defineProperty(globalThis, "navigator", descriptor);
        return;
      }

      Reflect.deleteProperty(globalThis, "navigator");
    },
  };
}

async function waitForGpuSample(canvas: HTMLCanvasElement): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (canvas.dataset.gpuSampleRgba) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

async function waitForGpuReadbackError(canvas: HTMLCanvasElement): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (canvas.dataset.gpuReadbackError) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("frontend service contracts", () => {
  it("exposes the expected public method arity", () => {
    const bootstrap = new WebPlayerBootstrap();
    const transport = new WebTransportIngestClient();
    const assembler = new EncodedChunkAssembler();
    const decoder = new VideoDecodeCoordinator();
    const metadata = new OverlayTimelineStore();
    const scheduler = new PresentationScheduler();
    const renderer = new WebGpuRenderer();
    const telemetry = new PlayerTelemetryCollector();

    expect(bootstrap.initializeSession.length).toBe(2);
    expect(bootstrap.disposeSession.length).toBe(1);
    expect(transport.connect.length).toBe(2);
    expect(transport.connectStreaming.length).toBe(2);
    expect(transport.readVideoMessages.length).toBe(2);
    expect(transport.readStreamingFrames.length).toBe(2);
    expect(transport.readMetadataMessages.length).toBe(2);
    expect(transport.closeConnection.length).toBe(1);
    expect(assembler.applyTransportMessage.length).toBe(1);
    expect(assembler.resetForDiscontinuity.length).toBe(1);
    expect(decoder.configureDecoder.length).toBe(1);
    expect(decoder.enqueueChunk.length).toBe(1);
    expect(decoder.flush.length).toBe(0);
    expect(decoder.drainDecodedFrames.length).toBe(0);
    expect(decoder.liveBacklogFrameCount.length).toBe(0);
    expect(decoder.dispose.length).toBe(0);
    expect(metadata.ingestBatch.length).toBe(1);
    expect(metadata.queryActiveMetadata.length).toBe(2);
    expect(metadata.clearWindow.length).toBe(1);
    expect(scheduler.scheduleFrame.length).toBe(2);
    expect(scheduler.handleClockUpdate.length).toBe(1);
    expect(scheduler.dropExpiredFrames.length).toBe(2);
    expect(renderer.configureSurface.length).toBe(1);
    expect(renderer.renderFrame.length).toBe(1);
    expect(renderer.dispose.length).toBe(0);
    expect(telemetry.recordStageEvent.length).toBe(1);
    expect(telemetry.createSnapshot.length).toBe(1);
  });

  it("bootstraps and disposes a player session", async () => {
    const bootstrap = new WebPlayerBootstrap();

    const session = await bootstrap.initializeSession(createPlayerRequest());

    expect(session.channelId).toBe("channel-001");
    expect(session.streamId).toBe("camera-001");
    expect(session.viewerId).toBe("viewer-001");
    expect(session.sessionId).toMatch(/^player-/);

    await expect(bootstrap.disposeSession(session)).resolves.toBeUndefined();
    await expect(bootstrap.disposeSession(session)).rejects.toThrow("is not active");
  });

  it("connects a transport session and drains seeded video and metadata messages", async () => {
    const videoMessage = createVideoMessage();
    const metadataMessage = {
      streamId: "camera-001",
      batchStartTimestampUs: 2_000_000,
      batchEndTimestampUs: 2_033_333,
      records: createMetadataBatch().records,
    };
    const transport = new WebTransportIngestClient({
      videoMessagesByStream: {
        "camera-001": [videoMessage],
      },
      metadataMessagesByStream: {
        "camera-001": [metadataMessage],
      },
    });

    const connection = await transport.connect(createEndpoint());

    expect(connection.channelId).toBe("channel-001");
    expect(connection.streamId).toBe("camera-001");
    expect(connection.requestedTransport).toBe("webtransport-quic");
    expect(connection.activeTransport).toBe("http-seeded-fallback");
    expect(connection.webTransportReady).toBe(false);
    expect(connection.webTransportBytesReceived).toBe(0);
    expect(connection.webTransportMessagesReceived).toBe(0);
    expect(connection.connectionId).toMatch(/^transport-/);
    await expect(transport.readVideoMessages(connection)).resolves.toEqual([videoMessage]);
    await expect(transport.readVideoMessages(connection)).resolves.toEqual([]);
    await expect(transport.readMetadataMessages(connection)).resolves.toEqual([metadataMessage]);
    await expect(transport.readMetadataMessages(connection)).resolves.toEqual([]);
  });

  it("closes transport handles so stopped tiles cannot keep draining messages", async () => {
    const transport = new WebTransportIngestClient({
      videoMessagesByStream: {
        "camera-001": [createVideoMessage()],
      },
    });
    const connection = await transport.connect(createEndpoint());

    await expect(transport.closeConnection(connection)).resolves.toBeUndefined();
    await expect(transport.readVideoMessages(connection)).rejects.toThrow("is not active");
  });

  it("rejects real QUIC transport when WebTransport is unavailable and fallback is disabled", async () => {
    const transport = new WebTransportIngestClient();

    await expect(transport.connect({
      ...createEndpoint(),
      allowHttpFallback: false,
    })).rejects.toThrow("WebTransport is not available");
  });

  it("receives video and metadata messages from a browser-initiated WebTransport stream", async () => {
    const videoFrame = {
      kind: "video",
      message: {
        ...createVideoMessage(),
        payload: "AQIDBAU=",
      },
    };
    const metadataFrame = {
      kind: "metadata",
      message: {
        streamId: "camera-001",
        batchStartTimestampUs: 2_000_000,
        batchEndTimestampUs: 2_033_333,
        records: createMetadataBatch().records,
      },
    };
    const { restore, urls, writes } = installWebTransportStub([
      JSON.stringify(videoFrame),
      JSON.stringify(metadataFrame),
      JSON.stringify({ kind: "end" }),
    ]);

    try {
      const fallbackVideo = { ...createVideoMessage(), sequenceNumber: 999 };
      const transport = new WebTransportIngestClient({
        videoMessagesByStream: { "camera-001": [fallbackVideo] },
      });

      const connection = await transport.connect(createEndpoint());
      const [videoMessage] = await transport.readVideoMessages(connection);
      const [metadataMessage] = await transport.readMetadataMessages(connection);

      expect(urls).toEqual(["https://localhost:9443/live/channel-001"]);
      expect(writes.join("")).toContain("\"channelId\":\"channel-001\"");
      expect(writes.join("")).toContain("\"streamId\":\"camera-001\"");
      expect(writes.join("")).toContain("\"targetLatencyMs\"");
      expect(writes.join("")).toContain("\"desiredEgressFrameRate\":24");
      expect(writes.join("")).toContain("\"desiredMaxCodedWidth\":1920");
      expect(writes.join("")).toContain("\"desiredMaxCodedHeight\":1080");
      expect(connection.activeTransport).toBe("webtransport-quic");
      expect(connection.webTransportReady).toBe(true);
      expect(connection.webTransportBytesReceived).toBeGreaterThan(0);
      expect(connection.webTransportMessagesReceived).toBe(2);
      expect(videoMessage?.sequenceNumber).toBe(101);
      expect(Array.from(videoMessage?.payload ?? [])).toEqual([1, 2, 3, 4, 5]);
      expect(metadataMessage?.records[0]?.eventId).toBe("evt-1");
    } finally {
      restore();
    }
  });

  it("stops reading WebTransport streams at the protocol end frame", async () => {
    const videoFrame = {
      kind: "video",
      message: {
        ...createVideoMessage(),
        payload: "AQIDBAU=",
      },
    };
    const { restore } = installWebTransportStub([
      JSON.stringify(videoFrame),
      JSON.stringify({ kind: "end" }),
    ], { errorAfterFrames: true });

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connect({
        ...createEndpoint(),
        allowHttpFallback: false,
      });
      const videoMessages = await transport.readVideoMessages(connection);

      expect(connection.activeTransport).toBe("webtransport-quic");
      expect(connection.webTransportReady).toBe(true);
      expect(connection.webTransportMessagesReceived).toBe(1);
      expect(videoMessages).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("streams WebTransport frames incrementally for continuous browser sessions", async () => {
    const videoFrame = {
      kind: "video",
      message: {
        ...createVideoMessage(),
        payload: "AQIDBAU=",
      },
    };
    const metadataFrame = {
      kind: "metadata",
      message: {
        streamId: "camera-001",
        batchStartTimestampUs: 2_000_000,
        batchEndTimestampUs: 2_033_333,
        records: createMetadataBatch().records,
      },
    };
    const { restore, writes } = installWebTransportStub([
      JSON.stringify(videoFrame),
      JSON.stringify(metadataFrame),
      JSON.stringify({ kind: "end" }),
    ]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming({
        ...createEndpoint(),
        chaosDisconnectAfterFrames: 30,
        chaosFrameDelayMs: 15,
        chaosDropEveryNFrames: 7,
        streamMode: "continuous",
      });
      const frames = [];

      for await (const frame of transport.readStreamingFrames(connection)) {
        frames.push(frame);
      }

      expect(connection.activeTransport).toBe("webtransport-quic");
      expect(connection.webTransportReady).toBe(true);
      expect(connection.webTransportBytesReceived).toBeGreaterThan(0);
      expect(connection.webTransportMessagesReceived).toBe(2);
      expect(writes.join("")).toContain("\"streamMode\":\"continuous\"");
      expect(writes.join("")).toContain("\"targetLatencyMs\"");
      expect(writes.join("")).toContain("\"desiredEgressFrameRate\":24");
      expect(writes.join("")).toContain("\"desiredMaxCodedWidth\":1920");
      expect(writes.join("")).toContain("\"desiredMaxCodedHeight\":1080");
      expect(writes.join("")).toContain("\"chaosDisconnectAfterFrames\":30");
      expect(writes.join("")).toContain("\"chaosFrameDelayMs\":15");
      expect(writes.join("")).toContain("\"chaosDropEveryNFrames\":7");
      expect(frames.map((frame) => frame.kind)).toEqual(["video", "metadata", "end"]);
      expect(frames[0]?.bytesReceived).toBeGreaterThan(0);
      expect(frames[0]?.messagesReceived).toBe(1);
      expect(frames[0]?.receivedAtUnixTimeMs).toBeGreaterThan(0);
      expect(frames[1]?.messagesReceived).toBe(2);
      expect(frames[1]?.receivedAtUnixTimeMs).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("streams MoQ-shaped WebTransport video objects by default for continuous browser sessions", async () => {
    const videoMessage = createVideoMessage();
    const { restore, writes } = installWebTransportStub([
      createMoqVideoObjectFrame(videoMessage, 77, 3),
    ]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());
      const frames = [];

      for await (const frame of transport.readStreamingFrames(connection)) {
        frames.push(frame);
      }

      expect(connection.webTransportBytesReceived).toBeGreaterThan(0);
      expect(connection.webTransportMessagesReceived).toBe(1);
      expect(writes.join("")).toContain("\"streamMode\":\"continuous-moq\"");
      expect(writes.join("")).toContain("\"targetLatencyMs\"");
      expect(writes.join("")).toContain("\"desiredEgressFrameRate\":24");
      expect(writes.join("")).toContain("\"desiredMaxCodedWidth\":1920");
      expect(writes.join("")).toContain("\"desiredMaxCodedHeight\":1080");
      expect(frames).toHaveLength(1);
      expect(frames[0]?.kind).toBe("video");
      if (frames[0]?.kind !== "video") {
        throw new Error("Expected MoQ object video frame.");
      }

      expect(frames[0].message.streamId).toBe(videoMessage.streamId);
      expect(frames[0].message.sequenceNumber).toBe(videoMessage.sequenceNumber);
      expect(frames[0].message.payload).toEqual(videoMessage.payload);
      expect(frames[0].message.moqTrackAlias).toBe(1);
      expect(frames[0].message.moqGroupId).toBe(77);
      expect(frames[0].message.moqObjectId).toBe(3);
      expect(frames[0].message.moqSubgroupId).toBe(0);
      expect(frames[0].message.moqPublisherPriority).toBe(0);
    } finally {
      restore();
    }
  });

  it("reassembles MoQ-shaped video objects split across WebTransport chunks", async () => {
    const videoMessage = {
      ...createVideoMessage(),
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const objectFrame = createMoqVideoObjectFrame(videoMessage, 90, 0);
    const { restore } = installWebTransportStub([
      objectFrame.slice(0, 17),
      objectFrame.slice(17, 73),
      objectFrame.slice(73),
    ]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());
      const frames = await drainStreamingFrames(transport, connection);

      expect(frames).toHaveLength(1);
      expect(frames[0]?.kind).toBe("video");
      if (frames[0]?.kind !== "video") {
        throw new Error("Expected split MoQ object to reassemble as a video frame.");
      }

      expect(frames[0].message.payload).toEqual(videoMessage.payload);
      expect(frames[0].message.moqGroupId).toBe(90);
      expect(connection.webTransportMessagesReceived).toBe(1);
    } finally {
      restore();
    }
  });

  it("parses multiple MoQ-shaped video objects from one WebTransport chunk", async () => {
    const firstMessage = {
      ...createVideoMessage(),
      sequenceNumber: 101,
      payload: new Uint8Array([1]),
    };
    const secondMessage = {
      ...createVideoMessage(),
      sequenceNumber: 102,
      keyFrame: false,
      payload: new Uint8Array([2]),
    };
    const combined = concatBytes(
      createMoqVideoObjectFrame(firstMessage, 91, 0),
      createMoqVideoObjectFrame(secondMessage, 91, 1),
    );
    const { restore } = installWebTransportStub([combined]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());
      const frames = await drainStreamingFrames(transport, connection);

      expect(frames).toHaveLength(2);
      expect(frames.map((frame) => frame.kind)).toEqual(["video", "video"]);
      expect(connection.webTransportMessagesReceived).toBe(2);
      if (frames[0]?.kind !== "video" || frames[1]?.kind !== "video") {
        throw new Error("Expected combined MoQ objects to parse as video frames.");
      }

      expect(frames[0].message.sequenceNumber).toBe(101);
      expect(frames[1].message.sequenceNumber).toBe(102);
      expect(frames[1].message.keyFrame).toBe(false);
      expect(frames[1].message.moqObjectId).toBe(1);
    } finally {
      restore();
    }
  });

  it("cooperatively drains large MoQ bursts without dropping parsed objects", async () => {
    const messages = Array.from({ length: 34 }, (_, index) => ({
      ...createVideoMessage(),
      sequenceNumber: 201 + index,
      keyFrame: index === 0,
      payload: new Uint8Array([index + 1]),
    }));
    const combined = concatBytes(...messages.map((message, index) => createMoqVideoObjectFrame(message, 96, index)));
    const { restore } = installWebTransportStub([combined]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());
      const frames = await drainStreamingFrames(transport, connection);

      expect(frames).toHaveLength(messages.length);
      expect(connection.webTransportMessagesReceived).toBe(messages.length);
      expect(frames.map((frame) => frame.kind)).toEqual(messages.map(() => "video"));
      const lastFrame = frames.at(-1);
      expect(lastFrame?.kind).toBe("video");
      if (lastFrame?.kind !== "video") {
        throw new Error("Expected last burst frame to be video.");
      }

      expect(lastFrame.message.sequenceNumber).toBe(234);
    } finally {
      restore();
    }
  });

  it("reports a precise protocol error for a truncated MoQ object at stream end", async () => {
    const objectFrame = createMoqVideoObjectFrame(createVideoMessage(), 92, 0);
    const { restore } = installWebTransportStub([objectFrame.slice(0, 32)]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());

      await expect(drainStreamingFrames(transport, connection)).rejects.toThrow("MoQ object ended with a truncated frame");
      expect(connection.webTransportMessagesReceived).toBe(0);
    } finally {
      restore();
    }
  });

  it("reports a precise error when MoQ object magic changes", async () => {
    const objectFrame = createMoqVideoObjectFrame(createVideoMessage(), 93, 0);
    objectFrame[0] = "X".charCodeAt(0);
    const { restore } = installWebTransportStub([objectFrame]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());

      await expect(drainStreamingFrames(transport, connection)).rejects.toThrow("MoQ object magic is invalid");
    } finally {
      restore();
    }
  });

  it("reports a precise error when MoQ object version or kind is unsupported", async () => {
    const objectFrame = createMoqVideoObjectFrame(createVideoMessage(), 94, 0);
    objectFrame[4] = 9;
    const { restore } = installWebTransportStub([objectFrame]);

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());

      await expect(drainStreamingFrames(transport, connection)).rejects.toThrow(
        "Unsupported continuous WebTransport MoQ object version 9 kind 1",
      );
    } finally {
      restore();
    }
  });

  it("propagates WebTransport stream read errors with the original reason", async () => {
    const objectFrame = createMoqVideoObjectFrame(createVideoMessage(), 95, 0);
    const { restore } = installWebTransportStub([objectFrame.slice(0, 32)], { errorAfterFrames: true });

    try {
      const transport = new WebTransportIngestClient();
      const connection = await transport.connectStreaming(createEndpoint());

      await expect(drainStreamingFrames(transport, connection)).rejects.toThrow("Connection lost.");
    } finally {
      restore();
    }
  });

  it("falls back to seeded messages when WebTransport connection fails and fallback is allowed", async () => {
    const restore = installFailingWebTransportStub();

    try {
      const fallbackVideo = createVideoMessage();
      const transport = new WebTransportIngestClient({
        videoMessagesByStream: { "camera-001": [fallbackVideo] },
      });

      const connection = await transport.connect(createEndpoint());

      expect(connection.activeTransport).toBe("http-seeded-fallback");
      expect(connection.webTransportReady).toBe(false);
      expect(connection.webTransportBytesReceived).toBe(0);
      await expect(transport.readVideoMessages(connection)).resolves.toEqual([fallbackVideo]);
    } finally {
      restore();
    }
  });

  it("assembles video messages into decode-ready chunks and supports discontinuity reset", async () => {
    const assembler = new EncodedChunkAssembler();

    await expect(assembler.applyTransportMessage(createVideoMessage())).resolves.toEqual([
      {
        streamId: "camera-001",
        sequenceNumber: 101,
        encodedChunkType: "key",
        presentationTimestampUs: 2_000_000,
        payload: new Uint8Array(),
      },
    ]);

    await expect(assembler.applyTransportMessage(createVideoMessage())).rejects.toThrow("must increase monotonically");
    await assembler.resetForDiscontinuity(createDiscontinuity());

    const nextMessage = { ...createVideoMessage(), sequenceNumber: 1, keyFrame: false };
    const chunks = await assembler.applyTransportMessage(nextMessage);
    expect(chunks[0]?.encodedChunkType).toBe("delta");
  });

  it("configures decode and flushes decoded frames", async () => {
    const decoder = new VideoDecodeCoordinator();

    await expect(decoder.enqueueChunk(createChunk())).rejects.toThrow("must be configured");

    await decoder.configureDecoder(createDecoderConfig());
    await decoder.enqueueChunk(createChunk());
    await decoder.enqueueChunk({ ...createChunk(), sequenceNumber: 102, presentationTimestampUs: 2_033_333 });

    const frames = await decoder.flush();
    expect(frames).toEqual([
      {
        streamId: "camera-001",
        sequenceNumber: 101,
        presentationTimestampUs: 2_000_000,
        width: 1280,
        height: 720,
        decodeBackend: "synthetic-frame-plan",
      },
      {
        streamId: "camera-001",
        sequenceNumber: 102,
        presentationTimestampUs: 2_033_333,
        width: 1280,
        height: 720,
        decodeBackend: "synthetic-frame-plan",
      },
    ]);
    await expect(decoder.flush()).resolves.toEqual([]);
    decoder.dispose();
    await expect(decoder.flush()).resolves.toEqual([]);
  });

  it("uses WebCodecs to decode encoded chunks when available", async () => {
    const { restore, decodedChunks, configurations } = installWebCodecsStub();
    const decoder = new VideoDecodeCoordinator();

    try {
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.enqueueChunk({
        ...createChunk(),
        payload: new Uint8Array([0, 0, 0, 1, 9, 16]),
      });

      const frames = await decoder.flush();

      expect(decodedChunks).toEqual([
        {
          type: "key",
          timestamp: 2_000_000,
          byteLength: 6,
        },
      ]);
      expect(configurations[0]?.hardwareAcceleration).toBe("prefer-hardware");
      expect(frames).toHaveLength(1);
      expect(frames[0]?.decodeBackend).toBe("webcodecs");
      expect(frames[0]?.videoFrame).toBeDefined();
    } finally {
      restore();
    }
  });

  it("falls back to software WebCodecs only when hardware config is unsupported", async () => {
    const { restore, configurations } = installWebCodecsStub({
      isConfigSupported: (configuration) => configuration.hardwareAcceleration !== "prefer-hardware",
    });
    const decoder = new VideoDecodeCoordinator();

    try {
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.enqueueChunk({
        ...createChunk(),
        payload: new Uint8Array([0, 0, 0, 1, 9, 16]),
      });
      const frames = await decoder.flush();

      expect(configurations.map((configuration) => configuration.hardwareAcceleration)).toEqual([
        "prefer-hardware",
        "prefer-software",
      ]);
      expect(frames[0]?.decodeBackend).toBe("webcodecs");
    } finally {
      restore();
    }
  });

  it("drains live WebCodecs output without forcing a decoder flush between delta frames", async () => {
    const { restore, decodedChunks, flushCalls } = installWebCodecsStub();
    const decoder = new VideoDecodeCoordinator();

    try {
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.enqueueChunk({
        ...createChunk(),
        payload: new Uint8Array([0, 0, 0, 1, 9, 16]),
      });
      const [keyFrame] = decoder.drainDecodedFrames();

      await decoder.enqueueChunk({
        ...createChunk(),
        encodedChunkType: "delta",
        sequenceNumber: 102,
        presentationTimestampUs: 2_033_333,
        payload: new Uint8Array([0, 0, 0, 1, 1, 16]),
      });
      const [deltaFrame] = decoder.drainDecodedFrames();

      expect(flushCalls()).toBe(0);
      expect(decodedChunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
      expect(keyFrame?.decodeBackend).toBe("webcodecs");
      expect(deltaFrame?.decodeBackend).toBe("webcodecs");
    } finally {
      restore();
    }
  });

  it("surfaces async WebCodecs decode errors during live drain", async () => {
    const { restore } = installWebCodecsStub({ asyncErrorMessage: "decoder exploded" });
    const decoder = new VideoDecodeCoordinator();

    try {
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.enqueueChunk({
        ...createChunk(),
        payload: new Uint8Array([0, 0, 0, 1, 9, 16]),
      });

      expect(() => decoder.drainDecodedFrames()).toThrow("decoder exploded");
    } finally {
      restore();
    }
  });

  it("ignores VideoDecoder close errors after Chrome has already closed the codec", async () => {
    const { restore } = installWebCodecsStub({ closeThrows: true });
    const decoder = new VideoDecodeCoordinator();

    try {
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      await decoder.enqueueChunk({
        ...createChunk(),
        payload: new Uint8Array([0, 0, 0, 1, 9, 16]),
      });

      expect(() => decoder.dispose()).not.toThrow();
    } finally {
      restore();
    }
  });

  it("stores metadata by timeline and clears stream windows", async () => {
    const metadata = new OverlayTimelineStore();

    await metadata.ingestBatch(createMetadataBatch());
    await metadata.ingestBatch({
      ...createMetadataBatch(),
      batchStartTimestampUs: 2_033_333,
      batchEndTimestampUs: 2_066_666,
      records: [{ ...createMetadataBatch().records[0], eventId: "evt-1b", startTimestampUs: 2_033_333, endTimestampUs: 2_066_666 }],
    });
    await metadata.ingestBatch({
      ...createMetadataBatch(),
      batchStartTimestampUs: 3_000_000,
      batchEndTimestampUs: 3_100_000,
      records: [{ ...createMetadataBatch().records[0], eventId: "evt-2", startTimestampUs: 3_000_000, endTimestampUs: 3_100_000 }],
    });

    const active = await metadata.queryActiveMetadata("camera-001", 2_010_000);
    expect(active).toHaveLength(1);
    expect(active[0]?.records[0]?.eventId).toBe("evt-1");

    const boundaryActive = await metadata.queryActiveMetadata("camera-001", 2_033_333);
    expect(boundaryActive).toHaveLength(1);
    expect(boundaryActive[0]?.records[0]?.eventId).toBe("evt-1b");

    await metadata.clearWindow("camera-001");
    await expect(metadata.queryActiveMetadata("camera-001", 2_010_000)).resolves.toEqual([]);
  });

  it("schedules frames with bounded latency and drops expired queued work", async () => {
    const scheduler = new PresentationScheduler();

    await scheduler.handleClockUpdate(createClockSnapshot());

    const renderDecision = await scheduler.scheduleFrame(
      { ...createFrame(), presentationTimestampUs: 1_980_000 },
      [createMetadataBatch()],
    );
    expect(renderDecision.shouldRender).toBe(true);
    expect(renderDecision.selectedSequenceNumber).toBe(101);
    expect(renderDecision.activeMetadataCount).toBe(1);

    const lateDecision = await scheduler.scheduleFrame(
      { ...createFrame(), sequenceNumber: 102, presentationTimestampUs: 1_800_000 },
      [],
    );
    expect(lateDecision.shouldRender).toBe(false);
    expect(lateDecision.droppedFrames).toEqual([
      {
        streamId: "camera-001",
        sequenceNumber: 102,
        reason: "late",
      },
    ]);

    const futureDecision = await scheduler.scheduleFrame(
      { ...createFrame(), sequenceNumber: 103, presentationTimestampUs: 2_200_000 },
      [],
    );
    expect(futureDecision.shouldRender).toBe(false);
    expect(futureDecision.droppedFrames).toEqual([]);

    const expired = await scheduler.dropExpiredFrames("camera-001", 2_300_000);
    expect(expired).toEqual([
      {
        streamId: "camera-001",
        sequenceNumber: 103,
        reason: "late",
      },
    ]);
  });

  it("configures the renderer and keeps OSD counts at zero on the Canvas2D fallback", async () => {
    const renderer = new WebGpuRenderer();
    const { canvas, operations } = createCanvasStub();
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as Document);

    try {
      await expect(renderer.renderFrame(createRenderRequest())).rejects.toThrow("must be configured");

      await renderer.configureSurface(createSurfaceConfiguration());
      const result = await renderer.renderFrame(createRenderRequest());
      expect(result).toEqual({
        sessionId: "session-001",
        renderedSequenceNumber: 101,
        overlayPrimitiveCount: 0,
        renderBackend: "canvas2d-fallback",
        webGpuDisabledReason: "no-webgpu",
      });

      expect(canvas.width).toBe(1280);
      expect(canvas.height).toBe(720);
      expect(canvas.hidden).toBe(false);
      expect(canvas.style.display).toBe("block");
      expect(canvas.dataset.lastSequence).toBe("101");
      expect(canvas.dataset.overlayCount).toBe("0");
      expect(operations).toContain("getContext:2d");
      expect(operations.some((operation) => operation.startsWith("createLinearGradient:"))).toBe(true);
      expect(operations.some((operation) => operation.startsWith("fillText:Camera camera-001:"))).toBe(false);
      expect(operations.some((operation) => operation.startsWith("fillText:Sequence 101:"))).toBe(false);
      expect(operations.some((operation) => operation.startsWith("strokeRect:"))).toBe(false);

      await renderer.dispose();
      await expect(renderer.renderFrame(createRenderRequest())).rejects.toThrow("must be configured");
    } finally {
      restoreDocument();
    }
  });

  it("falls back to Canvas2D when WebGPU canvas presentation is unavailable", async () => {
    const renderer = new WebGpuRenderer();
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
    });
    const { canvas, operations: canvasOperations } = createCanvasStub();
    const { canvas: uploadCanvas } = createCanvasStub();
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
      createElement: (tagName: string) => (tagName === "canvas" ? uploadCanvas : null),
    } as unknown as Document);

    try {
      await renderer.configureSurface(createSurfaceConfiguration());
      const result = await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: { displayWidth: 1280, displayHeight: 720 },
        },
      });

      expect(result.renderBackend).toBe("canvas2d-fallback");
      expect(canvas.dataset.renderBackend).toBe("canvas2d-fallback");
      expect(canvas.dataset.webGpuDisabledReason).toBe("no-webgpu-canvas");
      expect(canvasOperations).toContain("getContext:2d");
      expect(gpuOperations).toEqual(["requestAdapter"]);
    } finally {
      restoreDocument();
      restoreGpu();
    }
  });

  it("fails WebGPU adapter startup fast instead of hanging playback setup", async () => {
    vi.useFakeTimers();
    const renderer = new WebGpuRenderer();
    const { canvas } = createCanvasStub();
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      requestAdapterNeverResolves: true,
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as Document);

    try {
      const configurePromise = renderer.configureSurface(createSurfaceConfiguration());

      await vi.advanceTimersByTimeAsync(2_999);
      expect(canvas.dataset.webGpuDisabledReason).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await configurePromise;

      expect(canvas.dataset.webGpuDisabledReason).toBe("webgpu-request-adapter-timeout");
      expect(gpuOperations).toEqual(["requestAdapter"]);
    } finally {
      vi.useRealTimers();
      restoreDocument();
      restoreGpu();
    }
  });

  it("presents decoded frames directly through a WebGPU canvas on hardware adapters", async () => {
    const renderer = new WebGpuRenderer();
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
    });
    const { canvas, operations: canvasOperations } = createCanvasStub();
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("swapchain.createView");
            return {};
          },
        };
      },
    };
    canvas.getContext = ((contextId: string): unknown => {
      canvasOperations.push(`getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    class FakeVideoFrame {
      public readonly displayWidth = 1280;
      public readonly displayHeight = 720;
      public close(): void {
        // The renderer owns frame close through the common frame lifecycle.
      }
    }
    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as unknown as Document);

    try {
      await renderer.configureSurface(createSurfaceConfiguration());
      const result = await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });

      await waitForGpuSample(canvas);
      expect(result.renderBackend).toBe("webgpu");
      expect(canvas.dataset.renderBackend).toBe("webgpu");
      expect(canvas.dataset.gpuPresentation).toBe("webgpu-canvas");
      expect(canvas.dataset.gpuAdapterVendor).toBe("nvidia");
      expect(canvas.dataset.gpuAdapterArchitecture).toBe("turing");
      expect(canvas.dataset.gpuSampleRgba).toBe("24,48,96,255");
      expect(canvasOperations).toContain("getContext:webgpu");
      expect(canvasOperations).not.toContain("getContext:2d");
      expect(gpuOperations).toContain("context.configure");
      expect(gpuOperations).toContain("context.getCurrentTexture");
      expect(gpuOperations).toContain("copyTextureToTexture");
      expect(gpuOperations).toContain("copyTextureToBuffer");
      expect(gpuOperations).toContain("copyExternalImageToTexture");
      expect(gpuOperations).not.toContain("writeTexture");
      expect(gpuOperations).toContain("draw");

      const copiesAfterDiagnosticSample = gpuOperations.filter((operation) => operation === "copyTextureToTexture").length;
      await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
            sequenceNumber: 102,
            presentationTimestampUs: 2_033_333,
            decodeBackend: "webcodecs",
            videoFrame: new FakeVideoFrame(),
          },
        });

      expect(gpuOperations.filter((operation) => operation === "copyTextureToTexture")).toHaveLength(copiesAfterDiagnosticSample);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(2);
    } finally {
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }
    }
  });

  it("uses WebGPU external textures for native VideoFrame rendering on hardware adapters", async () => {
    const renderer = new WebGpuRenderer();
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
    });
    const { canvas, operations: canvasOperations } = createCanvasStub();
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("swapchain.createView");
            return {};
          },
        };
      },
    };
    class FakeVideoFrame {
      public readonly displayWidth = 1280;
      public readonly displayHeight = 720;
      public close(): void {
        // The renderer owns frame close through the common frame lifecycle.
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    canvas.getContext = ((contextId: string): unknown => {
      canvasOperations.push(`getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as unknown as Document);

    try {
      await renderer.configureSurface(createSurfaceConfiguration());
      const result = await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });

      await waitForGpuSample(canvas);
      expect(result.renderBackend).toBe("webgpu");
      expect(canvas.dataset.renderBackend).toBe("webgpu");
      expect(canvas.dataset.gpuUploadSource).toBe("external-texture");
      expect(canvas.dataset.gpuPresentation).toBe("webgpu-canvas");
      expect(canvas.dataset.gpuSampleRgba).toBe("24,48,96,255");
      expect(gpuOperations).toContain("importExternalTexture");
      expect(gpuOperations).toContain("copyTextureToTexture");
      expect(gpuOperations).not.toContain("copyExternalImageToTexture");
      expect(gpuOperations).not.toContain("writeTexture");
    } finally {
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }
    }
  });

  it("shares one WebGPU device and pipeline set across tile renderers", async () => {
    const firstRenderer = new WebGpuRenderer();
    const secondRenderer = new WebGpuRenderer();
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
    });
    const firstCanvas = createCanvasStub().canvas;
    const secondCanvas = createCanvasStub().canvas;
    const createContext = () => ({
      configure(): void {
        gpuOperations.push("context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("swapchain.createView");
            return {};
          },
        };
      },
    });
    firstCanvas.getContext = ((contextId: string): unknown => contextId === "webgpu" ? createContext() : null) as HTMLCanvasElement["getContext"];
    secondCanvas.getContext = ((contextId: string): unknown => contextId === "webgpu" ? createContext() : null) as HTMLCanvasElement["getContext"];

    class FakeVideoFrame {
      public readonly displayWidth = 1280;
      public readonly displayHeight = 720;
      public close(): void {
        // The renderer owns frame close through the common frame lifecycle.
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => {
        if (id === "first-canvas") {
          return firstCanvas;
        }

        if (id === "second-canvas") {
          return secondCanvas;
        }

        return null;
      },
    } as unknown as Document);

    try {
      await firstRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "first-canvas" });
      await secondRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "second-canvas" });

      await firstRenderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });
      await secondRenderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          sequenceNumber: 102,
          presentationTimestampUs: 2_033_333,
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });

      expect(gpuOperations.filter((operation) => operation === "requestAdapter")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "requestDevice")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "createRenderPipeline")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "context.configure")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(2);
      expect(firstCanvas.dataset.gpuUploadSource).toBe("external-texture");
      expect(secondCanvas.dataset.gpuUploadSource).toBe("external-texture");
    } finally {
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }
    }
  });

  it("batches VMS tile renders through one matrix WebGPU canvas", async () => {
    const matrixCanvasId = "matrix-canvas-unit";
    const firstRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const secondRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    const closedFrames: string[] = [];
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
    });
    const matrixCanvas = createCanvasStub().canvas;
    const firstCanvas = createCanvasStub().canvas;
    const secondCanvas = createCanvasStub().canvas;
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("matrix.context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("matrix.context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("matrix.swapchain.createView");
            return {};
          },
        };
      },
    };

    matrixCanvas.getContext = ((contextId: string): unknown => {
      gpuOperations.push(`matrix.getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    Object.assign(matrixCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
    });
    Object.assign(firstCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 225 }),
    });
    Object.assign(secondCanvas, {
      getBoundingClientRect: () => ({ left: 400, top: 0, width: 400, height: 225 }),
    });

    class FakeVideoFrame {
      public readonly displayWidth = 1280;
      public readonly displayHeight = 720;
      public constructor(private readonly label: string) {
      }

      public close(): void {
        closedFrames.push(this.label);
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => {
        if (id === matrixCanvasId) {
          return matrixCanvas;
        }

        if (id === "first-canvas") {
          return firstCanvas;
        }

        if (id === "second-canvas") {
          return secondCanvas;
        }

        return null;
      },
    } as unknown as Document);

    try {
      await firstRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "first-canvas" });
      await secondRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "second-canvas" });

      const [firstResult, secondResult] = await Promise.all([
        firstRenderer.renderFrame({
          ...createRenderRequest(),
          frame: {
            ...createFrame(),
            decodeBackend: "webcodecs",
            videoFrame: new FakeVideoFrame("first"),
          },
        }),
        secondRenderer.renderFrame({
          ...createRenderRequest(),
          frame: {
            ...createFrame(),
            sequenceNumber: 102,
            presentationTimestampUs: 2_033_333,
            decodeBackend: "webcodecs",
            videoFrame: new FakeVideoFrame("second"),
          },
        }),
      ]);

      await waitForGpuSample(firstCanvas);
      await waitForGpuSample(secondCanvas);
      expect(firstResult.renderBackend).toBe("webgpu");
      expect(secondResult.renderBackend).toBe("webgpu");
      expect(firstCanvas.dataset.gpuPresentation).toBe("webgpu-canvas");
      expect(secondCanvas.dataset.gpuPresentation).toBe("webgpu-canvas");
      expect(firstCanvas.dataset.gpuUploadSource).toBe("external-texture");
      expect(secondCanvas.dataset.gpuUploadSource).toBe("external-texture");
      expect(firstResult.matrixPresentMode).toBe("immediate");
      expect(firstResult.matrixPresentPath).toBe("immediate");
      expect(firstResult.matrixFlushCount).toBe(1);
      expect(firstResult.matrixPresentCount).toBe(1);
      expect(firstResult.matrixDrawCount).toBe(2);
      expect(firstResult.matrixExternalImportCount).toBe(2);
      expect(firstResult.matrixBindGroupCount).toBe(2);
      expect(firstCanvas.dataset.gpuSampleRgba).toBe("1,1,1,255");
      expect(secondCanvas.dataset.gpuSampleRgba).toBe("1,1,1,255");
      expect(gpuOperations.filter((operation) => operation === "matrix.getContext:webgpu")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "matrix.context.getCurrentTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "beginRenderPass")).toHaveLength(1);
      expect(gpuOperations).toContain("loadOp:clear");
      expect(gpuOperations.filter((operation) => operation === "copyTextureToTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "setViewport")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "setScissorRect")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "copyExternalImageToTexture")).toHaveLength(0);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(2);
      expect(closedFrames).toEqual([]);

      const thirdResult = await secondRenderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          sequenceNumber: 103,
          presentationTimestampUs: 2_066_666,
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame("second-later"),
        },
      });

      expect(thirdResult.renderBackend).toBe("webgpu");
      expect(gpuOperations.filter((operation) => operation === "beginRenderPass")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "loadOp:clear")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "loadOp:load")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "matrix.context.getCurrentTexture")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "copyTextureToTexture")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(3);
      expect(gpuOperations.filter((operation) => operation === "copyExternalImageToTexture")).toHaveLength(0);
      expect(gpuOperations.filter((operation) => operation === "createBindGroup")).toHaveLength(3);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(3);
      expect(closedFrames).toEqual(["second"]);

      await firstRenderer.dispose();
      await secondRenderer.dispose();
      expect(closedFrames).toEqual(["second", "first", "second-later"]);
    } finally {
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }

      if (pixelRatioDescriptor) {
        Object.defineProperty(globalThis, "devicePixelRatio", pixelRatioDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "devicePixelRatio");
      }
    }
  });

  it("coalesces auto matrix presents and backs them up with a timer", async () => {
    const matrixCanvasId = "matrix-canvas-raf-present-unit";
    const firstRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const secondRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    const requestAnimationFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    const setTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout");
    const clearTimeoutDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const callbacks: FrameRequestCallback[] = [];
    const fallbackCallbacks: Array<() => void> = [];
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
    });
    const matrixCanvas = createCanvasStub().canvas;
    const firstCanvas = createCanvasStub().canvas;
    const secondCanvas = createCanvasStub().canvas;
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("matrix.context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("matrix.context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("matrix.swapchain.createView");
            return {};
          },
        };
      },
    };

    matrixCanvas.getContext = ((contextId: string): unknown => {
      gpuOperations.push(`matrix.getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    Object.assign(matrixCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
    });
    Object.assign(firstCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 225 }),
    });
    Object.assign(secondCanvas, {
      getBoundingClientRect: () => ({ left: 400, top: 0, width: 400, height: 225 }),
    });

    class FakeVideoFrame {
      public readonly displayWidth = 1920;
      public readonly displayHeight = 1080;
      public close(): void {
        // The compositor owns frame lifetime through the matrix slot.
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (callback: () => void) => {
        fallbackCallbacks.push(callback);
        return fallbackCallbacks.length;
      },
    });
    Object.defineProperty(globalThis, "clearTimeout", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
        value: {
          location: {
            search: "?matrixPresent=auto",
          },
          addEventListener: () => undefined,
        },
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => {
        if (id === matrixCanvasId) {
          return matrixCanvas;
        }

        if (id === "raf-first-canvas") {
          return firstCanvas;
        }

        if (id === "raf-second-canvas") {
          return secondCanvas;
        }

        return null;
      },
    } as unknown as Document);

    try {
      await firstRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "raf-first-canvas" });
      await secondRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "raf-second-canvas" });
      callbacks.length = 0;
      fallbackCallbacks.length = 0;

      let firstRenderSettled = false;
      const firstRenderPromise = Promise.all([
        firstRenderer.renderFrame({
          ...createRenderRequest(),
          frame: {
            ...createFrame(),
            decodeBackend: "webcodecs",
            videoFrame: new FakeVideoFrame(),
          },
        }),
        secondRenderer.renderFrame({
          ...createRenderRequest(),
          frame: {
            ...createFrame(),
            sequenceNumber: 104,
            presentationTimestampUs: 2_099_999,
            decodeBackend: "webcodecs",
            videoFrame: new FakeVideoFrame(),
          },
        }),
      ]).then((results) => {
        firstRenderSettled = true;
        return results;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const [firstResult, secondResult] = await firstRenderPromise;

      expect(firstRenderSettled).toBe(true);
      expect(firstResult.matrixPresentMode).toBe("auto");
      expect(firstResult.matrixPresentPath).toBe("immediate");
      expect(secondResult.matrixPresentPath).toBe("immediate");
      expect(firstResult.matrixFlushCount).toBe(1);
      expect(firstResult.matrixPresentCount).toBe(1);
      expect(firstResult.matrixDrawCount).toBe(2);
      expect(matrixCanvas.dataset.matrixPresentCount).toBe("1");
      expect(firstCanvas.dataset.matrixPresentCount).toBe("1");
      expect(secondCanvas.dataset.matrixPresentCount).toBe("1");
      expect(gpuOperations.filter((operation) => operation === "beginRenderPass")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "copyExternalImageToTexture")).toHaveLength(0);
      expect(gpuOperations.filter((operation) => operation === "matrix.context.getCurrentTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "copyTextureToTexture")).toHaveLength(1);
      expect(callbacks).toHaveLength(0);
      expect(fallbackCallbacks).toHaveLength(0);

      fallbackCallbacks.splice(0).forEach((callback) => callback());
      expect(matrixCanvas.dataset.matrixPresentCount).toBe("1");

      let thirdRenderSettled = false;
      const thirdRenderPromise = firstRenderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          sequenceNumber: 105,
          presentationTimestampUs: 2_133_333,
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      }).then((result) => {
        thirdRenderSettled = true;
        return result;
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(thirdRenderSettled).toBe(true);
      const thirdResult = await thirdRenderPromise;
      expect(matrixCanvas.dataset.matrixPresentCount).toBe("1");
      expect(gpuOperations.filter((operation) => operation === "beginRenderPass")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(3);
      expect(gpuOperations.filter((operation) => operation === "copyExternalImageToTexture")).toHaveLength(0);
      expect(thirdResult.matrixPresentPath).toBe("coalesced");
      expect(thirdResult.matrixPresentCount).toBe(1);
      expect(thirdResult.gpuUploadSource).toBe("external-texture");
      expect(thirdResult.matrixVideoFrameCopyCount).toBe(0);
      expect(callbacks).toHaveLength(1);
      expect(fallbackCallbacks.length).toBeGreaterThanOrEqual(1);

      fallbackCallbacks.splice(0).forEach((callback) => callback());
      expect(matrixCanvas.dataset.matrixPresentCount).toBe("2");
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(3);
      callbacks.shift()?.(performance.now());
      expect(matrixCanvas.dataset.matrixPresentCount).toBe("2");
    } finally {
      await firstRenderer.dispose();
      await secondRenderer.dispose();
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }

      if (pixelRatioDescriptor) {
        Object.defineProperty(globalThis, "devicePixelRatio", pixelRatioDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "devicePixelRatio");
      }

      if (requestAnimationFrameDescriptor) {
        Object.defineProperty(globalThis, "requestAnimationFrame", requestAnimationFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      }

      if (setTimeoutDescriptor) {
        Object.defineProperty(globalThis, "setTimeout", setTimeoutDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "setTimeout");
      }

      if (clearTimeoutDescriptor) {
        Object.defineProperty(globalThis, "clearTimeout", clearTimeoutDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "clearTimeout");
      }

      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("hides the shared matrix canvas when external texture import fails", async () => {
    const matrixCanvasId = "matrix-canvas-import-failure-unit";
    const renderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const closedFrames: string[] = [];
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
      importExternalTextureError: "Failed to import texture from video frame that doesn't have back resource",
    });
    const matrixCanvas = createCanvasStub().canvas;
    const tileCanvas = createCanvasStub().canvas;
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("matrix.context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("matrix.context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("matrix.swapchain.createView");
            return {};
          },
        };
      },
    };

    matrixCanvas.getContext = ((contextId: string): unknown => {
      gpuOperations.push(`matrix.getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    Object.assign(matrixCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    });
    Object.assign(tileCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
    });

    class FakeVideoFrame {
      public readonly displayWidth = 3840;
      public readonly displayHeight = 2160;
      public constructor(private readonly label: string) {
      }

      public close(): void {
        closedFrames.push(this.label);
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          search: "?matrixTexture=external",
        },
        addEventListener: () => undefined,
      },
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => {
        if (id === matrixCanvasId) {
          return matrixCanvas;
        }

        if (id === "import-failure-canvas") {
          return tileCanvas;
        }

        return null;
      },
    } as unknown as Document);

    try {
      await renderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "import-failure-canvas" });
      const result = await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame("failed-import"),
        },
      });

      expect(result.renderBackend).toBe("canvas2d-fallback");
      expect(result.matrixFallbackReason).toContain("back resource");
      expect(matrixCanvas.hidden).toBe(true);
      expect(matrixCanvas.style.display).toBe("none");
      expect(matrixCanvas.dataset.matrixFallbackReason).toContain("back resource");
      expect(tileCanvas.dataset.matrixFallbackReason).toContain("back resource");
      expect(tileCanvas.dataset.renderBackend).toBe("canvas2d-fallback");
      expect(tileCanvas.hidden).toBe(false);
      expect(tileCanvas.style.display).toBe("block");
      expect(gpuOperations).toContain("importExternalTexture");
      expect(gpuOperations.filter((operation) => operation === "matrix.context.getCurrentTexture")).toHaveLength(1);
      expect(closedFrames).toEqual(["failed-import"]);
    } finally {
      await renderer.dispose();
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }

      if (pixelRatioDescriptor) {
        Object.defineProperty(globalThis, "devicePixelRatio", pixelRatioDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "devicePixelRatio");
      }

      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("renders duplicate matrix views of the same VideoFrame without cloning", async () => {
    const matrixCanvasId = "matrix-canvas-duplicate-unit";
    const firstRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const secondRenderer = new WebGpuMatrixTileRenderer(matrixCanvasId);
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const closedFrames: string[] = [];
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      importExternalTexture: true,
    });
    const matrixCanvas = createCanvasStub().canvas;
    const firstCanvas = createCanvasStub().canvas;
    const secondCanvas = createCanvasStub().canvas;
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("matrix.context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("matrix.context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("matrix.swapchain.createView");
            return {};
          },
        };
      },
    };

    matrixCanvas.getContext = ((contextId: string): unknown => {
      gpuOperations.push(`matrix.getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    Object.assign(matrixCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 450 }),
    });
    Object.assign(firstCanvas, {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 225 }),
    });
    Object.assign(secondCanvas, {
      getBoundingClientRect: () => ({ left: 400, top: 0, width: 400, height: 225 }),
    });

    class FakeVideoFrame {
      public readonly displayWidth = 3840;
      public readonly displayHeight = 2160;
      public constructor(private readonly label: string) {
      }

      public clone(): FakeVideoFrame {
        throw new Error("duplicate matrix views should not clone shared VideoFrames");
      }

      public close(): void {
        closedFrames.push(this.label);
      }
    }

    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 1,
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          search: "?matrixTexture=external",
        },
        addEventListener: () => undefined,
      },
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => {
        if (id === matrixCanvasId) {
          return matrixCanvas;
        }

        if (id === "duplicate-first-canvas") {
          return firstCanvas;
        }

        if (id === "duplicate-second-canvas") {
          return secondCanvas;
        }

        return null;
      },
    } as unknown as Document);

    try {
      await firstRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "duplicate-first-canvas" });
      await secondRenderer.configureSurface({ ...createSurfaceConfiguration(), canvasId: "duplicate-second-canvas" });

      const sharedFrame = new FakeVideoFrame("shared");
      const sharedDecodedFrame = {
        ...createFrame(),
        decodeBackend: "webcodecs" as const,
        videoFrame: sharedFrame,
      };
      const sharedRequest = {
        ...createRenderRequest(),
        sessionId: "duplicate-shared",
        frame: sharedDecodedFrame,
      };
      const [firstResult, secondResult] = await Promise.all([
        firstRenderer.renderFrame(sharedRequest),
        secondRenderer.renderFrame(sharedRequest),
      ]);

      await waitForGpuSample(firstCanvas);
      await waitForGpuSample(secondCanvas);
      expect(firstResult.renderBackend).toBe("webgpu");
      expect(secondResult.renderBackend).toBe("webgpu");
      expect(gpuOperations.filter((operation) => operation === "matrix.context.getCurrentTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "beginRenderPass")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "importExternalTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "copyTextureToTexture")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "copyExternalImageToTexture")).toHaveLength(0);
      expect(gpuOperations.filter((operation) => operation === "writeBuffer")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "createBindGroup")).toHaveLength(2);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(2);
      expect(closedFrames).toEqual([]);

      await firstRenderer.dispose();
      await secondRenderer.dispose();
      expect(closedFrames).toEqual(["shared"]);
    } finally {
      await firstRenderer.dispose();
      await secondRenderer.dispose();
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }

      if (pixelRatioDescriptor) {
        Object.defineProperty(globalThis, "devicePixelRatio", pixelRatioDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "devicePixelRatio");
      }

      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("does not retry WebGPU diagnostic readback every frame after a readback failure", async () => {
    const renderer = new WebGpuRenderer();
    const videoFrameDescriptor = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "nvidia", architecture: "turing" },
      rejectReadback: true,
    });
    const { canvas } = createCanvasStub();
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("swapchain.createView");
            return {};
          },
        };
      },
    };
    canvas.getContext = ((contextId: string): unknown => {
      return contextId === "webgpu" ? webGpuContext : null;
    }) as HTMLCanvasElement["getContext"];
    class FakeVideoFrame {
      public readonly displayWidth = 1280;
      public readonly displayHeight = 720;
      public close(): void {
        // The renderer owns frame close through the common frame lifecycle.
      }
    }
    Object.defineProperty(globalThis, "VideoFrame", {
      configurable: true,
      writable: true,
      value: FakeVideoFrame,
    });
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as unknown as Document);

    try {
      await renderer.configureSurface(createSurfaceConfiguration());
      await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });
      await waitForGpuReadbackError(canvas);

      await renderer.renderFrame({
        ...createRenderRequest(),
        frame: {
          ...createFrame(),
          sequenceNumber: 102,
          presentationTimestampUs: 2_033_000,
          decodeBackend: "webcodecs",
          videoFrame: new FakeVideoFrame(),
        },
      });

      expect(canvas.dataset.gpuReadbackError).toContain("readback failed");
      expect(gpuOperations.filter((operation) => operation === "copyTextureToBuffer")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "onSubmittedWorkDone")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "mapAsync")).toHaveLength(1);
      expect(gpuOperations.filter((operation) => operation === "draw")).toHaveLength(2);
    } finally {
      restoreDocument();
      restoreGpu();
      if (videoFrameDescriptor) {
        Object.defineProperty(globalThis, "VideoFrame", videoFrameDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "VideoFrame");
      }
    }
  });

  it("falls back to Canvas2D instead of using a software WebGPU adapter", async () => {
    const renderer = new WebGpuRenderer();
    const { operations: gpuOperations, restore: restoreGpu } = installWebGpuStub({
      adapterInfo: { vendor: "google", architecture: "swiftshader" },
    });
    const { canvas, operations: canvasOperations } = createCanvasStub();
    const originalGetContext = canvas.getContext.bind(canvas);
    const webGpuContext = {
      configure(): void {
        gpuOperations.push("context.configure");
      },
      getCurrentTexture(): unknown {
        gpuOperations.push("context.getCurrentTexture");
        return {
          createView(): unknown {
            gpuOperations.push("swapchain.createView");
            return {};
          },
        };
      },
    };
    canvas.getContext = ((contextId: string): unknown => {
      canvasOperations.push(`getContext:${contextId}`);
      return contextId === "webgpu" ? webGpuContext : originalGetContext(contextId as never);
    }) as HTMLCanvasElement["getContext"];
    const restoreDocument = installDocumentStub({
      getElementById: (id: string) => (id === "player-canvas" ? canvas : null),
    } as Document);

    try {
      await renderer.configureSurface(createSurfaceConfiguration());
      const result = await renderer.renderFrame(createRenderRequest());

      expect(result.renderBackend).toBe("canvas2d-fallback");
      expect(result.gpuAdapterVendor).toBe("google");
      expect(result.gpuAdapterArchitecture).toBe("swiftshader");
      expect(canvas.dataset.renderBackend).toBe("canvas2d-fallback");
      expect(canvas.dataset.webGpuDisabledReason).toBe("software-adapter");
      expect(canvasOperations).toContain("getContext:2d");
      expect(gpuOperations).toContain("requestAdapter");
      expect(gpuOperations).not.toContain("requestDevice");
      expect(gpuOperations).not.toContain("createRenderPipeline");
      expect(gpuOperations).not.toContain("copyTextureToBuffer");
    } finally {
      restoreDocument();
      restoreGpu();
    }
  });

  it("records telemetry snapshots from multiple stages", async () => {
    const telemetry = new PlayerTelemetryCollector();

    await telemetry.recordStageEvent(createStageTimingEvent());
    await telemetry.recordStageEvent({
      ...createStageTimingEvent(),
      stageName: "render.frame",
      latencyMs: 4.5,
    });

    const snapshot = await telemetry.createSnapshot("camera-001");
    expect(snapshot.streamId).toBe("camera-001");
    expect(snapshot.stages).toHaveLength(2);
    expect(snapshot.stages.map((event) => event.stageName)).toEqual(["decode.enqueue", "render.frame"]);
    expect(new Date(snapshot.capturedAtIso).toString()).not.toBe("Invalid Date");
  });

  it("supports an integrated in-memory player flow", async () => {
    const videoMessage = createVideoMessage();
    const metadataBatch = createMetadataBatch();
    const transport = new WebTransportIngestClient({
      videoMessagesByStream: { "camera-001": [videoMessage] },
      metadataMessagesByStream: {
        "camera-001": [
          {
            streamId: metadataBatch.streamId,
            batchStartTimestampUs: metadataBatch.batchStartTimestampUs,
            batchEndTimestampUs: metadataBatch.batchEndTimestampUs,
            records: metadataBatch.records,
          },
        ],
      },
    });
    const bootstrap = new WebPlayerBootstrap({ transportClient: transport });
    const assembler = new EncodedChunkAssembler();
    const decoder = new VideoDecodeCoordinator();
    const metadata = new OverlayTimelineStore();
    const scheduler = new PresentationScheduler();
    const renderer = new WebGpuRenderer();

    const session = await bootstrap.initializeSession(createPlayerRequest());
    const connection = await transport.connect(createEndpoint());
    const [transportVideo] = await transport.readVideoMessages(connection);
    const [transportMetadata] = await transport.readMetadataMessages(connection);
    const [chunk] = await assembler.applyTransportMessage(transportVideo!);
    await decoder.configureDecoder(createDecoderConfig());
    await decoder.enqueueChunk(chunk!);
    const [frame] = await decoder.flush();
    await metadata.ingestBatch({
      streamId: transportMetadata!.streamId,
      batchStartTimestampUs: transportMetadata!.batchStartTimestampUs,
      batchEndTimestampUs: transportMetadata!.batchEndTimestampUs,
      records: transportMetadata!.records,
    });
    await scheduler.handleClockUpdate(createClockSnapshot());
    const activeMetadata = await metadata.queryActiveMetadata("camera-001", frame!.presentationTimestampUs);
    const decision = await scheduler.scheduleFrame(frame!, activeMetadata);
    await renderer.configureSurface(createSurfaceConfiguration());
    const rendered = await renderer.renderFrame({
      sessionId: session.sessionId,
      frame: frame!,
      activeMetadata,
      debugOverlayEnabled: true,
    });

    expect(decision.shouldRender).toBe(true);
    expect(activeMetadata).toHaveLength(1);
    expect(rendered.overlayPrimitiveCount).toBe(0);
    expect(rendered.renderedSequenceNumber).toBe(frame?.sequenceNumber);
  });
});
