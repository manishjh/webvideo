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
import {
  describeCapabilities,
  normalizeVideoMessages,
  openChannelSession,
} from "./browserDemoApi";
import type {
  BrowserTransportMode,
  DecodeBackend,
  RenderBackend,
  TimedMetadataBatch,
} from "../contracts/models";

declare global {
  interface Window {
    __webvideoLiveDemoState?: {
      status: string;
      renderedSequences: number[];
      overlayCounts: number[];
      channelId?: string;
      streamId?: string;
      sinkId?: string;
      requestedTransport?: BrowserTransportMode;
      activeTransport?: BrowserTransportMode;
      webTransportReady?: boolean;
      webTransportBytesReceived?: number;
      webTransportMessagesReceived?: number;
      decodeBackend?: DecodeBackend;
      renderBackend?: RenderBackend;
      sourceMode?: string;
      sourceVerified?: boolean;
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

function getRequestedChannelId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("channel")?.trim() || params.get("stream")?.trim() || "channel-4k-crowd";
}

function getRequestedFrameCount(): number | undefined {
  const params = new URLSearchParams(window.location.search);
  const parsed = Number.parseInt(params.get("frames") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function runLiveDemo(): Promise<void> {
  const channelId = getRequestedChannelId();
  const frameCount = getRequestedFrameCount();
  const apiEndpoint = `/api/demo/channels/${encodeURIComponent(channelId)}/sessions`;
  bind("demo-api-endpoint", apiEndpoint);
  bind("demo-status", "requesting-channel");
  bind("demo-channel-id", channelId);
  bind("demo-stream-id", "pending");
  bind("demo-error", "none");
  bind("demo-capabilities", describeCapabilities());

  window.__webvideoLiveDemoState = {
    status: "requesting-channel",
    renderedSequences: [],
    overlayCounts: [],
    channelId,
  };

  const payload = await openChannelSession(channelId, {
    viewerId: "browser-demo-viewer",
    authToken: "demo-token",
    targetLatencyMs: 150,
    enableMetadata: true,
    frameCount,
  });
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

  bind("demo-channel-id", payload.channelId);
  bind("demo-stream-id", payload.streamId);
  bind("demo-display-name", payload.displayName);
  bind("demo-source-rtsp", payload.sourceRtspUrl);
  bind("demo-quic-url", payload.webTransportUrl);
  bind("demo-sink-id", payload.sink.sinkId);
  bind("demo-transport-mode", `${payload.requestedTransport} -> ${payload.activeTransport}`);
  bind("demo-source-mode", `${payload.sourceMode} (${payload.accessUnitFormat})`);
  bind("demo-source-verified", payload.sourceVerified ? "yes" : "no");
  bind("demo-source-diagnostics", payload.sourceDiagnostics);

  const session = await bootstrap.initializeSession({
    channelId: payload.channelId,
    streamId: payload.streamId,
    viewerId: "browser-demo-viewer",
    targetLatencyMs: payload.targetLatencyMs,
    enableMetadata: true,
  });

  const connection = await transport.connect({
    channelId: payload.channelId,
    streamId: payload.streamId,
    webTransportUrl: payload.webTransportUrl,
    authToken: "demo-token",
    metadataChannelRequired: payload.metadataChannelRequired,
    requestedTransport: payload.requestedTransport,
    allowHttpFallback: true,
    serverCertificateHash: payload.webTransportCertificateHash,
    frameCount: payload.requestedFrameCount,
  });

  bind("demo-transport-mode", `${connection.requestedTransport} -> ${connection.activeTransport}`);
  bind("demo-webtransport-bytes", String(connection.webTransportBytesReceived));
  bind("demo-webtransport-messages", String(connection.webTransportMessagesReceived));
  await telemetry.recordStageEvent({
    streamId: payload.streamId,
    stageName: "transport.connect",
    latencyMs: connection.webTransportReady ? 1.0 : 0.1,
    queueDepth: 0,
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
  const decodeBackend = frames[0]?.decodeBackend ?? "synthetic-frame-plan";
  await telemetry.recordStageEvent({
    streamId: payload.streamId,
    stageName: "transport.read",
    latencyMs: 1.0,
    queueDepth: transportVideo.length,
  });

  bind("demo-status", "streaming");
  window.__webvideoLiveDemoState.status = "streaming";
  window.__webvideoLiveDemoState.channelId = payload.channelId;
  window.__webvideoLiveDemoState.streamId = payload.streamId;
  window.__webvideoLiveDemoState.sinkId = payload.sink.sinkId;
  window.__webvideoLiveDemoState.requestedTransport = connection.requestedTransport;
  window.__webvideoLiveDemoState.activeTransport = connection.activeTransport;
  window.__webvideoLiveDemoState.webTransportReady = connection.webTransportReady;
  window.__webvideoLiveDemoState.webTransportBytesReceived = connection.webTransportBytesReceived;
  window.__webvideoLiveDemoState.webTransportMessagesReceived = connection.webTransportMessagesReceived;
  window.__webvideoLiveDemoState.decodeBackend = decodeBackend;
  window.__webvideoLiveDemoState.renderBackend = "canvas2d-fallback";
  window.__webvideoLiveDemoState.sourceMode = payload.sourceMode;
  window.__webvideoLiveDemoState.sourceVerified = payload.sourceVerified;
  bind("demo-decode-backend", decodeBackend);
  bind("demo-render-backend", "pending");

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
    window.__webvideoLiveDemoState.renderBackend = renderResult.renderBackend;

    bind("demo-rendered-count", String(window.__webvideoLiveDemoState.renderedSequences.length));
    bind("demo-last-sequence", String(renderResult.renderedSequenceNumber));
    bind("demo-overlay-count", String(renderResult.overlayPrimitiveCount));
    bind("demo-render-backend", renderResult.renderBackend);
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
      channelId: getRequestedChannelId(),
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
