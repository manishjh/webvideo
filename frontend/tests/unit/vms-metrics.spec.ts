import { describe, expect, it } from "vitest";
import {
  addSample,
  createMetricSnapshot,
  createVmsCounterState,
  recordRenderBudgetSample,
  recordRenderedFrame,
  recordSequenceGap,
  summarizeLatency,
} from "../../src/video-pipe";

describe("VMS metrics", () => {
  it("summarizes latency samples with latest average p50 p95 p99 and max", () => {
    const summary = summarizeLatency([8, 2, 20, 4]);

    expect(summary.count).toBe(4);
    expect(summary.latestMs).toBe(4);
    expect(summary.averageMs).toBe(8.5);
    expect(summary.p50Ms).toBe(4);
    expect(summary.p95Ms).toBe(20);
    expect(summary.p99Ms).toBe(20);
    expect(summary.maxMs).toBe(20);
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
    state.framesDecoded = 34;
    state.framesDropped = 2;
    state.framesRateLimited = 5;
    state.renderAttempts = 31;
    state.batchesCompleted = 3;
    state.bytesReceived = 4096;
    state.messagesReceived = 12;
    addSample(state.decodeMs, 5);
    addSample(state.renderMs, 3);
    addSample(state.renderImportExternalTextureMs, 0.5);
    addSample(state.renderBindGroupMs, 0.75);
    addSample(state.renderUniformMs, 0.25);
    addSample(state.renderEncodeMs, 1.5);
    addSample(state.renderSubmitMs, 0.4);
    recordRenderBudgetSample(state, 12, 11);
    addSample(state.transportMs, 12);
    addSample(state.receiveIntervalMs, 16);
    addSample(state.rafIntervalMs, 17);
    addSample(state.decodeBacklogFrames, 2);
    addSample(state.renderQueueFrames, 1);

    const snapshot = createMetricSnapshot(state, 4000);

    expect(snapshot.framesRendered).toBe(30);
    expect(snapshot.framesDecoded).toBe(34);
    expect(snapshot.framesDropped).toBe(2);
    expect(snapshot.framesRateLimited).toBe(5);
    expect(snapshot.renderAttempts).toBe(31);
    expect(snapshot.sequenceGapEvents).toBe(1);
    expect(snapshot.sequenceGapFrames).toBe(7);
    expect(snapshot.frameHitches).toBe(0);
    expect(snapshot.severeFrameHitches).toBe(0);
    expect(snapshot.recentFrameHitches).toBe(0);
    expect(snapshot.recentSevereFrameHitches).toBe(0);
    expect(snapshot.batchesCompleted).toBe(3);
    expect(snapshot.bytesReceived).toBe(4096);
    expect(snapshot.messagesReceived).toBe(12);
    expect(snapshot.fps).toBe(10);
    expect(snapshot.renderFps).toBeCloseTo(30, 1);
    expect(snapshot.frameInterval.count).toBe(2);
    expect(snapshot.frameInterval.maxMs).toBeCloseTo(33.333, 3);
    expect(snapshot.sourceToRender.count).toBe(240);
    expect(snapshot.sourceToRender.maxMs).toBe(244);
    expect(snapshot.serverToRender.count).toBe(240);
    expect(snapshot.receiveToRender.count).toBe(240);
    expect(snapshot.decode.latestMs).toBe(5);
    expect(snapshot.render.latestMs).toBe(3);
    expect(snapshot.renderImportExternalTexture.latestMs).toBe(0.5);
    expect(snapshot.renderBindGroup.latestMs).toBe(0.75);
    expect(snapshot.renderUniform.latestMs).toBe(0.25);
    expect(snapshot.renderEncode.latestMs).toBe(1.5);
    expect(snapshot.renderSubmit.latestMs).toBe(0.4);
    expect(snapshot.renderBudgetOverrun120Fps).toBe(1);
    expect(snapshot.renderBudgetOverrun100Fps).toBe(1);
    expect(snapshot.renderBudgetOverrun60Fps).toBe(0);
    expect(snapshot.renderImportBudgetOverrun120Fps).toBe(1);
    expect(snapshot.renderImportBudgetOverrun100Fps).toBe(1);
    expect(snapshot.renderImportBudgetOverrun60Fps).toBe(0);
    expect(snapshot.transport.latestMs).toBe(12);
    expect(snapshot.receiveInterval.latestMs).toBe(16);
    expect(snapshot.rafInterval.latestMs).toBe(17);
    expect(snapshot.decodeBacklog.latestMs).toBe(2);
    expect(snapshot.renderQueue.latestMs).toBe(1);
  });

  it("counts render service budget misses for 120fps, 100fps, and 60fps targets", () => {
    const state = createVmsCounterState(1000);

    recordRenderBudgetSample(state, 7, 7);
    recordRenderBudgetSample(state, 9, 9);
    recordRenderBudgetSample(state, 12, 12);
    recordRenderBudgetSample(state, 20, 20);

    const snapshot = createMetricSnapshot(state, 2000);

    expect(snapshot.renderBudgetOverrun120Fps).toBe(3);
    expect(snapshot.renderBudgetOverrun100Fps).toBe(2);
    expect(snapshot.renderBudgetOverrun60Fps).toBe(1);
    expect(snapshot.renderImportBudgetOverrun120Fps).toBe(3);
    expect(snapshot.renderImportBudgetOverrun100Fps).toBe(2);
    expect(snapshot.renderImportBudgetOverrun60Fps).toBe(1);
  });

  it("counts frame hitches from source-frame cadence", () => {
    const state = createVmsCounterState(1000);

    recordRenderedFrame(state, 2000, 33.333);
    recordRenderedFrame(state, 2080, 33.333);
    recordRenderedFrame(state, 2240, 33.333);

    const snapshot = createMetricSnapshot(state, 2300);

    expect(snapshot.frameHitches).toBe(2);
    expect(snapshot.severeFrameHitches).toBe(1);
    expect(snapshot.recentFrameHitches).toBe(2);
    expect(snapshot.recentSevereFrameHitches).toBe(1);
    expect(snapshot.frameInterval.p95Ms).toBe(160);
  });

  it("uses an absolute severe hitch floor for high-fps streams", () => {
    const state = createVmsCounterState(1000);

    recordRenderedFrame(state, 2000, 16.667);
    recordRenderedFrame(state, 2056, 16.667);
    recordRenderedFrame(state, 2132, 16.667);
    recordRenderedFrame(state, 2262, 16.667);

    const snapshot = createMetricSnapshot(state, 2300);

    expect(snapshot.frameHitches).toBe(3);
    expect(snapshot.severeFrameHitches).toBe(1);
    expect(snapshot.recentFrameHitches).toBe(3);
    expect(snapshot.recentSevereFrameHitches).toBe(1);
  });

  it("keeps recent hitch counts separate from lifetime hitch totals", () => {
    const state = createVmsCounterState(1000);

    recordRenderedFrame(state, 2000, 33.333);
    recordRenderedFrame(state, 2080, 33.333);
    recordRenderedFrame(state, 2240, 33.333);

    const activeWindowSnapshot = createMetricSnapshot(state, 60_000);
    const cooledOffSnapshot = createMetricSnapshot(state, 63_000);

    expect(activeWindowSnapshot.frameHitches).toBe(2);
    expect(activeWindowSnapshot.severeFrameHitches).toBe(1);
    expect(activeWindowSnapshot.recentFrameHitches).toBe(2);
    expect(activeWindowSnapshot.recentSevereFrameHitches).toBe(1);

    expect(cooledOffSnapshot.frameHitches).toBe(2);
    expect(cooledOffSnapshot.severeFrameHitches).toBe(1);
    expect(cooledOffSnapshot.recentFrameHitches).toBe(0);
    expect(cooledOffSnapshot.recentSevereFrameHitches).toBe(0);
  });
});
