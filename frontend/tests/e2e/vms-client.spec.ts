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
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");
    await expect(page.getByTestId("vms-batch-size")).toContainText("continuous WebTransport");
    await expect(page.getByTestId("channel-option-channel-001")).toContainText("CCTV Lobby 720p");
    await expect(page.getByTestId("channel-option-channel-002")).toContainText("CCTV Entrance 720p");
    await expect(page.getByTestId("channel-option-channel-4k-crowd")).toContainText("CCTV Road Crowd 4K60");
    expect(channelCatalogResponses.length).toBeGreaterThan(0);

    const initialChannels = ["channel-001", "channel-002"];
    for (const channelId of initialChannels) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    for (const channelId of initialChannels) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
    }
    const channel001BeforeAddingThird = await tileSnapshot(page, "channel-001");
    const channel002BeforeAddingThird = await tileSnapshot(page, "channel-002");
    const channel001ConnectionsBeforeAddingThird = await tileConnectionOpenCount(page, "channel-001");
    const channel002ConnectionsBeforeAddingThird = await tileConnectionOpenCount(page, "channel-002");

    await page.getByTestId("add-channel-channel-003").click();
    await waitForContinuousPlayback(page, "channel-003", 8);
    await waitForProgressSince(page, "channel-001", channel001BeforeAddingThird);
    await waitForProgressSince(page, "channel-002", channel002BeforeAddingThird);
    expect(await tileConnectionOpenCount(page, "channel-001")).toBe(channel001ConnectionsBeforeAddingThird);
    expect(await tileConnectionOpenCount(page, "channel-002")).toBe(channel002ConnectionsBeforeAddingThird);

    const continuousChannels = ["channel-001", "channel-002", "channel-003"];
    for (const channelId of continuousChannels) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
    }
    await assertDiagnosticsCollapsedAndExpandable(page, "channel-001");
    await assertMatrixTilesVisible(page, continuousChannels);
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

  test("opens duplicate views of one camera through one shared channel session", async ({ page }) => {
    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await page.getByTestId("add-channel-channel-001").click();

    await expect(page.locator("[data-testid^='tile-channel-001']")).toHaveCount(2);
    await waitForContinuousPlayback(page, "channel-001", 8);
    await waitForContinuousPlayback(page, "channel-001-2", 8);
    await assertStreamingTile(page, "channel-001");
    await assertStreamingTile(page, "channel-001-2");
    await assertMatrixTilesVisible(page, ["channel-001", "channel-001-2"]);

    const duplicateState = await page.evaluate(() => window.__webvideoVmsState);
    expect(duplicateState?.activeChannels.filter((channelId) => channelId === "channel-001")).toHaveLength(2);
    expect(duplicateState?.activeTiles.map((tile) => tile.tileId)).toEqual(["channel-001", "channel-001-2"]);
    expect(duplicateState?.tiles["channel-001"]?.metrics.framesRendered).toBeGreaterThan(0);
    expect(duplicateState?.tiles["channel-001-2"]?.metrics.framesRendered).toBeGreaterThan(0);

    await waitForBackendSubscriberCount(page, "camera-001", 1);

    const secondTileBeforeClose = await tileSnapshot(page, "channel-001-2");
    await page.getByTestId("tile-channel-001").getByTestId("tile-close").click();
    await expect(page.getByTestId("tile-channel-001")).toHaveCount(0);
    await expect(page.getByTestId("tile-channel-001-2")).toHaveCount(1);
    await page.waitForFunction(
      () => {
        const state = window.__webvideoVmsState;
        return state
          && !state.activeTiles.some((tile) => tile.tileId === "channel-001")
          && state.activeTiles.some((tile) => tile.tileId === "channel-001-2")
          && state.activeChannels.filter((channelId) => channelId === "channel-001").length === 1;
      },
      undefined,
      { timeout: 8_000 },
    );
    await waitForBackendSubscriberCount(page, "camera-001", 1);
    await waitForProgressSince(page, "channel-001-2", secondTileBeforeClose);
  });

  test("renders an opt-in worker decode stream", async ({ page }) => {
    test.skip(
      process.env.WEBVIDEO_E2E_WORKER_DECODE !== "1",
      "Set WEBVIDEO_E2E_WORKER_DECODE=1 to exercise the experimental worker VideoDecoder handoff.",
    );

    await page.goto("/vms.html?decodeWorker=1");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await waitForContinuousPlayback(page, "channel-001", 8);
    const tileLocator = page.getByTestId("tile-channel-001");
    await tileLocator.getByTestId("tile-stats-toggle").click();
    await expect(tileLocator.getByTestId("tile-decode-pipeline")).toHaveText("worker");
    await assertStreamingTile(page, "channel-001");
    await assertMatrixTilesVisible(page, ["channel-001"]);
  });

  test("renders an opt-in media worker stream from WebTransport through WebCodecs", async ({ page }) => {
    test.skip(
      process.env.WEBVIDEO_E2E_MEDIA_WORKER !== "1",
      "Set WEBVIDEO_E2E_MEDIA_WORKER=1 to exercise worker-owned WebTransport and WebCodecs decode.",
    );

    await page.goto("/vms.html?mediaWorker=1");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await waitForContinuousPlayback(page, "channel-001", 8);
    const tileLocator = page.getByTestId("tile-channel-001");
    await tileLocator.getByTestId("tile-stats-toggle").click();
    await expect(tileLocator.getByTestId("tile-decode-pipeline")).toHaveText("media-worker");
    await assertStreamingTile(page, "channel-001");
    await assertMatrixTilesVisible(page, ["channel-001"]);
  });

  test("renders the VMS matrix through direct WebCodecs VideoFrame external textures", async ({ page }) => {
    test.skip(!requireHardwareWebGpu, "Hardware WebGPU is required to assert the external-texture matrix path.");

    await page.goto("/vms.html?matrixTexture=external");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await page.getByTestId("add-channel-channel-002").click();

    for (const channelId of ["channel-001", "channel-002"]) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-gpu-path")).toHaveText("external-texture / webgpu-canvas");
    }
    await assertMatrixTilesVisible(page, ["channel-001", "channel-002"]);
  });

  test("keeps high-fps stress isolated and recovers render caps after closing it", async ({ page }) => {
    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-4k-crowd").click();
    await waitForContinuousPlayback(page, "channel-4k-crowd", 12);
    await waitForHighSourceFrameRate(page, "channel-4k-crowd", 45);

    for (const channelId of ["channel-001", "channel-002", "channel-003", "channel-001"]) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    const visibleTiles = ["channel-4k-crowd", "channel-001", "channel-002", "channel-003", "channel-001-2"];
    for (const tileId of visibleTiles) {
      await waitForContinuousPlayback(page, tileId, 8, { allowReconnects: true });
    }
    await waitForRenderCaps(page, visibleTiles, 14, 16);
    await assertMatrixTilesVisible(page, visibleTiles);

    const normalTileIds = ["channel-001", "channel-002", "channel-003", "channel-001-2"];
    const beforeClose = new Map<string, TileProgressSnapshot>();
    const connectionCountsBeforeClose = new Map<string, number>();
    for (const tileId of normalTileIds) {
      beforeClose.set(tileId, await tileSnapshot(page, tileId));
      connectionCountsBeforeClose.set(tileId, await tileConnectionOpenCount(page, tileId));
    }

    await page.getByTestId("tile-channel-4k-crowd").getByTestId("tile-close").click();
    await expect(page.getByTestId("tile-channel-4k-crowd")).toHaveCount(0);
    await page.waitForFunction(
      () => !(window.__webvideoVmsState?.activeChannels ?? []).includes("channel-4k-crowd"),
      undefined,
      { timeout: 8_000 },
    );

    for (const tileId of normalTileIds) {
      await waitForResilientProgressSince(page, tileId, beforeClose.get(tileId)!);
      expect(await tileConnectionOpenCount(page, tileId)).toBeGreaterThanOrEqual(connectionCountsBeforeClose.get(tileId) ?? 1);
      await waitForSourceFrameRate(page, tileId, 29, 31);
    }
    await waitForRenderCaps(page, normalTileIds, 29, 31);
    await waitForAdaptivePressureAtMost(page, "channel-001", 1);
    await assertMatrixTilesVisible(page, normalTileIds);
  });

  test("recovers a VMS tile after a server-side WebTransport chaos disconnect", async ({ page }) => {
    await page.goto("/vms.html?chaosDisconnectAfterFrames=12");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await waitForContinuousPlayback(page, "channel-001", 6, { allowReconnects: true, allowProtocolEnds: true });
    const beforeReconnect = await tileSnapshot(page, "channel-001");

    await waitForConnectionOpenCountAtLeast(page, "channel-001", 2);
    await waitForResilientProgressSince(page, "channel-001", beforeReconnect);
    await assertStreamingTile(page, "channel-001", { allowProtocolEnds: true });
    await assertMatrixTilesVisible(page, ["channel-001"]);
  });

  test("keeps playback moving through delayed and dropped WebTransport frames", async ({ page }) => {
    await page.goto("/vms.html?chaosFrameDelayMs=6&chaosDropEveryNFrames=37");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-001").click();
    await waitForContinuousPlayback(page, "channel-001", 20);
    await page.waitForFunction(
      () => {
        const tile = window.__webvideoVmsState?.tiles["channel-001"];
        return tile
          && (tile.metrics.sequenceGapFrames > 0 || tile.metrics.framesDropped > 0)
          && (tile.status === "playing" || tile.status === "holding");
      },
      undefined,
      { timeout: 20_000 },
    );

    const afterChaos = await tileSnapshot(page, "channel-001");
    await waitForProgressSince(page, "channel-001", afterChaos);
    await assertStreamingTile(page, "channel-001");
    await assertMatrixTilesVisible(page, ["channel-001"]);
  });

  test("keeps mixed-rate 4K and 720p matrix tiles visible when one tile updates faster", async ({ page }) => {
    test.skip(process.env.WEBVIDEO_E2E_4K !== "1", "Set WEBVIDEO_E2E_4K=1 and START_4K_RTSP=1 to run the mixed-rate visual matrix check.");

    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("5 channels");

    await page.getByTestId("add-channel-channel-4k").click();
    await page.getByTestId("add-channel-channel-002").click();

    await waitForContinuousPlayback(page, "channel-4k", 8);
    await waitForContinuousPlayback(page, "channel-002", 8);
    await assertStreamingTile(page, "channel-4k", { minimumRenderFps: 1 });
    await assertStreamingTile(page, "channel-002");
    await page.waitForTimeout(2_000);
    await assertMatrixTilesVisible(page, ["channel-4k", "channel-002"]);
  });
});

