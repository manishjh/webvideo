import { expect, test } from "@playwright/test";
import {
  e2eScenarioCatalog,
  frontendBehaviorCatalog,
  frontendFlowCatalog,
} from "../../src/contracts/flows";

const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";

test.describe("contract harness page", () => {
  test("renders contract counts and page title", async ({ page }) => {
    await page.goto("/contract-harness.html?runPlayer=0");

    await expect(page.getByTestId("page-title")).toHaveText("WebVideo Contract Harness");
    await expect(page.getByTestId("flow-count")).toHaveText(String(frontendFlowCatalog.length));
    await expect(page.getByTestId("behavior-count")).toHaveText(String(frontendBehaviorCatalog.length));
    await expect(page.getByTestId("scenario-count")).toHaveText(String(e2eScenarioCatalog.length));
  });

  test("renders the required flow, behavior, and scenario rows", async ({ page }) => {
    await page.goto("/contract-harness.html?runPlayer=0");

    await expect(page.getByTestId("flow-row-player-session-bootstrap")).toContainText("Create the frontend player session");
    await expect(page.getByTestId("flow-row-decode-schedule-render")).toContainText("Decode frames");
    await expect(page.getByTestId("behavior-row-viewer-starts-live-session")).toContainText("transport-connect");
    await expect(page.getByTestId("behavior-row-browser-session-uses-rtsp-captured-payloads")).toContainText("annexb-payloads-present");
    await expect(page.getByTestId("behavior-row-player-enforces-bounded-latency")).toContainText("late-frame-drop");
    await expect(page.getByTestId("scenario-row-viewer-starts-live-stream")).toContainText("cctv-lobby-720p");
    await expect(page.getByTestId("scenario-row-player-recovers-from-stream-discontinuity")).toContainText("cctv-entrance-720p");
    await expect(page.getByTestId("scenario-row-tile-wall-renders-independent-channels")).toContainText("cctv-floor-1080p");
    await expect(page.getByTestId("scenario-row-high-resolution-4k-channel-is-declared")).toContainText("cctv-parking-4k");
  });

  test("runs the RTSP-backed player flow end to end in the browser harness", async ({ page }) => {
    const sessionRequestPromise = page.waitForRequest((request) => (
      request.method() === "POST"
      && request.url().includes("/api/demo/channels/channel-001/sessions")
    ));
    const sessionResponsePromise = page.waitForResponse((response) => (
      response.request().method() === "POST"
      && response.url().includes("/api/demo/channels/channel-001/sessions")
    ));

    await page.goto("/contract-harness.html");
    const sessionRequest = await sessionRequestPromise;
    const sessionResponse = await sessionResponsePromise;
    const sessionPayload = await sessionResponse.json();
    await page.waitForFunction(() => window.__webvideoHarnessState?.status === "completed");

    expect(sessionRequest.postDataJSON()).toMatchObject({
      viewerId: "harness-viewer",
      targetLatencyMs: 150,
      enableMetadata: true,
    });
    expect(sessionPayload).toMatchObject({
      channelId: "channel-001",
      streamId: "camera-001",
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
      accessUnitFormat: "annexb-h264",
    });
    expect(sessionPayload.videoMessages).toHaveLength(8);
    expect(typeof sessionPayload.videoMessages[0].payload).toBe("string");
    expect(sessionPayload.videoMessages[0].payload.length).toBeGreaterThan(1_000);

    await expect(page.getByTestId("sim-status")).toHaveText("completed");
    await expect(page.getByTestId("sim-session-id")).toContainText("player-");
    await expect(page.getByTestId("sim-channel-id")).toHaveText("channel-001");
    await expect(page.getByTestId("sim-stream-id")).toHaveText("camera-001");
    await expect(page.getByTestId("sim-sink-id")).toContainText("sink-");
    await expect(page.getByTestId("sim-transport-mode")).toHaveText("webtransport-quic -> webtransport-quic");
    await expect(page.getByTestId("sim-webtransport-bytes")).not.toHaveText("0");
    await expect(page.getByTestId("sim-webtransport-messages")).toHaveText("16");
    await expect(page.getByTestId("sim-decode-backend")).toHaveText("webcodecs");
    await expect(page.getByTestId("sim-render-backend")).toHaveText(requireHardwareWebGpu ? "webgpu" : /webgpu|canvas2d-fallback/);
    await expect(page.getByTestId("sim-source-mode")).toHaveText("rtsp-h264-capture (annexb-h264)");
    await expect(page.getByTestId("sim-source-verified")).toHaveText("yes");
    await expect(page.getByTestId("sim-source-diagnostics")).toContainText("captured 8 Annex B H.264 access units");
    await expect(page.getByTestId("sim-access-unit-format")).toHaveText("annexb-h264");
    await expect(page.getByTestId("sim-video-messages")).toHaveText("8");
    await expect(page.getByTestId("sim-metadata-records")).toHaveText("8");
    await expect(page.getByTestId("sim-decision")).toHaveText("render");
    await expect(page.getByTestId("sim-rendered-count")).toHaveText("8");
    await expect(page.getByTestId("sim-rendered-sequence")).toHaveText("108");
    await expect(page.getByTestId("sim-sequence-trace")).toHaveText("101, 102, 103, 104, 105, 106, 107, 108");
    await expect(page.getByTestId("sim-overlay-count")).toHaveText("1");
    await expect(page.getByTestId("sim-telemetry-count")).toHaveText("10");
    await expect(page.getByTestId("sim-telemetry-stages")).toContainText("transport.connect");
    await expect(page.getByTestId("sim-telemetry-stages")).toContainText("transport.read");
    await expect(page.getByTestId("sim-telemetry-stages")).toContainText("render.frame");
    await expect(page.getByTestId("sim-error")).toHaveText("none");

    const harnessState = await page.evaluate(() => window.__webvideoHarnessState);
    expect(harnessState).toMatchObject({
      channelId: "channel-001",
      streamId: "camera-001",
      requestedTransport: "webtransport-quic",
      activeTransport: "webtransport-quic",
      webTransportReady: true,
      decodeBackend: "webcodecs",
      sourceMode: "rtsp-h264-capture",
      sourceVerified: true,
      accessUnitFormat: "annexb-h264",
    });
    if (requireHardwareWebGpu) {
      expect(harnessState?.renderBackend).toBe("webgpu");
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(harnessState?.renderBackend);
    }
    expect(harnessState?.sinkId).toMatch(/^sink-/);
    expect(harnessState?.payloadBytes).toBeGreaterThan(8_000);
    expect(harnessState?.webTransportBytesReceived).toBeGreaterThan(8_000);
    expect(harnessState?.webTransportMessagesReceived).toBe(16);
  });

  test("renders visible pixels and tracks frame progression on the canvas surface", async ({ page }) => {
    await page.goto("/contract-harness.html");
    await page.waitForFunction(() => window.__webvideoHarnessState?.status === "completed");

    const canvas = page.getByTestId("contract-canvas");
    await expect(canvas).toBeVisible();

    const surface = await page.evaluate(() => {
      const element = document.querySelector<HTMLCanvasElement>("#contract-canvas");
      const probe = document.createElement("canvas");
      probe.width = element?.width ?? 0;
      probe.height = element?.height ?? 0;
      const context = probe.getContext("2d");
      if (element && context) {
        context.drawImage(element, 0, 0);
      }
      const sample = context ? Array.from(context.getImageData(320, 180, 1, 1).data) : [];

      return {
        width: element?.width ?? 0,
        height: element?.height ?? 0,
        hidden: element?.hidden ?? true,
        lastSequence: element?.dataset.lastSequence ?? "",
        overlayCount: element?.dataset.overlayCount ?? "",
        renderBackend: element?.dataset.renderBackend ?? "",
        gpuUploadSource: element?.dataset.gpuUploadSource ?? "",
        gpuPresentation: element?.dataset.gpuPresentation ?? "",
        gpuAdapterVendor: element?.dataset.gpuAdapterVendor ?? "",
        gpuAdapterArchitecture: element?.dataset.gpuAdapterArchitecture ?? "",
        webGpuStep: element?.dataset.webGpuStep ?? "",
        webGpuError: element?.dataset.webGpuError ?? "",
        gpuSample: (element?.dataset.gpuSampleRgba ?? "").split(",").map(Number),
        sample,
        renderedSequences: window.__webvideoHarnessState?.renderedSequences ?? [],
      };
    });

    expect(surface.width).toBe(1280);
    expect(surface.height).toBe(720);
    expect(surface.hidden).toBe(false);
    expect(surface.lastSequence).toBe("108");
    expect(surface.overlayCount).toBe("1");
    if (requireHardwareWebGpu) {
      expect(surface.renderBackend).toBe("webgpu");
      expect(surface.gpuPresentation).toBe("webgpu-canvas");
      expect(surface.gpuUploadSource).toBe("external-texture");
      expect(surface.webGpuStep).toBe("rendered");
      expect(surface.gpuSample).toHaveLength(4);
      expect(surface.gpuSample[3]).toBeGreaterThan(0);
      expect(surface.gpuSample.slice(0, 3).some((channel) => channel > 0)).toBe(true);
    } else {
      expect(["webgpu", "canvas2d-fallback"]).toContain(surface.renderBackend);
    }
    expect(surface.webGpuError).toBe("");
    expect(surface.renderedSequences).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    if (!requireHardwareWebGpu) {
      expect(surface.sample[3]).toBeGreaterThan(0);
    }
  });

  test("surfaces the critical documented browser scenarios", async ({ page }) => {
    await page.goto("/contract-harness.html?runPlayer=0");

    await expect(page.getByTestId("scenario-row-viewer-joins-at-keyframe-boundary")).toContainText("late-frame policy present");
    await expect(page.getByTestId("scenario-row-metadata-overlay-aligns-to-frame-pts")).toContainText("overlay alignment outcome present");
    await expect(page.getByTestId("scenario-row-rtsp-h264-source-feeds-browser-session")).toContainText("Annex B payload bytes present");
  });
});
