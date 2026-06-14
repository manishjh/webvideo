import { expect, test } from "@playwright/test";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("VMS client", () => {
  test.setTimeout(60_000);

  test("adds multiple camera channels, streams continuously, closes, and reopens a tile", async ({ page }) => {
    const channelCatalogResponses: unknown[] = [];
    const boundedSessionRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/api\/demo\/channels\/[^/]+\/sessions$/.test(request.url())) {
        boundedSessionRequests.push(request.url());
      }
    });
    page.on("response", async (response) => {
      if (response.url().endsWith("/api/demo/channels") && response.status() === 200) {
        channelCatalogResponses.push(await response.json());
      }
    });

    await page.goto("/vms.html");

    await expect(page.getByTestId("vms-title")).toHaveText("WebVideo VMS");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("4 channels");
    await expect(page.getByTestId("vms-batch-size")).toContainText("continuous WebTransport");
    await expect(page.getByTestId("channel-option-channel-001")).toContainText("CCTV Lobby 720p");
    await expect(page.getByTestId("channel-option-channel-002")).toContainText("CCTV Entrance 720p");
    expect(channelCatalogResponses.length).toBeGreaterThan(0);

    const continuousChannels = ["channel-001", "channel-002", "channel-003"];
    for (const channelId of continuousChannels) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    for (const channelId of continuousChannels) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
    }
    await assertBackendLiveMetrics(page, ["camera-001", "camera-002", "camera-003"]);

    const channel001Before = await tileSnapshot(page, "channel-001");
    const channel002Before = await tileSnapshot(page, "channel-002");
    const channel003Before = await tileSnapshot(page, "channel-003");
    await waitForProgressSince(page, "channel-001", channel001Before);
    await waitForProgressSince(page, "channel-002", channel002Before);
    await waitForProgressSince(page, "channel-003", channel003Before);

    const channel002BeforeClose = await tileSnapshot(page, "channel-002");
    const channel003BeforeClose = await tileSnapshot(page, "channel-003");
    await page.getByTestId("tile-channel-001").getByTestId("tile-close").click();
    await expect(page.getByTestId("tile-channel-001")).toHaveCount(0);
    await page.waitForFunction(
      () => !(window.__webvideoVmsState?.activeChannels ?? []).includes("channel-001"),
      undefined,
      { timeout: 5_000 },
    );
    await waitForProgressSince(page, "channel-002", channel002BeforeClose);
    await waitForProgressSince(page, "channel-003", channel003BeforeClose);

    await page.getByTestId("add-channel-channel-001").click();
    await waitForContinuousPlayback(page, "channel-001", 8);
    await assertStreamingTile(page, "channel-001");

    expect(boundedSessionRequests).toEqual([]);
  });
});

interface TileProgressSnapshot {
  framesRendered: number;
  bytesReceived: number;
  messagesReceived: number;
  lastSequenceNumber: number;
  lastFrameAtUnixTimeMs: number;
}

async function waitForContinuousPlayback(page: import("@playwright/test").Page, channelId: string, minimumFrames: number): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, minimumFrames: targetFrames, requireHardware }) => {
      const tile = window.__webvideoVmsState?.tiles[currentChannelId];
      if (!tile) {
        return false;
      }

      return (tile.status === "playing" || tile.status === "holding")
        && tile.connectionOpenCount === 1
        && tile.protocolEndFrameCount === 0
        && tile.activeTransport === "webtransport-quic"
        && tile.decodeBackend === "webcodecs"
        && (requireHardware ? tile.renderBackend === "webgpu" : Boolean(tile.renderBackend))
        && tile.streamMode === "continuous-moq"
        && tile.lastMoqTrackAlias === 1
        && (tile.lastMoqGroupId ?? 0) > 0
        && (tile.lastMoqObjectId ?? -1) >= 0
        && tile.metrics.framesRendered >= targetFrames
        && tile.metrics.renderFps > 0
        && tile.metrics.bytesReceived > 0
        && tile.metrics.messagesReceived >= targetFrames
        && (tile.lastSequenceNumber ?? 0) > 0
        && (tile.lastFrameAtUnixTimeMs ?? 0) > 0;
    },
    { channelId, minimumFrames, requireHardware: requireHardwareWebGpu },
    { timeout: 45_000 },
  );
}

async function waitForProgressSince(
  page: import("@playwright/test").Page,
  channelId: string,
  previous: TileProgressSnapshot,
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, previous: earlier }) => {
      const tile = window.__webvideoVmsState?.tiles[currentChannelId];
      if (!tile) {
        return false;
      }

      return tile.connectionOpenCount === 1
        && tile.protocolEndFrameCount === 0
        && tile.metrics.framesRendered > earlier.framesRendered
        && tile.metrics.bytesReceived > earlier.bytesReceived
        && tile.metrics.messagesReceived > earlier.messagesReceived
        && (tile.lastSequenceNumber ?? 0) > earlier.lastSequenceNumber
        && (tile.lastFrameAtUnixTimeMs ?? 0) > earlier.lastFrameAtUnixTimeMs;
    },
    { channelId, previous },
      { timeout: 20_000 },
    );
}

