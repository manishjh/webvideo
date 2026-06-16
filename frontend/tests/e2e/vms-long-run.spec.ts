import { expect, test } from "@playwright/test";

const longRunEnabled = process.env.WEBVIDEO_E2E_LONG === "1";
const durationMs = Number(process.env.WEBVIDEO_E2E_LONG_DURATION_MS ?? "60000");
const sampleIntervalMs = Number(process.env.WEBVIDEO_E2E_LONG_SAMPLE_INTERVAL_MS ?? "5000");
const minimumFinalFps = Number(process.env.WEBVIDEO_E2E_LONG_MIN_FPS ?? "20");
const minimumFpsRatio = Number(process.env.WEBVIDEO_E2E_LONG_MIN_FPS_RATIO ?? "0.65");
const minimumIntervalFps = Number(process.env.WEBVIDEO_E2E_LONG_MIN_INTERVAL_FPS ?? "10");
const frameIntervalP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_FRAME_INTERVAL_P95_BUDGET_MS ?? "150");
const frameIntervalP99BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_FRAME_INTERVAL_P99_BUDGET_MS ?? String(frameIntervalP95BudgetMs * 2));
const sourceToRenderP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_S2R_P95_BUDGET_MS ?? (process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1" ? "2000" : "3000"));
const sourceToRenderMaxBudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_S2R_MAX_BUDGET_MS ?? String(sourceToRenderP95BudgetMs * 3));
const serverToRenderP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_SERVER_TO_RENDER_P95_BUDGET_MS ?? String(sourceToRenderP95BudgetMs));
const receiveToRenderP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_R2R_P95_BUDGET_MS ?? "800");
const backendFrameIntervalMaxBudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_BACKEND_FRAME_INTERVAL_MAX_BUDGET_MS ?? String(frameIntervalP95BudgetMs * 4));
const dropRatioBudget = Number(process.env.WEBVIDEO_E2E_LONG_DROP_RATIO_BUDGET ?? "0.05");
const backendDropRatioBudget = Number(process.env.WEBVIDEO_E2E_LONG_BACKEND_DROP_RATIO_BUDGET ?? (process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1" ? "0.10" : "0.30"));
const sequenceGapFrameBudget = Number(process.env.WEBVIDEO_E2E_LONG_SEQUENCE_GAP_FRAME_BUDGET ?? "0");
const severeHitchBudget = Number(process.env.WEBVIDEO_E2E_LONG_SEVERE_HITCH_BUDGET ?? "0");
const frameHitchRatioBudget = Number(process.env.WEBVIDEO_E2E_LONG_FRAME_HITCH_RATIO_BUDGET ?? "0.02");
const freshnessBudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_FRESHNESS_BUDGET_MS ?? "1500");
const backendRestartBudget = Number(process.env.WEBVIDEO_E2E_LONG_BACKEND_RESTART_BUDGET ?? "0");
const channels = (process.env.WEBVIDEO_E2E_LONG_CHANNELS ?? "channel-4k-crowd,channel-15116604,channel-16147856")
  .split(",")
  .map((channel) => channel.trim())
  .filter((channel) => channel.length > 0);
const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("VMS long-running playback", () => {
  test.skip(!longRunEnabled, "Set WEBVIDEO_E2E_LONG=1 to run the 60 second VMS soak test.");
  test.setTimeout(durationMs + 90_000);

  test("keeps three RTSP-backed WebTransport/WebCodecs/WebGPU tiles moving for one minute", async ({ page }, testInfo) => {
    const timeline: LongRunSample[] = [];
    try {
      await page.goto("/vms.html");
      await expect(page.getByTestId("channel-picker-status")).toContainText("channels");

      for (const channelId of channels) {
        await page.getByTestId(`add-channel-${channelId}`).click();
      }

      await waitForAllTilesPlaying(page);
      await waitForBackendMetrics(page);
      const baseline = await captureLongRunSample(page, channels);
      timeline.push(baseline);
      assertHealthySample(baseline, "baseline");

      let previous = baseline;
      const deadline = Date.now() + durationMs;
      let sampleIndex = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(sampleIntervalMs, Math.max(0, deadline - Date.now())));
        const current = await captureLongRunSample(page, channels);
        timeline.push(current);
        sampleIndex += 1;
        assertHealthySample(current, `sample ${sampleIndex}`);
        assertIntervalProgress(previous, current, `sample ${sampleIndex}`);
        previous = current;
      }

      const finalSample = previous;
      assertLongRunProgress(baseline, finalSample);
    } finally {
      await attachLongRunArtifacts(page, testInfo, timeline);
    }
  });
});

