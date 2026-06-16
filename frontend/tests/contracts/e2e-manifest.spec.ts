import { describe, expect, it } from "vitest";
import {
  e2eScenarioCatalog,
  frontendBehaviorCatalog,
  requiredE2eScenarioIds,
} from "../../src/contracts/flows";

describe("frontend e2e manifest coverage", () => {
  it("covers the expected browser-facing end-to-end scenarios", () => {
    expect(requiredE2eScenarioIds).toEqual([
      "high-resolution-4k-channel-is-declared",
      "high-stress-4k60-crowd-channel-is-declared",
      "metadata-overlay-aligns-to-frame-pts",
      "player-recovers-from-stream-discontinuity",
      "rtsp-h264-source-feeds-browser-session",
      "tile-wall-renders-independent-channels",
      "viewer-joins-at-keyframe-boundary",
      "viewer-starts-live-stream",
    ]);
  });

  it("links every e2e scenario to known frontend behaviors", () => {
    const behaviorIds = new Set(frontendBehaviorCatalog.map((behavior) => behavior.specificationId));

    for (const scenario of e2eScenarioCatalog) {
      expect(scenario.requiredAssertions.length).toBeGreaterThan(0);
      expect(scenario.syntheticRtspScenarioId.length).toBeGreaterThan(0);

      for (const behaviorId of scenario.linkedBehaviorIds) {
        expect(behaviorIds.has(behaviorId)).toBe(true);
      }
    }
  });

  it("documents the synthetic RTSP scenarios needed by browser validation", () => {
    const referencedScenarios = new Set(e2eScenarioCatalog.map((scenario) => scenario.syntheticRtspScenarioId));
    expect(referencedScenarios).toEqual(new Set([
      "cctv-road-crowd-4k60",
      "download-13535786-4k60",
      "download-15116604-4k30",
      "download-15139494-4k60",
    ]));
  });
});
