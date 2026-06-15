import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebTransportIngestClient,
} from "../contracts/services";
import {
  shouldUseWorkerVideoDecoder,
  WorkerVideoDecodeCoordinator,
  type LiveVideoDecoder,
} from "./workerVideoDecodeCoordinator";
import {
  shouldUseWorkerMediaPipeline,
  WorkerMediaPipelineClient,
  type WorkerDecodedFrameEnvelope,
  type WorkerFrameMetadata,
  type WorkerMediaPipelineEvent,
} from "./workerMediaPipelineClient";
import type {
  BrowserTransportMode,
  DecodedFramePlan,
  MetadataTransportMessage,
  RenderFrameRequest,
  RenderFrameResult,
  RenderBackend,
  SelectedVideoSourceDescriptor,
  SurfaceConfigurationPlan,
  TimedMetadataBatch,
  TransportConnectionHandle,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../contracts/models";
import {
  AdaptiveRenderCadence,
  AdaptiveRenderFrameGovernor,
  type AdaptiveRenderGovernorSnapshot,
} from "./adaptiveRenderGovernor";
import {
  addSample,
  createMetricSnapshot,
  createVmsCounterState,
  recordRenderedFrame,
  recordSequenceGap,
  type VmsCounterState,
  type VmsMetricSnapshot,
} from "./metrics";

export type VideoPipeStatus = "starting" | "playing" | "holding" | "stopping" | "stopped" | "error";
export type VideoPipeRenderClock = "animation-frame" | "frame-arrival";

export interface VideoPipeChannel {
  channelId: string;
  streamId: string;
  displayName: string;
  sourceRtspUrl: string;
  codec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
}

export interface VideoPipePlayerOptions {
  tileId: string;
  channel: VideoPipeChannel;
  canvasId: string;
  renderer?: VideoPipeFrameRenderer;
  authToken: string;
  serverCertificateHash?: string;
  adaptiveRenderFrameRate?: boolean;
  batchFrameCount: number;
  targetBatches?: number;
  targetLatencyMs: number;
  maxHighFrameRateRenderFrameRate?: number;
  maxRenderFrameRate?: number;
  maxHighSourceFrameRate?: number;
  maxSourceFrameRate?: number;
  maxSourceCodedWidth?: number;
  maxSourceCodedHeight?: number;
  chaosDisconnectAfterFrames?: number;
  chaosFrameDelayMs?: number;
  chaosDropEveryNFrames?: number;
  renderClock?: VideoPipeRenderClock;
  onState: (state: VideoPipeRuntimeState) => void;
}

export type VideoPipePlayerRuntimeOptions = Pick<
  VideoPipePlayerOptions,
  | "adaptiveRenderFrameRate"
  | "maxHighFrameRateRenderFrameRate"
  | "maxHighSourceFrameRate"
  | "maxRenderFrameRate"
  | "maxSourceCodedWidth"
  | "maxSourceCodedHeight"
  | "maxSourceFrameRate"
  | "renderClock"
>;

export interface VideoPipeFrameRenderer {
  configureSurface: (configuration: SurfaceConfigurationPlan) => Promise<void>;
  renderFrame: (request: RenderFrameRequest) => Promise<RenderFrameResult>;
  canShareFrameReference?: () => boolean;
  dispose: () => Promise<void>;
}

export interface VideoPipeRuntimeState {
  tileId: string;
  channelId: string;
  streamId: string;
  displayName: string;
  status: VideoPipeStatus;
  activeTransport?: BrowserTransportMode;
  decodeBackend?: string;
  decodePipeline: "main-thread" | "worker" | "media-worker";
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
  lastClientDropReason?: string;
  batchFrameCount: number;
  renderClock: VideoPipeRenderClock;
  renderFrameRateLimit?: number;
  adaptiveRenderPressureLevel: number;
  sourceSwitchCount: number;
  sourceSwitchReason?: string;
  desiredSourceFrameRate?: number;
  desiredMaxCodedWidth?: number;
  desiredMaxCodedHeight?: number;
  error?: string;
  metrics: VmsMetricSnapshot;
}

export type VmsTileStatus = VideoPipeStatus;
export type VmsRenderClock = VideoPipeRenderClock;
export type VmsTileControllerOptions = VideoPipePlayerOptions;
export type VmsFrameRenderer = VideoPipeFrameRenderer;
export type VmsTileRuntimeState = VideoPipeRuntimeState;

interface LiveVideoFrameMetadata {
  sequenceNumber: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
}

interface DesiredSourceRequest {
  desiredEgressFrameRate?: number;
  desiredMaxCodedWidth?: number;
  desiredMaxCodedHeight?: number;
  key: string;
}

export class VideoPipePlayerController {
  private static readonly MaxLiveDecodeBacklogFrames = 12;
  private static readonly MaxLiveRenderQueueFrames = 8;
  private static readonly StateEmitIntervalMs = 1000;
  private static readonly SourceSwitchCooldownMs = 10_000;
  private static readonly ReconnectDelayMs = 120;
  private readonly options: VideoPipePlayerOptions;
  private readonly counters: VmsCounterState;
  private readonly renderer: VideoPipeFrameRenderer;
  private readonly adaptiveGovernor: AdaptiveRenderFrameGovernor;
  private readonly renderCadence = new AdaptiveRenderCadence();
  private readonly metadataStore = new OverlayTimelineStore();
  private abortController?: AbortController;
  private running = false;
  private configured = false;
  private state: VideoPipeRuntimeState;
  private lastStateEmitAtMs = 0;
  private lastRenderStartedAtMs?: number;
  private stateEmitTimer?: ReturnType<typeof setTimeout>;
  private sourceSwitchTimer?: ReturnType<typeof setTimeout>;
  private sessionAbortController?: AbortController;
  private connectedSourceRequestKey?: string;
  private lastSourceSwitchAtMs = Number.NEGATIVE_INFINITY;
  private reconnectAttempts = 0;
  private activeSourceFrameRate?: number;
  private activeCodec: VideoPipeChannel["codec"];

  public constructor(options: VideoPipePlayerOptions) {
    this.options = options;
    this.renderer = options.renderer ?? new WebGpuRenderer();
    this.adaptiveGovernor = new AdaptiveRenderFrameGovernor();
    this.counters = createVmsCounterState(performance.now());
    this.activeCodec = options.channel.codec;
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
      decodePipeline: "main-thread",
      connectionOpenCount: 0,
      protocolEndFrameCount: 0,
      batchFrameCount: options.batchFrameCount,
      renderClock: options.renderClock ?? "frame-arrival",
      renderFrameRateLimit: undefined,
      adaptiveRenderPressureLevel: 0,
      sourceSwitchCount: 0,
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
    this.clearSourceSwitchTimer();
    this.sessionAbortController?.abort();
    this.abortController?.abort();
    this.renderer.dispose();
    this.emit({ status: "stopped" }, true);
  }

  public updateRuntimeOptions(options: VideoPipePlayerRuntimeOptions): void {
    const previousSourceRequestKey = this.resolveDesiredSourceRequest().key;
    this.options.adaptiveRenderFrameRate = options.adaptiveRenderFrameRate;
    this.options.maxHighFrameRateRenderFrameRate = options.maxHighFrameRateRenderFrameRate;
    this.options.maxHighSourceFrameRate = options.maxHighSourceFrameRate;
    this.options.maxRenderFrameRate = options.maxRenderFrameRate;
    this.options.maxSourceCodedWidth = options.maxSourceCodedWidth;
    this.options.maxSourceCodedHeight = options.maxSourceCodedHeight;
    this.options.maxSourceFrameRate = options.maxSourceFrameRate;
    this.options.renderClock = options.renderClock;
    this.emit({ renderClock: options.renderClock ?? "frame-arrival" }, true);
    this.requestSourceSwitchIfNeeded("policy-change", previousSourceRequestKey);
  }

  private async runLoop(abortSignal: AbortSignal): Promise<void> {
    await this.configureRenderer();

    while (this.running && !abortSignal.aborted) {
      const sessionAbortController = new AbortController();
      const linkedAbort = createLinkedAbortController(abortSignal, sessionAbortController.signal);
      this.sessionAbortController = sessionAbortController;

      try {
        await this.runContinuousSession(linkedAbort.signal);
        if (!this.running || abortSignal.aborted) {
          return;
        }

        this.emit({
          status: "holding",
          lastClientDropReason: "transport-ended-reconnect",
        }, true);
        await delay(VideoPipePlayerController.ReconnectDelayMs, abortSignal);
      } catch (error) {
        if (abortSignal.aborted || !this.running) {
          return;
        }

        if (sessionAbortController.signal.aborted) {
          await delay(VideoPipePlayerController.ReconnectDelayMs, abortSignal);
          continue;
        }

        if (this.state.connectionOpenCount > 0) {
          this.reconnectAttempts += 1;
          const backoffMs = Math.min(2_000, VideoPipePlayerController.ReconnectDelayMs * this.reconnectAttempts);
          this.emit({
            status: "holding",
            lastClientDropReason: "transport-error-reconnect",
            error: error instanceof Error ? error.message : String(error),
          }, true);
          await delay(backoffMs, abortSignal);
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        this.running = false;
        this.renderer.dispose();
        this.emit({ status: "error", error: message }, true);
        return;
      } finally {
        linkedAbort.dispose();
        if (this.sessionAbortController === sessionAbortController) {
          this.sessionAbortController = undefined;
        }
      }
    }
  }

  private async configureRenderer(): Promise<void> {
    if (this.configured) {
      return;
    }

    const surfaceSize = resolveTileSurfaceSize(
      this.options.canvasId,
      this.options.channel.codec.codedWidth,
      this.options.channel.codec.codedHeight,
    );
    await this.renderer.configureSurface({
      canvasId: this.options.canvasId,
      canvasWidth: surfaceSize.width,
      canvasHeight: surfaceSize.height,
      outputColorSpace: "srgb",
    });
    this.configured = true;
  }

  private async runContinuousSession(abortSignal: AbortSignal): Promise<void> {
    const sourceRequest = this.resolveDesiredSourceRequest();
    this.connectedSourceRequestKey = sourceRequest.key;
    this.activeSourceFrameRate = resolveEffectiveSourceFrameRate(
      this.options.channel.codec.frameRate,
      sourceRequest.desiredEgressFrameRate,
    );

    if (shouldUseWorkerMediaPipeline()) {
      await this.runWorkerContinuousSession(sourceRequest, abortSignal);
      return;
    }

    const transport = new WebTransportIngestClient();
    let connection;
    const transportStart = performance.now();
    try {
      connection = await transport.connectStreaming(this.createStreamingEndpoint(sourceRequest), abortSignal);
      this.reconnectAttempts = 0;
      addSample(this.counters.transportMs, performance.now() - transportStart);
      this.emit({
        status: "playing",
        activeTransport: connection.activeTransport,
        sourceVerified: connection.webTransportReady,
        sourceFrameRate: this.sourceFrameRate(),
        streamMode: "continuous-moq",
        connectionOpenCount: this.state.connectionOpenCount + 1,
        desiredSourceFrameRate: sourceRequest.desiredEgressFrameRate,
        desiredMaxCodedWidth: sourceRequest.desiredMaxCodedWidth,
        desiredMaxCodedHeight: sourceRequest.desiredMaxCodedHeight,
      }, true);

      await this.decodeAndRenderStream(transport, connection, abortSignal);
    } finally {
      if (connection) {
        await transport.closeConnection(connection);
      }
    }
  }

  private async runWorkerContinuousSession(
    sourceRequest: DesiredSourceRequest,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const renderQueue = new LiveDecodedFrameQueue();
    const renderSignal = new LiveRenderSignal();
    const pendingVideoMessages = new Map<number, LiveVideoFrameMetadata>();
    const pendingReceiveTimesBySequence = new Map<number, number>();
    let workerClient: WorkerMediaPipelineClient | undefined;
    let hasLiveMetadata = false;
    let lastReceivedVideoAtUnixTimeMs: number | undefined;
    let renderPumpRunning = true;
    let renderPumpError: unknown;
    let lastWorkerDecodeBacklogFrameCount = 0;

    const renderAvailableFrames = async (): Promise<boolean> => {
      addSample(this.counters.decodeBacklogFrames, lastWorkerDecodeBacklogFrameCount);
      this.dropStaleQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      this.dropOverflowQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      addSample(this.counters.renderQueueFrames, renderQueue.length);
      this.recordAdaptiveBacklogPressure(lastWorkerDecodeBacklogFrameCount, renderQueue.length);

      const candidateFrame = renderQueue.peekNewest();
      if (!candidateFrame) {
        return false;
      }

      if (!this.isRenderFrameDue(candidateFrame)) {
        this.dropSupersededQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
        return false;
      }

      this.dropSupersededQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      const frame = renderQueue.dequeue();
      if (!frame) {
        return false;
      }

      await this.renderFrame(frame, hasLiveMetadata, pendingVideoMessages, pendingReceiveTimesBySequence, abortSignal);
      pendingVideoMessages.delete(frame.sequenceNumber);
      pendingReceiveTimesBySequence.delete(frame.sequenceNumber);
      return true;
    };

    const renderPump = (async (): Promise<void> => {
      let lastPaintAtMs: number | undefined;
      while (renderPumpRunning && !abortSignal.aborted) {
        const rendered = await renderAvailableFrames();
        if (this.state.renderClock === "animation-frame") {
          const paintAtMs = await waitForNextPaint(abortSignal);
          if (lastPaintAtMs !== undefined) {
            addSample(this.counters.rafIntervalMs, paintAtMs - lastPaintAtMs, 120);
          }
          lastPaintAtMs = paintAtMs;
          continue;
        }

        if (!rendered) {
          await renderSignal.wait(abortSignal);
        }
      }

      await renderAvailableFrames();
    })().catch((error: unknown) => {
      renderPumpError = error;
      workerClient?.dispose();
    });

    const enqueueWorkerFrames = (frames: readonly WorkerDecodedFrameEnvelope[]): void => {
      if (frames.length === 0) {
        return;
      }

      const decodedFrames = frames.map((envelope) => envelope.frame);
      this.counters.framesDecoded += decodedFrames.length;
      for (const envelope of frames) {
        const metadata = toLiveVideoFrameMetadataFromWorker(envelope.metadata, envelope.frame);
        pendingVideoMessages.set(envelope.frame.sequenceNumber, metadata);
        if (typeof envelope.receivedAtUnixTimeMs === "number") {
          if (lastReceivedVideoAtUnixTimeMs !== undefined) {
            addSample(this.counters.receiveIntervalMs, envelope.receivedAtUnixTimeMs - lastReceivedVideoAtUnixTimeMs, 240);
          }
          lastReceivedVideoAtUnixTimeMs = envelope.receivedAtUnixTimeMs;
          pendingReceiveTimesBySequence.set(envelope.frame.sequenceNumber, envelope.receivedAtUnixTimeMs);
        }
      }

      renderQueue.enqueue(decodedFrames);
      renderSignal.notify();
    };

    const handleWorkerEvent = (event: WorkerMediaPipelineEvent): void => {
      if (renderPumpError) {
        workerClient?.dispose();
        return;
      }

      if (event.type === "connected") {
        this.reconnectAttempts = 0;
        addSample(this.counters.transportMs, event.transportMs);
        this.emit({
          status: "playing",
          activeTransport: event.activeTransport,
          sourceVerified: event.webTransportReady,
          sourceFrameRate: this.sourceFrameRate(),
          streamMode: "continuous-moq",
          connectionOpenCount: this.state.connectionOpenCount + 1,
          desiredSourceFrameRate: sourceRequest.desiredEgressFrameRate,
          desiredMaxCodedWidth: sourceRequest.desiredMaxCodedWidth,
          desiredMaxCodedHeight: sourceRequest.desiredMaxCodedHeight,
          decodePipeline: "media-worker",
        }, true);
        return;
      }

      if (event.type === "source") {
        this.applySelectedSource(event.source);
        this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
        pendingVideoMessages.clear();
        pendingReceiveTimesBySequence.clear();
        this.emit({
          sourceRtspUrl: event.source.sourceRtspUrl,
          sourceFrameRate: this.sourceFrameRate(),
          width: event.source.codec.codedWidth,
          height: event.source.codec.codedHeight,
          lastMessageAtUnixTimeMs: Date.now(),
        }, true);
        return;
      }

      if (event.type === "metadata") {
        hasLiveMetadata = true;
        void this.metadataStore.ingestBatch(toTimedMetadataBatch(event.message)).then(() => {
          this.emit({ lastMessageAtUnixTimeMs: Date.now() });
        });
        return;
      }

      if (event.type === "decoded") {
        this.counters.bytesReceived = event.bytesReceived;
        this.counters.messagesReceived = event.messagesReceived;
        lastWorkerDecodeBacklogFrameCount = event.backlogFrameCount;
        addSample(this.counters.decodeMs, event.decodeMs);
        enqueueWorkerFrames(event.frames);
        return;
      }

      if (event.type === "drop") {
        this.counters.framesDropped += event.count;
        this.emit({
          status: "holding",
          lastClientDropReason: event.reason,
          lastMessageAtUnixTimeMs: event.lastMessageAtUnixTimeMs,
        });
        return;
      }

      if (event.type === "sequence-gap") {
        recordSequenceGap(this.counters, event.gapFrameCount);
        return;
      }

      this.counters.bytesReceived = event.bytesReceived;
      this.counters.messagesReceived = event.messagesReceived;
      this.emit({
        protocolEndFrameCount: this.state.protocolEndFrameCount + 1,
        lastMessageAtUnixTimeMs: Date.now(),
      });
    };

    try {
      workerClient = new WorkerMediaPipelineClient(handleWorkerEvent);
      await workerClient.start(
        this.createStreamingEndpoint(sourceRequest),
        this.activeCodec,
        this.options.targetLatencyMs,
        abortSignal,
      );

      if (renderPumpError) {
        throw renderPumpError;
      }
    } finally {
      renderPumpRunning = false;
      renderSignal.notify();
      await renderPump;
      this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      workerClient?.dispose();
    }
  }

  private async decodeAndRenderStream(
    transport: WebTransportIngestClient,
    connection: TransportConnectionHandle,
    abortSignal: AbortSignal,
  ): Promise<void> {
    let assembler = new EncodedChunkAssembler();
    let lastDecodedSequenceNumber: number | undefined;
    let lastReceivedVideoSequenceNumber: number | undefined;
    let lastReceivedVideoAtMs: number | undefined;
    let waitingForKeyFrame = true;
    let hasLiveMetadata = false;
    const renderQueue = new LiveDecodedFrameQueue();
    const renderSignal = new LiveRenderSignal();
    let decoder = await this.createConfiguredDecoder(() => renderSignal.notify());
    const pendingVideoMessages = new Map<number, LiveVideoFrameMetadata>();
    const pendingReceiveTimesBySequence = new Map<number, number>();
    let renderPumpRunning = true;
    let renderPumpError: unknown;
    const renderAvailableFrames = async (): Promise<boolean> => {
      const frames = decoder.drainDecodedFrames();
      if (frames.length > 0) {
        this.counters.framesDecoded += frames.length;
        renderQueue.enqueue(frames);
      }

      const decodeBacklogFrameCount = decoder.liveBacklogFrameCount();
      addSample(this.counters.decodeBacklogFrames, decodeBacklogFrameCount);
      this.dropStaleQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      this.dropOverflowQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      addSample(this.counters.renderQueueFrames, renderQueue.length);
      this.recordAdaptiveBacklogPressure(decodeBacklogFrameCount, renderQueue.length);

      const candidateFrame = renderQueue.peekNewest();
      if (!candidateFrame) {
        return false;
      }

      if (!this.isRenderFrameDue(candidateFrame)) {
        this.dropSupersededQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
        return false;
      }

      this.dropSupersededQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      const frame = renderQueue.dequeue();
      if (!frame) {
        return false;
      }

      await this.renderFrame(frame, hasLiveMetadata, pendingVideoMessages, pendingReceiveTimesBySequence, abortSignal);
      pendingVideoMessages.delete(frame.sequenceNumber);
      pendingReceiveTimesBySequence.delete(frame.sequenceNumber);
      return true;
    };
    const renderPump = (async (): Promise<void> => {
      let lastPaintAtMs: number | undefined;
      while (renderPumpRunning && !abortSignal.aborted) {
        const rendered = await renderAvailableFrames();
        if (this.state.renderClock === "animation-frame") {
          const paintAtMs = await waitForNextPaint(abortSignal);
          if (lastPaintAtMs !== undefined) {
            addSample(this.counters.rafIntervalMs, paintAtMs - lastPaintAtMs, 120);
          }
          lastPaintAtMs = paintAtMs;
          continue;
        }

        if (!rendered) {
          await renderSignal.wait(abortSignal);
        }
      }

      await renderAvailableFrames();
    })().catch((error: unknown) => {
      renderPumpError = error;
    });

    try {
      for await (const frame of transport.readStreamingFrames(connection, abortSignal)) {
        abortSignal.throwIfAborted();
        if (renderPumpError) {
          throw renderPumpError;
        }

        this.counters.bytesReceived = frame.bytesReceived;
        this.counters.messagesReceived = frame.messagesReceived;

        if (frame.kind === "end") {
          this.emit({
            protocolEndFrameCount: this.state.protocolEndFrameCount + 1,
            lastMessageAtUnixTimeMs: Date.now(),
          });
          return;
        }

        if (frame.kind === "source") {
          this.applySelectedSource(frame.source);
          decoder.dispose();
          assembler = new EncodedChunkAssembler();
          decoder = await this.createConfiguredDecoder(() => renderSignal.notify());
          waitingForKeyFrame = true;
          this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
          pendingVideoMessages.clear();
          pendingReceiveTimesBySequence.clear();
          this.emit({
            sourceRtspUrl: frame.source.sourceRtspUrl,
            sourceFrameRate: this.sourceFrameRate(),
            width: frame.source.codec.codedWidth,
            height: frame.source.codec.codedHeight,
            lastMessageAtUnixTimeMs: Date.now(),
          }, true);
          continue;
        }

        if (frame.kind === "metadata") {
          hasLiveMetadata = true;
          await this.metadataStore.ingestBatch(toTimedMetadataBatch(frame.message));
          this.emit({ lastMessageAtUnixTimeMs: Date.now() });
          continue;
        }

        const message = frame.message;
        const receivedVideoAtMs = performance.now();
        if (lastReceivedVideoAtMs !== undefined) {
          addSample(this.counters.receiveIntervalMs, receivedVideoAtMs - lastReceivedVideoAtMs, 240);
        }
        lastReceivedVideoAtMs = receivedVideoAtMs;
        const frameAgeMs = Date.now() - (message.sourceTimestampUnixTimeMs ?? message.serverTimestampUnixTimeMs ?? Date.now());
        if (!message.keyFrame && frameAgeMs > this.liveDropThresholdMs()) {
          waitingForKeyFrame = true;
          this.counters.framesDropped += 1;
          this.emit({
            status: "holding",
            lastClientDropReason: "stale-before-decode",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
          continue;
        }

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
            lastClientDropReason: "waiting-for-keyframe",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
          continue;
        }

        if ((waitingForKeyFrame || hasSequenceGap) && message.keyFrame) {
          decoder.dispose();
          assembler = new EncodedChunkAssembler();
          decoder = await this.createConfiguredDecoder(() => renderSignal.notify());
          waitingForKeyFrame = false;
          this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
          pendingVideoMessages.clear();
          pendingReceiveTimesBySequence.clear();
        }

        const decodeStart = performance.now();
        try {
          if (decoder.liveBacklogFrameCount() > this.maxLiveDecodeBacklogFrames()) {
            const decodedBacklogFrames = decoder.drainDecodedFrames();
            if (decodedBacklogFrames.length > 0) {
              this.counters.framesDecoded += decodedBacklogFrames.length;
              renderQueue.enqueue(decodedBacklogFrames);
              this.dropStaleQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
              this.dropOverflowQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
              addSample(this.counters.renderQueueFrames, renderQueue.length);
            }
          }

          if (decoder.liveBacklogFrameCount() > this.hardMaxLiveDecodeBacklogFrames()) {
            decoder.dispose();
            assembler = new EncodedChunkAssembler();
            decoder = await this.createConfiguredDecoder(() => renderSignal.notify());
            waitingForKeyFrame = true;
            this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
            pendingVideoMessages.clear();
            pendingReceiveTimesBySequence.clear();
            this.counters.framesDropped += 1;
            if (!message.keyFrame) {
              this.emit({
                status: "holding",
                lastClientDropReason: "decode-backlog-reset",
                lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
              });
              continue;
            }

            waitingForKeyFrame = false;
          }

          pendingVideoMessages.set(message.sequenceNumber, toLiveVideoFrameMetadata(message));
          pendingReceiveTimesBySequence.set(message.sequenceNumber, frame.receivedAtUnixTimeMs);
          const chunks = await assembler.applyTransportMessage(message);
          for (const chunk of chunks) {
            await decoder.enqueueChunk(chunk);
          }
          renderSignal.notify();

          addSample(this.counters.decodeMs, performance.now() - decodeStart);

          lastDecodedSequenceNumber = message.sequenceNumber;
        } catch {
          decoder.dispose();
          assembler = new EncodedChunkAssembler();
          decoder = await this.createConfiguredDecoder(() => renderSignal.notify());
          waitingForKeyFrame = true;
          this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
          pendingVideoMessages.clear();
          pendingReceiveTimesBySequence.clear();
          this.counters.framesDropped += 1;
          this.emit({
            status: "holding",
            lastClientDropReason: "decode-error-reset",
            lastMessageAtUnixTimeMs: message.serverTimestampUnixTimeMs,
          });
        }
      }

      await renderAvailableFrames();
    } finally {
      renderPumpRunning = false;
      renderSignal.notify();
      await renderPump;
      this.dropQueuedFrames(renderQueue, pendingVideoMessages, pendingReceiveTimesBySequence);
      decoder.dispose();
    }
  }

  private async createConfiguredDecoder(onDecodedFramesAvailable?: () => void): Promise<LiveVideoDecoder> {
    if (shouldUseWorkerVideoDecoder()) {
      const workerDecoder = new WorkerVideoDecodeCoordinator(onDecodedFramesAvailable);
      try {
        await workerDecoder.configureDecoder(this.activeCodec);
        this.emit({ decodePipeline: workerDecoder.decodePipeline });
        return workerDecoder;
      } catch {
        workerDecoder.dispose();
      }
    }

    const decoder = new VideoDecodeCoordinator() as VideoDecodeCoordinator & LiveVideoDecoder;
    decoder.decodePipeline = "main-thread";
    await decoder.configureDecoder(this.activeCodec);
    this.emit({ decodePipeline: decoder.decodePipeline });
    return decoder;
  }

  private applySelectedSource(source: SelectedVideoSourceDescriptor): void {
    this.activeCodec = {
      ...this.options.channel.codec,
      codec: source.codec.codec,
      codedWidth: source.codec.codedWidth,
      codedHeight: source.codec.codedHeight,
      description: source.codec.description,
      profile: source.codec.profile,
      frameRate: source.codec.frameRate,
    };
    this.activeSourceFrameRate = source.codec.frameRate;
  }

  private async renderFrame(
    frame: DecodedFramePlan,
    hasLiveMetadata: boolean,
    messageBySequenceNumber: ReadonlyMap<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: ReadonlyMap<number, number>,
    abortSignal: AbortSignal,
  ): Promise<void> {
    abortSignal.throwIfAborted();
    const activeMetadata = hasLiveMetadata
      ? await this.metadataStore.queryActiveMetadata(frame.streamId, frame.presentationTimestampUs)
      : [];

    const renderStart = performance.now();
    this.lastRenderStartedAtMs = renderStart;
    this.counters.renderAttempts += 1;
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

    const renderDurationMs = renderEnded - renderStart;
    addSample(this.counters.renderMs, renderDurationMs);
    addSample(this.counters.sourceToRenderMs, renderedAtUnixTimeMs - (message?.sourceTimestampUnixTimeMs ?? serverTimestampUnixTimeMs));
    addSample(this.counters.serverToRenderMs, renderedAtUnixTimeMs - serverTimestampUnixTimeMs);
    addSample(this.counters.receiveToRenderMs, renderedAtUnixTimeMs - (receivedAtUnixTimeMs ?? renderedAtUnixTimeMs));
    recordRenderedFrame(this.counters, renderEnded, this.expectedRenderFrameIntervalMs());
    this.recordAdaptiveRenderPressure(renderDurationMs);
    this.emit({
      status: "playing",
      lastClientDropReason: undefined,
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

  private createWebTransportUrl(): string {
    return `https://127.0.0.1:9443/live/${encodeURIComponent(this.options.channel.channelId)}`;
  }

  private createStreamingEndpoint(sourceRequest: DesiredSourceRequest): TransportEndpointDescriptor {
    return {
      channelId: this.options.channel.channelId,
      streamId: this.options.channel.streamId,
      webTransportUrl: this.createWebTransportUrl(),
      authToken: this.options.authToken,
      metadataChannelRequired: true,
      requestedTransport: "webtransport-quic",
      allowHttpFallback: false,
      serverCertificateHash: this.options.serverCertificateHash,
      targetLatencyMs: this.options.targetLatencyMs,
      desiredEgressFrameRate: sourceRequest.desiredEgressFrameRate,
      desiredMaxCodedWidth: sourceRequest.desiredMaxCodedWidth,
      desiredMaxCodedHeight: sourceRequest.desiredMaxCodedHeight,
      chaosDisconnectAfterFrames: normalizePositiveInteger(this.options.chaosDisconnectAfterFrames),
      chaosFrameDelayMs: normalizePositiveInteger(this.options.chaosFrameDelayMs),
      chaosDropEveryNFrames: normalizePositiveInteger(this.options.chaosDropEveryNFrames),
      streamMode: "continuous-moq",
    };
  }

  private liveDropThresholdMs(): number {
    return Math.max(500, this.options.targetLatencyMs * 3);
  }

  private maxLiveDecodeBacklogFrames(): number {
    const frameRate = this.sourceFrameRate();
    if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0) {
      return VideoPipePlayerController.MaxLiveDecodeBacklogFrames;
    }

    const framesInBudget = Math.ceil((this.options.targetLatencyMs / 1000) * frameRate);
    return Math.max(2, Math.min(VideoPipePlayerController.MaxLiveDecodeBacklogFrames, framesInBudget));
  }

  private maxLiveRenderQueueFrames(): number {
    const frameRate = this.sourceFrameRate();
    if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0) {
      return VideoPipePlayerController.MaxLiveRenderQueueFrames;
    }

    const framesInBudget = Math.ceil((this.options.targetLatencyMs / 1000) * frameRate);
    return Math.max(2, Math.min(VideoPipePlayerController.MaxLiveRenderQueueFrames, framesInBudget));
  }

  private isRenderFrameDue(frame: DecodedFramePlan): boolean {
    const nowMs = performance.now();
    const maxFrameRate = this.currentRenderFrameRateLimit();
    if (!maxFrameRate || !Number.isFinite(maxFrameRate) || maxFrameRate <= 0) {
      this.renderCadence.reset();
      return true;
    }

    const sourceFrameRate = this.sourceFrameRate();
    if (!sourceFrameRate || !Number.isFinite(sourceFrameRate) || sourceFrameRate <= maxFrameRate * 1.05) {
      this.renderCadence.reset();
      return true;
    }

    if (typeof frame.sequenceNumber === "number" && Number.isFinite(frame.sequenceNumber)) {
      return this.renderCadence.shouldRender(frame.sequenceNumber, sourceFrameRate, maxFrameRate, nowMs);
    }

    if (this.lastRenderStartedAtMs === undefined) {
      return true;
    }

    const minimumIntervalMs = 1000 / maxFrameRate;
    return nowMs - this.lastRenderStartedAtMs >= minimumIntervalMs;
  }

  private dropSupersededQueuedFrames(
    renderQueue: LiveDecodedFrameQueue,
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    this.recordRateLimitedFrames(renderQueue.dropOldestUntil(1), messageBySequenceNumber, receiveTimeBySequenceNumber);
  }

  private expectedRenderFrameIntervalMs(): number | undefined {
    const sourceFrameRate = this.sourceFrameRate();
    if (typeof sourceFrameRate !== "number" || !Number.isFinite(sourceFrameRate) || sourceFrameRate <= 0) {
      return undefined;
    }

    const maxFrameRate = this.currentRenderFrameRateLimit();
    const effectiveFrameRate = maxFrameRate !== undefined
      ? Math.min(sourceFrameRate, maxFrameRate)
      : sourceFrameRate;
    return expectedFrameIntervalMs(effectiveFrameRate);
  }

  private hardMaxLiveDecodeBacklogFrames(): number {
    const frameRate = this.sourceFrameRate();
    if (typeof frameRate !== "number" || !Number.isFinite(frameRate) || frameRate <= 0) {
      return VideoPipePlayerController.MaxLiveDecodeBacklogFrames * 3;
    }

    if (this.isSourceRenderRateLimited()) {
      return Math.max(8, this.maxLiveDecodeBacklogFrames() * 4);
    }

    return Math.max(VideoPipePlayerController.MaxLiveDecodeBacklogFrames * 3, Math.ceil(frameRate * 0.75));
  }

  private isSourceRenderRateLimited(): boolean {
    const sourceFrameRate = this.sourceFrameRate();
    const effectiveRenderFrameRate = this.currentRenderFrameRateLimit();
    return typeof sourceFrameRate === "number"
      && Number.isFinite(sourceFrameRate)
      && effectiveRenderFrameRate !== undefined
      && sourceFrameRate > effectiveRenderFrameRate * 1.05;
  }

  private currentRenderFrameRateLimit(nowMs = performance.now()): number | undefined {
    const sourceFrameRate = this.sourceFrameRate();
    const configuredFrameRateLimit = resolveEffectiveRenderFrameRate(sourceFrameRate, this.options);
    if (this.options.adaptiveRenderFrameRate === false) {
      return configuredFrameRateLimit;
    }

    return this.adaptiveGovernor.resolveFrameRateLimit(sourceFrameRate, configuredFrameRateLimit, nowMs).frameRateLimit;
  }

  private currentAdaptiveRenderPressureLevel(nowMs = performance.now()): number {
    if (this.options.adaptiveRenderFrameRate === false) {
      return 0;
    }

    return this.adaptiveGovernor.resolveFrameRateLimit(
      this.sourceFrameRate(),
      resolveEffectiveRenderFrameRate(this.sourceFrameRate(), this.options),
      nowMs,
    ).pressureLevel;
  }

  private sourceFrameRate(): number | undefined {
    return this.activeSourceFrameRate ?? this.options.channel.codec.frameRate;
  }

  private recordAdaptiveBacklogPressure(decodeBacklogFrameCount: number, renderQueueFrameCount: number): void {
    if (this.options.adaptiveRenderFrameRate === false || this.counters.framesRendered < 20) {
      return;
    }

    const decodeBudget = this.maxLiveDecodeBacklogFrames();
    if (decodeBacklogFrameCount > decodeBudget * 2) {
      this.recordAdaptivePressure(2);
    } else if (decodeBacklogFrameCount > decodeBudget) {
      this.recordAdaptivePressure(1);
    }

    if (renderQueueFrameCount > this.maxLiveRenderQueueFrames()) {
      this.recordAdaptivePressure(1);
    }
  }

  private recordAdaptiveRenderPressure(renderDurationMs: number): void {
    if (this.options.adaptiveRenderFrameRate === false || this.counters.framesRendered < 20) {
      return;
    }

    const expectedIntervalMs = this.expectedRenderFrameIntervalMs();
    if (expectedIntervalMs === undefined || expectedIntervalMs <= 0) {
      return;
    }

    if (renderDurationMs > expectedIntervalMs * 1.25) {
      this.recordAdaptivePressure(2);
    } else if (renderDurationMs > expectedIntervalMs) {
      this.recordAdaptivePressure(1);
    }
  }

  private recordAdaptivePressure(severity: number): void {
    const previousSourceRequestKey = this.resolveDesiredSourceRequest().key;
    this.adaptiveGovernor.recordPressure(severity);
    this.requestSourceSwitchIfNeeded("adaptive-pressure", previousSourceRequestKey);
  }

  private dropOverflowQueuedFrames(
    renderQueue: LiveDecodedFrameQueue,
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    const dropped = renderQueue.dropOldestUntil(this.maxLiveRenderQueueFrames());
    this.recordQueuedDrops(dropped, messageBySequenceNumber, receiveTimeBySequenceNumber);
  }

  private dropStaleQueuedFrames(
    renderQueue: LiveDecodedFrameQueue,
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    const nowUnixTimeMs = Date.now();
    const dropped = renderQueue.dropOldestWhile((frame) => {
      const message = messageBySequenceNumber.get(frame.sequenceNumber);
      const timestamp = message?.sourceTimestampUnixTimeMs ?? message?.serverTimestampUnixTimeMs;
      return timestamp !== undefined && nowUnixTimeMs - timestamp > this.liveDropThresholdMs();
    }, 1);
    this.recordQueuedDrops(dropped, messageBySequenceNumber, receiveTimeBySequenceNumber);
  }

  private dropQueuedFrames(
    renderQueue: LiveDecodedFrameQueue,
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    this.recordQueuedDrops(renderQueue.clear(), messageBySequenceNumber, receiveTimeBySequenceNumber);
  }

  private recordQueuedDrops(
    droppedFrames: readonly DecodedFramePlan[],
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    if (droppedFrames.length === 0) {
      return;
    }

    this.counters.framesDropped += droppedFrames.length;
    for (const frame of droppedFrames) {
      messageBySequenceNumber.delete(frame.sequenceNumber);
      receiveTimeBySequenceNumber.delete(frame.sequenceNumber);
      closeDecodedFrame(frame);
    }
  }

  private recordRateLimitedFrames(
    droppedFrames: readonly DecodedFramePlan[],
    messageBySequenceNumber: Map<number, LiveVideoFrameMetadata>,
    receiveTimeBySequenceNumber: Map<number, number>,
  ): void {
    if (droppedFrames.length === 0) {
      return;
    }

    this.counters.framesRateLimited += droppedFrames.length;
    for (const frame of droppedFrames) {
      messageBySequenceNumber.delete(frame.sequenceNumber);
      receiveTimeBySequenceNumber.delete(frame.sequenceNumber);
      closeDecodedFrame(frame);
    }
  }

  private emit(patch: Partial<VideoPipeRuntimeState>, immediate = false): void {
    this.state = {
      ...this.state,
      ...patch,
    };

    const nowMs = performance.now();
    if (immediate || nowMs - this.lastStateEmitAtMs >= VideoPipePlayerController.StateEmitIntervalMs) {
      this.publishState(nowMs);
      return;
    }

    if (this.stateEmitTimer === undefined) {
      this.stateEmitTimer = setTimeout(() => {
        this.stateEmitTimer = undefined;
        this.publishState(performance.now());
      }, Math.max(0, VideoPipePlayerController.StateEmitIntervalMs - (nowMs - this.lastStateEmitAtMs)));
    }
  }

  private publishState(nowMs: number): void {
    if (this.stateEmitTimer !== undefined) {
      clearTimeout(this.stateEmitTimer);
      this.stateEmitTimer = undefined;
    }

    this.lastStateEmitAtMs = nowMs;
    const renderFrameRateLimit = this.currentRenderFrameRateLimit(nowMs);
    this.requestSourceSwitchIfNeeded("adaptive-recovery");
    const desiredSourceRequest = this.resolveDesiredSourceRequest(nowMs);
    this.state = {
      ...this.state,
      sourceFrameRate: this.sourceFrameRate(),
      renderFrameRateLimit,
      adaptiveRenderPressureLevel: this.currentAdaptiveRenderPressureLevel(nowMs),
      desiredSourceFrameRate: desiredSourceRequest.desiredEgressFrameRate,
      desiredMaxCodedWidth: desiredSourceRequest.desiredMaxCodedWidth,
      desiredMaxCodedHeight: desiredSourceRequest.desiredMaxCodedHeight,
      metrics: createMetricSnapshot(this.counters, nowMs),
    };
    this.options.onState(this.state);
  }

  private requestSourceSwitchIfNeeded(
    reason: string,
    previousSourceRequestKey = this.connectedSourceRequestKey,
  ): void {
    if (!this.running || this.connectedSourceRequestKey === undefined) {
      return;
    }

    const nextSourceRequest = this.resolveDesiredSourceRequest();
    if (nextSourceRequest.key === this.connectedSourceRequestKey || nextSourceRequest.key === previousSourceRequestKey) {
      return;
    }

    const nowMs = performance.now();
    const elapsedMs = nowMs - this.lastSourceSwitchAtMs;
    if (elapsedMs < VideoPipePlayerController.SourceSwitchCooldownMs) {
      if (this.sourceSwitchTimer === undefined) {
        this.sourceSwitchTimer = setTimeout(() => {
          this.sourceSwitchTimer = undefined;
          this.requestSourceSwitchIfNeeded(reason);
        }, VideoPipePlayerController.SourceSwitchCooldownMs - elapsedMs);
      }
      return;
    }

    this.clearSourceSwitchTimer();
    this.lastSourceSwitchAtMs = nowMs;
    this.emit({
      status: "holding",
      lastClientDropReason: `source-${reason}`,
      sourceSwitchCount: this.state.sourceSwitchCount + 1,
      sourceSwitchReason: reason,
      desiredSourceFrameRate: nextSourceRequest.desiredEgressFrameRate,
      desiredMaxCodedWidth: nextSourceRequest.desiredMaxCodedWidth,
      desiredMaxCodedHeight: nextSourceRequest.desiredMaxCodedHeight,
    }, true);
    this.sessionAbortController?.abort();
  }

  private clearSourceSwitchTimer(): void {
    if (this.sourceSwitchTimer === undefined) {
      return;
    }

    clearTimeout(this.sourceSwitchTimer);
    this.sourceSwitchTimer = undefined;
  }

  private resolveDesiredSourceRequest(nowMs = performance.now()): DesiredSourceRequest {
    const originalSourceFrameRate = this.options.channel.codec.frameRate;
    const configuredSourceFrameRate = resolveEffectiveSourceEgressFrameRate(originalSourceFrameRate, this.options);
    const adaptiveSourceFrameRate = this.options.adaptiveRenderFrameRate === false
      ? undefined
      : resolveAdaptiveSourceFrameRateLimit(
        originalSourceFrameRate,
        this.adaptiveGovernor.resolveFrameRateLimit(originalSourceFrameRate, undefined, nowMs),
      );
    const desiredEgressFrameRate = normalizeDesiredSourceFrameRate(
      originalSourceFrameRate,
      minDefinedFrameRateLimit(configuredSourceFrameRate, adaptiveSourceFrameRate),
    );
    const desiredMaxCodedWidth = normalizePositiveInteger(this.options.maxSourceCodedWidth);
    const desiredMaxCodedHeight = normalizePositiveInteger(this.options.maxSourceCodedHeight);
    return {
      desiredEgressFrameRate,
      desiredMaxCodedWidth,
      desiredMaxCodedHeight,
      key: createSourceRequestKey(desiredEgressFrameRate, desiredMaxCodedWidth, desiredMaxCodedHeight),
    };
  }
}

export { VideoPipePlayerController as VmsTileController };

export class LiveDecodedFrameQueue {
  private readonly frames: DecodedFramePlan[] = [];

  public get length(): number {
    return this.frames.length;
  }

  public enqueue(frames: readonly DecodedFramePlan[]): void {
    this.frames.push(...frames);
  }

  public dequeue(): DecodedFramePlan | undefined {
    return this.frames.shift();
  }

  public peekNewest(): DecodedFramePlan | undefined {
    return this.frames[this.frames.length - 1];
  }

  public dropOldestUntil(maxFrames: number): DecodedFramePlan[] {
    const dropped: DecodedFramePlan[] = [];
    while (this.frames.length > maxFrames) {
      const frame = this.frames.shift();
      if (frame) {
        dropped.push(frame);
      }
    }

    return dropped;
  }

  public dropOldestWhile(
    predicate: (frame: DecodedFramePlan) => boolean,
    keepAtLeast = 0,
  ): DecodedFramePlan[] {
    const dropped: DecodedFramePlan[] = [];
    while (this.frames.length > keepAtLeast) {
      const frame = this.frames[0];
      if (!frame || !predicate(frame)) {
        break;
      }

      dropped.push(this.frames.shift()!);
    }

    return dropped;
  }

  public clear(): DecodedFramePlan[] {
    return this.frames.splice(0);
  }
}

class LiveRenderSignal {
  private resolveWaiter?: () => void;
  private readonly pollIntervalMs = 4;

  public notify(): void {
    const resolve = this.resolveWaiter;
    this.resolveWaiter = undefined;
    resolve?.();
  }

  public wait(abortSignal: AbortSignal): Promise<void> {
    if (abortSignal.aborted) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      let settled = false;
      const timeoutHandle = setTimeout(finish, this.pollIntervalMs);
      const abortListener = (): void => finish();
      const waiter = (): void => finish();

      this.resolveWaiter = waiter;
      abortSignal.addEventListener("abort", abortListener, { once: true });

      function finish(): void {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeoutHandle);
        abortSignal.removeEventListener("abort", abortListener);
        resolve();
      }
    });
  }
}

let sharedNextPaint: Promise<number> | undefined;
const RafStallFallbackMs = 250;

export function waitForNextPaint(abortSignal: AbortSignal): Promise<number> {
  if (abortSignal.aborted) {
    return Promise.resolve(performance.now());
  }

  if (sharedNextPaint) {
    return sharedNextPaint;
  }

  sharedNextPaint = new Promise<number>((resolve) => {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let resolved = false;
    const finish = (timestamp: number): void => {
      if (resolved) {
        return;
      }

      resolved = true;
      if (timeoutHandle !== undefined) {
        globalThis.clearTimeout(timeoutHandle);
      }

      sharedNextPaint = undefined;
      resolve(timestamp);
    };

    if (globalThis.requestAnimationFrame) {
      globalThis.requestAnimationFrame(finish);
      // This is only a stall escape hatch. If it races normal rAF it becomes
      // a timer-driven frame clock and caps 60 fps playback below vsync.
      timeoutHandle = globalThis.setTimeout(() => finish(performance.now()), RafStallFallbackMs);
      return;
    }

    timeoutHandle = globalThis.setTimeout(() => finish(performance.now()), 16);
  });
  return sharedNextPaint;
}

function toLiveVideoFrameMetadata(message: VideoTransportMessage): LiveVideoFrameMetadata {
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

function toLiveVideoFrameMetadataFromWorker(
  metadata: WorkerFrameMetadata | undefined,
  frame: DecodedFramePlan,
): LiveVideoFrameMetadata {
  return {
    sequenceNumber: metadata?.sequenceNumber ?? frame.sequenceNumber,
    sourceTimestampUnixTimeMs: metadata?.sourceTimestampUnixTimeMs,
    serverTimestampUnixTimeMs: metadata?.serverTimestampUnixTimeMs,
    moqTrackAlias: metadata?.moqTrackAlias,
    moqGroupId: metadata?.moqGroupId,
    moqObjectId: metadata?.moqObjectId,
    moqSubgroupId: metadata?.moqSubgroupId,
    moqPublisherPriority: metadata?.moqPublisherPriority,
  };
}

function expectedFrameIntervalMs(frameRate: number | undefined): number | undefined {
  return frameRate !== undefined && frameRate > 0 ? 1000 / frameRate : undefined;
}

export function resolveEffectiveRenderFrameRate(
  sourceFrameRate: number | undefined,
  options: Pick<VideoPipePlayerOptions, "maxHighFrameRateRenderFrameRate" | "maxRenderFrameRate">,
): number | undefined {
  const maxRenderFrameRate = normalizeFrameRateLimit(options.maxRenderFrameRate);
  const highFrameRateLimit = normalizeFrameRateLimit(options.maxHighFrameRateRenderFrameRate);
  if (
    highFrameRateLimit === undefined
    || typeof sourceFrameRate !== "number"
    || !Number.isFinite(sourceFrameRate)
    || sourceFrameRate <= 45
  ) {
    return maxRenderFrameRate;
  }

  return maxRenderFrameRate === undefined
    ? highFrameRateLimit
    : Math.min(maxRenderFrameRate, highFrameRateLimit);
}

export function resolveEffectiveSourceFrameRate(
  sourceFrameRate: number | undefined,
  desiredEgressFrameRate: number | undefined,
): number | undefined {
  const normalizedSourceFrameRate = normalizeFrameRateLimit(sourceFrameRate);
  const normalizedDesiredEgressFrameRate = normalizeFrameRateLimit(desiredEgressFrameRate);
  if (normalizedSourceFrameRate === undefined) {
    return normalizedDesiredEgressFrameRate;
  }

  if (normalizedDesiredEgressFrameRate === undefined) {
    return normalizedSourceFrameRate;
  }

  return Math.min(normalizedSourceFrameRate, normalizedDesiredEgressFrameRate);
}

export function resolveEffectiveSourceEgressFrameRate(
  sourceFrameRate: number | undefined,
  options: Pick<VideoPipePlayerOptions, "maxHighSourceFrameRate" | "maxSourceFrameRate">,
): number | undefined {
  const sourceFrameRateLimit = normalizeFrameRateLimit(options.maxSourceFrameRate);
  const highSourceFrameRateLimit = normalizeFrameRateLimit(options.maxHighSourceFrameRate);
  if (sourceFrameRateLimit === undefined && highSourceFrameRateLimit === undefined) {
    return undefined;
  }

  const highRateLimit = typeof sourceFrameRate === "number"
    && Number.isFinite(sourceFrameRate)
    && sourceFrameRate > 45
    ? highSourceFrameRateLimit
    : undefined;
  const limit = minDefinedFrameRateLimit(sourceFrameRateLimit, highRateLimit);
  return resolveEffectiveSourceFrameRate(sourceFrameRate, limit);
}

function normalizeFrameRateLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function minDefinedFrameRateLimit(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  const normalizedLeft = normalizeFrameRateLimit(left);
  const normalizedRight = normalizeFrameRateLimit(right);
  if (normalizedLeft === undefined) {
    return normalizedRight;
  }

  if (normalizedRight === undefined) {
    return normalizedLeft;
  }

  return Math.min(normalizedLeft, normalizedRight);
}

function resolveAdaptiveSourceFrameRateLimit(
  sourceFrameRate: number | undefined,
  snapshot: AdaptiveRenderGovernorSnapshot,
): number | undefined {
  if (snapshot.pressureLevel <= 0) {
    return undefined;
  }

  return normalizeDesiredSourceFrameRate(sourceFrameRate, snapshot.frameRateLimit);
}

function normalizeDesiredSourceFrameRate(
  sourceFrameRate: number | undefined,
  requestedFrameRate: number | undefined,
): number | undefined {
  const source = normalizeFrameRateLimit(sourceFrameRate);
  const requested = normalizeFrameRateLimit(requestedFrameRate);
  if (requested === undefined) {
    return undefined;
  }

  if (source === undefined) {
    return requested;
  }

  return requested < source * 0.99 ? requested : undefined;
}

function createSourceRequestKey(
  desiredEgressFrameRate: number | undefined,
  desiredMaxCodedWidth: number | undefined,
  desiredMaxCodedHeight: number | undefined,
): string {
  return [
    desiredEgressFrameRate === undefined ? "fps:auto" : `fps:${desiredEgressFrameRate.toFixed(3)}`,
    desiredMaxCodedWidth === undefined ? "w:auto" : `w:${desiredMaxCodedWidth}`,
    desiredMaxCodedHeight === undefined ? "h:auto" : `h:${desiredMaxCodedHeight}`,
  ].join("|");
}

function createLinkedAbortController(...signals: AbortSignal[]): AbortController & { dispose: () => void } {
  const controller = new AbortController() as AbortController & { dispose: () => void };
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abort();
      continue;
    }

    signal.addEventListener("abort", abort);
  }

  controller.dispose = () => {
    for (const signal of signals) {
      signal.removeEventListener("abort", abort);
    }
  };
  return controller;
}

function delay(durationMs: number, abortSignal: AbortSignal): Promise<void> {
  if (abortSignal.aborted || durationMs <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(finish, durationMs);
    const abort = (): void => finish();

    abortSignal.addEventListener("abort", abort, { once: true });

    function finish(): void {
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", abort);
      resolve();
    }
  });
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function resolveTileSurfaceSize(canvasId: string, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const fallback = { width: sourceWidth, height: sourceHeight };
  if (typeof document === "undefined") {
    return fallback;
  }

  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  const rect = canvas?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return fallback;
  }

  const pixelRatio = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 1.25);
  const width = Math.max(1, Math.round(Math.min(sourceWidth, rect.width * pixelRatio)));
  const height = Math.max(1, Math.round(Math.min(sourceHeight, rect.height * pixelRatio)));
  return { width, height };
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
