import { describe, expect, it } from "vitest";
import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PlayerTelemetryCollector,
  PresentationScheduler,
  VideoDecodeCoordinator,
  WebGpuRenderer,
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
    streamId: "camera-001",
    viewerId: "viewer-001",
    targetLatencyMs: 150,
    enableMetadata: true,
  };
}

function createSessionHandle(): PlayerSessionHandle {
  return {
    sessionId: "session-001",
    streamId: "camera-001",
    viewerId: "viewer-001",
  };
}

function createEndpoint(): TransportEndpointDescriptor {
  return {
    streamId: "camera-001",
    webTransportUrl: "https://localhost:9443/live/camera-001",
    authToken: "token",
    metadataChannelRequired: true,
  };
}

function createConnection(): TransportConnectionHandle {
  return {
    connectionId: "connection-001",
    streamId: "camera-001",
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
    expect(transport.readVideoMessages.length).toBe(2);
    expect(transport.readMetadataMessages.length).toBe(2);
    expect(assembler.applyTransportMessage.length).toBe(1);
    expect(assembler.resetForDiscontinuity.length).toBe(1);
    expect(decoder.configureDecoder.length).toBe(1);
    expect(decoder.enqueueChunk.length).toBe(1);
    expect(decoder.flush.length).toBe(0);
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

    expect(connection.streamId).toBe("camera-001");
    expect(connection.connectionId).toMatch(/^transport-/);
    await expect(transport.readVideoMessages(connection)).resolves.toEqual([videoMessage]);
    await expect(transport.readVideoMessages(connection)).resolves.toEqual([]);
    await expect(transport.readMetadataMessages(connection)).resolves.toEqual([metadataMessage]);
    await expect(transport.readMetadataMessages(connection)).resolves.toEqual([]);
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
      },
      {
        streamId: "camera-001",
        sequenceNumber: 102,
        presentationTimestampUs: 2_033_333,
        width: 1280,
        height: 720,
      },
    ]);
    await expect(decoder.flush()).resolves.toEqual([]);
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

  it("configures the renderer, paints a browser surface, and reports overlay primitive counts", async () => {
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
        overlayPrimitiveCount: 1,
      });

      expect(canvas.width).toBe(1280);
      expect(canvas.height).toBe(720);
      expect(canvas.hidden).toBe(false);
      expect(canvas.style.display).toBe("block");
      expect(canvas.dataset.lastSequence).toBe("101");
      expect(canvas.dataset.overlayCount).toBe("1");
      expect(operations).toContain("getContext:2d");
      expect(operations.some((operation) => operation.startsWith("createLinearGradient:"))).toBe(true);
      expect(operations.some((operation) => operation.startsWith("fillText:Camera camera-001:"))).toBe(true);
      expect(operations.some((operation) => operation.startsWith("fillText:Sequence 101:"))).toBe(true);
      expect(operations.some((operation) => operation.startsWith("strokeRect:"))).toBe(true);

      await renderer.dispose();
      await expect(renderer.renderFrame(createRenderRequest())).rejects.toThrow("must be configured");
    } finally {
      restoreDocument();
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
    expect(rendered.overlayPrimitiveCount).toBe(1);
    expect(rendered.renderedSequenceNumber).toBe(frame?.sequenceNumber);
  });
});
