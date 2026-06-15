import { describe, expect, it, vi } from "vitest";
import type { DecodedFramePlan } from "../../src/contracts/models";
import {
  AdaptiveRenderCadence,
  AdaptiveRenderFrameGovernor,
  LiveDecodedFrameQueue,
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
import { shouldUseWorkerMediaPipeline } from "../../src/video-pipe/workerMediaPipelineClient";

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

  it("keeps full media-pipeline worker opt-in until benchmarks prove it wins", () => {
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
      frameRateLimit: 50,
      pressureLevel: 1,
    });

    governor.recordPressure(2, 900);
    expect(governor.resolveFrameRateLimit(60, undefined, 1_000)).toEqual({
      frameRateLimit: 30,
      pressureLevel: 3,
    });

    expect(governor.resolveFrameRateLimit(60, undefined, 3_800)).toEqual({
      frameRateLimit: 30,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 4_100)).toEqual({
      frameRateLimit: 30,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 15_800)).toEqual({
      frameRateLimit: 30,
      pressureLevel: 3,
    });
    expect(governor.resolveFrameRateLimit(60, undefined, 15_950)).toEqual({
      frameRateLimit: 45,
      pressureLevel: 2,
    });
  });

  it("does not reduce low-fps streams until the adaptive ladder is lower than the source", () => {
    const governor = new AdaptiveRenderFrameGovernor();

    governor.recordPressure(1, 100);
    governor.recordPressure(1, 1_400);
    expect(governor.resolveFrameRateLimit(15, undefined, 1_500)).toEqual({
      frameRateLimit: 15,
      pressureLevel: 2,
    });
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
