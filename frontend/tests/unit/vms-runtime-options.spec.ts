import { describe, expect, it } from "vitest";
import { createVideoPipeViewportSessionKey } from "../../src/video-pipe";
import {
  createViewportOptions,
  shouldUseDirectTileRender,
  type RuntimeOptions,
} from "../../src/vms/VmsApp";

function createBaseOptions(): RuntimeOptions {
  return {
    adaptiveRenderFrameRate: true,
    adaptiveSourceFrameRate: false,
    batchFrameCount: 4,
    matrixCompositor: true,
    offscreenCanvas: false,
    renderClock: "frame-arrival",
  };
}

describe("VMS runtime options", () => {
  it("requests a viewport-sized source for single-tile playback", () => {
    expect(createViewportOptions(createBaseOptions(), 1)).toMatchObject({
      offscreenCanvas: false,
      maxHighFrameRateRenderFrameRate: undefined,
      maxRenderFrameRate: undefined,
      maxHighSourceFrameRate: undefined,
      maxSourceCodedWidth: undefined,
      maxSourceCodedHeight: undefined,
      maxSourceFrameRate: undefined,
    });
  });

  it("keeps explicit per-tile offscreen rendering for single-tile experiments", () => {
    expect(createViewportOptions({ ...createBaseOptions(), offscreenCanvas: true }, 1)).toMatchObject({
      offscreenCanvas: true,
    });
  });

  it("keeps explicit per-tile offscreen rendering for multi-tile performance mode", () => {
    expect(createViewportOptions({ ...createBaseOptions(), offscreenCanvas: true }, 4)).toMatchObject({
      offscreenCanvas: true,
    });
  });

  it("keeps native source policy for the fixed 2x2 wall", () => {
    expect(createViewportOptions(createBaseOptions(), 5)).toMatchObject({
      offscreenCanvas: false,
      maxHighFrameRateRenderFrameRate: undefined,
      maxRenderFrameRate: undefined,
      maxHighSourceFrameRate: undefined,
      maxSourceCodedWidth: undefined,
      maxSourceCodedHeight: undefined,
      maxSourceFrameRate: undefined,
    });
  });

  it("uses the shared wall canvas instead of per-tile offscreen for medium-density views", () => {
    expect(createViewportOptions(createBaseOptions(), 3)).toMatchObject({
      offscreenCanvas: false,
      maxHighFrameRateRenderFrameRate: undefined,
      maxHighSourceFrameRate: undefined,
      maxSourceCodedWidth: undefined,
      maxSourceCodedHeight: undefined,
      maxSourceFrameRate: undefined,
    });
  });

  it("keeps the viewport session key stable when wall density keeps the same source policy", () => {
    const singleTileKey = createVideoPipeViewportSessionKey(createViewportOptions(createBaseOptions(), 1));
    const multiTileKey = createVideoPipeViewportSessionKey(createViewportOptions(createBaseOptions(), 3));

    expect(multiTileKey).toBe(singleTileKey);
  });

  it("keeps explicit render caps from the URL", () => {
    expect(createViewportOptions({
      ...createBaseOptions(),
      maxHighFrameRateRenderFrameRate: 60,
      maxHighSourceFrameRate: 60,
      maxRenderFrameRate: 30,
      maxSourceCodedWidth: 3840,
      maxSourceCodedHeight: 2160,
      targetLatencyMs: 50,
    }, 9)).toMatchObject({
      offscreenCanvas: false,
      maxHighFrameRateRenderFrameRate: 60,
      maxHighSourceFrameRate: 60,
      maxRenderFrameRate: 30,
      maxSourceCodedWidth: 3840,
      maxSourceCodedHeight: 2160,
      maxSourceFrameRate: undefined,
      targetLatencyMs: 50,
    });
  });

  it("includes explicit latency in the viewport session key", () => {
    const baselineKey = createVideoPipeViewportSessionKey(createViewportOptions(createBaseOptions(), 1));
    const lowLatencyKey = createVideoPipeViewportSessionKey(createViewportOptions({
      ...createBaseOptions(),
      targetLatencyMs: 50,
    }, 1));

    expect(lowLatencyKey).not.toBe(baselineKey);
  });

  it("keeps the shared matrix canvas active for the single-tile viewport path", () => {
    expect(shouldUseDirectTileRender(
      createBaseOptions(),
      [{ tileId: "channel-001" }],
      {
        "channel-001": {
          renderBackend: "webgpu",
          gpuPresentation: "webgpu-canvas",
        },
      },
    )).toBe(false);
  });

  it("uses direct tile rendering for the explicit per-tile offscreen experiment", () => {
    expect(shouldUseDirectTileRender(
      { ...createBaseOptions(), offscreenCanvas: true },
      [{ tileId: "channel-001" }],
      {},
    )).toBe(true);
  });

  it("keeps the matrix canvas active for a healthy multi-tile wall", () => {
    expect(shouldUseDirectTileRender(
      createBaseOptions(),
      [{ tileId: "channel-001" }, { tileId: "channel-002" }],
      {
        "channel-001": {
          renderBackend: "webgpu",
          gpuPresentation: "webgpu-canvas",
        },
        "channel-002": {
          renderBackend: "webgpu",
          gpuPresentation: "webgpu-canvas",
        },
      },
    )).toBe(false);
  });

  it("uses direct tile canvases when matrix composition is disabled by URL", () => {
    expect(shouldUseDirectTileRender(
      { ...createBaseOptions(), matrixCompositor: false },
      [{ tileId: "channel-001" }],
      {},
    )).toBe(true);
  });

  it("uses direct tile canvases when runtime falls back from the matrix", () => {
    expect(shouldUseDirectTileRender(
      createBaseOptions(),
      [{ tileId: "channel-001" }],
      {
        "channel-001": {
          renderBackend: "webgpu",
          gpuPresentation: "webgpu-canvas",
          matrixFallbackReason: "matrix-disabled",
        },
      },
    )).toBe(true);
  });
});