interface TileProgressSnapshot {
  framesRendered: number;
  bytesReceived: number;
  messagesReceived: number;
  lastSequenceNumber: number;
  lastFrameAtUnixTimeMs: number;
}

interface TileFrameRateSnapshot {
  sourceFrameRate?: number;
  renderFrameRateLimit?: number;
}

async function assertDiagnosticsCollapsedAndExpandable(page: import("@playwright/test").Page, tileId: string): Promise<void> {
  const tileLocator = page.getByTestId(`tile-${tileId}`);
  await expect(tileLocator.getByTestId("tile-quick-stats")).toBeVisible();
  expect(await tileLocator.getByTestId("tile-diagnostics").evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await expect(tileLocator.getByTestId("tile-stats")).not.toBeVisible();
  await tileLocator.getByTestId("tile-stats-toggle").click();
  await expect(tileLocator.getByTestId("tile-stats")).toBeVisible();
}

async function waitForContinuousPlayback(
  page: import("@playwright/test").Page,
  channelId: string,
  minimumFrames: number,
  options: { allowReconnects?: boolean; allowProtocolEnds?: boolean } = {},
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, minimumFrames: targetFrames, requireHardware, allowReconnects, allowProtocolEnds }) => {
      const tile = window.__webvideoVmsState?.tiles[currentChannelId];
      if (!tile) {
        return false;
      }

      return (tile.status === "playing" || tile.status === "holding")
        && (allowReconnects ? tile.connectionOpenCount >= 1 : tile.connectionOpenCount === 1)
        && (allowProtocolEnds || tile.protocolEndFrameCount === 0)
        && tile.activeTransport === "webtransport-quic"
        && tile.decodeBackend === "webcodecs"
        && (requireHardware ? tile.renderBackend === "webgpu" : Boolean(tile.renderBackend))
        && tile.streamMode === "continuous-moq"
        && tile.lastMoqTrackAlias === 1
        && (tile.lastMoqGroupId ?? 0) > 0
        && (tile.lastMoqObjectId ?? -1) >= 0
        && tile.metrics.framesRendered >= targetFrames
        && tile.metrics.framesDecoded >= tile.metrics.framesRendered
        && tile.metrics.renderAttempts >= tile.metrics.framesRendered
        && tile.metrics.renderFps > 0
        && tile.metrics.bytesReceived > 0
        && tile.metrics.messagesReceived >= targetFrames
        && (tile.lastSequenceNumber ?? 0) > 0
        && (tile.lastFrameAtUnixTimeMs ?? 0) > 0;
    },
    {
      channelId,
      minimumFrames,
      requireHardware: requireHardwareWebGpu,
      allowReconnects: options.allowReconnects === true,
      allowProtocolEnds: options.allowProtocolEnds === true,
    },
    { timeout: 45_000 },
  );
}

