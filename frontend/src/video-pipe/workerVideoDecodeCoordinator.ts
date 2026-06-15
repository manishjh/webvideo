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

type PendingRequest = {
  resolve: (value?: DecodedFramePlan[]) => void;
  reject: (error: Error) => void;
};

export interface LiveVideoDecoder {
  decodePipeline: "main-thread" | "worker";
  configureDecoder: (configuration: VideoCodecConfiguration) => Promise<void>;
  enqueueChunk: (chunk: EncodedChunkEmission) => Promise<void>;
  flush: (waitForDrain?: boolean) => Promise<DecodedFramePlan[]>;
  drainDecodedFrames: () => DecodedFramePlan[];
  liveBacklogFrameCount: () => number;
  dispose: () => void;
}

export function shouldUseWorkerVideoDecoder(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return false;
  }

  const mode = new URLSearchParams(window.location.search).get("decodeWorker")?.toLowerCase();
  return ["1", "true", "on", "worker"].includes(mode ?? "");
}

export class WorkerVideoDecodeCoordinator implements LiveVideoDecoder {
  public readonly decodePipeline = "worker" as const;
  private readonly worker: Worker;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly decodedFrames: DecodedFramePlan[] = [];
  private nextRequestId = 0;
  private disposed = false;
  private backlogFrameCount = 0;
  private locallyQueuedChunks = 0;
  private failure?: Error;
  private readonly onDecodedFramesAvailable?: () => void;

  public constructor(onDecodedFramesAvailable?: () => void) {
    this.onDecodedFramesAvailable = onDecodedFramesAvailable;
    this.worker = new Worker(new URL("./videoDecodeWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleResponse(event.data);
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "Worker VideoDecoder failed."));
    };
    this.worker.onmessageerror = () => {
      this.fail(new Error("Worker VideoDecoder returned an unreadable message."));
    };
  }

  public async configureDecoder(configuration: VideoCodecConfiguration): Promise<void> {
    await this.request({ type: "configure", id: 0, configuration });
  }

  public enqueueChunk(chunk: EncodedChunkEmission): Promise<void> {
    this.throwIfFailed();
    const payload = copyBytes(chunk.payload);
    const request: WorkerRequest = {
      type: "enqueue",
      id: this.createRequestId(),
      chunk: {
        ...chunk,
        payload,
      },
    };
    this.locallyQueuedChunks += 1;
    this.worker.postMessage(request, [payload.buffer]);
    return Promise.resolve();
  }

  public async flush(waitForDrain = true): Promise<DecodedFramePlan[]> {
    const existingFrames = this.drainDecodedFrames();
    const frames = await this.request({
      type: "flush",
      id: 0,
      waitForDrain,
    });
    return [...existingFrames, ...(frames ?? [])];
  }

  public drainDecodedFrames(): DecodedFramePlan[] {
    this.throwIfFailed();
    const frames = [...this.decodedFrames];
    this.decodedFrames.length = 0;
    return frames;
  }

  public liveBacklogFrameCount(): number {
    return this.backlogFrameCount + this.decodedFrames.length + this.locallyQueuedChunks;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    closeDecodedFrames(this.decodedFrames.splice(0));
    this.pendingRequests.clear();
    try {
      this.worker.postMessage({
        type: "dispose",
        id: this.createRequestId(),
      } satisfies WorkerRequest);
    } catch {
      // The worker may already be gone after a decode failure.
    }
    this.worker.terminate();
  }

  private async request(request: WorkerRequest): Promise<DecodedFramePlan[] | undefined> {
    this.throwIfFailed();
    const id = this.createRequestId();
    const nextRequest = {
      ...request,
      id,
    } as WorkerRequest;
    return await new Promise<DecodedFramePlan[] | undefined>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker.postMessage(nextRequest);
    });
  }

  private handleResponse(response: WorkerResponse): void {
    if (response.type === "decoded") {
      this.backlogFrameCount = response.backlogFrameCount;
      this.locallyQueuedChunks = 0;
      this.decodedFrames.push(...response.frames);
      this.onDecodedFramesAvailable?.();
      return;
    }

    if (response.type === "error") {
      this.fail(new Error(response.message), response.id);
      return;
    }

    if (response.type === "enqueued") {
      this.backlogFrameCount = response.backlogFrameCount;
      this.locallyQueuedChunks = Math.max(0, this.locallyQueuedChunks - 1);
      return;
    }

    if (response.type === "configured") {
      this.backlogFrameCount = response.backlogFrameCount;
      this.resolvePending(response.id);
      return;
    }

    if (response.type === "flushed") {
      this.backlogFrameCount = response.backlogFrameCount;
      this.locallyQueuedChunks = 0;
      if (response.frames.length > 0) {
        this.onDecodedFramesAvailable?.();
      }
      this.resolvePending(response.id, response.frames);
      return;
    }

    this.resolvePending(response.id);
  }

  private resolvePending(id: number, frames?: DecodedFramePlan[]): void {
    const pending = this.pendingRequests.get(id);
    this.pendingRequests.delete(id);
    pending?.resolve(frames);
  }

  private fail(error: Error, requestId?: number): void {
    this.failure = error;
    if (requestId !== undefined) {
      const pending = this.pendingRequests.get(requestId);
      this.pendingRequests.delete(requestId);
      pending?.reject(error);
      return;
    }

    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      pending.reject(error);
    }
  }

  private throwIfFailed(): void {
    if (this.failure) {
      throw this.failure;
    }

    if (this.disposed) {
      throw new Error("Worker VideoDecoder has been disposed.");
    }
  }

  private createRequestId(): number {
    this.nextRequestId += 1;
    return this.nextRequestId;
  }
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function closeDecodedFrames(frames: DecodedFramePlan[]): void {
  for (const frame of frames) {
    (frame.videoFrame as { close?: () => void } | undefined)?.close?.();
  }
}
