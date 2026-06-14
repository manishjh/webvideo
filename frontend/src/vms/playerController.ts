import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PresentationScheduler,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebTransportIngestClient,
} from "../contracts/services";
import type {
  BrowserTransportMode,
  DecodedFramePlan,
  MetadataTransportMessage,
  RenderBackend,
  TimedMetadataBatch,
  TransportConnectionHandle,
  VideoTransportMessage,
} from "../contracts/models";
import type { BrowserDemoChannelSummary } from "../testing/browserDemoApi";
import {
  addSample,
  createMetricSnapshot,
  createVmsCounterState,
  recordRenderedFrame,
  recordSequenceGap,
  type VmsCounterState,
  type VmsMetricSnapshot,
} from "./metrics";

export type VmsTileStatus = "starting" | "playing" | "holding" | "stopping" | "stopped" | "error";

export interface VmsTileControllerOptions {
  tileId: string;
  channel: BrowserDemoChannelSummary;
  canvasId: string;
  authToken: string;
  serverCertificateHash?: string;
  batchFrameCount: number;
  targetBatches?: number;
  targetLatencyMs: number;
  onState: (state: VmsTileRuntimeState) => void;
}

export interface VmsTileRuntimeState {
  tileId: string;
  channelId: string;
  streamId: string;
  displayName: string;
  status: VmsTileStatus;
  activeTransport?: BrowserTransportMode;
  decodeBackend?: string;
  renderBackend?: RenderBackend;
  sourceRtspUrl: string;
  sourceVerified: boolean;
  sourceFrameRate?: number;
  width: number;
  height: number;
  lastSequenceNumber?: number;
  lastMoqTrackAlias?: number;
  lastMoqGroupId?: number;
  lastMoqObjectId?: number;
  lastMoqSubgroupId?: number;
  lastMoqPublisherPriority?: number;
  streamMode?: string;
  connectionOpenCount: number;
  protocolEndFrameCount: number;
  lastMessageAtUnixTimeMs?: number;
  lastFrameAtUnixTimeMs?: number;
  gpuPresentation?: string;
  gpuUploadSource?: string;
  gpuAdapterVendor?: string;
  gpuAdapterArchitecture?: string;
  gpuReadbackError?: string;
  webGpuDisabledReason?: string;
  batchFrameCount: number;
  error?: string;
  metrics: VmsMetricSnapshot;
}

export class VmsTileController {
  private readonly options: VmsTileControllerOptions;
  private readonly counters: VmsCounterState;
  private readonly renderer = new WebGpuRenderer();
  private readonly scheduler = new PresentationScheduler();
  private readonly metadataStore = new OverlayTimelineStore();
  private abortController?: AbortController;
  private running = false;
  private configured = false;
  private state: VmsTileRuntimeState;
  private lastStateEmitAtMs = 0;
  private stateEmitTimer?: ReturnType<typeof setTimeout>;

  public constructor(options: VmsTileControllerOptions) {
    this.options = options;
    this.counters = createVmsCounterState(performance.now());
    this.state = {
      tileId: options.tileId,
      channelId: options.channel.channelId,
      streamId: options.channel.streamId,
      displayName: options.channel.displayName,
      status: "starting",
      sourceRtspUrl: options.channel.sourceRtspUrl,
      sourceVerified: false,
      sourceFrameRate: options.channel.codec.frameRate,
      width: options.channel.codec.codedWidth,
      height: options.channel.codec.codedHeight,
      connectionOpenCount: 0,
      protocolEndFrameCount: 0,
      batchFrameCount: options.batchFrameCount,
      metrics: createMetricSnapshot(this.counters, performance.now()),
    };
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.emit({ status: "starting" }, true);
    void this.runLoop(this.abortController.signal);
  }

  public stop(): void {
    if (!this.running && this.state.status === "stopped") {
      return;
    }

    this.running = false;
    this.emit({ status: "stopping" }, true);
    this.abortController?.abort();
    this.renderer.dispose();
    this.emit({ status: "stopped" }, true);
  }

  private async runLoop(abortSignal: AbortSignal): Promise<void> {
    try {
      await this.configureRenderer();
      await this.runContinuousSession(abortSignal);
    } catch (error) {
      if (abortSignal.aborted || !this.running) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.running = false;
      this.renderer.dispose();
      this.emit({ status: "error", error: message }, true);
    }
  }

  private async configureRenderer(): Promise<void> {
    if (this.configured) {
      return;
    }

    await this.renderer.configureSurface({
      canvasId: this.options.canvasId,
      canvasWidth: this.options.channel.codec.codedWidth,
      canvasHeight: this.options.channel.codec.codedHeight,
      outputColorSpace: "srgb",
    });
    this.configured = true;
  }