type ChannelId = string;

interface TileLongRunSnapshot {
  status: string;
  error?: string;
  activeTransport?: string;
  decodeBackend?: string;
  renderBackend?: string;
  connectionOpenCount: number;
  protocolEndFrameCount: number;
  framesRendered: number;
  framesDropped: number;
  sequenceGapFrames: number;
  frameHitches: number;
  severeFrameHitches: number;
  messagesReceived: number;
  bytesReceived: number;
  renderFps: number;
  cumulativeFps: number;
  sourceFrameRate: number;
  frameIntervalP95Ms: number;
  frameIntervalP99Ms: number;
  frameIntervalMaxMs: number;
  receiveIntervalP95Ms: number;
  rafIntervalP95Ms: number;
  decodeBacklogMaxFrames: number;
  renderQueueMaxFrames: number;
  sourceToRenderP50Ms: number;
  sourceToRenderP95Ms: number;
  sourceToRenderMaxMs: number;
  serverToRenderP95Ms: number;
  receiveToRenderP50Ms: number;
  receiveToRenderP95Ms: number;
  receiveToRenderMaxMs: number;
  decodeP95Ms: number;
  renderP95Ms: number;
  clientFrameAgeMs: number;
  clientMessageAgeMs: number;
  lastSequenceNumber: number;
  lastFrameAtUnixTimeMs: number;
  lastMessageAtUnixTimeMs: number;
  canvasRenderBackend: string;
  canvasGpuUploadSource?: string;
  canvasGpuPresentation?: string;
  canvasGpuAdapterVendor?: string;
  canvasGpuAdapterArchitecture?: string;
  canvasGpuReadbackError?: string;
  canvasWebGpuError?: string;
  canvasGpuExternalTextureError?: string;
  canvasGpuSampleRgba?: string;
  canvasLastSequence: number;
  webGpuDisabledReason?: string;
  backend?: BackendMetricSnapshot;
}

interface BackendMetricSnapshot {
  streamId: string;
  readerRunning?: boolean;
  processRunning: boolean;
  subscriberCount: number;
  framesRead: number;
  bytesRead: number;
  subscriberFramesDropped: number;
  lastFrameIntervalMs?: number;
  maxFrameIntervalMs?: number;
  lastFrameAgeMs?: number;
  recentFrameIntervalP95Ms?: number;
  recentFrameIntervalMaxMs?: number;
  recentFrameHitches?: number;
  recentSevereFrameHitches?: number;
  lastKeyFrameIntervalMs?: number;
  readerRestartCount?: number;
  readerErrorCount?: number;
  ingressFps?: number;
  publishedFps?: number;
  subscriberReadFps?: number;
  recentIngressFps?: number;
  recentPublishedFps?: number;
  recentSubscriberReadFps?: number;
  lastFrameUnixTimeMs?: number;
  subscribers: Array<{
    pendingFrames: number;
    framesRead: number;
    framesDropped: number;
    recentReadFps?: number;
  }>;
}

interface LongRunSample {
  capturedAtUnixTimeMs: number;
  tiles: Record<ChannelId, TileLongRunSnapshot>;
}

async function waitForAllTilesPlaying(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    ({ expectedChannels, requireHardware }) => expectedChannels.every((channelId) => {
      const tile = window.__webvideoVmsState?.tiles[channelId];
      return tile
        && (tile.status === "playing" || tile.status === "holding")
        && tile.activeTransport === "webtransport-quic"
        && tile.decodeBackend === "webcodecs"
        && (requireHardware ? tile.renderBackend === "webgpu" : Boolean(tile.renderBackend))
        && tile.connectionOpenCount === 1
        && tile.protocolEndFrameCount === 0
        && tile.metrics.framesRendered >= 30
        && tile.metrics.messagesReceived >= 30
        && tile.metrics.renderFps > 0;
    }),
    { expectedChannels: channels, requireHardware: requireHardwareWebGpu },
    { timeout: 45_000 },
  );
}

