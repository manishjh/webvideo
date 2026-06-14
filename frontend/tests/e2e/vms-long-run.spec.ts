import { expect, test } from "@playwright/test";

const longRunEnabled = process.env.WEBVIDEO_E2E_LONG === "1";
const durationMs = Number(process.env.WEBVIDEO_E2E_LONG_DURATION_MS ?? "60000");
const sampleIntervalMs = Number(process.env.WEBVIDEO_E2E_LONG_SAMPLE_INTERVAL_MS ?? "5000");
const minimumFinalFps = Number(process.env.WEBVIDEO_E2E_LONG_MIN_FPS ?? "20");
const minimumFpsRatio = Number(process.env.WEBVIDEO_E2E_LONG_MIN_FPS_RATIO ?? "0.65");
const minimumIntervalFps = Number(process.env.WEBVIDEO_E2E_LONG_MIN_INTERVAL_FPS ?? "10");
const frameIntervalP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_FRAME_INTERVAL_P95_BUDGET_MS ?? "150");
const sourceToRenderP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_S2R_P95_BUDGET_MS ?? (process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1" ? "2000" : "3000"));
const receiveToRenderP95BudgetMs = Number(process.env.WEBVIDEO_E2E_LONG_R2R_P95_BUDGET_MS ?? "800");
const dropRatioBudget = Number(process.env.WEBVIDEO_E2E_LONG_DROP_RATIO_BUDGET ?? "0.05");
const backendDropRatioBudget = Number(process.env.WEBVIDEO_E2E_LONG_BACKEND_DROP_RATIO_BUDGET ?? (process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1" ? "0.10" : "0.30"));
const channels = (process.env.WEBVIDEO_E2E_LONG_CHANNELS ?? "channel-001,channel-002,channel-003")
  .split(",")
  .map((channel) => channel.trim())
  .filter((channel) => channel.length > 0);
const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("VMS long-running playback", () => {
  test.skip(!longRunEnabled, "Set WEBVIDEO_E2E_LONG=1 to run the 60 second VMS soak test.");
  test.setTimeout(durationMs + 90_000);

  test("keeps three RTSP-backed WebTransport/WebCodecs/WebGPU tiles moving for one minute", async ({ page }) => {
    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toContainText("channels");

    for (const channelId of channels) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    await waitForAllTilesPlaying(page);
    await waitForBackendMetrics(page);
    const baseline = await captureLongRunSample(page, channels);
    assertHealthySample(baseline, "baseline");

    let previous = baseline;
    const deadline = Date.now() + durationMs;
    let sampleIndex = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(Math.min(sampleIntervalMs, Math.max(0, deadline - Date.now())));
      const current = await captureLongRunSample(page, channels);
      sampleIndex += 1;
      assertHealthySample(current, `sample ${sampleIndex}`);
      assertIntervalProgress(previous, current, `sample ${sampleIndex}`);
      previous = current;
    }

    const finalSample = previous;
    assertLongRunProgress(baseline, finalSample);
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
  sourceToRenderP95Ms: number;
  receiveToRenderP95Ms: number;
  decodeP95Ms: number;
  renderP95Ms: number;
  lastSequenceNumber: number;
  lastFrameAtUnixTimeMs: number;
  lastMessageAtUnixTimeMs: number;
  canvasRenderBackend: string;
  canvasGpuUploadSource?: string;
  canvasGpuPresentation?: string;
  canvasGpuAdapterVendor?: string;
  canvasGpuAdapterArchitecture?: string;
  canvasGpuReadbackError?: string;
  canvasGpuSampleRgba?: string;
  canvasLastSequence: number;
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
  lastFrameUnixTimeMs?: number;
  subscribers: Array<{
    pendingFrames: number;
    framesRead: number;
    framesDropped: number;
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
        sourceToRenderP95Ms: tile?.metrics.sourceToRender.p95Ms ?? 0,
        receiveToRenderP95Ms: tile?.metrics.receiveToRender.p95Ms ?? 0,
        decodeP95Ms: tile?.metrics.decode.p95Ms ?? 0,
        renderP95Ms: tile?.metrics.render.p95Ms ?? 0,
        lastSequenceNumber: tile?.lastSequenceNumber ?? 0,
        lastFrameAtUnixTimeMs: tile?.lastFrameAtUnixTimeMs ?? 0,
        lastMessageAtUnixTimeMs: tile?.lastMessageAtUnixTimeMs ?? 0,
        canvasRenderBackend: canvas?.dataset.renderBackend ?? "",
        canvasGpuUploadSource: canvas?.dataset.gpuUploadSource,
        canvasGpuPresentation: canvas?.dataset.gpuPresentation,
        canvasGpuAdapterVendor: canvas?.dataset.gpuAdapterVendor,
        canvasGpuAdapterArchitecture: canvas?.dataset.gpuAdapterArchitecture,
        canvasGpuReadbackError: canvas?.dataset.gpuReadbackError,
        canvasGpuSampleRgba: canvas?.dataset.gpuSampleRgba,
        canvasLastSequence: Number(canvas?.dataset.lastSequence ?? "0"),
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
      expect(tile.canvasGpuUploadSource, `${label} ${channelId} GPU upload source`).toBe("external-texture");
      expect(tile.canvasGpuPresentation, `${label} ${channelId} GPU presentation`).toBe("webgpu-canvas");
      expect(tile.canvasGpuAdapterVendor && tile.canvasGpuAdapterVendor !== "google", `${label} ${channelId} GPU vendor`).toBe(true);
      expect(tile.canvasGpuAdapterArchitecture && tile.canvasGpuAdapterArchitecture !== "swiftshader", `${label} ${channelId} GPU architecture`).toBe(true);
    }
    expect(tile.connectionOpenCount, `${label} ${channelId} connection count`).toBe(1);
    expect(tile.protocolEndFrameCount, `${label} ${channelId} protocol end frames`).toBe(0);
    expect(tile.lastSequenceNumber, `${label} ${channelId} sequence`).toBeGreaterThan(0);
    expect(tile.canvasLastSequence, `${label} ${channelId} canvas sequence`).toBeGreaterThan(0);
    expect(tile.lastFrameAtUnixTimeMs, `${label} ${channelId} last frame time`).toBeGreaterThan(0);
    expect(tile.lastMessageAtUnixTimeMs, `${label} ${channelId} last message time`).toBeGreaterThan(0);
    expect(tile.renderFps, `${label} ${channelId} render fps`).toBeGreaterThan(minimumFpsForTile(tile));
    expect(tile.frameIntervalP95Ms, `${label} ${channelId} frame interval p95`).toBeLessThan(frameIntervalP95BudgetMs);
    expect(tile.sourceToRenderP95Ms, `${label} ${channelId} S2R p95`).toBeLessThan(sourceToRenderP95BudgetMs);
    expect(tile.receiveToRenderP95Ms, `${label} ${channelId} receive-to-render p95`).toBeLessThan(receiveToRenderP95BudgetMs);
    expect(tile.decodeP95Ms, `${label} ${channelId} decode p95`).toBeLessThan(150);
    expect(tile.renderP95Ms, `${label} ${channelId} render p95`).toBeLessThan(50);

    expect(tile.backend?.processRunning, `${label} ${channelId} backend process`).toBe(true);
    expect(tile.backend?.subscriberCount, `${label} ${channelId} backend subscribers`).toBeGreaterThanOrEqual(1);
    expect(tile.backend?.framesRead, `${label} ${channelId} backend frames`).toBeGreaterThan(0);
    expect(tile.backend?.bytesRead, `${label} ${channelId} backend bytes`).toBeGreaterThan(0);
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
    expect(after.framesRendered - before.framesRendered, `${label} ${channelId} frame progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(after.messagesReceived - before.messagesReceived, `${label} ${channelId} WebTransport message progress`).toBeGreaterThanOrEqual(minimumFrameDelta);
    expect(after.bytesReceived, `${label} ${channelId} byte progress`).toBeGreaterThan(before.bytesReceived);
    expect(after.lastSequenceNumber, `${label} ${channelId} sequence progress`).toBeGreaterThan(before.lastSequenceNumber);
    expect(after.lastFrameAtUnixTimeMs, `${label} ${channelId} render timestamp progress`).toBeGreaterThan(before.lastFrameAtUnixTimeMs);
    expect(after.lastMessageAtUnixTimeMs, `${label} ${channelId} message timestamp progress`).toBeGreaterThan(before.lastMessageAtUnixTimeMs);
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
    const backendDropDelta = (after.backend?.subscriberFramesDropped ?? 0) - (before.backend?.subscriberFramesDropped ?? 0);
    const allowedDrops = Math.max(30, Math.floor(messageDelta * dropRatioBudget));
    const allowedBackendDrops = Math.max(180, Math.floor(messageDelta * backendDropRatioBudget));

    expect(renderedDelta, `${channelId} sustained rendered frame delta`).toBeGreaterThanOrEqual(minimumRenderedFrames);
    expect(messageDelta, `${channelId} sustained WebTransport message delta`).toBeGreaterThanOrEqual(minimumRenderedFrames);
    expect(clientDropDelta, `${channelId} client drop delta`).toBeLessThanOrEqual(allowedDrops);
    expect(backendDropDelta, `${channelId} backend subscriber drop delta`).toBeLessThanOrEqual(allowedBackendDrops);
  }
}

function minimumFpsForTile(tile: TileLongRunSnapshot, fallback = minimumFinalFps): number {
  if (tile.sourceFrameRate > 0) {
    return Math.max(1, tile.sourceFrameRate * minimumFpsRatio);
  }

  return fallback;
}
