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
  e2eScenarioCatalog,
  frontendBehaviorCatalog,
  frontendFlowCatalog,
} from "../contracts/flows";
import {
  describeCapabilities,
  normalizeVideoMessages,
  openChannelSession,
} from "./browserDemoApi";
import type {
  BrowserTransportMode,
  DecodeBackend,
  MetadataTransportMessage,
  RenderBackend,
  TimedMetadataBatch,
} from "../contracts/models";

declare global {
  interface Window {
    __webvideoHarnessState?: {
      renderedSequences: number[];
      overlayCounts: number[];
      status: string;
      canvasLastSequence?: string;
      telemetryStages: string[];
      sessionId?: string;
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
      accessUnitFormat?: string;
      payloadBytes?: number;
      error?: string;
    };
  }
}

function appendCell(row: HTMLTableRowElement, value: string): void {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.appendChild(cell);
}

function bindText(testId: string, value: string): void {
  const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  if (element) {
    element.textContent = value;
  }
}

function renderFlowTable(): void {
  const target = document.querySelector<HTMLTableSectionElement>("[data-testid='flow-rows']");
  if (!target) {
    return;
  }

  for (const flow of frontendFlowCatalog) {
    const row = document.createElement("tr");
    row.dataset.testid = `flow-row-${flow.flowId}`;
    appendCell(row, flow.flowId);
    appendCell(row, flow.summary);
    appendCell(row, flow.steps.map((step) => `${step.sequence}. ${step.title}`).join(" | "));
    target.appendChild(row);
  }
}

function renderBehaviorTable(): void {
  const target = document.querySelector<HTMLTableSectionElement>("[data-testid='behavior-rows']");
  if (!target) {
    return;
  }

  for (const behavior of frontendBehaviorCatalog) {
    const row = document.createElement("tr");
    row.dataset.testid = `behavior-row-${behavior.specificationId}`;
    appendCell(row, behavior.specificationId);
    appendCell(row, behavior.summary);
    appendCell(row, behavior.requiredOutcomes.join(", "));
    target.appendChild(row);
  }
}

function renderScenarioTable(): void {
  const target = document.querySelector<HTMLTableSectionElement>("[data-testid='scenario-rows']");
  if (!target) {
    return;
  }

  for (const scenario of e2eScenarioCatalog) {
    const row = document.createElement("tr");
    row.dataset.testid = `scenario-row-${scenario.scenarioId}`;
    appendCell(row, scenario.scenarioId);
    appendCell(row, scenario.summary);
    appendCell(row, scenario.syntheticRtspScenarioId);
    appendCell(row, scenario.requiredAssertions.join(", "));
    target.appendChild(row);
  }
}

function renderCounts(): void {
  const flowCount = document.querySelector<HTMLElement>("[data-testid='flow-count']");
  const behaviorCount = document.querySelector<HTMLElement>("[data-testid='behavior-count']");
  const scenarioCount = document.querySelector<HTMLElement>("[data-testid='scenario-count']");

  if (flowCount) {
    flowCount.textContent = String(frontendFlowCatalog.length);
  }

  if (behaviorCount) {
    behaviorCount.textContent = String(frontendBehaviorCatalog.length);
  }

  if (scenarioCount) {
    scenarioCount.textContent = String(e2eScenarioCatalog.length);
  }
}

function shouldRunSimulatedPlayerFlow(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("runPlayer") !== "0";
}