async function waitForBackendMetrics(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    (expectedChannels) => expectedChannels.every((channelId) => {
      const tile = window.__webvideoVmsState?.tiles[channelId];
      if (!tile) {
        return false;
      }

      const metric = window.__webvideoVmsState?.serverMetrics[tile.streamId];
      return metric
        && metric.processRunning
        && metric.subscriberCount >= 1
        && metric.framesRead > 0
        && metric.bytesRead > 0;
    }),
    channels,
    { timeout: 10_000 },
  );
}

async function captureLongRunSample(
  page: import("@playwright/test").Page,
  expectedChannels: readonly ChannelId[],
): Promise<LongRunSample> {
  return await page.evaluate(async (channelIds) => {
    const state = window.__webvideoVmsState;
    let serverMetrics = state?.serverMetrics ?? {};
    try {
      const response = await fetch("/api/demo/live/metrics");
      if (response.ok) {
        const metrics = await response.json() as BackendMetricSnapshot[];
        serverMetrics = Object.fromEntries(metrics.map((metric) => [metric.streamId, metric]));
      }
    } catch {
      // The assertions below will fail with a useful missing-backend message.
    }

    const tiles = {} as Record<ChannelId, TileLongRunSnapshot>;
    for (const channelId of channelIds) {
      const tile = state?.tiles[channelId];
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${channelId}']`);
      tiles[channelId] = {
        status: tile?.status ?? "missing",
        error: tile?.error,
        activeTransport: tile?.activeTransport,
        decodeBackend: tile?.decodeBackend,
        renderBackend: tile?.renderBackend,
        connectionOpenCount: tile?.connectionOpenCount ?? 0,
        protocolEndFrameCount: tile?.protocolEndFrameCount ?? 0,
        framesRendered: tile?.metrics.framesRendered ?? 0,
        framesDropped: tile?.metrics.framesDropped ?? 0,
        sequenceGapFrames: tile?.metrics.sequenceGapFrames ?? 0,
        frameHitches: tile?.metrics.frameHitches ?? 0,
        severeFrameHitches: tile?.metrics.severeFrameHitches ?? 0,
        messagesReceived: tile?.metrics.messagesReceived ?? 0,
        bytesReceived: tile?.metrics.bytesReceived ?? 0,
        renderFps: tile?.metrics.renderFps ?? 0,
        cumulativeFps: tile?.metrics.fps ?? 0,
        sourceFrameRate: tile?.sourceFrameRate ?? 0,
        frameIntervalP95Ms: tile?.metrics.frameInterval.p95Ms ?? 0,
        frameIntervalP99Ms: tile?.metrics.frameInterval.p99Ms ?? 0,
        frameIntervalMaxMs: tile?.metrics.frameInterval.maxMs ?? 0,
        receiveIntervalP95Ms: tile?.metrics.receiveInterval.p95Ms ?? 0,
        rafIntervalP95Ms: tile?.metrics.rafInterval.p95Ms ?? 0,
        decodeBacklogMaxFrames: tile?.metrics.decodeBacklog.maxMs ?? 0,
        renderQueueMaxFrames: tile?.metrics.renderQueue.maxMs ?? 0,
        sourceToRenderP50Ms: tile?.metrics.sourceToRender.p50Ms ?? 0,
        sourceToRenderP95Ms: tile?.metrics.sourceToRender.p95Ms ?? 0,
        sourceToRenderMaxMs: tile?.metrics.sourceToRender.maxMs ?? 0,
        serverToRenderP95Ms: tile?.metrics.serverToRender.p95Ms ?? 0,
        receiveToRenderP50Ms: tile?.metrics.receiveToRender.p50Ms ?? 0,
        receiveToRenderP95Ms: tile?.metrics.receiveToRender.p95Ms ?? 0,
        receiveToRenderMaxMs: tile?.metrics.receiveToRender.maxMs ?? 0,
        decodeP95Ms: tile?.metrics.decode.p95Ms ?? 0,
        renderP95Ms: tile?.metrics.render.p95Ms ?? 0,
        lastSequenceNumber: tile?.lastSequenceNumber ?? 0,
        lastFrameAtUnixTimeMs: tile?.lastFrameAtUnixTimeMs ?? 0,
        lastMessageAtUnixTimeMs: tile?.lastMessageAtUnixTimeMs ?? 0,
        clientFrameAgeMs: tile?.lastFrameAtUnixTimeMs ? Date.now() - tile.lastFrameAtUnixTimeMs : Number.POSITIVE_INFINITY,
        clientMessageAgeMs: tile?.lastMessageAtUnixTimeMs ? Date.now() - tile.lastMessageAtUnixTimeMs : Number.POSITIVE_INFINITY,
        canvasRenderBackend: canvas?.dataset.renderBackend ?? "",
        canvasGpuUploadSource: canvas?.dataset.gpuUploadSource,
        canvasGpuPresentation: canvas?.dataset.gpuPresentation,
        canvasGpuAdapterVendor: canvas?.dataset.gpuAdapterVendor,
        canvasGpuAdapterArchitecture: canvas?.dataset.gpuAdapterArchitecture,
        canvasGpuReadbackError: canvas?.dataset.gpuReadbackError,
        canvasWebGpuError: canvas?.dataset.webGpuError,
        canvasGpuExternalTextureError: canvas?.dataset.gpuExternalTextureError,
        canvasGpuSampleRgba: canvas?.dataset.gpuSampleRgba,
        canvasLastSequence: Number(canvas?.dataset.lastSequence ?? "0"),
        webGpuDisabledReason: tile?.webGpuDisabledReason,
        backend: tile ? serverMetrics[tile.streamId] as BackendMetricSnapshot | undefined : undefined,
      };
    }

    return {
      capturedAtUnixTimeMs: Date.now(),
      tiles,
    };
  }, expectedChannels);
}