async function waitForHighSourceFrameRate(
  page: import("@playwright/test").Page,
  channelId: string,
  minimumExclusive: number,
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, minimum }) => {
      return (window.__webvideoVmsState?.tiles[currentChannelId]?.sourceFrameRate ?? 0) > minimum;
    },
    { channelId, minimum: minimumExclusive },
    { timeout: 20_000 },
  );
}

async function waitForAdaptivePressureAtMost(
  page: import("@playwright/test").Page,
  channelId: string,
  maximumInclusive: number,
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, maximum }) => {
      const pressure = window.__webvideoVmsState?.tiles[currentChannelId]?.adaptiveRenderPressureLevel;
      return typeof pressure === "number" && pressure <= maximum;
    },
    { channelId, maximum: maximumInclusive },
    { timeout: 20_000 },
  );
}

async function waitForRenderCaps(
  page: import("@playwright/test").Page,
  channelIds: string[],
  minInclusive: number,
  maxInclusive: number,
): Promise<void> {
  await page.waitForFunction(
    ({ channelIds: currentChannelIds, minInclusive: min, maxInclusive: max }) => {
      return currentChannelIds.every((channelId) => {
        const cap = window.__webvideoVmsState?.tiles[channelId]?.renderFrameRateLimit;
        return typeof cap === "number" && cap >= min && cap <= max;
      });
    },
    { channelIds, minInclusive, maxInclusive },
    { timeout: 20_000 },
  );
}

