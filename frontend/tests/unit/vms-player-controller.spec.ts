import { describe, expect, it, vi } from "vitest";
import type { DecodedFramePlan } from "../../src/contracts/models";
import {
  AdaptiveRenderCadence,
  AdaptiveRenderFrameGovernor,
  LiveDecodedFrameQueue,
  LiveRenderTimingController,
  resolveAdaptiveRenderDurationPressureSeverity,
  resolveLiveDecodeBacklogBudgetFrames,
  resolveLiveHardDecodeBacklogFrames,
  resolveLiveRenderPlayoutDelayMs,
  resolveLiveRenderQueueBudgetFrames,
  resolveLiveStaleFrameDropThresholdMs,
  resolveEffectiveRenderFrameRate,
  resolveEffectiveSourceEgressFrameRate,
  resolveEffectiveSourceFrameRate,
  resolveTileSurfaceSize,
  waitForNextPaint,
} from "../../src/video-pipe";
import {
  shouldUseWorkerVideoDecoder,
  WorkerVideoDecodeCoordinator,
} from "../../src/video-pipe/workerVideoDecodeCoordinator";
import {
  shouldUseWorkerMediaPipeline,
  WorkerMediaPipelineClient,
} from "../../src/video-pipe/workerMediaPipelineClient";
import {
  EncodedFrameAdmissionController,
  isDroppableNonReferenceAvcAnnexBFrame,
} from "../../src/video-pipe/encodedFrameAdmission";

