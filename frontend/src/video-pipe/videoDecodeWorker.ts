import { VideoDecodeCoordinator } from "../contracts/services";
import type {
  DecodedFramePlan,
  EncodedChunkEmission,
  VideoCodecConfiguration,
} from "../contracts/models";

type WorkerRequest =
  | { type: "configure"; id: number; configuration: VideoCodecConfiguration }
  | { type: "enqueue"; id: number; chunk: EncodedChunkEmission }
  | { type: "flush"; id: number; waitForDrain: boolean }
  | { type: "dispose"; id: number };

type WorkerResponse =
  | { type: "configured"; id: number; backlogFrameCount: number }
  | { type: "enqueued"; id: number; backlogFrameCount: number }
  | { type: "decoded"; frames: DecodedFramePlan[]; backlogFrameCount: number }
  | { type: "flushed"; id: number; frames: DecodedFramePlan[]; backlogFrameCount: number }
  | { type: "disposed"; id: number }
  | { type: "error"; id?: number; message: string };

let decoder = new VideoDecodeCoordinator();
let drainScheduled = false;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
let drainPollAttemptsRemaining = 0;

const DrainPollAttemptsAfterEnqueue = 16;

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  (globalThis as unknown as Worker).postMessage(response, transfer);
}

function collectTransferables(frames: readonly DecodedFramePlan[]): Transferable[] {
  const transferables: Transferable[] = [];
  for (const frame of frames) {
    if (frame.videoFrame && typeof frame.videoFrame === "object") {
      transferables.push(frame.videoFrame as Transferable);
    }
  }

  return transferables;
}

function postDecodedFrames(frames: DecodedFramePlan[], backlogFrameCount: number): void {
  if (frames.length === 0) {
    return;
  }

  post(
    {
      type: "decoded",
      frames,
      backlogFrameCount,
    },
    collectTransferables(frames),
  );
}

function scheduleDrain(extraPollAttempts = 0): void {
  drainPollAttemptsRemaining = Math.max(drainPollAttemptsRemaining, extraPollAttempts);
  if (drainScheduled) {
    return;
  }

  drainScheduled = true;
  drainTimer = setTimeout(() => {
    drainScheduled = false;
    drainTimer = undefined;
    const drainedFrameCount = drainDecodedFrames();
    if (decoder.liveBacklogFrameCount() === 0 && drainPollAttemptsRemaining > 0) {
      drainPollAttemptsRemaining -= 1;
    }

    if (decoder.liveBacklogFrameCount() > 0 || drainPollAttemptsRemaining > 0 || drainedFrameCount > 0) {
      scheduleDrain();
    }
  }, 0);
}

function drainDecodedFrames(): number {
  const frames = decoder.drainDecodedFrames();
  postDecodedFrames(frames, decoder.liveBacklogFrameCount());
  return frames.length;
}

function resetDecoder(): void {
  if (drainTimer !== undefined) {
    clearTimeout(drainTimer);
    drainTimer = undefined;
  }

  drainScheduled = false;
  drainPollAttemptsRemaining = 0;
  decoder.dispose();
  decoder = new VideoDecodeCoordinator();
}

async function handleRequest(request: WorkerRequest): Promise<void> {
  if (request.type === "configure") {
    resetDecoder();
    await decoder.configureDecoder(request.configuration);
    post({
      type: "configured",
      id: request.id,
      backlogFrameCount: decoder.liveBacklogFrameCount(),
    });
    return;
  }

  if (request.type === "enqueue") {
    await decoder.enqueueChunk(request.chunk);
    post({
      type: "enqueued",
      id: request.id,
      backlogFrameCount: decoder.liveBacklogFrameCount(),
    });
    scheduleDrain(DrainPollAttemptsAfterEnqueue);
    return;
  }

  if (request.type === "flush") {
    const frames = await decoder.flush(request.waitForDrain);
    post(
      {
        type: "flushed",
        id: request.id,
        frames,
        backlogFrameCount: decoder.liveBacklogFrameCount(),
      },
      collectTransferables(frames),
    );
    return;
  }

  resetDecoder();
  post({ type: "disposed", id: request.id });
}

(globalThis as unknown as Worker).onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handleRequest(event.data).catch((error: unknown) => {
    post({
      type: "error",
      id: event.data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  });
};
