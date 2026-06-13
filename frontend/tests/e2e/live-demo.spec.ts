import { expect, test } from "@playwright/test";

const demoApiPayload = {
  streamId: "camera-001",
  displayName: "Synthetic Camera 001",
  scenarioId: "udp-h264-smoke",
  sourceRtspUrl: "rtsp://127.0.0.1:8554/live/udp-h264-smoke",
  sourceSummary: "Synthetic H.264 smoke stream over ForceUdp.",
  targetLatencyMs: 150,
  frameIntervalMs: 1,
  webTransportUrl: "https://localhost:9443/live/camera-001",
  metadataChannelRequired: true,
  codec: {
    codec: "avc1",
    codedWidth: 1280,
    codedHeight: 720,
  },
  videoMessages: Array.from({ length: 4 }, (_, index) => ({
    streamId: "camera-001",
    sequenceNumber: 101 + index,
    presentationTimestampUs: 2_000_000 + index * 33_333,
    decodeTimestampUs: 2_000_000 + index * 33_333,
    keyFrame: index === 0,
    codecConfigVersion: "cfg-demo-v1",
    payload: [index + 1, (index + 3) * 2],
  })),
  metadataMessages: Array.from({ length: 4 }, (_, index) => ({
    streamId: "camera-001",
    batchStartTimestampUs: 2_000_000 + index * 33_333,
    batchEndTimestampUs: 2_000_000 + (index + 1) * 33_333,
    records: [
      {
        eventId: `evt-${index + 1}`,
        eventType: "box2d",
        startTimestampUs: 2_000_000 + index * 33_333,
        endTimestampUs: 2_000_000 + (index + 1) * 33_333,
        coordinateSpace: "normalized-video",
        tags: {
          label: index % 2 === 0 ? "ball" : "player",
          x: `${0.1 + index * 0.07}`,
          y: `${0.12 + (index % 3) * 0.12}`,
          w: "0.14",
          h: "0.18",
        },
      },
    ],
  })),
};

test.describe("live demo page", () => {
  test("fetches a backend stream payload and renders visible playback", async ({ page }) => {
    await page.route("**/api/demo/streams/camera-001", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(demoApiPayload),
      });
    });

    await page.goto("/live-demo.html");
    await page.waitForFunction(() => window.__webvideoLiveDemoState?.status === "completed");

    await expect(page.getByTestId("page-title")).toHaveText("WebVideo Live Demo");
    await expect(page.getByTestId("demo-status")).toHaveText("completed");
    await expect(page.getByTestId("demo-stream-id")).toHaveText("camera-001");
    await expect(page.getByTestId("demo-display-name")).toHaveText("Synthetic Camera 001");
    await expect(page.getByTestId("demo-rendered-count")).toHaveText("4");
    await expect(page.getByTestId("demo-last-sequence")).toHaveText("104");
    await expect(page.getByTestId("demo-overlay-count")).toHaveText("1");
    await expect(page.getByTestId("demo-sequence-trace")).toHaveText("101, 102, 103, 104");

    const canvas = page.getByTestId("live-demo-canvas");
    await expect(canvas).toBeVisible();

    const sample = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>("#live-demo-canvas");
      const context = canvas?.getContext("2d");
      const pixel = context ? Array.from(context.getImageData(320, 180, 1, 1).data) : [];

      return {
        width: canvas?.width ?? 0,
        hidden: canvas?.hidden ?? true,
        lastSequence: canvas?.dataset.lastSequence ?? "",
        overlayCount: canvas?.dataset.overlayCount ?? "",
        pixel,
      };
    });

    expect(sample.width).toBe(1280);
    expect(sample.hidden).toBe(false);
    expect(sample.lastSequence).toBe("104");
    expect(sample.overlayCount).toBe("1");
    expect(sample.pixel).toHaveLength(4);
    expect(sample.pixel[3]).toBeGreaterThan(0);
  });
});
