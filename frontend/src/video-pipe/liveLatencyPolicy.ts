const DefaultTargetLatencyMs = 150;
const DefaultFrameRate = 30;

export interface LiveDecodeBacklogPolicyInput {
  targetLatencyMs: number;
  frameRate?: number;
  maxFrames?: number;
}

export interface LiveHardDecodeBacklogPolicyInput extends LiveDecodeBacklogPolicyInput {
  renderRateLimited?: boolean;
}

export function resolveLiveStaleFrameDropThresholdMs(targetLatencyMs: number): number {
  const target = normalizePositiveNumber(targetLatencyMs, DefaultTargetLatencyMs);
  return Math.max(900, Math.min(1_500, target * 6));
}

export function resolveLiveDecodeBacklogBudgetFrames(input: LiveDecodeBacklogPolicyInput): number {
  const frameRate = normalizePositiveNumber(input.frameRate, DefaultFrameRate);
  const target = normalizePositiveNumber(input.targetLatencyMs, DefaultTargetLatencyMs);
  const maxFrames = normalizePositiveNumber(input.maxFrames, 12);
  const framesInTargetLatency = Math.ceil((target / 1000) * frameRate);
  return Math.max(2, Math.min(Math.floor(maxFrames), framesInTargetLatency));
}

export function resolveLiveHardDecodeBacklogFrames(input: LiveHardDecodeBacklogPolicyInput): number {
  const softBudget = resolveLiveDecodeBacklogBudgetFrames(input);
  const maxFrames = Math.floor(normalizePositiveNumber(input.maxFrames, 12));
  const slackFrames = input.renderRateLimited ? 5 : 4;
  return Math.max(4, Math.min(maxFrames, softBudget + slackFrames));
}

export function resolveLiveRenderQueueBudgetFrames(input: LiveDecodeBacklogPolicyInput): number {
  const frameRate = normalizePositiveNumber(input.frameRate, DefaultFrameRate);
  const target = normalizePositiveNumber(input.targetLatencyMs, DefaultTargetLatencyMs);
  const maxFrames = Math.floor(normalizePositiveNumber(input.maxFrames, 8));
  const framesInTargetLatency = Math.ceil((target / 1000) * frameRate);
  return Math.max(2, Math.min(maxFrames, framesInTargetLatency));
}

function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}
