import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PlayerTelemetryCollector,
  PresentationScheduler,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebPlayerBootstrap,
  WebTransportIngestClient,
} from "../contracts/services";
import type {
  MetadataTransportMessage,
  TimedMetadataBatch,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../contracts/models";

interface BrowserDemoApiResponse {
  streamId: string;
  displayName: string;
  scenarioId: string;
  sourceRtspUrl: string;
  sourceSummary: string;
  targetLatencyMs: number;
  frameIntervalMs: number;
  webTransportUrl: string;
  metadataChannelRequired: boolean;
  codec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
  videoMessages: Array<Omit<VideoTransportMessage, "payload"> & { payload: number[] }>;
  metadataMessages: MetadataTransportMessage[];
}

declare global {
  interface Window {
    __webvideoLiveDemoState?: {
      status: string;
      renderedSequences: number[];
      overlayCounts: number[];
      streamId?: string;
      error?: string;
    };
  }
}

function bind(testId: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  if (element) {
    element.textContent = value;
  }
}

function getRequestedStreamId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("stream")?.trim() || "camera-001";
}

async function loadStreamPayload(streamId: string): Promise<BrowserDemoApiResponse> {
  const response = await fetch(`/api/demo/streams/${encodeURIComponent(streamId)}`);
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status} for stream '${streamId}'.`);
  }

  return await response.json() as BrowserDemoApiResponse;
}

function normalizeVideoMessages(messages: BrowserDemoApiResponse["videoMessages"]): VideoTransportMessage[] {
  return messages.map((message) => ({
    ...message,
    payload: new Uint8Array(message.payload),
  }));
}

async function runLiveDemo(): Promise<void> {
  const streamId = getRequestedStreamId();
  const apiEndpoint = `/api/demo/streams/${encodeURIComponent(streamId)}`;
  bind("demo-api-endpoint", apiEndpoint);
  bind("demo-status", "loading");
  bind("demo-stream-id", streamId);
  bind("demo-error", "none");

  window.__webvideoLiveDemoState = {
    status: "loading",
    renderedSequences: [],
    overlayCounts: [],
    streamId,
  };

  const payload = await loadStreamPayload(streamId);
  const videoMessages = normalizeVideoMessages(payload.videoMessages);
  const metadataMessages = payload.metadataMessages;

  const bootstrap = new WebPlayerBootstrap();
  const transport = new WebTransportIngestClient({
    videoMessagesByStream: { [payload.streamId]: videoMessages },
    metadataMessagesByStream: { [payload.streamId]: metadataMessages },
  });
  const assembler = new EncodedChunkAssembler();
  const decoder = new VideoDecodeCoordinator();
  const metadataStore = new OverlayTimelineStore();
  const scheduler = new PresentationScheduler();
  const renderer = new WebGpuRenderer();
  const telemetry = new PlayerTelemetryCollector();

  bind("demo-display-name", payload.displayName);
  bind("demo-source-rtsp", payload.sourceRtspUrl);

  const session = await bootstrap.initializeSession({
    streamId: payload.streamId,
    viewerId: "browser-demo-viewer",
    targetLatencyMs: payload.targetLatencyMs,
    enableMetadata: true,
  });

  const connection = await transport.connect({
    streamId: payload.streamId,
    webTransportUrl: payload.webTransportUrl,
    authToken: "demo-token",
    metadataChannelRequired: payload.metadataChannelRequired,
  });

  const transportVideo = await transport.readVideoMessages(connection);
  const transportMetadata = await transport.readMetadataMessages(connection);
  const chunks = [];
  for (const message of transportVideo) {
    chunks.push(...await assembler.applyTransportMessage(message));
  }

  await decoder.configureDecoder(payload.codec);
  for (const chunk of chunks) {
    await decoder.enqueueChunk(chunk);
  }

  for (const message of transportMetadata) {
    const batch: TimedMetadataBatch = {
      streamId: message.streamId,
      batchStartTimestampUs: message.batchStartTimestampUs,
      batchEndTimestampUs: message.batchEndTimestampUs,
      records: message.records,
    };
    await metadataStore.ingestBatch(batch);
  }

  await renderer.configureSurface({
    canvasId: "live-demo-canvas",
    canvasWidth: payload.codec.codedWidth,
    canvasHeight: payload.codec.codedHeight,
    outputColorSpace: "srgb",
  });

  const frames = await decoder.flush();
  await telemetry.recordStageEvent({
    streamId: payload.streamId,
    stageName: "transport.read",
    latencyMs: 1.0,
    queueDepth: transportVideo.length,
  });

  bind("demo-status", "streaming");
  window.__webvideoLiveDemoState.status = "streaming";

  for (const frame of frames) {
    await scheduler.handleClockUpdate({
      streamId: frame.streamId,
      mediaTimestampUs: frame.presentationTimestampUs - 20_000,
      monotonicNowMs: performance.now(),
      clockSkewMs: 2,
    });

    const activeMetadata = await metadataStore.queryActiveMetadata(frame.streamId, frame.presentationTimestampUs);
    const decision = await scheduler.scheduleFrame(frame, activeMetadata);
    if (!decision.shouldRender) {
      continue;
    }

    const renderResult = await renderer.renderFrame({
      sessionId: session.sessionId,
      frame,
      activeMetadata,
      debugOverlayEnabled: true,
    });

    window.__webvideoLiveDemoState.renderedSequences.push(renderResult.renderedSequenceNumber);
    window.__webvideoLiveDemoState.overlayCounts.push(renderResult.overlayPrimitiveCount);

    bind("demo-rendered-count", String(window.__webvideoLiveDemoState.renderedSequences.length));
    bind("demo-last-sequence", String(renderResult.renderedSequenceNumber));
    bind("demo-overlay-count", String(renderResult.overlayPrimitiveCount));
    bind("demo-sequence-trace", window.__webvideoLiveDemoState.renderedSequences.join(", "));

    await telemetry.recordStageEvent({
      streamId: frame.streamId,
      stageName: "render.frame",
      latencyMs: 4.0,
      queueDepth: 0,
    });

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, payload.frameIntervalMs);
    });
  }

  const snapshot = await telemetry.createSnapshot(payload.streamId);
  bind("demo-telemetry-stages", snapshot.stages.map((stage) => stage.stageName).join(", "));
  bind("demo-status", "completed");
  window.__webvideoLiveDemoState.status = "completed";
  await bootstrap.disposeSession(session);
}

async function bootLiveDemo(): Promise<void> {
  try {
    await runLiveDemo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bind("demo-status", "error");
    bind("demo-error", message);
    window.__webvideoLiveDemoState = {
      status: "error",
      renderedSequences: [],
      overlayCounts: [],
      error: message,
      streamId: getRequestedStreamId(),
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootLiveDemo();
  }, { once: true });
} else {
  void bootLiveDemo();
}