describe("VMS player controller", () => {
  it("keeps decoded burst frames for the render pump instead of dropping them immediately", () => {
    const queue = new LiveDecodedFrameQueue();

    queue.enqueue([
      createFrame(1),
      createFrame(2),
      createFrame(3),
    ]);

    expect(queue.length).toBe(3);
    expect(queue.dequeue()?.sequenceNumber).toBe(1);
    expect(queue.dequeue()?.sequenceNumber).toBe(2);
    expect(queue.dequeue()?.sequenceNumber).toBe(3);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("drops only the oldest decoded frames when the live render queue exceeds its budget", () => {
    const queue = new LiveDecodedFrameQueue();

    queue.enqueue([
      createFrame(1),
      createFrame(2),
      createFrame(3),
      createFrame(4),
      createFrame(5),
    ]);

    const dropped = queue.dropOldestUntil(3);

    expect(dropped.map((frame) => frame.sequenceNumber)).toEqual([1, 2]);
    expect(queue.length).toBe(3);
    expect(queue.dequeue()?.sequenceNumber).toBe(3);
  });

  it("can inspect the freshest decoded frame without removing queued frames", () => {
    const queue = new LiveDecodedFrameQueue();

    queue.enqueue([
      createFrame(1),
      createFrame(2),
      createFrame(3),
    ]);

    expect(queue.peekNewest()?.sequenceNumber).toBe(3);
    expect(queue.length).toBe(3);
    expect(queue.dequeue()?.sequenceNumber).toBe(1);
  });

  it("keeps future frames buffered until their media timestamp is due", () => {
    const queue = new LiveDecodedFrameQueue();
    const timing = new LiveRenderTimingController();
    const playoutDelayMs = resolveLiveRenderPlayoutDelayMs(60, 150);

    queue.enqueue([
      createFrame(1),
      createFrame(2),
    ]);

    expect(queue.takeNewestWhere((frame) => timing.isFrameDue(frame, 60, 150, 1_000)).frame).toBeUndefined();
    expect(queue.length).toBe(2);
    expect(timing.waitMsUntilNextFrame(queue, 60, 150, 1_000)).toBeCloseTo(playoutDelayMs, 1);

    const firstSelection = queue.takeNewestWhere((frame) => {
      return timing.isFrameDue(frame, 60, 150, 1_000 + playoutDelayMs + 1);
    });

    expect(firstSelection.frame?.sequenceNumber).toBe(1);
    expect(firstSelection.dropped).toEqual([]);
    expect(queue.length).toBe(1);
    expect(queue.peekOldest()?.sequenceNumber).toBe(2);
  });

  it("drops old due frames and presents the newest due frame after a burst", () => {
    const queue = new LiveDecodedFrameQueue();
    const timing = new LiveRenderTimingController();
    const playoutDelayMs = resolveLiveRenderPlayoutDelayMs(60, 150);

    queue.enqueue([
      createFrame(1),
      createFrame(2),
      createFrame(3),
      createFrame(4),
    ]);
    timing.waitMsUntilNextFrame(queue, 60, 150, 1_000);

    const selection = queue.takeNewestWhere((frame) => {
      return timing.isFrameDue(frame, 60, 150, 1_000 + playoutDelayMs + 55);
    });

    expect(selection.frame?.sequenceNumber).toBe(4);
    expect(selection.dropped.map((frame) => frame.sequenceNumber)).toEqual([1, 2, 3]);
    expect(queue.length).toBe(0);
  });

  it("resets render timing when media timestamps jump backwards", () => {
    const timing = new LiveRenderTimingController();
    const playoutDelayMs = resolveLiveRenderPlayoutDelayMs(60, 150);

    const firstDueMs = timing.dueTimeMs(createFrame(60), 60, 150, 1_000);
    const resetDueMs = timing.dueTimeMs(createFrame(1), 60, 150, 2_000);

    expect(firstDueMs).toBeCloseTo(1_000 + playoutDelayMs, 1);
    expect(resetDueMs).toBeCloseTo(2_000 + playoutDelayMs, 1);
  });

  it("keeps at least one frame while dropping stale decoded frames", () => {
    const queue = new LiveDecodedFrameQueue();

    queue.enqueue([
      createFrame(1),
      createFrame(2),
      createFrame(3),
    ]);

    const dropped = queue.dropOldestWhile((frame) => frame.sequenceNumber < 10, 1);

    expect(dropped.map((frame) => frame.sequenceNumber)).toEqual([1, 2]);
    expect(queue.length).toBe(1);
    expect(queue.dequeue()?.sequenceNumber).toBe(3);
  });

  it("sizes VMS WebGPU surfaces to the visible tile instead of native camera resolution", () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
    Object.defineProperty(globalThis, "devicePixelRatio", {
      configurable: true,
      value: 2,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => id === "tile-canvas"
          ? {
            getBoundingClientRect: () => ({
              width: 480,
              height: 270,
            }),
          }
          : null,
      },
    });

    try {
      expect(resolveTileSurfaceSize("tile-canvas", 3840, 2160)).toEqual({
        width: 600,
        height: 338,
      });
    } finally {
      if (documentDescriptor) {
        Object.defineProperty(globalThis, "document", documentDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }

      if (pixelRatioDescriptor) {
        Object.defineProperty(globalThis, "devicePixelRatio", pixelRatioDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "devicePixelRatio");
      }
    }
  });

  it("does not let the rAF stall fallback pace high-fps playback", async () => {
    vi.useFakeTimers();
    const rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
    let settled = false;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        globalThis.setTimeout(() => callback(20), 20);
        return 1;
      },
    });

    try {
      const paintPromise = waitForNextPaint(new AbortController().signal).then((timestamp) => {
        settled = true;
        return timestamp;
      });

      await vi.advanceTimersByTimeAsync(19);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(paintPromise).resolves.toBe(20);
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
      if (rafDescriptor) {
        Object.defineProperty(globalThis, "requestAnimationFrame", rafDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      }
    }
  });

  it("leaves normal 30 fps cameras on the wall-wide render cap", () => {
    expect(resolveEffectiveRenderFrameRate(30, {
      maxHighFrameRateRenderFrameRate: 24,
      maxRenderFrameRate: 30,
    })).toBe(30);
  });

  it("uses the high-frame-rate cap only for high-fps sources", () => {
    expect(resolveEffectiveRenderFrameRate(60, {
      maxHighFrameRateRenderFrameRate: 24,
      maxRenderFrameRate: 30,
    })).toBe(24);
  });

  it("does not treat normal offscreen WebGPU render completion latency as adaptive pressure", () => {
    const sixtyFpsIntervalMs = 1000 / 60;

    expect(resolveAdaptiveRenderDurationPressureSeverity(27, sixtyFpsIntervalMs)).toBe(0);
    expect(resolveAdaptiveRenderDurationPressureSeverity(51, sixtyFpsIntervalMs)).toBe(1);
    expect(resolveAdaptiveRenderDurationPressureSeverity(101, sixtyFpsIntervalMs)).toBe(2);
  });

  it("keeps live decode admission tied to latency instead of building a hidden DVR buffer", () => {
    expect(resolveLiveStaleFrameDropThresholdMs(150)).toBe(900);
    expect(resolveLiveDecodeBacklogBudgetFrames({
      frameRate: 60,
      maxFrames: 12,
      targetLatencyMs: 150,
    })).toBe(9);
    expect(resolveLiveHardDecodeBacklogFrames({
      frameRate: 60,
      maxFrames: 12,
      targetLatencyMs: 150,
    })).toBe(12);
    expect(resolveLiveHardDecodeBacklogFrames({
      frameRate: 30,
      maxFrames: 12,
      targetLatencyMs: 150,
    })).toBe(9);
    expect(resolveLiveHardDecodeBacklogFrames({
      maxFrames: 12,
      targetLatencyMs: 150,
    })).toBeLessThanOrEqual(9);
  });

  it("keeps the render queue budget inside the live latency target", () => {
    expect(resolveLiveRenderQueueBudgetFrames({
      frameRate: 60,
      maxFrames: 8,
      targetLatencyMs: 150,
    })).toBe(8);
    expect(resolveLiveRenderQueueBudgetFrames({
      frameRate: 30,
      maxFrames: 8,
      targetLatencyMs: 150,
    })).toBe(5);
  });

  it("keeps worker decode opt-in until browser transfer is proven stable", () => {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class FakeWorker {},
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          search: "",
        },
      },
    });

    try {
      expect(shouldUseWorkerVideoDecoder()).toBe(false);
      (globalThis.window as unknown as { location: { search: string } }).location.search = "?decodeWorker=1";
      expect(shouldUseWorkerVideoDecoder()).toBe(true);
      (globalThis.window as unknown as { location: { search: string } }).location.search = "?decodeWorker=worker";
      expect(shouldUseWorkerVideoDecoder()).toBe(true);
    } finally {
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }

      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("uses the full media-pipeline worker by default and keeps an escape hatch", () => {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: class FakeWorker {},
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          search: "",
        },
      },
    });

    try {
      expect(shouldUseWorkerMediaPipeline()).toBe(true);
      (globalThis.window as unknown as { location: { search: string } }).location.search = "?mediaWorker=0";
      expect(shouldUseWorkerMediaPipeline()).toBe(false);
      (globalThis.window as unknown as { location: { search: string } }).location.search = "?mediaWorker=1";
      expect(shouldUseWorkerMediaPipeline()).toBe(true);
      (globalThis.window as unknown as { location: { search: string } }).location.search = "?mediaWorker=worker";
      expect(shouldUseWorkerMediaPipeline()).toBe(true);
    } finally {
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }

      if (windowDescriptor) {
        Object.defineProperty(globalThis, "window", windowDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
    }
  });

  it("posts copied chunks to the worker decoder and drains flushed frames", async () => {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const postedMessages: Array<{ message: unknown; transfer?: Transferable[] }> = [];

    class FakeWorker {
      public onmessage?: (event: MessageEvent) => void;
      public onerror?: (event: ErrorEvent) => void;
      public onmessageerror?: (event: MessageEvent) => void;

      public postMessage(message: { type: string; id: number }, transfer?: Transferable[]): void {
        postedMessages.push({ message, transfer });
        if (message.type === "configure") {
          queueMicrotask(() => this.onmessage?.({
            data: { type: "configured", id: message.id, backlogFrameCount: 0 },
          } as MessageEvent));
          return;
        }

        if (message.type === "enqueue") {
          queueMicrotask(() => this.onmessage?.({
            data: { type: "enqueued", id: message.id, backlogFrameCount: 1 },
          } as MessageEvent));
          return;
        }

        if (message.type === "flush") {
          queueMicrotask(() => this.onmessage?.({
            data: {
              type: "flushed",
              id: message.id,
              frames: [createFrame(9)],
              backlogFrameCount: 0,
            },
          } as MessageEvent));
        }
      }

      public terminate(): void {
        postedMessages.push({ message: { type: "terminated" } });
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: FakeWorker,
    });

    try {
      const decoder = new WorkerVideoDecodeCoordinator();
      await decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });

      const payload = new Uint8Array([1, 2, 3, 4]);
      await decoder.enqueueChunk({
        streamId: "camera-001",
        sequenceNumber: 9,
        encodedChunkType: "key",
        presentationTimestampUs: 9_000,
        payload,
      });
      const frames = await decoder.flush();

      const enqueueMessage = postedMessages
        .map((entry) => entry.message)
        .find((message): message is { type: string; chunk: { payload: Uint8Array } } => {
          return typeof message === "object"
            && message !== null
            && (message as { type?: string }).type === "enqueue";
        });
      expect(enqueueMessage?.chunk.payload).toEqual(payload);
      expect(enqueueMessage?.chunk.payload).not.toBe(payload);
      expect(frames.map((frame) => frame.sequenceNumber)).toEqual([9]);
      decoder.dispose();
    } finally {
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    }
  });

  it("times out a hung worker decoder request so the player can fall back", async () => {
    vi.useFakeTimers();
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const postedMessages: unknown[] = [];

    class HungWorker {
      public onmessage?: (event: MessageEvent) => void;
      public onerror?: (event: ErrorEvent) => void;
      public onmessageerror?: (event: MessageEvent) => void;

      public postMessage(message: unknown): void {
        postedMessages.push(message);
      }

      public terminate(): void {
        postedMessages.push({ type: "terminated" });
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: HungWorker,
    });

    try {
      const decoder = new WorkerVideoDecodeCoordinator(undefined, { requestTimeoutMs: 25 });
      const configure = decoder.configureDecoder({
        codec: "avc1.42C01F",
        codedWidth: 1280,
        codedHeight: 720,
      });
      const rejected = expect(configure).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(postedMessages).toHaveLength(1);
      decoder.dispose();
    } finally {
      vi.useRealTimers();
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    }
  });

  it("rejects media-worker startup when no decoded frame arrives", async () => {
    vi.useFakeTimers();
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const postedMessages: unknown[] = [];

    class HungWorker {
      public onmessage?: (event: MessageEvent) => void;
      public onerror?: (event: ErrorEvent) => void;
      public onmessageerror?: (event: MessageEvent) => void;

      public postMessage(message: unknown): void {
        postedMessages.push(message);
      }

      public terminate(): void {
        postedMessages.push({ type: "terminated" });
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: HungWorker,
    });

    try {
      const client = new WorkerMediaPipelineClient(() => undefined, { startupTimeoutMs: 50 });
      const abortController = new AbortController();
      const started = client.start(
        {
          channelId: "channel-001",
          streamId: "camera-001",
          webTransportUrl: "https://127.0.0.1:9443/live/channel-001",
          authToken: "test-token",
          metadataChannelRequired: true,
          requestedTransport: "webtransport-quic",
          allowHttpFallback: false,
        },
        {
          codec: "avc1.42C01F",
          codedWidth: 1280,
          codedHeight: 720,
        },
        250,
        abortController.signal,
      );
      const rejected = expect(started).rejects.toThrow("did not decode a frame");

      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(postedMessages.some((message) => {
        return typeof message === "object"
          && message !== null
          && (message as { type?: string }).type === "terminated";
      })).toBe(true);
    } finally {
      vi.useRealTimers();
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    }
  });

  it("sends metadata toggle changes to the media worker", () => {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
    const postedMessages: unknown[] = [];

    class ToggleWorker {
      public onmessage?: (event: MessageEvent) => void;
      public onerror?: (event: ErrorEvent) => void;
      public onmessageerror?: (event: MessageEvent) => void;

      public postMessage(message: unknown): void {
        postedMessages.push(message);
      }

      public terminate(): void {
        postedMessages.push({ type: "terminated" });
      }
    }

    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: ToggleWorker,
    });

    try {
      const client = new WorkerMediaPipelineClient(() => undefined);
      client.setMetadataEnabled(false);
      client.setMetadataEnabled(true);
      client.dispose();

      expect(postedMessages).toContainEqual({ type: "set-metadata-enabled", enabled: false });
      expect(postedMessages).toContainEqual({ type: "set-metadata-enabled", enabled: true });
    } finally {
      if (workerDescriptor) {
        Object.defineProperty(globalThis, "Worker", workerDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "Worker");
      }
    }
  });

  it("does not cap high-fps sources unless a render cap is configured", () => {
    expect(resolveEffectiveRenderFrameRate(60, {})).toBeUndefined();
  });

  it("tracks the selected source rate after requesting a lower egress variant", () => {
    expect(resolveEffectiveSourceFrameRate(60, 15)).toBe(15);
    expect(resolveEffectiveSourceFrameRate(30, 15)).toBe(15);
    expect(resolveEffectiveSourceFrameRate(15, 24)).toBe(15);
    expect(resolveEffectiveSourceFrameRate(30, undefined)).toBe(30);
  });

  it("keeps source egress separate from render caps", () => {
    expect(resolveEffectiveSourceEgressFrameRate(60, {
      maxSourceFrameRate: 15,
    })).toBe(15);
    expect(resolveEffectiveSourceEgressFrameRate(60, {
      maxHighSourceFrameRate: 24,
    })).toBe(24);
    expect(resolveEffectiveSourceEgressFrameRate(30, {
      maxHighSourceFrameRate: 24,
    })).toBe(30);
    expect(resolveEffectiveSourceEgressFrameRate(60, {})).toBeUndefined();
  });

  it("lowers a player render cap quickly but waits for a stable quiet window before recovery", () => {
    const governor = new AdaptiveRenderFrameGovernor();

    expect(governor.resolveFrameRateLimit(60, undefined, 0)).toEqual({
      frameRateLimit: 60,
      pressureLevel: 0,
    });

    governor.recordPressure(1, 100);
    expect(governor.resolveFrameRateLimit(60, undefined, 200)).toEqual({
      frameRateLimit: 60,
      pressureLevel: 1,
    });

    governor.recordPressure(2, 1_400);
    expect(governor.resolveFrameRateLimit(60, undefined, 1_500)).toEqual({
      frameRateLimit: 45,
      pressureLevel: 3,
    });

    expect(governor.resolveFrameRateLimit(60, undefined, 3_800)).toEqual({
      frameRateLimit: 45,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 4_100)).toEqual({
      frameRateLimit: 45,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 7_300)).toEqual({
      frameRateLimit: 45,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 7_500)).toEqual({
      frameRateLimit: 50,
      pressureLevel: 2,
    });
  });

  it("does not reduce low-fps streams until the adaptive ladder is lower than the source", () => {
    const governor = new AdaptiveRenderFrameGovernor();

    governor.recordPressure(1, 100);
    governor.recordPressure(1, 1_400);
    expect(governor.resolveFrameRateLimit(15, undefined, 1_500)).toEqual({
      frameRateLimit: 15,
      pressureLevel: 1,
    });
  });

  it("classifies only non-reference AVC Annex B delta frames as pre-decode droppable", () => {
    expect(isDroppableNonReferenceAvcAnnexBFrame(annexB(0x01, [1, 2, 3]), "avc1.640033")).toBe(true);
    expect(isDroppableNonReferenceAvcAnnexBFrame(annexB(0x21, [1, 2, 3]), "avc1.640033")).toBe(false);
    expect(isDroppableNonReferenceAvcAnnexBFrame(annexB(0x65, [1, 2, 3]), "avc1.640033")).toBe(false);
    expect(isDroppableNonReferenceAvcAnnexBFrame(annexB(0x01, [1, 2, 3]), "hev1.1.6.L120")).toBe(false);
  });

  it("admits reference frames while shedding non-reference frames under render-import pressure", () => {
    const controller = new EncodedFrameAdmissionController();
    controller.recordPresentedFrame({
      renderMs: 30,
      importExternalTextureMs: 30,
      sourceFrameRate: 60,
    });

    expect(controller.decideBeforeDecode({
      keyFrame: true,
      presentationTimestampUs: 0,
      payload: annexB(0x65),
    }, "avc1.640033", 60)).toEqual({ admit: true });
    expect(controller.decideBeforeDecode({
      keyFrame: false,
      presentationTimestampUs: 16_667,
      payload: annexB(0x01),
    }, "avc1.640033", 60)).toEqual({
      admit: false,
      reason: "predecode-nonreference-render-budget",
    });
    expect(controller.decideBeforeDecode({
      keyFrame: false,
      presentationTimestampUs: 33_333,
      payload: annexB(0x21),
    }, "avc1.640033", 60)).toEqual({ admit: true });
    expect(controller.decideBeforeDecode({
      keyFrame: false,
      presentationTimestampUs: 50_000,
      payload: annexB(0x01),
    }, "avc1.640033", 60)).toEqual({
      admit: false,
      reason: "predecode-nonreference-render-budget",
    });
  });

  it("recovers pre-decode admission when render service time returns under source cadence", () => {
    const controller = new EncodedFrameAdmissionController();
    controller.recordPresentedFrame({
      renderMs: 45,
      importExternalTextureMs: 45,
      sourceFrameRate: 60,
    });
    controller.decideBeforeDecode({
      keyFrame: true,
      presentationTimestampUs: 0,
      payload: annexB(0x65),
    }, "avc1.640033", 60);
    expect(controller.decideBeforeDecode({
      keyFrame: false,
      presentationTimestampUs: 16_667,
      payload: annexB(0x01),
    }, "avc1.640033", 60).admit).toBe(false);

    for (let sample = 0; sample < 18; sample += 1) {
      controller.recordPresentedFrame({
        renderMs: 4,
        importExternalTextureMs: 4,
        sourceFrameRate: 60,
      });
    }

    expect(controller.decideBeforeDecode({
      keyFrame: false,
      presentationTimestampUs: 33_333,
      payload: annexB(0x01),
    }, "avc1.640033", 60)).toEqual({ admit: true });
  });

  it("selects a fractional render cadence instead of collapsing to every other frame", () => {
    const cadence = new AdaptiveRenderCadence();
    const selected: number[] = [];

    for (let sequence = 1; sequence <= 30; sequence += 1) {
      const nowMs = ((sequence - 1) * 1_000) / 30;
      if (cadence.shouldRender(sequence, 30, 24, nowMs)) {
        selected.push(sequence);
      }
    }

    expect(selected).toHaveLength(24);
    expect(selected.slice(0, 10)).toEqual([1, 3, 4, 5, 7, 8, 9, 10, 12, 13]);
  });

  it("caps 60 fps sources near 20 fps without catching up skipped frames", () => {
    const cadence = new AdaptiveRenderCadence();
    const selected: number[] = [];

    for (let sequence = 1; sequence <= 60; sequence += 1) {
      const nowMs = ((sequence - 1) * 1_000) / 60;
      if (cadence.shouldRender(sequence, 60, 20, nowMs)) {
        selected.push(sequence);
      }
    }

    expect(selected).toHaveLength(20);
    expect(selected.slice(0, 8)).toEqual([1, 4, 7, 10, 13, 16, 19, 22]);
  });

  it("does not burst render after a stalled source resumes", () => {
    const cadence = new AdaptiveRenderCadence();
    const selected: number[] = [];
    const timesMs = [
      0,
      1_000 / 60,
      2_000 / 60,
      3_000 / 60,
      4_000 / 60,
      1_000,
      1_000 + 1_000 / 60,
      1_000 + 2_000 / 60,
      1_000 + 3_000 / 60,
      1_000 + 4_000 / 60,
    ];

    timesMs.forEach((nowMs, index) => {
      const sequence = index + 1;
      if (cadence.shouldRender(sequence, 60, 20, nowMs)) {
        selected.push(sequence);
      }
    });

    expect(selected).toEqual([1, 4, 6, 9]);
  });
});

function createFrame(sequenceNumber: number): DecodedFramePlan {
  return {
    streamId: "camera-001",
    sequenceNumber,
    presentationTimestampUs: 2_000_000 + sequenceNumber * 16_667,
    width: 1280,
    height: 720,
    decodeBackend: "webcodecs",
  };
}

function annexB(nalHeader: number, body: readonly number[] = [0]): Uint8Array {
  return new Uint8Array([0, 0, 0, 1, nalHeader, ...body]);
}