function assertHealthySample(sample: LongRunSample, label: string): void {
  for (const channelId of channels) {
    const tile = sample.tiles[channelId];
    expect(tile.status, `${label} ${channelId} status`).toMatch(/playing|holding/);
    expect(tile.error ?? "", `${label} ${channelId} tile error`).toBe("");
    expect(tile.activeTransport, `${label} ${channelId} transport`).toBe("webtransport-quic");
    expect(tile.decodeBackend, `${label} ${channelId} decode backend`).toBe("webcodecs");
    if (requireHardwareWebGpu) {
      expect(tile.renderBackend, `${label} ${channelId} render backend`).toBe("webgpu");
      expect(tile.canvasRenderBackend, `${label} ${channelId} canvas render backend`).toBe("webgpu");
    } else {
      expect(["webgpu", "canvas2d-fallback"], `${label} ${channelId} render backend`).toContain(tile.renderBackend);
      expect(["webgpu", "canvas2d-fallback"], `${label} ${channelId} canvas render backend`).toContain(tile.canvasRenderBackend);
    }
    expect(tile.canvasGpuReadbackError ?? "", `${label} ${channelId} GPU readback error`).toBe("");
    if (requireHardwareWebGpu) {
      expect(["external-texture", "videoframe-copy"], `${label} ${channelId} GPU upload source`).toContain(tile.canvasGpuUploadSource);
      expect(tile.canvasGpuPresentation, `${label} ${channelId} GPU presentation`).toBe("webgpu-canvas");
      expect(tile.canvasGpuAdapterVendor && tile.canvasGpuAdapterVendor !== "google", `${label} ${channelId} GPU vendor`).toBe(true);
      expect(tile.canvasGpuAdapterArchitecture && tile.canvasGpuAdapterArchitecture !== "swiftshader", `${label} ${channelId} GPU architecture`).toBe(true);
      expect(tile.webGpuDisabledReason ?? "", `${label} ${channelId} WebGPU disabled reason`).toBe("");
      expect(tile.canvasWebGpuError ?? "", `${label} ${channelId} WebGPU error`).toBe("");
      expect(tile.canvasGpuExternalTextureError ?? "", `${label} ${channelId} external texture error`).toBe("");
    }
    expect(tile.connectionOpenCount, `${label} ${channelId} connection count`).toBe(1);
    expect(tile.protocolEndFrameCount, `${label} ${channelId} protocol end frames`).toBe(0);
    expect(tile.lastSequenceNumber, `${label} ${channelId} sequence`).toBeGreaterThan(0);
    expect(tile.canvasLastSequence, `${label} ${channelId} canvas sequence`).toBeGreaterThan(0);
    expect(tile.lastFrameAtUnixTimeMs, `${label} ${channelId} last frame time`).toBeGreaterThan(0);
    expect(tile.lastMessageAtUnixTimeMs, `${label} ${channelId} last message time`).toBeGreaterThan(0);
    expect(tile.clientFrameAgeMs, `${label} ${channelId} rendered frame freshness`).toBeLessThan(freshnessBudgetMs);
    expect(tile.clientMessageAgeMs, `${label} ${channelId} message freshness`).toBeLessThan(freshnessBudgetMs);
    expect(tile.renderFps, `${label} ${channelId} render fps`).toBeGreaterThan(minimumFpsForTile(tile));
    expect(tile.frameIntervalP95Ms, `${label} ${channelId} frame interval p95`).toBeLessThan(frameIntervalP95BudgetMs);
    expect(tile.frameIntervalP99Ms, `${label} ${channelId} frame interval p99`).toBeLessThan(frameIntervalP99BudgetMs);
    expect(tile.frameIntervalMaxMs, `${label} ${channelId} frame interval max`).toBeLessThan(frameIntervalP95BudgetMs * 4);
    expect(tile.receiveIntervalP95Ms, `${label} ${channelId} WebTransport receive interval p95`).toBeGreaterThanOrEqual(0);
    expect(tile.rafIntervalP95Ms, `${label} ${channelId} RAF interval p95`).toBeGreaterThanOrEqual(0);
    expect(tile.decodeBacklogMaxFrames, `${label} ${channelId} decode backlog max`).toBeLessThanOrEqual(12);
    expect(tile.renderQueueMaxFrames, `${label} ${channelId} render queue max`).toBeLessThanOrEqual(8);
    expect(tile.sourceToRenderP95Ms, `${label} ${channelId} S2R p95`).toBeLessThan(sourceToRenderP95BudgetMs);
    expect(tile.sourceToRenderMaxMs, `${label} ${channelId} S2R max`).toBeLessThan(sourceToRenderMaxBudgetMs);
    expect(tile.serverToRenderP95Ms, `${label} ${channelId} server-to-render p95`).toBeLessThan(serverToRenderP95BudgetMs);
    expect(tile.receiveToRenderP95Ms, `${label} ${channelId} receive-to-render p95`).toBeLessThan(receiveToRenderP95BudgetMs);
    expect(tile.receiveToRenderMaxMs, `${label} ${channelId} receive-to-render max`).toBeLessThan(receiveToRenderP95BudgetMs * 4);
    expect(tile.decodeP95Ms, `${label} ${channelId} decode p95`).toBeLessThan(150);
    expect(tile.renderP95Ms, `${label} ${channelId} render p95`).toBeLessThan(50);

    expect(tile.backend?.readerRunning, `${label} ${channelId} backend reader`).toBe(true);
    expect(tile.backend?.processRunning, `${label} ${channelId} backend process`).toBe(true);
    expect(tile.backend?.subscriberCount, `${label} ${channelId} backend subscribers`).toBeGreaterThanOrEqual(1);
    expect(tile.backend?.framesRead, `${label} ${channelId} backend frames`).toBeGreaterThan(0);
    expect(tile.backend?.bytesRead, `${label} ${channelId} backend bytes`).toBeGreaterThan(0);
    expect(tile.backend?.recentPublishedFps ?? 0, `${label} ${channelId} backend recent published fps`).toBeGreaterThan(0);
    expect(tile.backend?.recentSubscriberReadFps ?? 0, `${label} ${channelId} backend recent subscriber fps`).toBeGreaterThan(0);
    expect(tile.backend?.readerRestartCount ?? 0, `${label} ${channelId} backend restarts`).toBeLessThanOrEqual(backendRestartBudget);
    expect(tile.backend?.readerErrorCount ?? 0, `${label} ${channelId} backend errors`).toBe(0);
    expect(
      tile.backend?.recentFrameIntervalMaxMs ?? tile.backend?.maxFrameIntervalMs ?? 0,
      `${label} ${channelId} backend recent max frame interval`,
    ).toBeLessThan(backendFrameIntervalMaxBudgetMs);
    expect(tile.backend?.subscribers[0]?.pendingFrames ?? 0, `${label} ${channelId} backend pending frames`).toBeLessThanOrEqual(6);
    if (tile.backend?.lastFrameUnixTimeMs) {
      expect(sample.capturedAtUnixTimeMs - tile.backend.lastFrameUnixTimeMs, `${label} ${channelId} backend freshness`).toBeLessThan(2_000);
    }
  }
}

