import { describe, expect, it } from "vitest";
import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PlayerTelemetryCollector,
  PresentationScheduler,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebPlayerBootstrap,
  WebTransportIngestClient,
} from "../../src/contracts/services";
import {
  frontendBehaviorCatalog,
  frontendFlowCatalog,
  requiredFrontendFlowIds,
} from "../../src/contracts/flows";

const serviceRegistry = {
  WebPlayerBootstrap: new WebPlayerBootstrap(),
  WebTransportIngestClient: new WebTransportIngestClient(),
  EncodedChunkAssembler: new EncodedChunkAssembler(),
  VideoDecodeCoordinator: new VideoDecodeCoordinator(),
  OverlayTimelineStore: new OverlayTimelineStore(),
  PresentationScheduler: new PresentationScheduler(),
  WebGpuRenderer: new WebGpuRenderer(),
  PlayerTelemetryCollector: new PlayerTelemetryCollector(),
} satisfies Record<string, object>;

describe("frontend flow coverage", () => {
  it("covers the expected frontend flow ids", () => {
    expect(requiredFrontendFlowIds).toEqual([
      "clock-and-recovery",
      "decode-schedule-render",
      "frontend-telemetry",
      "metadata-ingest-and-timeline",
      "player-session-bootstrap",
      "transport-read-and-assembly",
    ]);
  });

  it("ensures every flow step references a real service method", () => {
    for (const flow of frontendFlowCatalog) {
      expect(flow.steps.length).toBeGreaterThan(0);

      for (const step of flow.steps) {
        expect(step.sequence).toBeGreaterThan(0);
        expect(step.requiredMetrics.length).toBeGreaterThan(0);

        for (const method of step.methods) {
          expect(method.owner in serviceRegistry).toBe(true);

          const service = serviceRegistry[method.owner as keyof typeof serviceRegistry] as Record<string, unknown>;
          expect(typeof service[method.methodName]).toBe("function");
        }
      }
    }
  });

  it("captures every required frontend behavior and maps it to real flows", () => {
    const flowIds = new Set(requiredFrontendFlowIds);
    const behaviorIds = frontendBehaviorCatalog
      .map((behavior) => behavior.specificationId)
      .sort((left, right) => left.localeCompare(right));

    expect(behaviorIds).toEqual([
      "frontend-telemetry-is-queryable",
      "metadata-overlays-align-to-presentation-time",
      "player-enforces-bounded-latency",
      "player-recovers-from-discontinuity",
      "video-chunks-are-assembled-before-decode",
      "viewer-starts-live-session",
    ]);

    for (const behavior of frontendBehaviorCatalog) {
      expect(behavior.requiredOutcomes.length).toBeGreaterThan(0);
      expect(behavior.requiredMethods.length).toBeGreaterThan(0);
      expect(behavior.coveredFlowIds.length).toBeGreaterThan(0);

      for (const flowId of behavior.coveredFlowIds) {
        expect(flowIds.has(flowId)).toBe(true);
      }
    }
  });
});