async function waitForSourceFrameRate(
  page: import("@playwright/test").Page,
  channelId: string,
  minInclusive: number,
  maxInclusive: number,
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, minInclusive: min, maxInclusive: max }) => {
      const frameRate = window.__webvideoVmsState?.tiles[currentChannelId]?.sourceFrameRate;
      return typeof frameRate === "number" && frameRate >= min && frameRate <= max;
    },
    { channelId, minInclusive, maxInclusive },
    { timeout: 30_000 },
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

async function waitForResilientProgressSince(
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

      const frameClockAdvanced = (tile.lastFrameAtUnixTimeMs ?? 0) > earlier.lastFrameAtUnixTimeMs;
      const renderedMoreFrames = tile.metrics.framesRendered > earlier.framesRendered;

      return tile.connectionOpenCount >= 2
        && (tile.status === "playing" || tile.status === "holding")
        && tile.activeTransport === "webtransport-quic"
        && (renderedMoreFrames || frameClockAdvanced)
        && tile.metrics.bytesReceived > 0
        && tile.metrics.messagesReceived > 0
        && (tile.lastSequenceNumber ?? 0) > 0
        && (tile.lastFrameAtUnixTimeMs ?? 0) > 0;
    },
    { channelId, previous },
    { timeout: 30_000 },
  );
}