  private async runContinuousSession(abortSignal: AbortSignal): Promise<void> {
    const transport = new WebTransportIngestClient();
    let connection;
    const transportStart = performance.now();
    try {
      connection = await transport.connectStreaming({
        channelId: this.options.channel.channelId,
        streamId: this.options.channel.streamId,
        webTransportUrl: this.createWebTransportUrl(),
        authToken: this.options.authToken,
        metadataChannelRequired: true,
        requestedTransport: "webtransport-quic",
        allowHttpFallback: false,
        serverCertificateHash: this.options.serverCertificateHash,
        streamMode: "continuous-moq",
      }, abortSignal);
      addSample(this.counters.transportMs, performance.now() - transportStart);
      this.emit({
        status: "playing",
        activeTransport: connection.activeTransport,
        sourceVerified: connection.webTransportReady,
        streamMode: "continuous-moq",
        connectionOpenCount: this.state.connectionOpenCount + 1,
      }, true);

      await this.decodeAndRenderStream(transport, connection, abortSignal);
    } finally {
      if (connection) {
        await transport.closeConnection(connection);
      }
    }
  }

  private async decodeAndRenderStream(
    transport: WebTransportIngestClient,
    connection: TransportConnectionHandle,
    abortSignal: AbortSignal,
  ): Promise<void> {
    let assembler = new EncodedChunkAssembler();
    let decoder = await this.createConfiguredDecoder();
    let lastDecodedSequenceNumber: number | undefined;
    let lastReceivedVideoSequenceNumber: number | undefined;
    let waitingForKeyFrame = false;
    const pendingVideoMessages = new Map<number, VideoTransportMessage>();
    const pendingReceiveTimesBySequence = new Map<number, number>();

    try {
      for await (const frame of transport.readStreamingFrames(connection, abortSignal)) {
        abortSignal.throwIfAborted();
        this.counters.bytesReceived = frame.bytesReceived;
        this.counters.messagesReceived = frame.messagesReceived;

        if (frame.kind === "end") {
          this.emit({
            protocolEndFrameCount: this.state.protocolEndFrameCount + 1,
            lastMessageAtUnixTimeMs: Date.now(),
          });
          return;
        }

        if (frame.kind === "metadata") {
          await this.metadataStore.ingestBatch(toTimedMetadataBatch(frame.message));
          this.emit({ lastMessageAtUnixTimeMs: Date.now() });
          continue;
        }

        const message = frame.message;
        if (lastReceivedVideoSequenceNumber !== undefined && message.sequenceNumber > lastReceivedVideoSequenceNumber + 1) {
          recordSequenceGap(this.counters, message.sequenceNumber - lastReceivedVideoSequenceNumber - 1);
        }
        lastReceivedVideoSequenceNumber = message.sequenceNumber;

        const hasSequenceGap = lastDecodedSequenceNumber !== undefined
          && message.sequenceNumber !== lastDecodedSequenceNumber + 1;
        if ((waitingForKeyFrame || hasSequenceGap) && !message.keyFrame) {
          waitingForKeyFrame = true;
          this.counters.framesDropped += 1;
          this.emit({
            status: "holding",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
          continue;
        }

        if ((waitingForKeyFrame || hasSequenceGap) && message.keyFrame) {
          decoder.dispose();
          assembler = new EncodedChunkAssembler();
          decoder = await this.createConfiguredDecoder();
          waitingForKeyFrame = false;
          pendingVideoMessages.clear();
          pendingReceiveTimesBySequence.clear();
        }

        const decodeStart = performance.now();
        try {
          pendingVideoMessages.set(message.sequenceNumber, message);
          pendingReceiveTimesBySequence.set(message.sequenceNumber, frame.receivedAtUnixTimeMs);
          const chunks = await assembler.applyTransportMessage(message);
          for (const chunk of chunks) {
            await decoder.enqueueChunk(chunk);
          }

          const frames = await decoder.flush(false);
          addSample(this.counters.decodeMs, performance.now() - decodeStart);
          await this.renderFrames(frames, pendingVideoMessages, pendingReceiveTimesBySequence, abortSignal);
          for (const decodedFrame of frames) {
            pendingVideoMessages.delete(decodedFrame.sequenceNumber);
            pendingReceiveTimesBySequence.delete(decodedFrame.sequenceNumber);
          }

          lastDecodedSequenceNumber = message.sequenceNumber;
        } catch {
          decoder.dispose();
          assembler = new EncodedChunkAssembler();
          decoder = await this.createConfiguredDecoder();
          waitingForKeyFrame = true;
          pendingVideoMessages.clear();
          pendingReceiveTimesBySequence.clear();
          this.counters.framesDropped += 1;
          this.emit({
            status: "holding",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
        }
      }
    } finally {
      decoder.dispose();
    }
  }

  private async createConfiguredDecoder(): Promise<VideoDecodeCoordinator> {
    const decoder = new VideoDecodeCoordinator();
    await decoder.configureDecoder(this.options.channel.codec);
    return decoder;
  }

  private async renderFrames(
    frames: DecodedFramePlan[],
    messageBySequenceNumber: ReadonlyMap<number, VideoTransportMessage>,
    receiveTimeBySequenceNumber: ReadonlyMap<number, number>,
    abortSignal: AbortSignal,
  ): Promise<void> {
    for (const frame of frames) {
      abortSignal.throwIfAborted();
      await this.scheduler.handleClockUpdate({
        streamId: frame.streamId,
        mediaTimestampUs: frame.presentationTimestampUs - 20_000,
        monotonicNowMs: performance.now(),
        clockSkewMs: 0,
      });

      const activeMetadata = await this.metadataStore.queryActiveMetadata(frame.streamId, frame.presentationTimestampUs);
      const decision = await this.scheduler.scheduleFrame(frame, activeMetadata);
      if (!decision.shouldRender) {
        this.counters.framesDropped += 1;
        closeDecodedFrame(frame);
        continue;
      }

      const renderStart = performance.now();
      const renderResult = await this.renderer.renderFrame({
        sessionId: this.options.tileId,
        frame,
        activeMetadata,
        debugOverlayEnabled: false,
      });
      const renderEnded = performance.now();
      const message = messageBySequenceNumber.get(frame.sequenceNumber);
      const receivedAtUnixTimeMs = receiveTimeBySequenceNumber.get(frame.sequenceNumber);
      const renderedAtUnixTimeMs = Date.now();
      const serverTimestampUnixTimeMs = message?.serverTimestampUnixTimeMs ?? renderedAtUnixTimeMs;

      addSample(this.counters.renderMs, renderEnded - renderStart);
      addSample(this.counters.sourceToRenderMs, renderedAtUnixTimeMs - (message?.sourceTimestampUnixTimeMs ?? serverTimestampUnixTimeMs));
      addSample(this.counters.serverToRenderMs, renderedAtUnixTimeMs - serverTimestampUnixTimeMs);
      addSample(this.counters.receiveToRenderMs, renderedAtUnixTimeMs - (receivedAtUnixTimeMs ?? renderedAtUnixTimeMs));
      recordRenderedFrame(this.counters, renderEnded, expectedFrameIntervalMs(this.options.channel.codec.frameRate));
      this.emit({
        status: "playing",
        decodeBackend: frame.decodeBackend,
        renderBackend: renderResult.renderBackend,
        lastSequenceNumber: frame.sequenceNumber,
        lastMoqTrackAlias: message?.moqTrackAlias,
        lastMoqGroupId: message?.moqGroupId,
        lastMoqObjectId: message?.moqObjectId,
        lastMoqSubgroupId: message?.moqSubgroupId,
        lastMoqPublisherPriority: message?.moqPublisherPriority,
        lastMessageAtUnixTimeMs: message?.serverTimestampUnixTimeMs,
        lastFrameAtUnixTimeMs: renderedAtUnixTimeMs,
        gpuPresentation: renderResult.gpuPresentation,
        gpuUploadSource: renderResult.gpuUploadSource,
        gpuAdapterVendor: renderResult.gpuAdapterVendor,
        gpuAdapterArchitecture: renderResult.gpuAdapterArchitecture,
        gpuReadbackError: renderResult.gpuReadbackError,
        webGpuDisabledReason: renderResult.webGpuDisabledReason,
      });
    }
  }

  private createWebTransportUrl(): string {
    return `https://127.0.0.1:9443/live/${encodeURIComponent(this.options.channel.channelId)}`;
  }

  private emit(patch: Partial<VmsTileRuntimeState>, immediate = false): void {
    this.state = {
      ...this.state,
      ...patch,
      metrics: createMetricSnapshot(this.counters, performance.now()),
    };

    const nowMs = performance.now();
    if (immediate || nowMs - this.lastStateEmitAtMs >= 100) {
      this.publishState(nowMs);
      return;
    }

    if (this.stateEmitTimer === undefined) {
      this.stateEmitTimer = setTimeout(() => {
        this.stateEmitTimer = undefined;
        this.publishState(performance.now());
      }, Math.max(0, 100 - (nowMs - this.lastStateEmitAtMs)));
    }
  }

  private publishState(nowMs: number): void {
    if (this.stateEmitTimer !== undefined) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = undefined;
    }

    this.lastStateEmitAtMs = nowMs;
    this.options.onState(this.state);
  }
}

function expectedFrameIntervalMs(frameRate: number | undefined): number | undefined {
  return frameRate !== undefined && frameRate > 0 ? 1000 / frameRate : undefined;
}

function toTimedMetadataBatch(message: MetadataTransportMessage): TimedMetadataBatch {
  return {
    streamId: message.streamId,
    batchStartTimestampUs: message.batchStartTimestampUs,
    batchEndTimestampUs: message.batchEndTimestampUs,
    records: message.records,
  };
}

function closeDecodedFrame(frame: DecodedFramePlan): void {
  (frame.videoFrame as { close?: () => void } | undefined)?.close?.();
}
