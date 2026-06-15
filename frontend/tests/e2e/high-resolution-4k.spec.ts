import { expect, test } from "@playwright/test";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("4K channel smoke", () => {
  test.setTimeout(60_000);

  test.skip(process.env.WEBVIDEO_E2E_4K !== "1", "Set WEBVIDEO_E2E_4K=1 and START_4K_RTSP=1 to run the 4K browser smoke.");

  test("decodes and renders a 4K RTSP-backed channel frame", async ({ page }) => {
    await page.goto("/live-demo.html?channel=channel-4k&frames=1");
    await page.waitForFunction(() => window.__webvideoLiveDemoState?.status === "completed", null, {
      timeout: 45_000,
    });

    await expect(page.getByTestId("demo-status")).toHaveText("completed");
    await expect(page.getByTestId("demo-channel-id")).toHaveText("channel-4k");
    await expect(page.getByTestId("demo-stream-id")).toHaveText("camera-4k");
    await expect(page.getByTestId("demo-source-rtsp")).toHaveText("rtsp://127.0.0.1:8554/live/cctv-parking-4k");
    await expect(page.getByTestId("demo-source-mode")).toHaveText("rtsp-h264-capture (annexb-h264)");
    await expect(page.getByTestId("demo-source-verified")).toHaveText("yes");
    await expect(page.getByTestId("demo-webtransport-messages")).toHaveText("2");
    await expect(page.getByTestId("demo-decode-backend")).toHaveText("webcodecs");
    await expect(page.getByTestId("demo-render-backend")).toHaveText(requireHardwareWebGpu ? "webgpu" : /webgpu|canvas2d-fallback/);
    await expect(page.getByTestId("demo-rendered-count")).toHaveText("1");

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#live-demo-canvas");
      return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        renderBackend: canvas?.dataset.renderBackend ?? "",
        gpuSample: (canvas?.dataset.gpuSampleRgba ?? "").split(",").map(Number),
        state: window.__webvideoLiveDemoState,
      };
    });

    expect(sample.width).toBe(3840);
    expect(sample.height).toBe(2160);
    if (requireHardwareWebGpu) {
      expect(sample.renderBackend).toBe("webgpu");
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(sample.renderBackend);
    }
    expect(sample.state?.webTransportBytesReceived).toBeGreaterThan(10_000);
    if (requireHardwareWebGpu) {
      expect(sample.gpuSample).toHaveLength(4);
      expect(sample.gpuSample[3]).toBeGreaterThan(0);
    }
  });

  test("renders a 4K channel tile beside another browser-initiated channel", async ({ page }) => {
    await page.goto("/tile-wall.html?channels=channel-001,channel-4k&frames=1");
    await page.waitForFunction(() => window.__webvideoTileWallState?.status === "completed", null, {
      timeout: 45_000,
    });

    await expect(page.getByTestId("tile-wall-summary")).toHaveText("2/2 completed");
    await expect(page.getByTestId("tile-channel-001").getByTestId("tile-status")).toHaveText("completed");
    await expect(page.getByTestId("tile-channel-4k").getByTestId("tile-status")).toHaveText("completed");

    const state = await page.evaluate(() => window.__webvideoTileWallState);
    const standardTile = state?.tiles["channel-001"];
    const highResolutionTile = state?.tiles["channel-4k"];

    expect(state?.requestedFrameCount).toBe(1);
    expect(state?.channels).toEqual(["channel-001", "channel-4k"]);
    expect(standardTile).toMatchObject({
      channelId: "channel-001",
      streamId: "camera-001",
      width: 1280,
      height: 720,
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
      activeTransport: "webtransport-quic",
      decodeBackend: "webcodecs",
    });
    expect(highResolutionTile).toMatchObject({
      channelId: "channel-4k",
      streamId: "camera-4k",
      width: 3840,
      height: 2160,
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
      activeTransport: "webtransport-quic",
      decodeBackend: "webcodecs",
    });
    if (requireHardwareWebGpu) {
      expect(standardTile?.renderBackend).toBe("webgpu");
      expect(highResolutionTile?.renderBackend).toBe("webgpu");
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(standardTile?.renderBackend);
      expect(["webgpu", "canvas2d-fallback"]).toContain(highResolutionTile?.renderBackend);
    }
    expect(standardTile?.webTransportMessagesReceived).toBe(2);
    expect(highResolutionTile?.webTransportMessagesReceived).toBe(2);
    expect(highResolutionTile?.webTransportBytesReceived).toBeGreaterThan(10_000);
    expect(highResolutionTile?.renderedSequences).toHaveLength(1);
    if (requireHardwareWebGpu) {
      expect(highResolutionTile?.gpuSampleRgba?.split(",").map(Number)[3]).toBeGreaterThan(0);
    }
  });

  test("decodes and renders the 4K60 crowd stress channel frame", async ({ page }) => {
    test.skip(process.env.WEBVIDEO_E2E_4K_STRESS !== "1", "Set WEBVIDEO_E2E_4K_STRESS=1 and START_4K_RTSP=1 to run the 4K60 crowd stress smoke.");

    await page.goto("/vms.html");
    const channels = await page.evaluate(async () => {
      const response = await fetch("/api/demo/channels");
      return await response.json();
    }) as Array<{
      channelId: string;
      streamId: string;
      scenarioId: string;
      codec: { codedWidth: number; codedHeight: number; frameRate: number };
    }>;
    const stressChannel = channels.find((channel) => channel.channelId === "channel-4k-crowd");
    expect(stressChannel).toMatchObject({
      channelId: "channel-4k-crowd",
      streamId: "camera-4k-crowd",
      scenarioId: "cctv-road-crowd-4k60",
      codec: {
        codedWidth: 3840,
        codedHeight: 2160,
        frameRate: 60,
      },
    });

    await page.goto("/live-demo.html?channel=channel-4k-crowd&frames=1");
    await page.waitForFunction(() => window.__webvideoLiveDemoState?.status === "completed", null, {
      timeout: 60_000,
    });

    await expect(page.getByTestId("demo-status")).toHaveText("completed");
    await expect(page.getByTestId("demo-channel-id")).toHaveText("channel-4k-crowd");
    await expect(page.getByTestId("demo-stream-id")).toHaveText("camera-4k-crowd");
    await expect(page.getByTestId("demo-source-rtsp")).toHaveText("rtsp://127.0.0.1:8554/live/cctv-road-crowd-4k60");
    await expect(page.getByTestId("demo-source-mode")).toHaveText("rtsp-h264-capture (annexb-h264)");
    await expect(page.getByTestId("demo-source-verified")).toHaveText("yes");
    await expect(page.getByTestId("demo-decode-backend")).toHaveText("webcodecs");
    await expect(page.getByTestId("demo-render-backend")).toHaveText(requireHardwareWebGpu ? "webgpu" : /webgpu|canvas2d-fallback/);
    await expect(page.getByTestId("demo-rendered-count")).toHaveText("1");

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#live-demo-canvas");
      return {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        state: window.__webvideoLiveDemoState,
      };
    });

    expect(sample.width).toBe(3840);
    expect(sample.height).toBe(2160);
    expect(sample.state?.webTransportBytesReceived).toBeGreaterThan(10_000);
  });
});
