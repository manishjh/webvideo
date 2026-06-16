const FrameRateLadder = [undefined, 60, 50, 45, 40, 30, 24, 20, 15] as const;
const PressureCooldownMs = 1_800;
const SeverePressureCooldownMs = 1_200;
const RecoveryQuietMs = 6_000;
const RecoveryStepMs = 2_000;

export interface AdaptiveRenderGovernorSnapshot {
  frameRateLimit?: number;
  pressureLevel: number;
}

export class AdaptiveRenderCadence {
  private renderTokens = 1;
  private lastUpdatedAtMs?: number;
  private lastSourceFrameRate?: number;
  private lastTargetFrameRate?: number;

  public shouldRender(
    sequenceNumber: number,
    sourceFrameRate: number | undefined,
    targetFrameRate: number | undefined,
    nowMs = now(),
  ): boolean {
    const source = normalizeFrameRate(sourceFrameRate);
    const target = normalizeFrameRate(targetFrameRate);
    if (source === undefined || target === undefined || source <= target * 1.05) {
      this.reset();
      return true;
    }

    if (this.lastSourceFrameRate !== source || this.lastTargetFrameRate !== target) {
      this.reset();
      this.lastSourceFrameRate = source;
      this.lastTargetFrameRate = target;
      this.lastUpdatedAtMs = nowMs;
    }

    if (!Number.isFinite(sequenceNumber)) {
      this.reset();
      this.lastSourceFrameRate = source;
      this.lastTargetFrameRate = target;
      this.lastUpdatedAtMs = nowMs;
    }

    if (this.lastUpdatedAtMs === undefined) {
      this.lastUpdatedAtMs = nowMs;
    } else {
      const elapsedMs = Math.max(0, nowMs - this.lastUpdatedAtMs);
      const sourceFrameTokenBudget = target / source;
      this.renderTokens = Math.min(
        1 + sourceFrameTokenBudget,
        this.renderTokens + (elapsedMs * target) / 1_000,
      );
      this.lastUpdatedAtMs = nowMs;
    }

    if (this.renderTokens < 1) {
      return false;
    }

    this.renderTokens -= 1;
    return true;
  }

  public reset(): void {
    this.renderTokens = 1;
    this.lastUpdatedAtMs = undefined;
    this.lastSourceFrameRate = undefined;
    this.lastTargetFrameRate = undefined;
  }
}

export class AdaptiveRenderFrameGovernor {
  private pressureLevel = 0;
  private lastPressureAtMs = Number.NEGATIVE_INFINITY;
  private lastLevelChangeAtMs = Number.NEGATIVE_INFINITY;

  public recordPressure(severity = 1, nowMs = now()): void {
    if (!Number.isFinite(severity) || severity <= 0) {
      return;
    }

    const cooldownMs = severity >= 2 ? SeverePressureCooldownMs : PressureCooldownMs;
    if (nowMs - this.lastLevelChangeAtMs < cooldownMs) {
      this.lastPressureAtMs = nowMs;
      return;
    }

    const nextLevel = Math.min(FrameRateLadder.length - 1, this.pressureLevel + Math.ceil(severity));
    this.lastPressureAtMs = nowMs;
    if (nextLevel === this.pressureLevel) {
      return;
    }

    this.pressureLevel = nextLevel;
    this.lastLevelChangeAtMs = nowMs;
  }

  public resolveFrameRateLimit(
    sourceFrameRate: number | undefined,
    configuredFrameRateLimit: number | undefined,
    nowMs = now(),
  ): AdaptiveRenderGovernorSnapshot {
    this.recoverIfQuiet(nowMs);
    const adaptiveFrameRateLimit = FrameRateLadder[this.pressureLevel];
    const frameRateLimit = minDefinedFrameRateLimit(configuredFrameRateLimit, adaptiveFrameRateLimit);
    return {
      frameRateLimit: minDefinedFrameRateLimit(frameRateLimit, normalizeFrameRate(sourceFrameRate)),
      pressureLevel: this.pressureLevel,
    };
  }

  public reset(): void {
    this.pressureLevel = 0;
    this.lastPressureAtMs = Number.NEGATIVE_INFINITY;
    this.lastLevelChangeAtMs = Number.NEGATIVE_INFINITY;
  }

  private recoverIfQuiet(nowMs: number): void {
    if (this.pressureLevel <= 0) {
      return;
    }

    if (nowMs - this.lastPressureAtMs < RecoveryQuietMs) {
      return;
    }

    if (nowMs - this.lastLevelChangeAtMs < RecoveryStepMs) {
      return;
    }

    this.pressureLevel -= 1;
    this.lastLevelChangeAtMs = nowMs;
  }
}

function minDefinedFrameRateLimit(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  const normalizedLeft = normalizeFrameRate(left);
  const normalizedRight = normalizeFrameRate(right);
  if (normalizedLeft === undefined) {
    return normalizedRight;
  }

  if (normalizedRight === undefined) {
    return normalizedLeft;
  }

  return Math.min(normalizedLeft, normalizedRight);
}

function normalizeFrameRate(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}
