import { expect, test } from "@playwright/test";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";
const rtspPort = process.env.RTSP_PORT ?? "8554";
const webTransportPort = process.env.WEBTRANSPORT_PORT ?? "9443";

test.describe("live demo page", () => {
  test("opens a client-initiated channel session and renders visible playback", async ({ page }) => {
    const sessionRequestPromise = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes("/api/demo/channels/channel-4k-crowd/sessions")
    ));
    const sessionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes("/api/demo/channels/channel-4k-crowd/sessions")
    ));

    await page.goto("/live-demo.html?channel=channel-4k-crowd");
    const sessionRequest = await sessionRequestPromise;
    const sessionResponse = await sessionResponsePromise;
    const sessionPayload = await sessionResponse.json();
    await page.waitForFunction(() => window.__webvideoLiveDemoState?.status === "completed");

    expect(sessionRequest.postDataJSON()).toMatchObject({
      viewerId: "browser-demo-viewer",
      targetLatencyMs: 150,
      enableMetadata: true,
    });
    expect(sessionPayload).toMatchObject({
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
      accessUnitFormat: "annexb-h264",
    });
    expect(sessionPayload.videoMessages).toHaveLength(8);
    expect(typeof sessionPayload.videoMessages[0].payload).toBe("string");
    expect(sessionPayload.videoMessages[0].payload.length).toBeGreaterThan(1_000);

    await expect(page.getByTestId("page-title")).toHaveText("WebVideo Live Demo");
    await expect(page.getByTestId("demo-status")).toHaveText("completed");
    await expect(page.getByTestId("demo-channel-id")).toHaveText("channel-4k-crowd");
    await expect(page.getByTestId("demo-stream-id")).toHaveText("camera-4k-crowd");
    await expect(page.getByTestId("demo-display-name")).toHaveText("CCTV Road Crowd 4K60");
    await expect(page.getByTestId("demo-source-rtsp")).toHaveText(`rtsp://127.0.0.1:${rtspPort}/live/cctv-road-crowd-4k60`);
    await expect(page.getByTestId("demo-quic-url")).toHaveText(`https://127.0.0.1:${webTransportPort}/live/channel-4k-crowd`);
    await expect(page.getByTestId("demo-sink-id")).toContainText("sink-");
    await expect(page.getByTestId("demo-transport-mode")).toHaveText("webtransport-quic -> webtransport-quic");
    await expect(page.getByTestId("demo-webtransport-bytes")).not.toHaveText("0");
    await expect(page.getByTestId("demo-webtransport-messages")).toHaveText("16");
    await expect(page.getByTestId("demo-decode-backend")).toHaveText("webcodecs");
    await expect(page.getByTestId("demo-render-backend")).toHaveText(requireHardwareWebGpu ? "webgpu" : /webgpu|canvas2d-fallback/);
    await expect(page.getByTestId("demo-source-mode")).toHaveText("rtsp-h264-capture (annexb-h264)");
    await expect(page.getByTestId("demo-source-verified")).toHaveText("yes");
    await expect(page.getByTestId("demo-source-diagnostics")).toContainText("captured 8 Annex B H.264 access units");
    await expect(page.getByTestId("demo-rendered-count")).toHaveText("8");
    await expect(page.getByTestId("demo-last-sequence")).toHaveText("108");
    await expect(page.getByTestId("demo-overlay-count")).toHaveText(requireHardwareWebGpu ? "1" : "0");
    await expect(page.getByTestId("demo-sequence-trace")).toHaveText("101, 102, 103, 104, 105, 106, 107, 108");

    const canvas = page.getByTestId("live-demo-canvas");
    await expect(canvas).toBeVisible();

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#live-demo-canvas");
      const probe = document.createElement("canvas");
      probe.width = canvas?.width ?? 0;
      probe.height = canvas?.height ?? 0;
      const context = probe.getContext("2d");
      if (canvas && context) {
        context.drawImage(canvas, 0, 0);
      }
      const pixel = context ? Array.from(context.getImageData(320, 180, 1, 1).data) : [];

      return {
        width: canvas?.width ?? 0,
        hidden: canvas?.hidden ?? true,
        lastSequence: canvas?.dataset.lastSequence ?? "",
        overlayCount: canvas?.dataset.overlayCount ?? "",
        renderBackend: canvas?.dataset.renderBackend ?? "",
        gpuUploadSource: canvas?.dataset.gpuUploadSource ?? "",
        gpuPresentation: canvas?.dataset.gpuPresentation ?? "",
        gpuAdapterVendor: canvas?.dataset.gpuAdapterVendor ?? "",
        gpuAdapterArchitecture: canvas?.dataset.gpuAdapterArchitecture ?? "",
        webGpuStep: canvas?.dataset.webGpuStep ?? "",
        webGpuError: canvas?.dataset.webGpuError ?? "",
        gpuSample: (canvas?.dataset.gpuSampleRgba ?? "").split(",").map(Number),
        state: window.__webvideoLiveDemoState,
        pixel,
      };
    });

    expect(sample.width).toBe(3840);
    expect(sample.hidden).toBe(false);
    expect(sample.lastSequence).toBe("108");
    expect(sample.overlayCount).toBe(requireHardwareWebGpu ? "1" : "0");
    if (requireHardwareWebGpu) {
      expect(sample.renderBackend).toBe("webgpu");
      expect(sample.gpuPresentation).toBe("webgpu-canvas");
      expect(sample.gpuUploadSource).toBe("external-texture");
      expect(sample.webGpuStep).toBe("rendered");
      expect(sample.gpuSample).toHaveLength(4);
      expect(sample.gpuSample[3]).toBeGreaterThan(0);
      expect(sample.gpuSample.slice(0, 3).some((channel) => channel > 0)).toBe(true);
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(sample.renderBackend);
    }
    expect(sample.webGpuError).toBe("");
    expect(sample.state).toMatchObject({
      channelId: "channel-4k-crowd",
      streamId: "camera-4k-crowd",
      requestedTransport: "webtransport-quic",
      activeTransport: "webtransport-quic",
      webTransportReady: true,
      decodeBackend: "webcodecs",
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
    });
    if (requireHardwareWebGpu) {
      expect(sample.state?.renderBackend).toBe("webgpu");
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(sample.state?.renderBackend);
    }
    expect(sample.state?.webTransportBytesReceived).toBeGreaterThan(8_000);
    expect(sample.state?.webTransportMessagesReceived).toBe(16);
    expect(sample.state?.sinkId).toMatch(/^sink-/);
    if (!requireHardwareWebGpu) {
      expect(sample.pixel[3]).toBeGreaterThan(0);
    }
  });
});