async function assertStreamingTile(
  page: import("@playwright/test").Page,
  channelId: string,
  options: { minimumRenderFps?: number; allowProtocolEnds?: boolean } = {},
): Promise<void> {
  const tileLocator = page.getByTestId(`tile-${channelId}`);
  await expect(tileLocator.getByTestId("tile-status")).toHaveText(/playing|holding/);
  await expect(tileLocator.getByTestId("tile-transport")).toHaveText("webtransport-quic");
  await expect(tileLocator.getByTestId("tile-decode")).toHaveText("webcodecs");
  if (requireHardwareWebGpu) {
    await expect(tileLocator.getByTestId("tile-render")).toHaveText("webgpu");
    await expect(tileLocator.getByTestId("tile-gpu-path")).toHaveText(/(external-texture|videoframe-copy) \/ webgpu-canvas/);
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
  if (options.allowProtocolEnds) {
    expect(tile?.connectionOpenCount).toBeGreaterThanOrEqual(1);
  } else {
    expect(tile?.connectionOpenCount).toBe(1);
    expect(tile?.protocolEndFrameCount).toBe(0);
  }
  expect(tile?.metrics.framesRendered).toBeGreaterThanOrEqual(8);
  expect(tile?.metrics.framesDecoded).toBeGreaterThanOrEqual(tile?.metrics.framesRendered ?? 0);
  expect(tile?.metrics.renderAttempts).toBeGreaterThanOrEqual(tile?.metrics.framesRendered ?? 0);
  expect(tile?.metrics.renderFps).toBeGreaterThanOrEqual(options.minimumRenderFps ?? minimumExpectedRenderFps(tile));
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
  await expect(tileLocator.getByTestId("tile-server-fps")).toContainText("fps");
  await expect(tileLocator.getByTestId("tile-server-recent-fps")).toContainText("fps");
  await expect(tileLocator.getByTestId("tile-server-restarts")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-client-drops")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-decoded")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-render-attempts")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-drop-reason")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-sequence-gaps")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-frame-hitches")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-frame-interval-p95")).toContainText("ms");
  await expect(tileLocator.getByTestId("tile-frame-interval-max")).toContainText("ms");
  await expect(tileLocator.getByTestId("tile-receive-interval-p95")).toContainText("ms");
  await expect(tileLocator.getByTestId("tile-raf-interval-p95")).toContainText("ms");
  await expect(tileLocator.getByTestId("tile-decode-backlog")).not.toHaveText("");
  await expect(tileLocator.getByTestId("tile-render-queue")).not.toHaveText("");
  if (requireHardwareWebGpu) {
    expect(sample.gpuAdapterVendor && sample.gpuAdapterVendor !== "google").toBe(true);
    expect(sample.gpuAdapterArchitecture && sample.gpuAdapterArchitecture !== "swiftshader").toBe(true);
    expect(sample.gpuPresentation).toBe("webgpu-canvas");
    expect(["external-texture", "videoframe-copy"]).toContain(sample.gpuUploadSource);
    expect(sample.gpuSample.slice(0, 3).some((channel) => channel > 0)).toBe(true);
  }
}

