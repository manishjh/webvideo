import type { VideoTransportMessage } from "../contracts/models";

export interface RenderServiceSample {
  renderMs: number;
  importExternalTextureMs?: number;
  sourceFrameRate?: number;
}

export interface EncodedFrameAdmissionDecision {
  admit: boolean;
  reason?: "predecode-nonreference-render-budget";
}

const DefaultSourceFrameRate = 60;
const DefaultMinFrameRate = 5;
const RenderSafetyMargin = 1.15;
const AdmissionSlackRatio = 0.25;

export class EncodedFrameAdmissionController {
  private renderServiceEwmaMs?: number;
  private targetFrameIntervalUs?: number;
  private lastAdmittedPresentationTimestampUs?: number;

  public reset(): void {
    this.renderServiceEwmaMs = undefined;
    this.targetFrameIntervalUs = undefined;
    this.lastAdmittedPresentationTimestampUs = undefined;
  }

  public recordPresentedFrame(sample: RenderServiceSample): void {
    const serviceMs = Math.max(
      finitePositive(sample.renderMs) ?? 0,
      finitePositive(sample.importExternalTextureMs) ?? 0,
    );
    if (serviceMs <= 0) {
      return;
    }

    this.renderServiceEwmaMs = this.renderServiceEwmaMs === undefined
      ? serviceMs
      : this.renderServiceEwmaMs * 0.82 + serviceMs * 0.18;

    const sourceFrameRate = finitePositive(sample.sourceFrameRate) ?? DefaultSourceFrameRate;
    const sourceFrameIntervalMs = 1_000 / sourceFrameRate;
    const minFrameIntervalMs = 1_000 / DefaultMinFrameRate;
    const targetIntervalMs = clamp(
      this.renderServiceEwmaMs * RenderSafetyMargin,
      sourceFrameIntervalMs,
      minFrameIntervalMs,
    );
    this.targetFrameIntervalUs = targetIntervalMs * 1_000;
  }

  public decideBeforeDecode(
    message: Pick<VideoTransportMessage, "keyFrame" | "presentationTimestampUs" | "payload">,
    codec: string,
    sourceFrameRate?: number,
  ): EncodedFrameAdmissionDecision {
    if (
      message.keyFrame
      || this.targetFrameIntervalUs === undefined
      || !isDroppableNonReferenceAvcAnnexBFrame(message.payload, codec)
    ) {
      this.markAdmitted(message.presentationTimestampUs);
      return { admit: true };
    }

    const sourceFrameRateValue = finitePositive(sourceFrameRate) ?? DefaultSourceFrameRate;
    const sourceFrameIntervalUs = 1_000_000 / sourceFrameRateValue;
    if (this.targetFrameIntervalUs <= sourceFrameIntervalUs * 1.2) {
      this.markAdmitted(message.presentationTimestampUs);
      return { admit: true };
    }

    if (this.lastAdmittedPresentationTimestampUs === undefined) {
      this.markAdmitted(message.presentationTimestampUs);
      return { admit: true };
    }

    const elapsedUs = message.presentationTimestampUs - this.lastAdmittedPresentationTimestampUs;
    if (!Number.isFinite(elapsedUs) || elapsedUs < 0) {
      this.markAdmitted(message.presentationTimestampUs);
      return { admit: true };
    }

    if (elapsedUs + sourceFrameIntervalUs * AdmissionSlackRatio < this.targetFrameIntervalUs) {
      return { admit: false, reason: "predecode-nonreference-render-budget" };
    }

    this.markAdmitted(message.presentationTimestampUs);
    return { admit: true };
  }

  private markAdmitted(presentationTimestampUs: number): void {
    if (Number.isFinite(presentationTimestampUs)) {
      this.lastAdmittedPresentationTimestampUs = presentationTimestampUs;
    }
  }
}

export function isDroppableNonReferenceAvcAnnexBFrame(payload: Uint8Array, codec: string): boolean {
  if (!isAvcCodec(codec) || payload.byteLength < 5) {
    return false;
  }

  let sawDroppableVcl = false;
  for (const nal of enumerateAnnexBNalUnits(payload)) {
    if (nal.start >= nal.end) {
      continue;
    }

    const header = payload[nal.start] ?? 0;
    const nalRefIdc = (header >> 5) & 0x03;
    const nalUnitType = header & 0x1f;
    if (nalUnitType === 1) {
      if (nalRefIdc !== 0) {
        return false;
      }

      sawDroppableVcl = true;
      continue;
    }

    if (nalUnitType >= 2 && nalUnitType <= 5) {
      return false;
    }
  }

  return sawDroppableVcl;
}

function* enumerateAnnexBNalUnits(payload: Uint8Array): Generator<{ start: number; end: number }> {
  let startCode = findStartCode(payload, 0);
  while (startCode) {
    const nalStart = startCode.offset + startCode.length;
    const nextStartCode = findStartCode(payload, nalStart);
    const nalEnd = nextStartCode?.offset ?? payload.byteLength;
    yield { start: nalStart, end: trimTrailingZeroBytes(payload, nalStart, nalEnd) };
    startCode = nextStartCode;
  }
}

function findStartCode(payload: Uint8Array, from: number): { offset: number; length: number } | undefined {
  for (let index = Math.max(0, from); index + 3 < payload.byteLength; index += 1) {
    if (payload[index] !== 0 || payload[index + 1] !== 0) {
      continue;
    }

    if (payload[index + 2] === 1) {
      return { offset: index, length: 3 };
    }

    if (index + 4 < payload.byteLength && payload[index + 2] === 0 && payload[index + 3] === 1) {
      return { offset: index, length: 4 };
    }
  }

  return undefined;
}

function trimTrailingZeroBytes(payload: Uint8Array, start: number, end: number): number {
  let cursor = end;
  while (cursor > start && payload[cursor - 1] === 0) {
    cursor -= 1;
  }

  return cursor;
}

function isAvcCodec(codec: string): boolean {
  const normalized = codec.toLowerCase();
  return normalized.startsWith("avc1") || normalized.startsWith("avc3") || normalized === "h264";
}

function finitePositive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
