import type { DecodedFramePlan } from "../contracts/models";

export interface LiveFrameSelection {
  dropped: DecodedFramePlan[];
  frame?: DecodedFramePlan;
}

const DefaultFrameRate = 60;
const DueSlackMs = 1;

export class LiveDecodedFrameQueue {
  private readonly frames: DecodedFramePlan[] = [];

  public get length(): number {
    return this.frames.length;
  }

  public enqueue(frames: readonly DecodedFramePlan[]): void {
    this.frames.push(...frames);
  }

  public dequeue(): DecodedFramePlan | undefined {
    return this.frames.shift();
  }

  public peekOldest(): DecodedFramePlan | undefined {
    return this.frames[0];
  }

  public peekNewest(): DecodedFramePlan | undefined {
    return this.frames[this.frames.length - 1];
  }

  public takeNewestWhere(predicate: (frame: DecodedFramePlan) => boolean): LiveFrameSelection {
    let selectedIndex = -1;
    for (let index = 0; index < this.frames.length; index += 1) {
      const frame = this.frames[index];
      if (frame && predicate(frame)) {
        selectedIndex = index;
      }
    }

    if (selectedIndex < 0) {
      return { dropped: [] };
    }

    const dropped = this.frames.splice(0, selectedIndex);
    const frame = this.frames.shift();
    return { dropped, frame };
  }

  public dropOldestUntil(maxFrames: number): DecodedFramePlan[] {
    const dropped: DecodedFramePlan[] = [];
    while (this.frames.length > maxFrames) {
      const frame = this.frames.shift();
      if (frame) {
        dropped.push(frame);
      }
    }

    return dropped;
  }

  public dropOldestWhile(
    predicate: (frame: DecodedFramePlan) => boolean,
    keepAtLeast = 0,
  ): DecodedFramePlan[] {
    const dropped: DecodedFramePlan[] = [];
    while (this.frames.length > keepAtLeast) {
      const frame = this.frames[0];
      if (!frame || !predicate(frame)) {
        break;
      }

      dropped.push(this.frames.shift()!);
    }

    return dropped;
  }

  public clear(): DecodedFramePlan[] {
    return this.frames.splice(0);
  }
}

export class LiveRenderTimingController {
  private anchorPresentationTimestampUs?: number;
  private anchorClockMs?: number;

  public reset(): void {
    this.anchorPresentationTimestampUs = undefined;
    this.anchorClockMs = undefined;
  }

  public isFrameDue(
    frame: DecodedFramePlan,
    sourceFrameRate: number | undefined,
    targetLatencyMs: number,
    nowMs = now(),
  ): boolean {
    return this.dueTimeMs(frame, sourceFrameRate, targetLatencyMs, nowMs) - nowMs <= DueSlackMs;
  }

  public waitMsUntilNextFrame(
    queue: LiveDecodedFrameQueue,
    sourceFrameRate: number | undefined,
    targetLatencyMs: number,
    nowMs = now(),
  ): number | undefined {
    const frame = queue.peekOldest();
    if (!frame) {
      return undefined;
    }

    return Math.max(0, this.dueTimeMs(frame, sourceFrameRate, targetLatencyMs, nowMs) - nowMs);
  }

  public dueTimeMs(
    frame: DecodedFramePlan,
    sourceFrameRate: number | undefined,
    targetLatencyMs: number,
    nowMs = now(),
  ): number {
    const presentationTimestampUs = normalizeTimestampUs(frame.presentationTimestampUs);
    const frameIntervalMs = expectedFrameIntervalMs(sourceFrameRate);
    const playoutDelayMs = resolveLiveRenderPlayoutDelayMs(sourceFrameRate, targetLatencyMs);

    if (
      this.anchorPresentationTimestampUs === undefined
      || this.anchorClockMs === undefined
      || presentationTimestampUs + frameIntervalMs * 2_000 < this.anchorPresentationTimestampUs
    ) {
      this.anchorPresentationTimestampUs = presentationTimestampUs;
      this.anchorClockMs = nowMs + playoutDelayMs;
      return this.anchorClockMs;
    }

    let dueTimeMs = this.anchorClockMs + (presentationTimestampUs - this.anchorPresentationTimestampUs) / 1_000;
    const driftResetWindowMs = Math.max(1_500, targetLatencyMs * 6, frameIntervalMs * 12);
    if (
      !Number.isFinite(dueTimeMs)
      || dueTimeMs < nowMs - driftResetWindowMs
      || dueTimeMs > nowMs + driftResetWindowMs
    ) {
      this.anchorPresentationTimestampUs = presentationTimestampUs;
      this.anchorClockMs = nowMs + playoutDelayMs;
      dueTimeMs = this.anchorClockMs;
    }

    return dueTimeMs;
  }
}

export function resolveLiveRenderPlayoutDelayMs(
  sourceFrameRate: number | undefined,
  targetLatencyMs: number,
): number {
  const frameIntervalMs = expectedFrameIntervalMs(sourceFrameRate);
  const latencyBudgetMs = Number.isFinite(targetLatencyMs) && targetLatencyMs > 0 ? targetLatencyMs : 150;
  return Math.max(
    4,
    Math.min(frameIntervalMs * 1.25, latencyBudgetMs * 0.2, 32),
  );
}

function normalizeTimestampUs(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function expectedFrameIntervalMs(frameRate: number | undefined): number {
  return typeof frameRate === "number" && Number.isFinite(frameRate) && frameRate > 0
    ? 1_000 / frameRate
    : 1_000 / DefaultFrameRate;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
