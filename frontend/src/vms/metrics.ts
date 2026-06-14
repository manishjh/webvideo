export interface VmsLatencySummary {
  count: number;
  latestMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface VmsCounterState {
  startedAtMs: number;
  lastFrameAtMs?: number;
  framesRendered: number;
  framesDropped: number;
  sequenceGapEvents: number;
  sequenceGapFrames: number;
  frameHitches: number;
  severeFrameHitches: number;
  batchesCompleted: number;
  bytesReceived: number;
  messagesReceived: number;
  transportMs: number[];
  decodeMs: number[];
  renderMs: number[];
  sourceToRenderMs: number[];
  serverToRenderMs: number[];
  receiveToRenderMs: number[];
  frameIntervalMs: number[];
}

export interface VmsMetricSnapshot {
  framesRendered: number;
  framesDropped: number;
  sequenceGapEvents: number;
  sequenceGapFrames: number;
  frameHitches: number;
  severeFrameHitches: number;
  batchesCompleted: number;
  bytesReceived: number;
  messagesReceived: number;
  fps: number;
  renderFps: number;
  transport: VmsLatencySummary;
  decode: VmsLatencySummary;
  render: VmsLatencySummary;
  frameInterval: VmsLatencySummary;
  sourceToRender: VmsLatencySummary;
  serverToRender: VmsLatencySummary;
  receiveToRender: VmsLatencySummary;
}

export function createVmsCounterState(nowMs: number): VmsCounterState {
  return {
    startedAtMs: nowMs,
    framesRendered: 0,
    framesDropped: 0,
    sequenceGapEvents: 0,
    sequenceGapFrames: 0,
    frameHitches: 0,
    severeFrameHitches: 0,
    batchesCompleted: 0,
    bytesReceived: 0,
    messagesReceived: 0,
    transportMs: [],
    decodeMs: [],
    renderMs: [],
    sourceToRenderMs: [],
    serverToRenderMs: [],
    receiveToRenderMs: [],
    frameIntervalMs: [],
  };
}

export function addSample(samples: number[], valueMs: number, maxSamples = 240): void {
  if (!Number.isFinite(valueMs) || valueMs < 0) {
    return;
  }

  samples.push(valueMs);
  if (samples.length > maxSamples) {
    samples.splice(0, samples.length - maxSamples);
  }
}

export function recordSequenceGap(state: VmsCounterState, skippedFrames: number): void {
  if (!Number.isFinite(skippedFrames) || skippedFrames <= 0) {
    return;
  }

  state.sequenceGapEvents += 1;
  state.sequenceGapFrames += Math.floor(skippedFrames);
}

export function recordRenderedFrame(
  state: VmsCounterState,
  nowMs: number,
  expectedFrameIntervalMs?: number,
): void {
  if (state.lastFrameAtMs !== undefined) {
    const intervalMs = nowMs - state.lastFrameAtMs;
    addSample(state.frameIntervalMs, intervalMs, 120);
    if (expectedFrameIntervalMs !== undefined && expectedFrameIntervalMs > 0) {
      if (intervalMs > expectedFrameIntervalMs * 2.25) {
        state.frameHitches += 1;
      }

      if (intervalMs > expectedFrameIntervalMs * 4) {
        state.severeFrameHitches += 1;
      }
    }
  }

  state.framesRendered += 1;
  state.lastFrameAtMs = nowMs;
}

export function summarizeLatency(samples: readonly number[]): VmsLatencySummary {
  if (samples.length === 0) {
    return {
      count: 0,
      latestMs: 0,
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
    };
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    latestMs: samples[samples.length - 1] ?? 0,
    averageMs: total / samples.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

export function createMetricSnapshot(state: VmsCounterState, nowMs: number): VmsMetricSnapshot {
  const elapsedSeconds = Math.max((nowMs - state.startedAtMs) / 1000, 0.001);
  const frameInterval = summarizeLatency(state.frameIntervalMs);
  return {
    framesRendered: state.framesRendered,
    framesDropped: state.framesDropped,
    sequenceGapEvents: state.sequenceGapEvents,
    sequenceGapFrames: state.sequenceGapFrames,
    frameHitches: state.frameHitches,
    severeFrameHitches: state.severeFrameHitches,
    batchesCompleted: state.batchesCompleted,
    bytesReceived: state.bytesReceived,
    messagesReceived: state.messagesReceived,
    fps: state.framesRendered / elapsedSeconds,
    renderFps: frameInterval.averageMs > 0 ? 1000 / frameInterval.averageMs : 0,
    transport: summarizeLatency(state.transportMs),
    decode: summarizeLatency(state.decodeMs),
    render: summarizeLatency(state.renderMs),
    frameInterval,
    sourceToRender: summarizeLatency(state.sourceToRenderMs),
    serverToRender: summarizeLatency(state.serverToRenderMs),
    receiveToRender: summarizeLatency(state.receiveToRenderMs),
  };
}

function percentile(sortedSamples: readonly number[], fraction: number): number {
  if (sortedSamples.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil(sortedSamples.length * fraction) - 1),
  );
  return sortedSamples[index] ?? 0;
}