function minimumExpectedRenderFps(tile: TileFrameRateSnapshot | undefined): number {
  const sourceFrameRate = finitePositive(tile?.sourceFrameRate);
  const renderFrameRateLimit = finitePositive(tile?.renderFrameRateLimit);
  const effectiveFrameRate = renderFrameRateLimit ?? sourceFrameRate ?? 15;
  return Math.max(1, Math.min(15, effectiveFrameRate * 0.65));
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function assertMatrixTilesVisible(page: import("@playwright/test").Page, channelIds: string[]): Promise<void> {
  if (!requireHardwareWebGpu) {
    return;
  }

  await expect(async () => {
    const readback = await readMatrixTiles(page, channelIds);
    expect(readback.ok, `matrix canvas readback failed: ${"error" in readback ? readback.error : ""}`).toBe(true);
    for (const tile of readback.tiles) {
      expect(tile.alphaPixels, `${tile.channelId} matrix tile has visible pixels`).toBeGreaterThan(12);
      expect(tile.brightPixels, `${tile.channelId} matrix tile is not cleared/black`).toBeGreaterThan(3);
      expect(tile.colorRange, `${tile.channelId} matrix tile has image detail`).toBeGreaterThan(30);
    }
  }).toPass({ intervals: [250, 500, 1_000], timeout: 10_000 });
}

async function readMatrixTiles(page: import("@playwright/test").Page, channelIds: string[]) {
  return await page.evaluate(async (ids) => {
    const matrixCanvas = document.getElementById("vms-matrix-canvas") as HTMLCanvasElement | null;
    if (!matrixCanvas) {
      return { ok: false, error: "missing matrix canvas", tiles: [] };
    }

    const matrixRect = matrixCanvas.getBoundingClientRect();
    if (matrixRect.width <= 0 || matrixRect.height <= 0 || matrixCanvas.width <= 0 || matrixCanvas.height <= 0) {
      return { ok: false, error: "empty matrix canvas", tiles: [] };
    }

    try {
      const image = new Image();
      image.src = matrixCanvas.toDataURL("image/png");
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("matrix image decode failed"));
      });

      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = matrixCanvas.width;
      sampleCanvas.height = matrixCanvas.height;
      const context = sampleCanvas.getContext("2d");
      if (!context) {
        return { ok: false, error: "missing 2d readback context", tiles: [] };
      }

      context.drawImage(image, 0, 0);
      const scaleX = matrixCanvas.width / matrixRect.width;
      const scaleY = matrixCanvas.height / matrixRect.height;
      const tiles = ids.map((channelId) => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${channelId}']`);
        const tileRect = tileCanvas?.getBoundingClientRect();
        if (!tileCanvas || !tileRect || tileRect.width <= 0 || tileRect.height <= 0) {
          return {
            channelId,
            alphaPixels: 0,
            brightPixels: 0,
            colorRange: 0,
            samples: 0,
          };
        }

        let alphaPixels = 0;
        let brightPixels = 0;
        let minBrightness = Number.POSITIVE_INFINITY;
        let maxBrightness = 0;
        let samples = 0;
        const fractions = [0.18, 0.34, 0.5, 0.66, 0.82];
        for (const yFraction of fractions) {
          for (const xFraction of fractions) {
            const x = Math.max(0, Math.min(matrixCanvas.width - 1, Math.round((tileRect.left - matrixRect.left + tileRect.width * xFraction) * scaleX)));
            const y = Math.max(0, Math.min(matrixCanvas.height - 1, Math.round((tileRect.top - matrixRect.top + tileRect.height * yFraction) * scaleY)));
            const [red = 0, green = 0, blue = 0, alpha = 0] = Array.from(context.getImageData(x, y, 1, 1).data);
            const brightness = red + green + blue;
            samples += 1;
            if (alpha > 0) {
              alphaPixels += 1;
            }
            if (alpha > 0 && brightness > 70) {
              brightPixels += 1;
            }
            minBrightness = Math.min(minBrightness, brightness);
            maxBrightness = Math.max(maxBrightness, brightness);
          }
        }

        return {
          channelId,
          alphaPixels,
          brightPixels,
          colorRange: maxBrightness - minBrightness,
          samples,
        };
      });

      return { ok: true, tiles };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        tiles: [],
      };
    }
  }, channelIds);
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
    recentPublishedFps?: number;
    recentSubscriberReadFps?: number;
    subscribers: Array<{ pendingFrames: number; framesRead: number; framesDropped: number }>;
  }>;
  for (const streamId of streamIds) {
    const streamMetrics = metrics
      .filter((candidate) => candidate.streamId === streamId)
      .sort((left, right) => {
        if (left.subscriberCount !== right.subscriberCount) {
          return right.subscriberCount - left.subscriberCount;
        }

        return Number(right.processRunning) - Number(left.processRunning);
      })[0];
    expect(streamMetrics?.processRunning).toBe(true);
    expect(streamMetrics?.subscriberCount).toBeGreaterThanOrEqual(1);
    expect(streamMetrics?.framesRead).toBeGreaterThan(0);
    expect(streamMetrics?.bytesRead).toBeGreaterThan(0);
    expect(streamMetrics?.recentPublishedFps ?? 0).toBeGreaterThan(0);
    expect(streamMetrics?.recentSubscriberReadFps ?? 0).toBeGreaterThan(0);
    expect(streamMetrics?.subscribers[0]?.pendingFrames).toBeLessThanOrEqual(6);
  }
}

async function waitForBackendSubscriberCount(
  page: import("@playwright/test").Page,
  streamId: string,
  expectedSubscriberCount: number,
): Promise<void> {
  await page.waitForFunction(
    async ({ streamId: expectedStreamId, expectedSubscriberCount: expectedCount }) => {
      const response = await fetch("/api/demo/live/metrics");
      if (!response.ok) {
        return false;
      }

      const metrics = await response.json() as Array<{ streamId: string; subscriberCount: number }>;
      return metrics.find((candidate) => candidate.streamId === expectedStreamId)?.subscriberCount === expectedCount;
    },
    { streamId, expectedSubscriberCount },
    { timeout: 8_000 },
  );
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

async function tileConnectionOpenCount(page: import("@playwright/test").Page, channelId: string): Promise<number> {
  return await page.evaluate((currentChannelId) => {
    return window.__webvideoVmsState?.tiles[currentChannelId]?.connectionOpenCount ?? 0;
  }, channelId);
}

async function waitForConnectionOpenCountAtLeast(
  page: import("@playwright/test").Page,
  channelId: string,
  minimum: number,
): Promise<void> {
  await page.waitForFunction(
    ({ channelId: currentChannelId, minimum: target }) => {
      return (window.__webvideoVmsState?.tiles[currentChannelId]?.connectionOpenCount ?? 0) >= target;
    },
    { channelId, minimum },
    { timeout: 30_000 },
  );
}