function assertIntervalProgress(previous: LongRunSample, current: LongRunSample, label: string): void {
  const elapsedSeconds = Math.max((current.capturedAtUnixTimeMs - previous.capturedAtUnixTimeMs) / 1000, 0.001);

  for (const channelId of channels) {
    const before = previous.tiles[channelId];
    const after = current.tiles[channelId];
    const minimumFrameDelta = Math.floor(elapsedSeconds * minimumFpsForTile(after, minimumIntervalFps));
    const renderedDelta = after.framesRendered - before.framesRendered;
    const messageDelta = after.messagesReceived - before.messagesReceived;
    const clientDropDelta = after.framesDropped - before.framesDropped;
    const backendDropDelta = (after.backend?.subscriberFramesDropped ?? 0) - (before.backend?.subscriberFramesDropped ?? 0);
    const backendFrameDelta = (after.backend?.framesRead ?? 0) - (before.backend?.framesRead ?? 0);
    const backendSubscriberReadDelta = (after.backend?.subscribers[0]?.framesRead ?? 0) - (before.backend?.subscribers[0]?.framesRead ?? 0);
    expect(renderedDelta, `${label} ${channelId} frame progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(messageDelta, `${label} ${channelId} WebTransport message progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(backendFrameDelta, `${label} ${channelId} backend frame progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(backendSubscriberReadDelta, `${label} ${channelId} backend subscriber progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(after.bytesReceived, `${label} ${channelId} byte progress`).toBeGreaterThan(before.bytesReceived);
    expect(after.lastSequenceNumber, `${label} ${channelId} sequence progress`).toBeGreaterThan(before.lastSequenceNumber);
    expect(after.canvasLastSequence, `${label} ${channelId} canvas sequence progress`).toBeGreaterThan(before.canvasLastSequence);
    expect(after.lastFrameAtUnixTimeMs, `${label} ${channelId} render timestamp progress`).toBeGreaterThan(before.lastFrameAtUnixTimeMs);
    expect(after.lastMessageAtUnixTimeMs, `${label} ${channelId} message timestamp progress`).toBeGreaterThan(before.lastMessageAtUnixTimeMs);
    expect(after.sequenceGapFrames - before.sequenceGapFrames, `${label} ${channelId} interval sequence gaps`).toBeLessThanOrEqual(sequenceGapFrameBudget);
    expect(after.severeFrameHitches - before.severeFrameHitches, `${label} ${channelId} interval severe hitches`).toBeLessThanOrEqual(severeHitchBudget);
    expect(after.frameHitches - before.frameHitches, `${label} ${channelId} interval hitches`).toBeLessThanOrEqual(
      Math.max(1, Math.floor(renderedDelta * frameHitchRatioBudget)),
    );
    expect(clientDropDelta, `${label} ${channelId} interval client drops`).toBeLessThanOrEqual(
      Math.max(1, Math.floor(messageDelta * dropRatioBudget)),
    );
    expect(backendDropDelta, `${label} ${channelId} interval backend drops`).toBeLessThanOrEqual(
      Math.max(1, Math.floor(messageDelta * backendDropRatioBudget)),
    );
  }
}

function assertLongRunProgress(baseline: LongRunSample, finalSample: LongRunSample): void {
  const elapsedSeconds = Math.max((finalSample.capturedAtUnixTimeMs - baseline.capturedAtUnixTimeMs) / 1000, 0.001);

  for (const channelId of channels) {
    const before = baseline.tiles[channelId];
    const after = finalSample.tiles[channelId];
    const minimumRenderedFrames = Math.floor(elapsedSeconds * minimumFpsForTile(after));
    const renderedDelta = after.framesRendered - before.framesRendered;
    const messageDelta = after.messagesReceived - before.messagesReceived;
    const clientDropDelta = after.framesDropped - before.framesDropped;
    const sequenceGapDelta = after.sequenceGapFrames - before.sequenceGapFrames;
    const severeHitchDelta = after.severeFrameHitches - before.severeFrameHitches;
    const frameHitchDelta = after.frameHitches - before.frameHitches;
    const backendDropDelta = (after.backend?.subscriberFramesDropped ?? 0) - (before.backend?.subscriberFramesDropped ?? 0);
    const allowedDrops = Math.max(3, Math.floor(messageDelta * dropRatioBudget));
    const allowedBackendDrops = Math.max(10, Math.floor(messageDelta * backendDropRatioBudget));
    const allowedHitches = Math.max(1, Math.floor(renderedDelta * frameHitchRatioBudget));

    expect(renderedDelta, `${channelId} sustained rendered frame delta`).toBeGreaterThanOrEqual(minimumRenderedFrames);
    expect(messageDelta, `${channelId} sustained WebTransport message delta`).toBeGreaterThanOrEqual(minimumRenderedFrames);
    expect(clientDropDelta, `${channelId} client drop delta`).toBeLessThanOrEqual(allowedDrops);
    expect(backendDropDelta, `${channelId} backend subscriber drop delta`).toBeLessThanOrEqual(allowedBackendDrops);
    expect(sequenceGapDelta, `${channelId} sustained sequence gaps`).toBeLessThanOrEqual(sequenceGapFrameBudget);
    expect(severeHitchDelta, `${channelId} sustained severe hitches`).toBeLessThanOrEqual(severeHitchBudget);
    expect(frameHitchDelta, `${channelId} sustained frame hitches`).toBeLessThanOrEqual(allowedHitches);
  }
}

function minimumFpsForTile(tile: TileLongRunSnapshot, fallback = minimumFinalFps): number {
  if (tile.sourceFrameRate > 0) {
    return Math.max(1, tile.sourceFrameRate * minimumFpsRatio);
  }

  return fallback;
}

async function attachLongRunArtifacts(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  timeline: readonly LongRunSample[],
): Promise<void> {
  if (timeline.length > 0) {
    await testInfo.attach("vms-long-run-metrics.jsonl", {
      body: timeline.map((sample) => JSON.stringify(sample)).join("\n"),
      contentType: "application/jsonl",
    });
  }

  try {
    const state = await page.evaluate(() => window.__webvideoVmsState ?? null);
    await testInfo.attach("vms-window-state.json", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    });
  } catch {
    // Page-level diagnostics are best-effort after crashes or forced browser teardown.
  }

  try {
    const backendMetrics = await page.evaluate(async () => {
      const response = await fetch("/api/demo/live/metrics");
      return response.ok ? await response.json() : { status: response.status };
    });
    await testInfo.attach("vms-backend-metrics.json", {
      body: JSON.stringify(backendMetrics, null, 2),
      contentType: "application/json",
    });
  } catch {
    // Assertion errors still include the missing backend condition when the page is alive.
  }

  try {
    await testInfo.attach("vms-long-run-page.png", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  } catch {
    // Screenshot capture is diagnostic only.
  }
}
