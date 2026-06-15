import { describe, expect, it } from "vitest";
import {
  createViewportOptions,
  type RuntimeOptions,
} from "../../src/vms/VmsApp";

function createBaseOptions(): RuntimeOptions {
  return {
    adaptiveRenderFrameRate: true,
    batchFrameCount: 4,
    matrixCompositor: true,
    renderClock: "frame-arrival",
  };
}

describe("VMS runtime options", () => {
  it("requests a viewport-sized source for single-tile playback", () => {
    expect(createViewportOptions(createBaseOptions(), 1)).toMatchObject({
      maxHighFrameRateRenderFrameRate: undefined,
      maxRenderFrameRate: undefined,
      maxHighSourceFrameRate: undefined,
      maxSourceCodedWidth: 1920,
      maxSourceCodedHeight: 1080,
      maxSourceFrameRate: undefined,
    });
  });

  it("requests low-rate source variants when the wall is dense", () => {
    expect(createViewportOptions(createBaseOptions(), 5)).toMatchObject({
      maxHighFrameRateRenderFrameRate: 15,
      maxRenderFrameRate: 15,
      maxHighSourceFrameRate: 15,
      maxSourceCodedWidth: 1280,
      maxSourceCodedHeight: 720,
      maxSourceFrameRate: 15,
    });
  });

  it("requests 1080p source variants for medium-density views", () => {
    expect(createViewportOptions(createBaseOptions(), 3)).toMatchObject({
      maxHighFrameRateRenderFrameRate: 24,
      maxHighSourceFrameRate: 24,
      maxSourceCodedWidth: 1920,
      maxSourceCodedHeight: 1080,
      maxSourceFrameRate: undefined,
    });
  });

  it("keeps explicit render caps from the URL", () => {
    expect(createViewportOptions({
      ...createBaseOptions(),
      maxHighFrameRateRenderFrameRate: 60,
      maxHighSourceFrameRate: 60,
      maxRenderFrameRate: 30,
      maxSourceCodedWidth: 3840,
      maxSourceCodedHeight: 2160,
    }, 9)).toMatchObject({
      maxHighFrameRateRenderFrameRate: 60,
      maxHighSourceFrameRate: 60,
      maxRenderFrameRate: 30,
      maxSourceCodedWidth: 3840,
      maxSourceCodedHeight: 2160,
      maxSourceFrameRate: undefined,
    });
  });
});
