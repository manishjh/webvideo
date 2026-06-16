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
  frameHitchTimestampsMs: number[];
  severeFrameHitchTimestampsMs: number[];
  batchesCompleted: number;
  bytesReceived: number;
  messagesReceived: number;
  transportMs: number[];
  decodeMs: number[];
  renderMs: number[];
  renderImportExternalTextureMs: number[];
  renderBindGroupMs: number[];
  renderUniformMs: number[];
  renderEncodeMs: number[];
  renderSubmitMs: number[];
  renderBudgetOverrun120Fps: number;
  renderBudgetOverrun100Fps: number;
  renderBudgetOverrun60Fps: number;
  renderImportBudgetOverrun120Fps: number;
  renderImportBudgetOverrun100Fps: number;
  renderImportBudgetOverrun60Fps: number;
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
  recentFrameHitches: number;
  recentSevereFrameHitches: number;
  batchesCompleted: number;
  bytesReceived: number;
  messagesReceived: number;
  fps: number;
  renderFps: number;
  transport: VmsLatencySummary;
  decode: VmsLatencySummary;
  render: VmsLatencySummary;
  renderImportExternalTexture: VmsLatencySummary;
  renderBindGroup: VmsLatencySummary;
  renderUniform: VmsLatencySummary;
  renderEncode: VmsLatencySummary;
  renderSubmit: VmsLatencySummary;
  renderBudgetOverrun120Fps: number;
  renderBudgetOverrun100Fps: number;
  renderBudgetOverrun60Fps: number;
  renderImportBudgetOverrun120Fps: number;
  renderImportBudgetOverrun100Fps: number;
  renderImportBudgetOverrun60Fps: number;
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
    frameHitchTimestampsMs: [],
    severeFrameHitchTimestampsMs: [],
    batchesCompleted: 0,
    bytesReceived: 0,
    messagesReceived: 0,
    transportMs: [],
    decodeMs: [],
    renderMs: [],
    renderImportExternalTextureMs: [],
    renderBindGroupMs: [],
    renderUniformMs: [],
    renderEncodeMs: [],
    renderSubmitMs: [],
    renderBudgetOverrun120Fps: 0,
    renderBudgetOverrun100Fps: 0,
    renderBudgetOverrun60Fps: 0,
    renderImportBudgetOverrun120Fps: 0,
    renderImportBudgetOverrun100Fps: 0,
    renderImportBudgetOverrun60Fps: 0,
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

export const FrameServiceBudgetMs = {
  fps120: 1000 / 120,
  fps100: 10,
  fps60: 1000 / 60,
} as const;

export function recordRenderBudgetSample(
  state: VmsCounterState,
  renderMs: number,
  importExternalTextureMs?: number,
): void {
  if (Number.isFinite(renderMs)) {
    if (renderMs > FrameServiceBudgetMs.fps120) {
      state.renderBudgetOverrun120Fps += 1;
    }
    if (renderMs > FrameServiceBudgetMs.fps100) {
      state.renderBudgetOverrun100Fps += 1;
    }
    if (renderMs > FrameServiceBudgetMs.fps60) {
      state.renderBudgetOverrun60Fps += 1;
    }
  }

  if (importExternalTextureMs === undefined || !Number.isFinite(importExternalTextureMs)) {
    return;
  }

  if (importExternalTextureMs > FrameServiceBudgetMs.fps120) {
    state.renderImportBudgetOverrun120Fps += 1;
  }
  if (importExternalTextureMs > FrameServiceBudgetMs.fps100) {
    state.renderImportBudgetOverrun100Fps += 1;
  }
  if (importExternalTextureMs > FrameServiceBudgetMs.fps60) {
    state.renderImportBudgetOverrun60Fps += 1;
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
        addTimestamp(state.frameHitchTimestampsMs, nowMs);
      }

      if (intervalMs > severeHitchThresholdMs) {
        state.severeFrameHitches += 1;
        addTimestamp(state.severeFrameHitchTimestampsMs, nowMs);
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
  const recentFrameHitches = countRecentTimestamps(state.frameHitchTimestampsMs, nowMs);
  const recentSevereFrameHitches = countRecentTimestamps(state.severeFrameHitchTimestampsMs, nowMs);
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
    recentFrameHitches,
    recentSevereFrameHitches,
    batchesCompleted: state.batchesCompleted,
    bytesReceived: state.bytesReceived,
    messagesReceived: state.messagesReceived,
    fps: state.framesRendered / elapsedSeconds,
    renderFps: recentFrameIntervalMs > 0 ? 1000 / recentFrameIntervalMs : 0,
    transport: summarizeLatency(state.transportMs),
    decode: summarizeLatency(state.decodeMs),
    render: summarizeLatency(state.renderMs),
    renderImportExternalTexture: summarizeLatency(state.renderImportExternalTextureMs),
    renderBindGroup: summarizeLatency(state.renderBindGroupMs),
    renderUniform: summarizeLatency(state.renderUniformMs),
    renderEncode: summarizeLatency(state.renderEncodeMs),
    renderSubmit: summarizeLatency(state.renderSubmitMs),
    renderBudgetOverrun120Fps: state.renderBudgetOverrun120Fps,
    renderBudgetOverrun100Fps: state.renderBudgetOverrun100Fps,
    renderBudgetOverrun60Fps: state.renderBudgetOverrun60Fps,
    renderImportBudgetOverrun120Fps: state.renderImportBudgetOverrun120Fps,
    renderImportBudgetOverrun100Fps: state.renderImportBudgetOverrun100Fps,
    renderImportBudgetOverrun60Fps: state.renderImportBudgetOverrun60Fps,
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

const RecentHitchWindowMs = 60_000;
const MaxRecentHitchTimestamps = 2048;

function addTimestamp(timestampsMs: number[], nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return;
  }

  timestampsMs.push(nowMs);
  pruneTimestamps(timestampsMs, nowMs);
}

function countRecentTimestamps(timestampsMs: number[], nowMs: number): number {
  pruneTimestamps(timestampsMs, nowMs);
  return timestampsMs.length;
}

function pruneTimestamps(timestampsMs: number[], nowMs: number): void {
  const oldestAllowedMs = nowMs - RecentHitchWindowMs;
  let firstRetainedIndex = 0;

  while (
    firstRetainedIndex < timestampsMs.length &&
    (timestampsMs[firstRetainedIndex] ?? 0) < oldestAllowedMs
  ) {
    firstRetainedIndex += 1;
  }

  if (firstRetainedIndex > 0) {
    timestampsMs.splice(0, firstRetainedIndex);
  }

  if (timestampsMs.length > MaxRecentHitchTimestamps) {
    timestampsMs.splice(0, timestampsMs.length - MaxRecentHitchTimestamps);
  }
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
