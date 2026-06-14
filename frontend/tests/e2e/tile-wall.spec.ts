import { expect, test } from "@playwright/test";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("tile wall page", () => {
  test("opens multiple independent channel tiles and renders each stream", async ({ page }) => {
    const requestedChannels = ["channel-001", "channel-002", "channel-003"];
    const sessionRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/api/demo/channels/")) {
        sessionRequests.push(request.url());
      }
    });

    await page.goto(`/tile-wall.html?channels=${requestedChannels.join(",")}&frames=4`);
    await page.waitForFunction(() => window.__webvideoTileWallState?.status === "completed", null, {
      timeout: 30_000,
    });

    await expect(page.getByTestId("tile-wall-title")).toHaveText("WebVideo Tile Wall");
    await expect(page.getByTestId("tile-wall-summary")).toHaveText("3/3 completed");

    const state = await page.evaluate(() => window.__webvideoTileWallState);
    expect(state?.requestedFrameCount).toBe(4);
    expect(state?.channels).toEqual(requestedChannels);
    expect(Object.keys(state?.tiles ?? {}).sort()).toEqual([...requestedChannels].sort());

    for (const channelId of requestedChannels) {
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-status")).toHaveText("completed");
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-decode")).toHaveText("webcodecs");
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-render")).toHaveText(requireHardwareWebGpu ? "webgpu" : /webgpu|canvas2d-fallback/);
      await expect(page.getByTestId(`tile-${channelId}`).getByTestId("tile-frames")).toHaveText("4");

      const tile = state?.tiles[channelId];
      expect(tile).toMatchObject({
        channelId,
        sourceMode: "rtsp-h264-capture",
        sourceVerified: true,
        activeTransport: "webtransport-quic",
        decodeBackend: "webcodecs",
      });
      if (requireHardwareWebGpu) {
        expect(tile?.renderBackend).toBe("webgpu");
      } else {
        expect(["webgpu", "canvas2d-fallback"]).toContain(tile?.renderBackend);
      }
      expect(tile?.sinkId).toMatch(/^sink-/);
      expect(tile?.webTransportBytesReceived).toBeGreaterThan(4_000);
      expect(tile?.webTransportMessagesReceived).toBe(8);
      expect(tile?.renderedSequences).toHaveLength(4);
      if (requireHardwareWebGpu) {
        expect(tile?.gpuSampleRgba?.split(",").map(Number)[3]).toBeGreaterThan(0);
      }
    }

    expect(state?.tiles["channel-001"]?.streamId).toBe("camera-001");
    expect(state?.tiles["channel-002"]?.streamId).toBe("camera-002");
    expect(state?.tiles["channel-003"]?.streamId).toBe("camera-003");
    expect(state?.tiles["channel-003"]?.width).toBe(1920);
    expect(state?.tiles["channel-003"]?.height).toBe(1080);
    for (const channelId of requestedChannels) {
      expect(sessionRequests.some((url) => url.includes(`/api/demo/channels/${channelId}/sessions`))).toBe(true);
    }
  });
});
