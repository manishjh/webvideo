import { describe, expect, it } from "vitest";
import {
  e2eScenarioCatalog,
  frontendBehaviorCatalog,
  requiredE2eScenarioIds,
} from "../../src/contracts/flows";

describe("frontend e2e manifest coverage", () => {
  it("covers the expected browser-facing end-to-end scenarios", () => {
    expect(requiredE2eScenarioIds).toEqual([
      "metadata-overlay-aligns-to-frame-pts",
      "player-recovers-from-stream-discontinuity",
      "synthetic-rtsp-source-publishes-test-pattern",
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
    expect(referencedScenarios).toEqual(new Set(["tcp-h264-smoke", "udp-h264-smoke"]));
  });
});

