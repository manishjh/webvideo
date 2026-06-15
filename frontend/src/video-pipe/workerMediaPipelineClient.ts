import type {
  BrowserTransportMode,
  DecodedFramePlan,
  MetadataTransportMessage,
  SelectedVideoSourceDescriptor,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
} from "../contracts/models";

export type WorkerMediaPipelineMode = "main-thread" | "media-worker";

export type WorkerFrameMetadata = {
  sequenceNumber: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
};

export type WorkerDecodedFrameEnvelope = {
  frame: DecodedFramePlan;
  metadata?: WorkerFrameMetadata;
  receivedAtUnixTimeMs?: number;
};

export type WorkerMediaPipelineEvent =
  | {
    type: "connected";
    activeTransport: BrowserTransportMode;
    webTransportReady: boolean;
    transportMs: number;
  }
  | {
    type: "source";
    source: SelectedVideoSourceDescriptor;
  }
  | {
    type: "metadata";
    message: MetadataTransportMessage;
  }
  | {
    type: "decoded";
    frames: WorkerDecodedFrameEnvelope[];
    bytesReceived: number;
    messagesReceived: number;
    decodeMs: number;
    backlogFrameCount: number;
  }
  | {
    type: "drop";
    count: number;
    reason: string;
    lastMessageAtUnixTimeMs?: number;
  }
  | {
    type: "sequence-gap";
    gapFrameCount: number;
  }
  | {
    type: "end";
    bytesReceived: number;
    messagesReceived: number;
  };

type WorkerRequest =
  | {
    type: "start";
    endpoint: TransportEndpointDescriptor;
    initialCodec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
    targetLatencyMs: number;
  }
  | { type: "stop" };

type WorkerResponse = WorkerMediaPipelineEvent | { type: "error"; message: string };

export function shouldUseWorkerMediaPipeline(): boolean {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return false;
  }

  const mode = new URLSearchParams(window.location.search).get("mediaWorker")?.toLowerCase();
  return ["1", "true", "on", "worker"].includes(mode ?? "");
}

export class WorkerMediaPipelineClient {
  public readonly pipelineMode = "media-worker" as const;
  private readonly worker: Worker;
  private disposed = false;
  private complete?: {
    resolve: () => void;
    reject: (error: Error) => void;
  };

  public constructor(private readonly onEvent: (event: WorkerMediaPipelineEvent) => void) {
    this.worker = new Worker(new URL("./mediaPipelineWorker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event) => {
      this.fail(new Error(event.message || "Media pipeline worker failed."));
    };
    this.worker.onmessageerror = () => {
      this.fail(new Error("Media pipeline worker returned an unreadable message."));
    };
  }

  public start(
    endpoint: TransportEndpointDescriptor,
    initialCodec: VideoCodecConfiguration & { profile?: string; frameRate?: number },
    targetLatencyMs: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Media pipeline worker has been disposed."));
    }

    const abort = (): void => {
      this.dispose();
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    return new Promise<void>((resolve, reject) => {
      this.complete = {
        resolve: () => {
          abortSignal.removeEventListener("abort", abort);
          resolve();
        },
        reject: (error) => {
          abortSignal.removeEventListener("abort", abort);
          reject(error);
        },
      };
      this.worker.postMessage({
        type: "start",
        endpoint,
        initialCodec,
        targetLatencyMs,
      } satisfies WorkerRequest);
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    try {
      this.worker.postMessage({ type: "stop" } satisfies WorkerRequest);
    } catch {
      // The worker can already be gone after a decode or transport failure.
    }
    this.worker.terminate();
    this.complete?.resolve();
    this.complete = undefined;
  }

  private handleMessage(message: WorkerResponse): void {
    if (message.type === "error") {
      this.fail(new Error(message.message));
      return;
    }

    this.onEvent(message);
    if (message.type === "end") {
      this.complete?.resolve();
      this.complete = undefined;
    }
  }

  private fail(error: Error): void {
    this.complete?.reject(error);
    this.complete = undefined;
  }
}
