import { describe, expect, it } from "vitest";
import {
  addSample,
  createMetricSnapshot,
  createVmsCounterState,
  recordRenderedFrame,
  recordSequenceGap,
  summarizeLatency,
} from "../../src/vms/metrics";

describe("VMS metrics", () => {
  it("summarizes latency samples with latest average p50 and p95", () => {
    const summary = summarizeLatency([8, 2, 20, 4]);

    expect(summary.count).toBe(4);
    expect(summary.latestMs).toBe(4);
    expect(summary.averageMs).toBe(8.5);
    expect(summary.p50Ms).toBe(4);
    expect(summary.p95Ms).toBe(20);
  });

  it("creates a tile metric snapshot with throughput and bounded sample windows", () => {
    const state = createVmsCounterState(1000);
    for (let index = 0; index < 245; index += 1) {
      addSample(state.sourceToRenderMs, index);
      addSample(state.serverToRenderMs, index / 2);
      addSample(state.receiveToRenderMs, index / 4);
    }
    recordRenderedFrame(state, 2000, 33.333);
    recordRenderedFrame(state, 2033.333, 33.333);
    recordRenderedFrame(state, 2066.666, 33.333);
    recordSequenceGap(state, 7);
    state.framesRendered = 30;
    state.framesDropped = 2;
    state.batchesCompleted = 3;
    state.bytesReceived = 4096;
    state.messagesReceived = 12;
    addSample(state.decodeMs, 5);
    addSample(state.renderMs, 3);
    addSample(state.transportMs, 12);

    const snapshot = createMetricSnapshot(state, 4000);

    expect(snapshot.framesRendered).toBe(30);
    expect(snapshot.framesDropped).toBe(2);
    expect(snapshot.sequenceGapEvents).toBe(1);
    expect(snapshot.sequenceGapFrames).toBe(7);
    expect(snapshot.frameHitches).toBe(0);
    expect(snapshot.severeFrameHitches).toBe(0);
    expect(snapshot.batchesCompleted).toBe(3);
    expect(snapshot.bytesReceived).toBe(4096);
    expect(snapshot.messagesReceived).toBe(12);
    expect(snapshot.fps).toBe(10);
    expect(snapshot.renderFps).toBeCloseTo(30, 1);
    expect(snapshot.frameInterval.count).toBe(2);
    expect(snapshot.sourceToRender.count).toBe(240);
    expect(snapshot.serverToRender.count).toBe(240);
    expect(snapshot.receiveToRender.count).toBe(240);
    expect(snapshot.decode.latestMs).toBe(5);
    expect(snapshot.render.latestMs).toBe(3);
    expect(snapshot.transport.latestMs).toBe(12);
  });

  it("counts frame hitches from source-frame cadence", () => {
    const state = createVmsCounterState(1000);

    recordRenderedFrame(state, 2000, 33.333);
    recordRenderedFrame(state, 2080, 33.333);
    recordRenderedFrame(state, 2240, 33.333);

    const snapshot = createMetricSnapshot(state, 2300);

    expect(snapshot.frameHitches).toBe(2);
    expect(snapshot.severeFrameHitches).toBe(1);
    expect(snapshot.frameInterval.p95Ms).toBe(160);
  });
});