async function assertStreamingTile(page: import("@playwright/test").Page, channelId: string): Promise<void> {
  const tileLocator = page.getByTestId(`tile-${channelId}`);
  await expect(tileLocator.getByTestId("tile-status")).toHaveText(/playing|holding/);
  await expect(tileLocator.getByTestId("tile-transport")).toHaveText("webtransport-quic");
  await expect(tileLocator.getByTestId("tile-decode")).toHaveText("webcodecs");
  if (requireHardwareWebGpu) {
    await expect(tileLocator.getByTestId("tile-render")).toHaveText("webgpu");
    await expect(tileLocator.getByTestId("tile-gpu-path")).toHaveText("external-texture / webgpu-canvas");
    await expect(tileLocator.getByTestId("tile-gpu-adapter")).not.toHaveText(/google|swiftshader|pending/);
  } else {
    await expect(tileLocator.getByTestId("tile-render")).toHaveText(/webgpu|canvas2d-fallback/);
  }
  await expect(tileLocator.getByTestId("tile-error")).toHaveText("none");

  const tile = await page.evaluate((currentChannelId) => window.__webvideoVmsState?.tiles[currentChannelId], channelId);
  expect(tile?.activeTransport).toBe("webtransport-quic");
  expect(tile?.decodeBackend).toBe("webcodecs");
  if (requireHardwareWebGpu) {
    expect(tile?.renderBackend).toBe("webgpu");
  } else {
    expect(["webgpu", "canvas2d-fallback"]).toContain(tile?.renderBackend);
  }
  expect(tile?.streamMode).toBe("continuous-moq");
  expect(tile?.connectionOpenCount).toBe(1);
  expect(tile?.protocolEndFrameCount).toBe(0);
  expect(tile?.metrics.framesRendered).toBeGreaterThanOrEqual(8);
  expect(tile?.metrics.renderFps).toBeGreaterThan(15);
  expect(tile?.metrics.batchesCompleted).toBeLessThanOrEqual(1);
  expect(tile?.metrics.bytesReceived).toBeGreaterThan(0);
  expect(tile?.metrics.messagesReceived).toBeGreaterThanOrEqual(8);
  expect(tile?.lastSequenceNumber).toBeGreaterThan(0);
  expect(tile?.lastMoqTrackAlias).toBe(1);
  expect(tile?.lastMoqGroupId).toBeGreaterThan(0);
  expect(tile?.lastMoqObjectId).toBeGreaterThanOrEqual(0);
  expect(tile?.lastMoqSubgroupId).toBe(0);
  expect(tile?.lastMoqPublisherPriority).toBe(0);
  expect(tile?.lastMessageAtUnixTimeMs).toBeGreaterThan(0);
  expect(tile?.lastFrameAtUnixTimeMs).toBeGreaterThan(0);
  expect(tile?.metrics.sourceToRender.latestMs).toBeGreaterThan(0);
  expect(tile?.metrics.sourceToRender.p95Ms).toBeGreaterThan(0);
  expect(tile?.metrics.serverToRender.p95Ms).toBeGreaterThan(0);
  expect(tile?.metrics.receiveToRender.p95Ms).toBeGreaterThanOrEqual(0);
  expect(Number.isFinite(tile?.metrics.decode.p95Ms)).toBe(true);
  expect(Number.isFinite(tile?.metrics.render.p95Ms)).toBe(true);
  assertLocalLatencyBudgets(tile);

  const sample = await page.evaluate((currentChannelId) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${currentChannelId}']`);
    return {
      width: canvas?.width ?? 0,
      height: canvas?.height ?? 0,
      renderBackend: canvas?.dataset.renderBackend,
      gpuUploadSource: canvas?.dataset.gpuUploadSource,
      gpuPresentation: canvas?.dataset.gpuPresentation,
      gpuAdapterVendor: canvas?.dataset.gpuAdapterVendor,
      gpuAdapterArchitecture: canvas?.dataset.gpuAdapterArchitecture,
      gpuSample: (canvas?.dataset.gpuSampleRgba ?? "").split(",").map(Number),
    };
  }, channelId);
  expect(sample.width).toBeGreaterThan(0);
  expect(sample.height).toBeGreaterThan(0);
  if (requireHardwareWebGpu) {
    expect(sample.renderBackend).toBe("webgpu");
    expect(sample.gpuSample).toHaveLength(4);
    expect(sample.gpuSample[3]).toBeGreaterThan(0);
  } else {
    expect(["webgpu", "canvas2d-fallback"]).toContain(sample.renderBackend);
  }
  await expect(tileLocator.getByTestId("tile-render-fps")).toContainText("fps");
  await expect(tileLocator.getByTestId("tile-source-fps")).toContainText("fps");
  await expect(tileLocator.getByTestId("tile-client-drops")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-sequence-gaps")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-frame-hitches")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-frame-interval-p95")).toContainText("ms");
  if (requireHardwareWebGpu) {
    expect(sample.gpuAdapterVendor && sample.gpuAdapterVendor !== "google").toBe(true);
    expect(sample.gpuAdapterArchitecture && sample.gpuAdapterArchitecture !== "swiftshader").toBe(true);
    expect(sample.gpuPresentation).toBe("webgpu-canvas");
    expect(sample.gpuUploadSource).toBe("external-texture");
    expect(sample.gpuSample.slice(0, 3).some((channel) => channel > 0)).toBe(true);
  }
}

