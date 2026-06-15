export interface VmsLatencySummary {
  count: number;
  latestMs: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface VmsCounterState {
  startedAtMs: number;
  lastFrameAtMs?: number;
  framesRendered: number;
  framesDecoded: number;
  framesDropped: number;
  framesRateLimited: number;
  renderAttempts: number;
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
  receiveIntervalMs: number[];
  rafIntervalMs: number[];
  decodeBacklogFrames: number[];
  renderQueueFrames: number[];
}

export interface VmsMetricSnapshot {
  framesRendered: number;
  framesDecoded: number;
  framesDropped: number;
  framesRateLimited: number;
  renderAttempts: number;
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
  receiveInterval: VmsLatencySummary;
  rafInterval: VmsLatencySummary;
  decodeBacklog: VmsLatencySummary;
  renderQueue: VmsLatencySummary;
}

export function createVmsCounterState(nowMs: number): VmsCounterState {
  return {
    startedAtMs: nowMs,
    framesRendered: 0,
    framesDecoded: 0,
    framesDropped: 0,
    framesRateLimited: 0,
    renderAttempts: 0,
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
    receiveIntervalMs: [],
    rafIntervalMs: [],
    decodeBacklogFrames: [],
    renderQueueFrames: [],
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
      const hitchThresholdMs = Math.max(expectedFrameIntervalMs * 2.25, 45);
      const severeHitchThresholdMs = Math.max(expectedFrameIntervalMs * 4, 120);
      if (intervalMs > hitchThresholdMs) {
        state.frameHitches += 1;
      }

      if (intervalMs > severeHitchThresholdMs) {
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
      p99Ms: 0,
      maxMs: 0,
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
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

export function createMetricSnapshot(state: VmsCounterState, nowMs: number): VmsMetricSnapshot {
  const elapsedSeconds = Math.max((nowMs - state.startedAtMs) / 1000, 0.001);
  const frameInterval = summarizeLatency(state.frameIntervalMs);
  const recentFrameIntervalMs = averageRecent(state.frameIntervalMs, 30);
  return {
    framesRendered: state.framesRendered,
    framesDecoded: state.framesDecoded,
    framesDropped: state.framesDropped,
    framesRateLimited: state.framesRateLimited,
    renderAttempts: state.renderAttempts,
    sequenceGapEvents: state.sequenceGapEvents,
    sequenceGapFrames: state.sequenceGapFrames,
    frameHitches: state.frameHitches,
    severeFrameHitches: state.severeFrameHitches,
    batchesCompleted: state.batchesCompleted,
    bytesReceived: state.bytesReceived,
    messagesReceived: state.messagesReceived,
    fps: state.framesRendered / elapsedSeconds,
    renderFps: recentFrameIntervalMs > 0 ? 1000 / recentFrameIntervalMs : 0,
    transport: summarizeLatency(state.transportMs),
    decode: summarizeLatency(state.decodeMs),
    render: summarizeLatency(state.renderMs),
    frameInterval,
    sourceToRender: summarizeLatency(state.sourceToRenderMs),
    serverToRender: summarizeLatency(state.serverToRenderMs),
    receiveToRender: summarizeLatency(state.receiveToRenderMs),
    receiveInterval: summarizeLatency(state.receiveIntervalMs),
    rafInterval: summarizeLatency(state.rafIntervalMs),
    decodeBacklog: summarizeLatency(state.decodeBacklogFrames),
    renderQueue: summarizeLatency(state.renderQueueFrames),
  };
}

function averageRecent(samples: readonly number[], maxSamples: number): number {
  if (samples.length === 0) {
    return 0;
  }

  const start = Math.max(0, samples.length - maxSamples);
  let total = 0;
  for (let index = start; index < samples.length; index += 1) {
    total += samples[index] ?? 0;
  }

  return total / (samples.length - start);
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
