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
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");
    await expect(page.getByTestId("vms-batch-size")).toContainText("continuous WebTransport");
    await expect(page.getByTestId("channel-option-channel-13535786")).toContainText("Clip 13535786 4K60");
    await expect(page.getByTestId("channel-option-channel-15116604")).toContainText("Clip 15116604 4K30");
    await expect(page.getByTestId("channel-option-channel-4k-crowd")).toContainText("CCTV Road Crowd 4K60");
    expect(channelCatalogResponses.length).toBeGreaterThan(0);

    const initialChannels = ["channel-13535786", "channel-15116604"];
    for (const channelId of initialChannels) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    for (const channelId of initialChannels) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
    }
    const channel001BeforeAddingThird = await tileSnapshot(page, "channel-13535786");
    const channel002BeforeAddingThird = await tileSnapshot(page, "channel-15116604");
    const channel001ConnectionsBeforeAddingThird = await tileConnectionOpenCount(page, "channel-13535786");
    const channel002ConnectionsBeforeAddingThird = await tileConnectionOpenCount(page, "channel-15116604");

    await page.getByTestId("add-channel-channel-16147856").click();
    await waitForContinuousPlayback(page, "channel-16147856", 8);
    await waitForProgressSince(page, "channel-13535786", channel001BeforeAddingThird);
    await waitForProgressSince(page, "channel-15116604", channel002BeforeAddingThird);
    expect(await tileConnectionOpenCount(page, "channel-13535786")).toBe(channel001ConnectionsBeforeAddingThird);
    expect(await tileConnectionOpenCount(page, "channel-15116604")).toBe(channel002ConnectionsBeforeAddingThird);

    const continuousChannels = ["channel-13535786", "channel-15116604", "channel-16147856"];
    for (const channelId of continuousChannels) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
    }
    await assertDiagnosticsCollapsedAndExpandable(page, "channel-13535786");
    if (requireHardwareWebGpu) {
      await assertMetadataOsdCanToggle(page, "channel-13535786", "3840x2160");
    }
    await assertMatrixTilesVisible(page, continuousChannels);
    await assertBackendLiveMetrics(page, ["camera-13535786", "camera-15116604", "camera-16147856"]);

    const channel001Before = await tileSnapshot(page, "channel-13535786");
    const channel002Before = await tileSnapshot(page, "channel-15116604");
    const channel003Before = await tileSnapshot(page, "channel-16147856");
    await waitForProgressSince(page, "channel-13535786", channel001Before);
    await waitForProgressSince(page, "channel-15116604", channel002Before);
    await waitForProgressSince(page, "channel-16147856", channel003Before);

    const channel002BeforeClose = await tileSnapshot(page, "channel-15116604");
    const channel003BeforeClose = await tileSnapshot(page, "channel-16147856");
    await page.getByTestId("tile-channel-13535786").getByTestId("tile-close").click();
    await expect(page.getByTestId("tile-channel-13535786")).toHaveCount(0);
    await page.waitForFunction(
      () => !(window.__webvideoVmsState?.activeChannels ?? []).includes("channel-13535786"),
      undefined,
      { timeout: 5_000 },
    );
    await waitForProgressSince(page, "channel-15116604", channel002BeforeClose);
    await waitForProgressSince(page, "channel-16147856", channel003BeforeClose);

    await page.getByTestId("add-channel-channel-13535786").click();
    await waitForContinuousPlayback(page, "channel-13535786", 8);
    await assertStreamingTile(page, "channel-13535786");

    expect(boundedSessionRequests).toEqual([]);
  });

  test("opens duplicate views of one camera through one shared channel session", async ({ page }) => {
    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-16147856").click();
    await page.getByTestId("add-channel-channel-16147856").click();

    await expect(page.locator("[data-testid^='tile-channel-16147856']")).toHaveCount(2);
    await waitForContinuousPlayback(page, "channel-16147856", 8);
    await waitForContinuousPlayback(page, "channel-16147856-2", 8);
    await assertStreamingTile(page, "channel-16147856", { receiveToRenderP95BudgetMs: 1500 });
    await assertStreamingTile(page, "channel-16147856-2", { receiveToRenderP95BudgetMs: 1500 });
    await assertMatrixTilesVisible(page, ["channel-16147856", "channel-16147856-2"]);

    const duplicateState = await page.evaluate(() => window.__webvideoVmsState);
    expect(duplicateState?.activeChannels.filter((channelId) => channelId === "channel-16147856")).toHaveLength(2);
    expect(duplicateState?.activeTiles.map((tile) => tile.tileId)).toEqual(["channel-16147856", "channel-16147856-2"]);
    expect(duplicateState?.tiles["channel-16147856"]?.metrics.framesRendered).toBeGreaterThan(0);
    expect(duplicateState?.tiles["channel-16147856-2"]?.metrics.framesRendered).toBeGreaterThan(0);

    await waitForBackendSubscriberCount(page, "camera-16147856", 1);

    const secondTileBeforeClose = await tileSnapshot(page, "channel-16147856-2");
    await page.getByTestId("tile-channel-16147856").getByTestId("tile-close").click();
    await expect(page.getByTestId("tile-channel-16147856")).toHaveCount(0);
    await expect(page.getByTestId("tile-channel-16147856-2")).toHaveCount(1);
    await page.waitForFunction(
      () => {
        const state = window.__webvideoVmsState;
        return state
          && !state.activeTiles.some((tile) => tile.tileId === "channel-16147856")
          && state.activeTiles.some((tile) => tile.tileId === "channel-16147856-2")
          && state.activeChannels.filter((channelId) => channelId === "channel-16147856").length === 1;
      },
      undefined,
      { timeout: 8_000 },
    );
    await waitForBackendSubscriberCount(page, "camera-16147856", 1);
    await waitForProgressSince(page, "channel-16147856-2", secondTileBeforeClose);
  });

  test("does not blank existing video while adding a second tile", async ({ page }) => {
    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-16147856").click();
    await waitForContinuousPlayback(page, "channel-16147856", 12);
    await expectVisibleTileSamples(page, ["channel-16147856"]);

    await page.getByTestId("add-channel-channel-15116604").click();
    let longestBlankRun = 0;
    let currentBlankRun = 0;

    for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
      await page.waitForTimeout(120);
      const samples = await readVisibleTileSamples(page, ["channel-16147856"]);
      const firstTile = samples.tiles[0];
      if (firstTile && isHealthyVisibleTileSample(firstTile)) {
        currentBlankRun = 0;
      } else {
        currentBlankRun += 1;
        longestBlankRun = Math.max(longestBlankRun, currentBlankRun);
      }
    }

    expect(longestBlankRun, "existing tile should not blank for a visible transition window").toBeLessThanOrEqual(1);
    await waitForContinuousPlayback(page, "channel-15116604", 8);
    await expectVisibleTileSamples(page, ["channel-16147856", "channel-15116604"]);
  });

  test("renders an opt-in worker decode stream", async ({ page }) => {
    test.skip(
      process.env.WEBVIDEO_E2E_WORKER_DECODE !== "1",
      "Set WEBVIDEO_E2E_WORKER_DECODE=1 to exercise the experimental worker VideoDecoder handoff.",
    );

    await page.goto("/vms.html?decodeWorker=1");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-13535786").click();
    await waitForContinuousPlayback(page, "channel-13535786", 8);
    const tileLocator = page.getByTestId("tile-channel-13535786");
    await tileLocator.getByTestId("tile-stats-toggle").click();
    await expect(tileLocator.getByTestId("tile-decode-pipeline")).toHaveText("worker");
    await assertStreamingTile(page, "channel-13535786");
    await assertMatrixTilesVisible(page, ["channel-13535786"]);
  });

  test("renders an opt-in media worker stream from WebTransport through WebCodecs", async ({ page }) => {
    test.skip(
      process.env.WEBVIDEO_E2E_MEDIA_WORKER !== "1",
      "Set WEBVIDEO_E2E_MEDIA_WORKER=1 to exercise worker-owned WebTransport and WebCodecs decode.",
    );

    await page.goto("/vms.html?mediaWorker=1&offscreen=1");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-13535786").click();
    await waitForContinuousPlayback(page, "channel-13535786", 8);
    const tileLocator = page.getByTestId("tile-channel-13535786");
    await tileLocator.getByTestId("tile-stats-toggle").click();
    await expect(tileLocator.getByTestId("tile-decode-pipeline")).toHaveText("media-worker");
    await expect(tileLocator.getByTestId("tile-gpu-path")).toHaveText(/external-texture \/ (worker-offscreen-webgpu-canvas|worker-offscreen-matrix-canvas)/);
    await assertStreamingTile(page, "channel-13535786");
    await assertMatrixTilesVisible(page, ["channel-13535786"]);
  });

  test("renders duplicated VMS tiles through the shared offscreen matrix viewport", async ({ page }) => {
    test.skip(!requireHardwareWebGpu, "Hardware WebGPU is required to assert the external-texture matrix path.");

    await page.goto("/vms.html?matrixTexture=external");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-4k-crowd").click();
    await page.getByTestId("add-channel-channel-4k-crowd").click();

    for (const channelId of ["channel-4k-crowd", "channel-4k-crowd-2"]) {
      await waitForContinuousPlayback(page, channelId, 8);
      await assertStreamingTile(page, channelId);
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-gpu-path")).toHaveText("external-texture / worker-offscreen-matrix-canvas");
    }
    await assertMatrixTilesVisible(page, ["channel-4k-crowd", "channel-4k-crowd-2"]);
  });

  test("keeps high-fps stress isolated and recovers render caps after closing it", async ({ page }) => {
    test.skip(
      process.env.WEBVIDEO_E2E_4K_STRESS !== "1",
      "Set WEBVIDEO_E2E_4K_STRESS=1 and START_4K_STRESS_RTSP=1 to run the high-fps VMS stress recovery check.",
    );

    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-4k-crowd").click();
    await waitForContinuousPlayback(page, "channel-4k-crowd", 12);
    await waitForHighSourceFrameRate(page, "channel-4k-crowd", 45);

    for (const channelId of ["channel-13535786", "channel-15116604", "channel-16147856", "channel-13535786"]) {
      await page.getByTestId(`add-channel-${channelId}`).click();
    }

    const visibleTiles = ["channel-4k-crowd", "channel-13535786", "channel-15116604", "channel-16147856", "channel-13535786-2"];
    for (const tileId of visibleTiles) {
      await waitForContinuousPlayback(page, tileId, 8, { allowReconnects: true });
    }
    await waitForRenderCaps(page, visibleTiles, 14, 16);
    await assertMatrixTilesVisible(page, visibleTiles);

    const normalTileIds = ["channel-13535786", "channel-15116604", "channel-16147856", "channel-13535786-2"];
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
    await waitForAdaptivePressureAtMost(page, "channel-13535786", 1);
    await assertMatrixTilesVisible(page, normalTileIds);
  });

  test("recovers a VMS tile after a server-side WebTransport chaos disconnect", async ({ page }) => {
    await page.goto("/vms.html?chaosDisconnectAfterFrames=12");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-13535786").click();
    await waitForContinuousPlayback(page, "channel-13535786", 6, { allowReconnects: true, allowProtocolEnds: true });
    const beforeReconnect = await tileSnapshot(page, "channel-13535786");

    await waitForConnectionOpenCountAtLeast(page, "channel-13535786", 2);
    await waitForResilientProgressSince(page, "channel-13535786", beforeReconnect);
    await assertStreamingTile(page, "channel-13535786", { allowProtocolEnds: true });
    await assertMatrixTilesVisible(page, ["channel-13535786"]);
  });

  test("keeps playback moving through delayed and dropped WebTransport frames", async ({ page }) => {
    await page.goto("/vms.html?chaosFrameDelayMs=6&chaosDropEveryNFrames=37");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-13535786").click();
    await waitForContinuousPlayback(page, "channel-13535786", 20);
    await page.waitForFunction(
      () => {
        const tile = window.__webvideoVmsState?.tiles["channel-13535786"];
        return tile
          && (tile.metrics.sequenceGapFrames > 0 || tile.metrics.framesDropped > 0)
          && (tile.status === "playing" || tile.status === "holding");
      },
      undefined,
      { timeout: 20_000 },
    );

    const afterChaos = await tileSnapshot(page, "channel-13535786");
    await waitForProgressSince(page, "channel-13535786", afterChaos);
    await assertStreamingTile(page, "channel-13535786");
    await assertMatrixTilesVisible(page, ["channel-13535786"]);
  });

  test("keeps mixed-rate 4K and 1080p matrix tiles visible when one tile updates faster", async ({ page }) => {
    test.skip(process.env.WEBVIDEO_E2E_4K !== "1", "Set WEBVIDEO_E2E_4K=1 and START_4K_RTSP=1 to run the mixed-rate visual matrix check.");

    await page.goto("/vms.html");
    await expect(page.getByTestId("channel-picker-status")).toHaveText("7 channels");

    await page.getByTestId("add-channel-channel-4k-crowd").click();
    await page.getByTestId("add-channel-channel-15116604").click();

    await waitForContinuousPlayback(page, "channel-4k-crowd", 8);
    await waitForContinuousPlayback(page, "channel-15116604", 8);
    await assertStreamingTile(page, "channel-4k-crowd", { minimumRenderFps: 1 });
    await assertStreamingTile(page, "channel-15116604");
    await page.waitForTimeout(2_000);
    await assertMatrixTilesVisible(page, ["channel-4k-crowd", "channel-15116604"]);
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

async function assertMetadataOsdCanToggle(
  page: import("@playwright/test").Page,
  tileId: string,
  expectedResolution: string,
): Promise<void> {
  const tileLocator = page.getByTestId(`tile-${tileId}`);
  const diagnosticsOpen = await tileLocator
    .getByTestId("tile-diagnostics")
    .evaluate((element) => (element as HTMLDetailsElement).open);
  if (!diagnosticsOpen) {
    await tileLocator.getByTestId("tile-stats-toggle").click();
  }

  await page.waitForFunction(
    ({ tileId: currentTileId, expectedResolution: expected }) => {
      const tile = window.__webvideoVmsState?.tiles[currentTileId];
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${currentTileId}']`);
      const overlayCount = Number(canvas?.dataset.overlayCount ?? "0");
      const overlay = tile?.metadataOverlay;
      return overlay?.active === true
        && overlay.sourceResolution === expected
        && Math.abs(overlay.driftUs) <= 250_000
        && overlayCount > 0;
    },
    { tileId, expectedResolution },
    { timeout: 20_000 },
  );
  await expect(tileLocator.getByTestId("tile-metadata-enabled")).toHaveText("on");
  await expect(tileLocator.getByTestId("tile-metadata-source")).toHaveText(expectedResolution);
  await expect(tileLocator.getByTestId("tile-metadata-drift")).toContainText("ms");

  await tileLocator.getByTestId("tile-metadata-toggle").uncheck();
  await page.waitForFunction(
    (currentTileId) => {
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${currentTileId}']`);
      return window.__webvideoVmsState?.metadataEnabledByTile[currentTileId] === false
        && Number(canvas?.dataset.overlayCount ?? "1") === 0;
    },
    tileId,
    { timeout: 10_000 },
  );
  await expect(tileLocator.getByTestId("tile-metadata-enabled")).toHaveText("off");

  await tileLocator.getByTestId("tile-metadata-toggle").check();
  await page.waitForFunction(
    (currentTileId) => window.__webvideoVmsState?.metadataEnabledByTile[currentTileId] !== false,
    tileId,
    { timeout: 5_000 },
  );
  await expect(tileLocator.getByTestId("tile-metadata-enabled")).toHaveText("on");
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
  options: {
    minimumRenderFps?: number;
    allowProtocolEnds?: boolean;
    receiveToRenderP95BudgetMs?: number;
    renderP95BudgetMs?: number;
    serverToRenderP95BudgetMs?: number;
    sourceToRenderP95BudgetMs?: number;
  } = {},
): Promise<void> {
  const tileLocator = page.getByTestId(`tile-${channelId}`);
  await expect(tileLocator.getByTestId("tile-status")).toHaveText(/playing|holding/);
  await expect(tileLocator.getByTestId("tile-transport")).toHaveText("webtransport-quic");
  await expect(tileLocator.getByTestId("tile-decode")).toHaveText("webcodecs");
  if (requireHardwareWebGpu) {
    await expect(tileLocator.getByTestId("tile-render")).toHaveText("webgpu");
    await expect(tileLocator.getByTestId("tile-gpu-path")).toHaveText(/(external-texture|videoframe-copy) \/ (webgpu-canvas|worker-offscreen-webgpu-canvas|worker-offscreen-matrix-canvas)/);
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
  assertLocalLatencyBudgets(tile, options);

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
    expect(["webgpu-canvas", "worker-offscreen-webgpu-canvas", "worker-offscreen-matrix-canvas"]).toContain(sample.gpuPresentation);
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
    const fallback = await readMatrixFallbackState(page, channelIds);
    if (fallback.matrixHidden) {
      expect(fallback.shellClass, "matrix fallback should reveal direct tile canvases").toContain("direct-render");
      for (const tile of fallback.tiles) {
        expect(tile.width, `${tile.channelId} direct tile width`).toBeGreaterThan(0);
        expect(tile.height, `${tile.channelId} direct tile height`).toBeGreaterThan(0);
        expect(tile.display, `${tile.channelId} direct tile display`).not.toBe("none");
        expect(Number(tile.opacity), `${tile.channelId} direct tile opacity`).toBeGreaterThan(0.9);
        expect(tile.matrixFallbackReason, `${tile.channelId} matrix fallback reason`).toContain("matrix-disabled");
      }
      return;
    }

    const readback = await readMatrixTiles(page, channelIds);
    expect(readback.ok, `matrix canvas readback failed: ${"error" in readback ? readback.error : ""}`).toBe(true);
    for (const tile of readback.tiles) {
      expect(tile.alphaPixels, `${tile.channelId} matrix tile has visible pixels`).toBeGreaterThan(12);
      expect(tile.brightPixels, `${tile.channelId} matrix tile is not cleared/black`).toBeGreaterThan(3);
      expect(tile.colorRange, `${tile.channelId} matrix tile has image detail`).toBeGreaterThan(30);
    }
  }).toPass({ intervals: [250, 500, 1_000], timeout: 10_000 });
}

async function readMatrixFallbackState(page: import("@playwright/test").Page, channelIds: string[]) {
  return await page.evaluate((ids) => {
    const matrixCanvas = document.getElementById("vms-matrix-canvas") as HTMLCanvasElement | null;
    const matrixStyle = matrixCanvas ? getComputedStyle(matrixCanvas) : undefined;
    const matrixHidden = !matrixCanvas
      || matrixCanvas.hidden
      || matrixStyle?.display === "none"
      || matrixCanvas.getBoundingClientRect().width <= 0
      || matrixCanvas.getBoundingClientRect().height <= 0;
    const state = window.__webvideoVmsState?.tiles ?? {};

    return {
      matrixHidden,
      shellClass: document.querySelector(".vms-grid-shell")?.className ?? "",
      tiles: ids.map((channelId) => {
        const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${channelId}']`);
        const style = canvas ? getComputedStyle(canvas) : undefined;
        const rect = canvas?.getBoundingClientRect();
        return {
          channelId,
          display: style?.display ?? "",
          opacity: style?.opacity ?? "0",
          width: rect?.width ?? 0,
          height: rect?.height ?? 0,
          matrixFallbackReason: state[channelId]?.matrixFallbackReason ?? canvas?.dataset.matrixFallbackReason ?? "",
        };
      }),
    };
  }, channelIds);
}

async function expectVisibleTileSamples(
  page: import("@playwright/test").Page,
  channelIds: string[],
): Promise<void> {
  await expect(async () => {
    const samples = await readVisibleTileSamples(page, channelIds);
    for (const tile of samples.tiles) {
      expect(
        isHealthyVisibleTileSample(tile),
        `${tile.channelId} should have visible, non-black pixels: ${JSON.stringify(tile)}`,
      ).toBe(true);
    }
  }).toPass({ intervals: [250, 500, 1_000], timeout: 10_000 });
}

interface VisibleTileSample {
  channelId: string;
  samples: number;
  alphaPixels: number;
  brightPixels: number;
  colorRange: number;
  datasetAlpha: number;
  datasetBrightness: number;
  datasetLastSequence: number;
  error?: string;
}

function isHealthyVisibleTileSample(sample: VisibleTileSample): boolean {
  if (sample.alphaPixels > Math.max(0, sample.samples * 0.7) && (sample.brightPixels > 2 || sample.colorRange > 24)) {
    return true;
  }

  return sample.datasetAlpha > 0 && sample.datasetLastSequence > 0;
}

async function readVisibleTileSamples(
  page: import("@playwright/test").Page,
  channelIds: string[],
): Promise<{ tiles: VisibleTileSample[] }> {
  return await page.evaluate(async (ids) => {
    const gridShell = document.querySelector<HTMLElement>(".vms-grid-shell");
    const directRender = gridShell?.classList.contains("direct-render") ?? false;
    const matrixCanvas = document.getElementById("vms-matrix-canvas") as HTMLCanvasElement | null;
    const matrixRect = matrixCanvas?.getBoundingClientRect();
    const matrixVisible = !directRender
      && matrixCanvas
      && matrixRect
      && matrixRect.width > 0
      && matrixRect.height > 0
      && matrixCanvas.width > 0
      && matrixCanvas.height > 0
      && getComputedStyle(matrixCanvas).display !== "none";

    async function createReadback(canvas: HTMLCanvasElement): Promise<{
      context: CanvasRenderingContext2D;
      width: number;
      height: number;
      rect: DOMRect;
    }> {
      const image = new Image();
      image.src = canvas.toDataURL("image/png");
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("canvas image decode failed"));
      });

      const sampleCanvas = document.createElement("canvas");
      sampleCanvas.width = canvas.width;
      sampleCanvas.height = canvas.height;
      const context = sampleCanvas.getContext("2d");
      if (!context) {
        throw new Error("missing 2d readback context");
      }

      context.drawImage(image, 0, 0);
      return {
        context,
        width: canvas.width,
        height: canvas.height,
        rect: canvas.getBoundingClientRect(),
      };
    }

    function datasetSample(canvas: HTMLCanvasElement | null): {
      datasetAlpha: number;
      datasetBrightness: number;
      datasetLastSequence: number;
    } {
      const [red = 0, green = 0, blue = 0, alpha = 0] = (canvas?.dataset.gpuSampleRgba ?? "")
        .split(",")
        .map((value) => Number(value));
      const lastSequence = Number(canvas?.dataset.lastSequence ?? "0");
      return {
        datasetAlpha: Number.isFinite(alpha) ? alpha : 0,
        datasetBrightness: [red, green, blue]
          .filter((value) => Number.isFinite(value))
          .reduce((sum, value) => sum + value, 0),
        datasetLastSequence: Number.isFinite(lastSequence) ? lastSequence : 0,
      };
    }

    function sampleRegion(
      channelId: string,
      context: CanvasRenderingContext2D,
      sourceRect: DOMRect,
      sourceWidth: number,
      sourceHeight: number,
      regionRect: DOMRect,
      dataset: { datasetAlpha: number; datasetBrightness: number; datasetLastSequence: number },
    ): VisibleTileSample {
      let alphaPixels = 0;
      let brightPixels = 0;
      let minBrightness = Number.POSITIVE_INFINITY;
      let maxBrightness = 0;
      let samples = 0;
      const scaleX = sourceWidth / sourceRect.width;
      const scaleY = sourceHeight / sourceRect.height;
      const fractions = [0.2, 0.35, 0.5, 0.65, 0.8];
      for (const yFraction of fractions) {
        for (const xFraction of fractions) {
          const x = Math.max(
            0,
            Math.min(sourceWidth - 1, Math.round((regionRect.left - sourceRect.left + regionRect.width * xFraction) * scaleX)),
          );
          const y = Math.max(
            0,
            Math.min(sourceHeight - 1, Math.round((regionRect.top - sourceRect.top + regionRect.height * yFraction) * scaleY)),
          );
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
        samples,
        alphaPixels,
        brightPixels,
        colorRange: maxBrightness - minBrightness,
        ...dataset,
      };
    }

    let matrixReadback: Awaited<ReturnType<typeof createReadback>> | undefined;
    if (matrixVisible && matrixCanvas) {
      try {
        matrixReadback = await createReadback(matrixCanvas);
      } catch {
        matrixReadback = undefined;
      }
    }

    const tiles = await Promise.all(ids.map(async (channelId): Promise<VisibleTileSample> => {
      const tileCanvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${channelId}']`);
      const tileRect = tileCanvas?.getBoundingClientRect();
      const dataset = datasetSample(tileCanvas);
      if (!tileCanvas || !tileRect || tileRect.width <= 0 || tileRect.height <= 0) {
        return { channelId, samples: 0, alphaPixels: 0, brightPixels: 0, colorRange: 0, ...dataset, error: "missing tile canvas" };
      }

      if (matrixReadback) {
        return sampleRegion(
          channelId,
          matrixReadback.context,
          matrixReadback.rect,
          matrixReadback.width,
          matrixReadback.height,
          tileRect,
          dataset,
        );
      }

      try {
        const readback = await createReadback(tileCanvas);
        return sampleRegion(channelId, readback.context, readback.rect, readback.width, readback.height, tileRect, dataset);
      } catch (error) {
        return {
          channelId,
          samples: 0,
          alphaPixels: 0,
          brightPixels: 0,
          colorRange: 0,
          ...dataset,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    return { tiles };
  }, channelIds);
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
} | undefined, budgets: {
  receiveToRenderP95BudgetMs?: number;
  renderP95BudgetMs?: number;
  serverToRenderP95BudgetMs?: number;
  sourceToRenderP95BudgetMs?: number;
} = {}): void {
  const s2rBudgetMs = budgets.sourceToRenderP95BudgetMs
    ?? Number(process.env.WEBVIDEO_E2E_S2R_P95_BUDGET_MS ?? "2000");
  const defaultServerToRenderBudgetMs = requireHardwareWebGpu ? "1000" : "2000";
  const serverToRenderBudgetMs = budgets.serverToRenderP95BudgetMs
    ?? Number(process.env.WEBVIDEO_E2E_SERVER_TO_RENDER_P95_BUDGET_MS ?? defaultServerToRenderBudgetMs);
  const defaultReceiveToRenderBudgetMs = requireHardwareWebGpu ? "250" : "800";
  const receiveToRenderBudgetMs = budgets.receiveToRenderP95BudgetMs
    ?? Number(process.env.WEBVIDEO_E2E_RECEIVE_TO_RENDER_P95_BUDGET_MS ?? defaultReceiveToRenderBudgetMs);
  const decodeBudgetMs = Number(process.env.WEBVIDEO_E2E_DECODE_P95_BUDGET_MS ?? "100");
  const renderBudgetMs = budgets.renderP95BudgetMs
    ?? Number(process.env.WEBVIDEO_E2E_RENDER_P95_BUDGET_MS ?? "100");

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
    lastFrameAgeMs?: number;
    recentFrameIntervalP95Ms?: number;
    recentFrameIntervalMaxMs?: number;
    recentFrameHitches?: number;
    recentSevereFrameHitches?: number;
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