function assertLocalLatencyBudgets(tile: {
  metrics: {
    framesRendered: number;
    sourceToRender: { p95Ms: number };
    serverToRender: { p95Ms: number };
    receiveToRender: { p95Ms: number };
    decode: { p95Ms: number };
    render: { p95Ms: number };
  };
} | undefined): void {
  const s2rBudgetMs = Number(process.env.WEBVIDEO_E2E_S2R_P95_BUDGET_MS ?? "2000");
  const defaultServerToRenderBudgetMs = requireHardwareWebGpu ? "1000" : "2000";
  const serverToRenderBudgetMs = Number(process.env.WEBVIDEO_E2E_SERVER_TO_RENDER_P95_BUDGET_MS ?? defaultServerToRenderBudgetMs);
  const defaultReceiveToRenderBudgetMs = requireHardwareWebGpu ? "250" : "800";
  const receiveToRenderBudgetMs = Number(process.env.WEBVIDEO_E2E_RECEIVE_TO_RENDER_P95_BUDGET_MS ?? defaultReceiveToRenderBudgetMs);
  const decodeBudgetMs = Number(process.env.WEBVIDEO_E2E_DECODE_P95_BUDGET_MS ?? "100");
  const renderBudgetMs = Number(process.env.WEBVIDEO_E2E_RENDER_P95_BUDGET_MS ?? "100");

  expect(tile?.metrics.sourceToRender.p95Ms).toBeLessThan(s2rBudgetMs);
  expect(tile?.metrics.serverToRender.p95Ms).toBeLessThan(serverToRenderBudgetMs);
  expect(tile?.metrics.receiveToRender.p95Ms).toBeLessThan(receiveToRenderBudgetMs);
  expect(tile?.metrics.decode.p95Ms).toBeLessThan(decodeBudgetMs);
  expect(tile?.metrics.render.p95Ms).toBeLessThan(renderBudgetMs);
}

async function assertBackendLiveMetrics(page: import("@playwright/test").Page, streamIds: string[]): Promise<void> {
  const metrics = await page.evaluate(async () => {
    const response = await fetch("/api/demo/live/metrics");
    return await response.json();
  }) as Array<{
    streamId: string;
    processRunning: boolean;
    subscriberCount: number;
    framesRead: number;
    bytesRead: number;
    subscriberFramesDropped: number;
    subscribers: Array<{ pendingFrames: number; framesRead: number; framesDropped: number }>;
  }>;
  for (const streamId of streamIds) {
    const streamMetrics = metrics.find((candidate) => candidate.streamId === streamId);
    expect(streamMetrics?.processRunning).toBe(true);
    expect(streamMetrics?.subscriberCount).toBeGreaterThanOrEqual(1);
    expect(streamMetrics?.framesRead).toBeGreaterThan(0);
    expect(streamMetrics?.bytesRead).toBeGreaterThan(0);
    expect(streamMetrics?.subscribers[0]?.pendingFrames).toBeLessThanOrEqual(6);
  }
}

async function tileSnapshot(page: import("@playwright/test").Page, channelId: string): Promise<TileProgressSnapshot> {
  return await page.evaluate((currentChannelId) => {
    const tile = window.__webvideoVmsState?.tiles[currentChannelId];
    return {
      framesRendered: tile?.metrics.framesRendered ?? 0,
      bytesReceived: tile?.metrics.bytesReceived ?? 0,
      messagesReceived: tile?.metrics.messagesReceived ?? 0,
      lastSequenceNumber: tile?.lastSequenceNumber ?? 0,
      lastFrameAtUnixTimeMs: tile?.lastFrameAtUnixTimeMs ?? 0,
    };
  }, channelId);
}
