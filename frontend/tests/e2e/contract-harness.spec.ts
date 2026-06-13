import { expect, test } from "@playwright/test";
import {
  e2eScenarioCatalog,
  frontendBehaviorCatalog,
  frontendFlowCatalog,
} from "../../src/contracts/flows";

test.describe("contract harness page", () => {
  test("renders contract counts and page title", async ({ page }) => {
    await page.goto("/contract-harness.html");

    await expect(page.getByTestId("page-title")).toHaveText("WebVideo Contract Harness");
    await expect(page.getByTestId("flow-count")).toHaveText(String(frontendFlowCatalog.length));
    await expect(page.getByTestId("behavior-count")).toHaveText(String(frontendBehaviorCatalog.length));
    await expect(page.getByTestId("scenario-count")).toHaveText(String(e2eScenarioCatalog.length));
  });

  test("renders the required flow, behavior, and scenario rows", async ({ page }) => {
    await page.goto("/contract-harness.html");

    await expect(page.getByTestId("flow-row-player-session-bootstrap")).toContainText("Create the frontend player session");
    await expect(page.getByTestId("flow-row-decode-schedule-render")).toContainText("Decode frames");
    await expect(page.getByTestId("behavior-row-viewer-starts-live-session")).toContainText("transport-connect");
    await expect(page.getByTestId("behavior-row-player-enforces-bounded-latency")).toContainText("late-frame-drop");
    await expect(page.getByTestId("scenario-row-viewer-starts-live-stream")).toContainText("udp-h264-smoke");
    await expect(page.getByTestId("scenario-row-player-recovers-from-stream-discontinuity")).toContainText("tcp-h264-smoke");
  });

  test("runs the simulated player flow end to end in the browser harness", async ({ page }) => {
    await page.goto("/contract-harness.html");
    await page.waitForFunction(() => window.__webvideoHarnessState?.status === "completed");

    await expect(page.getByTestId("sim-status")).toHaveText("completed");
    await expect(page.getByTestId("sim-session-id")).toContainText("player-");
    await expect(page.getByTestId("sim-video-messages")).toHaveText("8");
    await expect(page.getByTestId("sim-metadata-records")).toHaveText("8");
    await expect(page.getByTestId("sim-decision")).toHaveText("render");
    await expect(page.getByTestId("sim-rendered-count")).toHaveText("8");
    await expect(page.getByTestId("sim-rendered-sequence")).toHaveText("108");
    await expect(page.getByTestId("sim-sequence-trace")).toHaveText("101, 102, 103, 104, 105, 106, 107, 108");
    await expect(page.getByTestId("sim-overlay-count")).toHaveText("1");
    await expect(page.getByTestId("sim-telemetry-count")).toHaveText("9");
    await expect(page.getByTestId("sim-telemetry-stages")).toContainText("transport.read");
    await expect(page.getByTestId("sim-telemetry-stages")).toContainText("render.frame");
  });

  test("renders visible pixels and tracks frame progression on the canvas surface", async ({ page }) => {
    await page.goto("/contract-harness.html");
    await page.waitForFunction(() => window.__webvideoHarnessState?.status === "completed");

    const canvas = page.getByTestId("contract-canvas");
    await expect(canvas).toBeVisible();

    const surface = await page.evaluate(() => {
      const element = document.querySelector<HTMLCanvasElement>("#contract-canvas");
      const context = element?.getContext("2d");
      const sample = context ? Array.from(context.getImageData(320, 180, 1, 1).data) : [];

      return {
        width: element?.width ?? 0,
        height: element?.height ?? 0,
        hidden: element?.hidden ?? true,
        lastSequence: element?.dataset.lastSequence ?? "",
        overlayCount: element?.dataset.overlayCount ?? "",
        sample,
        renderedSequences: window.__webvideoHarnessState?.renderedSequences ?? [],
      };
    });

    expect(surface.width).toBe(1280);
    expect(surface.height).toBe(720);
    expect(surface.hidden).toBe(false);
    expect(surface.lastSequence).toBe("108");
    expect(surface.overlayCount).toBe("1");
    expect(surface.renderedSequences).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(surface.sample).toHaveLength(4);
    expect(surface.sample[3]).toBeGreaterThan(0);
    expect(surface.sample.slice(0, 3).some((channel) => channel > 0)).toBe(true);
  });

  test("surfaces the critical documented browser scenarios", async ({ page }) => {
    await page.goto("/contract-harness.html");

    await expect(page.getByTestId("scenario-row-viewer-joins-at-keyframe-boundary")).toContainText("late-frame policy present");
    await expect(page.getByTestId("scenario-row-metadata-overlay-aligns-to-frame-pts")).toContainText("overlay alignment outcome present");
    await expect(page.getByTestId("scenario-row-synthetic-rtsp-source-publishes-test-pattern")).toContainText("TCP smoke stream listed");
  });
});
