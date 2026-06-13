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
import type {
  MetadataTransportMessage,
  TimedMetadataBatch,
  VideoTransportMessage,
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
    };
  }
}

function appendCell(row: HTMLTableRowElement, value: string): void {
  const cell = document.createElement("td");
  cell.textContent = value;
  row.appendChild(cell);
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

async function runSimulatedPlayerFlow(): Promise<void> {
  const baseTimestampUs = 2_000_000;
  const frameDurationUs = 33_333;
  const videoMessages: VideoTransportMessage[] = Array.from({ length: 8 }, (_, index) => ({
    streamId: "camera-001",
    sequenceNumber: 101 + index,
    presentationTimestampUs: baseTimestampUs + index * frameDurationUs,
    decodeTimestampUs: baseTimestampUs + index * frameDurationUs,
    keyFrame: index === 0,
    codecConfigVersion: "cfg-001",
    payload: new Uint8Array([index + 1, (index + 3) * 2]),
  }));
  const metadataMessages: MetadataTransportMessage[] = videoMessages.map((message, index) => ({
    streamId: message.streamId,
    batchStartTimestampUs: message.presentationTimestampUs,
    batchEndTimestampUs: message.presentationTimestampUs + frameDurationUs,
    records: [
      {
        eventId: `evt-${index + 1}`,
        eventType: "box2d",
        startTimestampUs: message.presentationTimestampUs,
        endTimestampUs: message.presentationTimestampUs + frameDurationUs,
        coordinateSpace: "normalized-video",
        tags: {
          label: index % 2 === 0 ? "ball" : "player",
          x: `${0.1 + index * 0.07}`,
          y: `${0.12 + (index % 3) * 0.12}`,
          w: "0.14",
          h: "0.18",
        },
      },
    ],
  }));

  const bootstrap = new WebPlayerBootstrap();
  const transport = new WebTransportIngestClient({
    videoMessagesByStream: { "camera-001": videoMessages },
    metadataMessagesByStream: { "camera-001": metadataMessages },
  });
  const assembler = new EncodedChunkAssembler();
  const decoder = new VideoDecodeCoordinator();
  const metadataStore = new OverlayTimelineStore();
  const scheduler = new PresentationScheduler();
  const renderer = new WebGpuRenderer();
  const telemetry = new PlayerTelemetryCollector();

  const session = await bootstrap.initializeSession({
    streamId: "camera-001",
    viewerId: "harness-viewer",
    targetLatencyMs: 150,
    enableMetadata: true,
  });
  const connection = await transport.connect({
    streamId: "camera-001",
    webTransportUrl: "https://localhost:9443/live/camera-001",
    authToken: "token",
    metadataChannelRequired: true,
  });

  const receivedVideoMessages = await transport.readVideoMessages(connection);
  const receivedMetadataMessages = await transport.readMetadataMessages(connection);
  const chunks = [];
  for (const message of receivedVideoMessages) {
    chunks.push(...await assembler.applyTransportMessage(message));
  }

  await decoder.configureDecoder({
    codec: "avc1",
    codedWidth: 1280,
    codedHeight: 720,
  });
  for (const chunk of chunks) {
    await decoder.enqueueChunk(chunk);
  }
  const frames = await decoder.flush();
  await renderer.configureSurface({
    canvasId: "contract-canvas",
    canvasWidth: 1280,
    canvasHeight: 720,
    outputColorSpace: "srgb",
  });
  const bind = (testId: string, value: string): void => {
    const element = document.querySelector<HTMLElement>(`[data-testid='${testId}']`);
    if (element) {
      element.textContent = value;
    }
  };

  const delay = (durationMs: number): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, durationMs);
    });

  window.__webvideoHarnessState = {
    renderedSequences: [],
    overlayCounts: [],
    status: "streaming",
    telemetryStages: [],
  };

  bind("sim-status", "streaming");
  bind("sim-session-id", session.sessionId);
  bind("sim-video-messages", String(receivedVideoMessages.length));
  bind("sim-metadata-records", String(receivedMetadataMessages.reduce((total, batch) => total + batch.records.length, 0)));
  bind("sim-rendered-count", "0");
  bind("sim-telemetry-count", "0");
  bind("sim-sequence-trace", "pending");

  await telemetry.recordStageEvent({
    streamId: "camera-001",
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

    bind("sim-rendered-sequence", String(renderResult.renderedSequenceNumber));
    bind("sim-overlay-count", String(renderResult.overlayPrimitiveCount));
    bind("sim-decision", decision.shouldRender ? "render" : "hold");
    bind("sim-rendered-count", String(window.__webvideoHarnessState.renderedSequences.length));
    bind("sim-sequence-trace", window.__webvideoHarnessState.renderedSequences.join(", "));

    await delay(60);
  }

  const telemetrySnapshot = await telemetry.createSnapshot("camera-001");
  window.__webvideoHarnessState.status = "completed";
  window.__webvideoHarnessState.telemetryStages = telemetrySnapshot.stages.map((stage) => stage.stageName);
  bind("sim-status", "completed");
  bind("sim-telemetry-stages", telemetrySnapshot.stages.map((stage) => stage.stageName).join(", "));
  bind("sim-telemetry-count", String(telemetrySnapshot.stages.length));

  await bootstrap.disposeSession(session);
}

async function bootHarness(): Promise<void> {
  renderCounts();
  renderFlowTable();
  renderBehaviorTable();
  renderScenarioTable();
  await runSimulatedPlayerFlow();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootHarness();
  }, { once: true });
} else {
  void bootHarness();
}
