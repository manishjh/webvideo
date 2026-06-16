import { expect, test } from "@playwright/test";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("tile wall page", () => {
  test("opens multiple independent channel tiles and renders each stream", async ({ page }) => {
    const requestedChannels = ["channel-4k-crowd", "channel-15116604", "channel-16147856"];
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

    expect(state?.tiles["channel-4k-crowd"]?.streamId).toBe("camera-4k-crowd");
    expect(state?.tiles["channel-15116604"]?.streamId).toBe("camera-15116604");
    expect(state?.tiles["channel-16147856"]?.streamId).toBe("camera-16147856");
    expect(state?.tiles["channel-15116604"]?.width).toBe(3840);
    expect(state?.tiles["channel-15116604"]?.height).toBe(2160);
    for (const channelId of requestedChannels) {
      expect(sessionRequests.some((url) => url.includes(`/api/demo/channels/${channelId}/sessions`))).toBe(true);
    }
  });
});
