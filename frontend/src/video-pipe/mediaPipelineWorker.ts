import {
  EncodedChunkAssembler,
  VideoDecodeCoordinator,
  WebTransportIngestClient,
} from "../contracts/services";
import type {
  DecodedFramePlan,
  MetadataTransportMessage,
  SelectedVideoSourceDescriptor,
  TransportEndpointDescriptor,
  TransportConnectionHandle,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../contracts/models";

type WorkerRequest =
  | {
    type: "start";
    endpoint: TransportEndpointDescriptor;
    initialCodec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
    targetLatencyMs: number;
  }
  | { type: "stop" };

type FrameMetadata = {
  sequenceNumber: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
};

type DecodedFrameEnvelope = {
  frame: DecodedFramePlan;
  metadata?: FrameMetadata;
  receivedAtUnixTimeMs?: number;
};

type WorkerResponse =
  | {
    type: "connected";
    activeTransport: "webtransport-quic" | "http-seeded-fallback";
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
    frames: DecodedFrameEnvelope[];
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
  }
  | {
    type: "error";
    message: string;
  };

let abortController: AbortController | undefined;
const DrainPollAttemptsAfterEnqueue = 16;

function post(response: WorkerResponse, transfer: Transferable[] = []): void {
  (globalThis as unknown as Worker).postMessage(response, transfer);
}

function collectTransferables(frames: readonly DecodedFrameEnvelope[]): Transferable[] {
  const transferables: Transferable[] = [];
  for (const envelope of frames) {
    const frame = envelope.frame.videoFrame;
    if (frame && typeof frame === "object") {
      transferables.push(frame as Transferable);
    }
  }

  return transferables;
}

async function runPipeline(request: Extract<WorkerRequest, { type: "start" }>, abortSignal: AbortSignal): Promise<void> {
  const transport = new WebTransportIngestClient();
  const transportStart = performance.now();
  let connection: TransportConnectionHandle | undefined;

  let activeCodec = request.initialCodec;
  let activeSourceFrameRate = activeCodec.frameRate;
  let assembler = new EncodedChunkAssembler();
  let decoder = new VideoDecodeCoordinator();
  let waitingForKeyFrame = true;
  let lastDecodedSequenceNumber: number | undefined;
  let lastReceivedVideoSequenceNumber: number | undefined;
  const pendingMetadataBySequence = new Map<number, FrameMetadata>();
  const pendingReceiveTimesBySequence = new Map<number, number>();
  let drainScheduled = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let drainPollAttemptsRemaining = 0;
  let pendingDecodeMs = 0;

  const clearScheduledDrain = (): void => {
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }

    drainScheduled = false;
    drainPollAttemptsRemaining = 0;
    pendingDecodeMs = 0;
  };

  const resetDecodeState = async (): Promise<void> => {
    clearScheduledDrain();
    decoder.dispose();
    assembler = new EncodedChunkAssembler();
    decoder = new VideoDecodeCoordinator();
    await decoder.configureDecoder(activeCodec);
    waitingForKeyFrame = true;
    pendingMetadataBySequence.clear();
    pendingReceiveTimesBySequence.clear();
  };

  const drainDecoded = (decodeMs: number): number => {
    if (!connection) {
      return 0;
    }

    const frames = decoder.drainDecodedFrames();
    if (frames.length === 0) {
      return 0;
    }

    const envelopes = frames.map((frame) => {
      const metadata = pendingMetadataBySequence.get(frame.sequenceNumber);
      const receivedAtUnixTimeMs = pendingReceiveTimesBySequence.get(frame.sequenceNumber);
      pendingMetadataBySequence.delete(frame.sequenceNumber);
      pendingReceiveTimesBySequence.delete(frame.sequenceNumber);
      return {
        frame,
        metadata,
        receivedAtUnixTimeMs,
      } satisfies DecodedFrameEnvelope;
    });
    post({
      type: "decoded",
      frames: envelopes,
      bytesReceived: connection.webTransportBytesReceived,
      messagesReceived: connection.webTransportMessagesReceived,
      decodeMs,
      backlogFrameCount: decoder.liveBacklogFrameCount(),
    }, collectTransferables(envelopes));
    return frames.length;
  };

  const scheduleDrain = (decodeMs = 0, extraPollAttempts = 0): void => {
    pendingDecodeMs = Math.max(pendingDecodeMs, decodeMs);
    drainPollAttemptsRemaining = Math.max(drainPollAttemptsRemaining, extraPollAttempts);
    if (drainScheduled) {
      return;
    }

    drainScheduled = true;
    drainTimer = setTimeout(() => {
      drainScheduled = false;
      drainTimer = undefined;
      try {
        const decodedFrameCount = drainDecoded(pendingDecodeMs);
        if (decodedFrameCount > 0) {
          pendingDecodeMs = 0;
        }
        const backlogFrameCount = decoder.liveBacklogFrameCount();
        if (backlogFrameCount === 0 && decodedFrameCount === 0 && drainPollAttemptsRemaining > 0) {
          drainPollAttemptsRemaining -= 1;
        } else if (backlogFrameCount === 0 && decodedFrameCount > 0) {
          drainPollAttemptsRemaining = 0;
        }

        if (backlogFrameCount > 0 || (decodedFrameCount === 0 && drainPollAttemptsRemaining > 0)) {
          scheduleDrain();
        }
      } catch {
        pendingDecodeMs = 0;
        void resetDecodeState().then(() => {
          post({
            type: "drop",
            count: 1,
            reason: "decode-error-reset",
          });
        }).catch((error: unknown) => {
          post({
            type: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }, 0);
  };

  try {
    connection = await transport.connectStreaming(request.endpoint, abortSignal);
    post({
      type: "connected",
      activeTransport: connection.activeTransport,
      webTransportReady: connection.webTransportReady,
      transportMs: performance.now() - transportStart,
    });

    await decoder.configureDecoder(activeCodec);

    for await (const frame of transport.readStreamingFrames(connection, abortSignal)) {
      abortSignal.throwIfAborted();
      connection.webTransportBytesReceived = frame.bytesReceived;
      connection.webTransportMessagesReceived = frame.messagesReceived;

      if (frame.kind === "end") {
        post({
          type: "end",
          bytesReceived: frame.bytesReceived,
          messagesReceived: frame.messagesReceived,
        });
        return;
      }

      if (frame.kind === "source") {
        activeCodec = {
          ...activeCodec,
          codec: frame.source.codec.codec,
          codedWidth: frame.source.codec.codedWidth,
          codedHeight: frame.source.codec.codedHeight,
          description: frame.source.codec.description,
          profile: frame.source.codec.profile,
          frameRate: frame.source.codec.frameRate,
        };
        activeSourceFrameRate = frame.source.codec.frameRate;
        await resetDecodeState();
        post({ type: "source", source: frame.source });
        continue;
      }

      if (frame.kind === "metadata") {
        post({ type: "metadata", message: frame.message });
        continue;
      }

      const message = frame.message;
      const frameAgeMs = Date.now() - (message.sourceTimestampUnixTimeMs ?? message.serverTimestampUnixTimeMs ?? Date.now());
      if (!message.keyFrame && frameAgeMs > liveDropThresholdMs(request.targetLatencyMs)) {
        waitingForKeyFrame = true;
        post({
          type: "drop",
          count: 1,
          reason: "stale-before-decode",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
        continue;
      }

      if (lastReceivedVideoSequenceNumber !== undefined && message.sequenceNumber > lastReceivedVideoSequenceNumber + 1) {
        post({
          type: "sequence-gap",
          gapFrameCount: message.sequenceNumber - lastReceivedVideoSequenceNumber - 1,
        });
      }
      lastReceivedVideoSequenceNumber = message.sequenceNumber;

      const hasSequenceGap = lastDecodedSequenceNumber !== undefined
        && message.sequenceNumber !== lastDecodedSequenceNumber + 1;
      if ((waitingForKeyFrame || hasSequenceGap) && !message.keyFrame) {
        waitingForKeyFrame = true;
        post({
          type: "drop",
          count: 1,
          reason: "waiting-for-keyframe",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
        continue;
      }

      if ((waitingForKeyFrame || hasSequenceGap) && message.keyFrame) {
        await resetDecodeState();
        waitingForKeyFrame = false;
      }

      const decodeStart = performance.now();
      try {
        if (decoder.liveBacklogFrameCount() > hardMaxLiveDecodeBacklogFrames(activeSourceFrameRate)) {
          await resetDecodeState();
          post({
            type: "drop",
            count: 1,
            reason: "decode-backlog-reset",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
          if (!message.keyFrame) {
            continue;
          }

          waitingForKeyFrame = false;
        }

        pendingMetadataBySequence.set(message.sequenceNumber, toFrameMetadata(message));
        pendingReceiveTimesBySequence.set(message.sequenceNumber, frame.receivedAtUnixTimeMs);
        const chunks = await assembler.applyTransportMessage(message);
        for (const chunk of chunks) {
          await decoder.enqueueChunk(chunk);
        }
        scheduleDrain(performance.now() - decodeStart, DrainPollAttemptsAfterEnqueue);
        lastDecodedSequenceNumber = message.sequenceNumber;
      } catch {
        await resetDecodeState();
        post({
          type: "drop",
          count: 1,
          reason: "decode-error-reset",
          lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
        });
      }
    }
  } finally {
    clearScheduledDrain();
    decoder.dispose();
    if (connection) {
      await transport.closeConnection(connection);
    }
  }
}

function toFrameMetadata(message: VideoTransportMessage): FrameMetadata {
  return {
    sequenceNumber: message.sequenceNumber,
    sourceTimestampUnixTimeMs: message.sourceTimestampUnixTimeMs,
    serverTimestampUnixTimeMs: message.serverTimestampUnixTimeMs,
    moqTrackAlias: message.moqTrackAlias,
    moqGroupId: message.moqGroupId,
    moqObjectId: message.moqObjectId,
    moqSubgroupId: message.moqSubgroupId,
    moqPublisherPriority: message.moqPublisherPriority,
  };
}

function liveDropThresholdMs(targetLatencyMs: number): number {
  return Math.max(500, targetLatencyMs * 3);
}

function hardMaxLiveDecodeBacklogFrames(frameRate: number | undefined): number {
  if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0) {
    return 36;
  }

  return Math.max(36, Math.ceil(frameRate * 0.75));
}

(globalThis as unknown as Worker).onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === "stop") {
    abortController?.abort();
    return;
  }

  abortController?.abort();
  abortController = new AbortController();
  void runPipeline(event.data, abortController.signal).catch((error: unknown) => {
    if (!abortController?.signal.aborted) {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