async function runSimulatedPlayerFlow(): Promise<void> {
  const channelId = "channel-001";

  bindText("sim-status", "requesting-channel");
  bindText("sim-channel-id", channelId);
  bindText("sim-capabilities", describeCapabilities());
  bindText("sim-error", "none");

  window.__webvideoHarnessState = {
    renderedSequences: [],
    overlayCounts: [],
    status: "requesting-channel",
    telemetryStages: [],
    channelId,
  };

  const payload = await openChannelSession(channelId, {
    viewerId: "harness-viewer",
    authToken: "demo-token",
    targetLatencyMs: 150,
    enableMetadata: true,
  });
  const videoMessages = normalizeVideoMessages(payload.videoMessages);
  const metadataMessages: MetadataTransportMessage[] = payload.metadataMessages;
  const payloadBytes = videoMessages.reduce((total, message) => total + message.payload.byteLength, 0);

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

  const session = await bootstrap.initializeSession({
    channelId: payload.channelId,
    streamId: payload.streamId,
    viewerId: "harness-viewer",
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

  const receivedVideoMessages = await transport.readVideoMessages(connection);
  const receivedMetadataMessages = await transport.readMetadataMessages(connection);
  const chunks = [];
  for (const message of receivedVideoMessages) {
    chunks.push(...await assembler.applyTransportMessage(message));
  }

  await decoder.configureDecoder(payload.codec);
  for (const chunk of chunks) {
    await decoder.enqueueChunk(chunk);
  }
  const frames = await decoder.flush();
  const decodeBackend = frames[0]?.decodeBackend ?? "synthetic-frame-plan";
  await renderer.configureSurface({
    canvasId: "contract-canvas",
    canvasWidth: payload.codec.codedWidth,
    canvasHeight: payload.codec.codedHeight,
    outputColorSpace: "srgb",
  });

  const delay = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, durationMs);
    });

  window.__webvideoHarnessState = {
    renderedSequences: [],
    overlayCounts: [],
    status: "streaming",
    telemetryStages: [],
    channelId: payload.channelId,
    streamId: payload.streamId,
    sinkId: payload.sink.sinkId,
    requestedTransport: connection.requestedTransport,
    activeTransport: connection.activeTransport,
    webTransportReady: connection.webTransportReady,
    webTransportBytesReceived: connection.webTransportBytesReceived,
    webTransportMessagesReceived: connection.webTransportMessagesReceived,
    decodeBackend,
    renderBackend: "canvas2d-fallback",
    sourceMode: payload.sourceMode,
    sourceVerified: payload.sourceVerified,
    accessUnitFormat: payload.accessUnitFormat,
    payloadBytes,
  };

  bindText("sim-status", "streaming");
  bindText("sim-session-id", session.sessionId);
  bindText("sim-channel-id", payload.channelId);
  bindText("sim-stream-id", payload.streamId);
  bindText("sim-sink-id", payload.sink.sinkId);
  bindText("sim-transport-mode", `${connection.requestedTransport} -> ${connection.activeTransport}`);
  bindText("sim-webtransport-bytes", String(connection.webTransportBytesReceived));
  bindText("sim-webtransport-messages", String(connection.webTransportMessagesReceived));
  bindText("sim-decode-backend", decodeBackend);
  bindText("sim-render-backend", "pending");
  bindText("sim-source-mode", `${payload.sourceMode} (${payload.accessUnitFormat})`);
  bindText("sim-source-verified", payload.sourceVerified ? "yes" : "no");
  bindText("sim-source-diagnostics", payload.sourceDiagnostics);
  bindText("sim-payload-bytes", String(payloadBytes));
  bindText("sim-access-unit-format", payload.accessUnitFormat);
  bindText("sim-video-messages", String(receivedVideoMessages.length));
  bindText("sim-metadata-records", String(receivedMetadataMessages.reduce((total, batch) => total + batch.records.length, 0)));
  bindText("sim-rendered-count", "0");
  bindText("sim-telemetry-count", "0");
  bindText("sim-sequence-trace", "pending");

  await telemetry.recordStageEvent({
    streamId: payload.streamId,
    stageName: "transport.connect",
    latencyMs: connection.webTransportReady ? 1.0 : 0.1,
    queueDepth: 0,
  });

  await telemetry.recordStageEvent({
    streamId: payload.streamId,
    stageName: "transport.read",
    latencyMs: 1.1,
    queueDepth: receivedVideoMessages.length,
  });

  for (const metadataMessage of receivedMetadataMessages) {
    const metadataBatch: TimedMetadataBatch = {
      streamId: metadataMessage.streamId,
      batchStartTimestampUs: metadataMessage.batchStartTimestampUs,
      batchEndTimestampUs: metadataMessage.batchEndTimestampUs,
      records: metadataMessage.records,
    };
    await metadataStore.ingestBatch(metadataBatch);
  }

  for (const frame of frames) {
    await scheduler.handleClockUpdate({
      streamId: frame.streamId,
      mediaTimestampUs: frame.presentationTimestampUs - 20_000,
      monotonicNowMs: performance.now(),
      clockSkewMs: 3,
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

    await telemetry.recordStageEvent({
      streamId: frame.streamId,
      stageName: "render.frame",
      latencyMs: 4.5,
      queueDepth: 0,
    });

    const canvas = document.querySelector<HTMLCanvasElement>("#contract-canvas");
    window.__webvideoHarnessState.renderedSequences.push(renderResult.renderedSequenceNumber);
    window.__webvideoHarnessState.overlayCounts.push(renderResult.overlayPrimitiveCount);
    window.__webvideoHarnessState.canvasLastSequence = canvas?.dataset.lastSequence;
    window.__webvideoHarnessState.sessionId = session.sessionId;
    window.__webvideoHarnessState.renderBackend = renderResult.renderBackend;

    bindText("sim-rendered-sequence", String(renderResult.renderedSequenceNumber));
    bindText("sim-render-backend", renderResult.renderBackend);
    bindText("sim-overlay-count", String(renderResult.overlayPrimitiveCount));
    bindText("sim-decision", decision.shouldRender ? "render" : "hold");
    bindText("sim-rendered-count", String(window.__webvideoHarnessState.renderedSequences.length));
    bindText("sim-sequence-trace", window.__webvideoHarnessState.renderedSequences.join(", "));

    await delay(payload.frameIntervalMs);
  }

  const telemetrySnapshot = await telemetry.createSnapshot(payload.streamId);
  window.__webvideoHarnessState.status = "completed";
  window.__webvideoHarnessState.telemetryStages = telemetrySnapshot.stages.map((stage) => stage.stageName);
  bindText("sim-status", "completed");
  bindText("sim-telemetry-stages", telemetrySnapshot.stages.map((stage) => stage.stageName).join(", "));
  bindText("sim-telemetry-count", String(telemetrySnapshot.stages.length));

  await bootstrap.disposeSession(session);
}

async function bootHarness(): Promise<void> {
  renderCounts();
  renderFlowTable();
  renderBehaviorTable();
  renderScenarioTable();

  if (!shouldRunSimulatedPlayerFlow()) {
    bindText("sim-status", "idle");
    window.__webvideoHarnessState = {
      renderedSequences: [],
      overlayCounts: [],
      status: "idle",
      telemetryStages: [],
      channelId: "channel-001",
    };
    return;
  }

  try {
    await runSimulatedPlayerFlow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bindText("sim-status", "error");
    bindText("sim-error", message);
    window.__webvideoHarnessState = {
      renderedSequences: [],
      overlayCounts: [],
      status: "error",
      telemetryStages: [],
      channelId: "channel-001",
      error: message,
    };
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootHarness();
  }, { once: true });
} else {
  void bootHarness();
}
