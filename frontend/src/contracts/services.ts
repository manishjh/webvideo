import type {
  DecodedFramePlan,
  DroppedFrameRecord,
  EncodedChunkEmission,
  MetadataTransportMessage,
  PlayerSessionHandle,
  PlayerSessionRequest,
  PlaybackClockSnapshot,
  PresentationDecision,
  RenderFrameRequest,
  RenderFrameResult,
  StageTimingEvent,
  StreamDiscontinuity,
  SurfaceConfigurationPlan,
  TelemetrySnapshot,
  TimedMetadataBatch,
  TransportConnectionHandle,
  TransportEndpointDescriptor,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "./models";

interface TransportSeedState {
  videoMessagesByStream?: Record<string, VideoTransportMessage[]>;
  metadataMessagesByStream?: Record<string, MetadataTransportMessage[]>;
}

interface BootstrapDependencies {
  transportClient?: WebTransportIngestClient;
  decoder?: VideoDecodeCoordinator;
  renderer?: WebGpuRenderer;
}

interface InternalPlayerSessionState {
  handle: PlayerSessionHandle;
  request: PlayerSessionRequest;
  disposed: boolean;
}

interface InternalTransportState {
  handle: TransportConnectionHandle;
  endpoint: TransportEndpointDescriptor;
  remainingVideoMessages: VideoTransportMessage[];
  remainingMetadataMessages: MetadataTransportMessage[];
}

interface InternalRendererState {
  configuredSurface?: SurfaceConfigurationPlan;
  disposed: boolean;
  lastRenderedSequence?: number;
}

function createId(prefix: string, sequence: number): string {
  return `${prefix}-${sequence.toString().padStart(4, "0")}`;
}

function countOverlayPrimitives(batches: TimedMetadataBatch[]): number {
  return batches.reduce((total, batch) => total + batch.records.length, 0);
}

function computeFramePalette(sequenceNumber: number): { background: string; accent: string; overlay: string } {
  const hue = (sequenceNumber * 37) % 360;
  return {
    background: `hsl(${hue} 72% 48%)`,
    accent: `hsl(${(hue + 58) % 360} 84% 74%)`,
    overlay: `hsl(${(hue + 180) % 360} 80% 58%)`,
  };
}

function parseNormalizedCoordinate(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, parsed));
}

function isCanvasLike(candidate: unknown): candidate is HTMLCanvasElement {
  return Boolean(
    candidate
    && typeof candidate === "object"
    && "getContext" in candidate
    && typeof (candidate as { getContext?: unknown }).getContext === "function",
  );
}

function lookupCanvas(canvasId: string): HTMLCanvasElement | null {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") {
    return null;
  }

  const candidate = document.getElementById(canvasId);
  if (!candidate) {
    return null;
  }

  if (typeof HTMLCanvasElement !== "undefined") {
    return candidate instanceof HTMLCanvasElement ? candidate : null;
  }

  return isCanvasLike(candidate) ? candidate : null;
}

function drawMetadataOverlay(
  context: CanvasRenderingContext2D,
  batch: TimedMetadataBatch,
  frameWidth: number,
  frameHeight: number,
  overlayColor: string,
): void {
  for (const [index, record] of batch.records.entries()) {
    const x = parseNormalizedCoordinate(record.tags.x, 0.08 + index * 0.1);
    const y = parseNormalizedCoordinate(record.tags.y, 0.12 + index * 0.08);
    const w = parseNormalizedCoordinate(record.tags.w, 0.18);
    const h = parseNormalizedCoordinate(record.tags.h, 0.14);
    const left = x * frameWidth;
    const top = y * frameHeight;
    const width = Math.max(24, w * frameWidth);
    const height = Math.max(20, h * frameHeight);

    context.strokeStyle = overlayColor;
    context.lineWidth = 4;
    context.strokeRect(left, top, width, height);

    const label = record.tags.label ?? record.eventType;
    context.fillStyle = "rgba(0, 0, 0, 0.68)";
    context.fillRect(left, Math.max(0, top - 26), Math.max(84, label.length * 10), 24);
    context.fillStyle = "#ffffff";
    context.font = "16px IBM Plex Sans, sans-serif";
    context.fillText(label, left + 8, Math.max(16, top - 10));
  }
}

function paintFrameOnCanvas(
  canvas: HTMLCanvasElement,
  configuration: SurfaceConfigurationPlan,
  request: RenderFrameRequest,
): void {
  canvas.width = configuration.canvasWidth;
  canvas.height = configuration.canvasHeight;
  canvas.hidden = false;
  canvas.style.display = "block";

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const { frame } = request;
  const palette = computeFramePalette(frame.sequenceNumber);
  const width = configuration.canvasWidth;
  const height = configuration.canvasHeight;

  context.clearRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, palette.background);
  gradient.addColorStop(1, palette.accent);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.fillStyle = "rgba(255, 255, 255, 0.14)";
  for (let x = 0; x < width; x += 64) {
    context.fillRect(x, 0, 2, height);
  }
  for (let y = 0; y < height; y += 64) {
    context.fillRect(0, y, width, 2);
  }

  const motionOffset = (frame.sequenceNumber * 29) % (width + 200);
  context.fillStyle = "rgba(255, 255, 255, 0.18)";
  context.fillRect((motionOffset - 200), height * 0.22, 220, height * 0.56);

  context.fillStyle = "rgba(5, 10, 20, 0.62)";
  context.fillRect(24, 24, 420, 92);
  context.fillStyle = "#ffffff";
  context.font = "600 30px IBM Plex Sans, sans-serif";
  context.fillText(`Camera ${frame.streamId}`, 40, 60);
  context.font = "18px IBM Plex Sans, sans-serif";
  context.fillText(`Sequence ${frame.sequenceNumber}`, 40, 88);
  context.fillText(`PTS ${frame.presentationTimestampUs}`, 190, 88);

  for (const batch of request.activeMetadata) {
    drawMetadataOverlay(context, batch, width, height, palette.overlay);
  }

  if (request.debugOverlayEnabled) {
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(width - 256, height - 58, 224, 34);
    context.fillStyle = "#fef2df";
    context.font = "16px IBM Plex Mono, monospace";
    context.fillText(`overlay=${countOverlayPrimitives(request.activeMetadata)}`, width - 240, height - 36);
  }

  canvas.dataset.lastSequence = String(frame.sequenceNumber);
  canvas.dataset.overlayCount = String(countOverlayPrimitives(request.activeMetadata));
}

export class WebPlayerBootstrap {
  private readonly sessions = new Map<string, InternalPlayerSessionState>();
  private readonly transportClient: WebTransportIngestClient;
  private readonly decoder: VideoDecodeCoordinator;
  private readonly renderer: WebGpuRenderer;
  private nextSequence = 0;

  public constructor(dependencies: BootstrapDependencies = {}) {
    this.transportClient = dependencies.transportClient ?? new WebTransportIngestClient();
    this.decoder = dependencies.decoder ?? new VideoDecodeCoordinator();
    this.renderer = dependencies.renderer ?? new WebGpuRenderer();
  }

  /**
   * Planned flow: resolve session metadata from the UI layer, connect the transport path,
   * configure decode/render components, and return a session handle for later teardown.
   */
  public initializeSession(
    request: PlayerSessionRequest,
    abortSignal?: AbortSignal,
  ): Promise<PlayerSessionHandle> {
    abortSignal?.throwIfAborted();

    const handle: PlayerSessionHandle = {
      sessionId: createId("player", ++this.nextSequence),
      streamId: request.streamId,
      viewerId: request.viewerId,
    };

    this.sessions.set(handle.sessionId, {
      handle,
      request,
      disposed: false,
    });

    return Promise.resolve(handle);
  }

  /**
   * Planned flow: stop the transport readers, flush decode state, and release GPU resources
   * tied to the session.
   */
  public disposeSession(
    handle: PlayerSessionHandle,
  ): Promise<void> {
    const state = this.sessions.get(handle.sessionId);
    if (!state) {
      return Promise.reject(new Error(`Player session '${handle.sessionId}' is not active.`));
    }

    state.disposed = true;
    this.sessions.delete(handle.sessionId);
    return Promise.resolve();
  }
}

export class WebTransportIngestClient {
  private readonly seededVideoMessages: Record<string, VideoTransportMessage[]>;
  private readonly seededMetadataMessages: Record<string, MetadataTransportMessage[]>;
  private readonly connections = new Map<string, InternalTransportState>();
  private nextSequence = 0;

  public constructor(seed: TransportSeedState = {}) {
    this.seededVideoMessages = seed.videoMessagesByStream ?? {};
    this.seededMetadataMessages = seed.metadataMessagesByStream ?? {};
  }

  /**
   * Planned flow: authenticate, create the WebTransport session, and return a logical
   * connection handle that drives video and metadata readers.
   */
  public connect(
    endpoint: TransportEndpointDescriptor,
    abortSignal?: AbortSignal,
  ): Promise<TransportConnectionHandle> {
    abortSignal?.throwIfAborted();

    if (!endpoint.authToken) {
      return Promise.reject(new Error("Transport connection requires a non-empty auth token."));
    }

    const handle: TransportConnectionHandle = {
      connectionId: createId("transport", ++this.nextSequence),
      streamId: endpoint.streamId,
    };

    this.connections.set(handle.connectionId, {
      handle,
      endpoint,
      remainingVideoMessages: [...(this.seededVideoMessages[endpoint.streamId] ?? [])],
      remainingMetadataMessages: [...(this.seededMetadataMessages[endpoint.streamId] ?? [])],
    });

    return Promise.resolve(handle);
  }

  /**
   * Planned flow: incrementally read video messages, emit them to the encoded chunk assembler,
   * and surface transport-level timing for telemetry.
   */
  public readVideoMessages(
    connection: TransportConnectionHandle,
    abortSignal?: AbortSignal,
  ): Promise<VideoTransportMessage[]> {
    abortSignal?.throwIfAborted();
    const state = this.getConnection(connection.connectionId);
    const messages = [...state.remainingVideoMessages];
    state.remainingVideoMessages = [];
    return Promise.resolve(messages);
  }

  /**
   * Planned flow: incrementally read timed metadata batches and surface them to the timeline
   * store without blocking video delivery.
   */
  public readMetadataMessages(
    connection: TransportConnectionHandle,
    abortSignal?: AbortSignal,
  ): Promise<MetadataTransportMessage[]> {
    abortSignal?.throwIfAborted();
    const state = this.getConnection(connection.connectionId);
    const messages = [...state.remainingMetadataMessages];
    state.remainingMetadataMessages = [];
    return Promise.resolve(messages);
  }

  private getConnection(connectionId: string): InternalTransportState {
    const state = this.connections.get(connectionId);
    if (!state) {
      throw new Error(`Transport connection '${connectionId}' is not active.`);
    }

    return state;
  }
}

export class EncodedChunkAssembler {
  private readonly lastSequenceByStream = new Map<string, number>();
  private readonly codecConfigByStream = new Map<string, string>();

  /**
   * Planned flow: validate sequence ordering, emit WebCodecs-ready chunks, and track
   * discontinuities so the decoder can be reset explicitly.
   */
  public applyTransportMessage(
    message: VideoTransportMessage,
  ): Promise<EncodedChunkEmission[]> {
    const lastSequence = this.lastSequenceByStream.get(message.streamId);
    if (lastSequence !== undefined && message.sequenceNumber <= lastSequence) {
      return Promise.reject(new Error(`Video sequence for stream '${message.streamId}' must increase monotonically.`));
    }

    this.lastSequenceByStream.set(message.streamId, message.sequenceNumber);
    this.codecConfigByStream.set(message.streamId, message.codecConfigVersion);

    return Promise.resolve([
      {
        streamId: message.streamId,
        sequenceNumber: message.sequenceNumber,
        encodedChunkType: message.keyFrame ? "key" : "delta",
        presentationTimestampUs: message.presentationTimestampUs,
        payload: message.payload,
      },
    ]);
  }

  /**
   * Planned flow: reset local assembler state when ingest discontinuity or codec config change
   * is signaled.
   */
  public resetForDiscontinuity(
    discontinuity: StreamDiscontinuity,
  ): Promise<void> {
    this.lastSequenceByStream.delete(discontinuity.streamId);
    if (discontinuity.reason === "codec-config-change") {
      this.codecConfigByStream.delete(discontinuity.streamId);
    }

    return Promise.resolve();
  }
}

export class VideoDecodeCoordinator {
  private configuration?: VideoCodecConfiguration;
  private readonly queuedFrames: DecodedFramePlan[] = [];

  /**
   * Planned flow: configure WebCodecs with the resolved codec description and reset any prior
   * decoder state.
   */
  public configureDecoder(
    configuration: VideoCodecConfiguration,
  ): Promise<void> {
    this.configuration = configuration;
    this.queuedFrames.length = 0;
    return Promise.resolve();
  }

  /**
   * Planned flow: enqueue a single encoded chunk into the decoder with bounded backlog.
   */
  public enqueueChunk(
    chunk: EncodedChunkEmission,
  ): Promise<void> {
    if (!this.configuration) {
      return Promise.reject(new Error("Decoder must be configured before chunks can be enqueued."));
    }

    this.queuedFrames.push({
      streamId: chunk.streamId,
      sequenceNumber: chunk.sequenceNumber,
      presentationTimestampUs: chunk.presentationTimestampUs,
      width: this.configuration.codedWidth,
      height: this.configuration.codedHeight,
    });

    return Promise.resolve();
  }

  /**
   * Planned flow: flush decode state during stream drain or controlled reset and surface
   * decoded frame descriptors to the scheduler.
   */
  public flush(): Promise<DecodedFramePlan[]> {
    const frames = [...this.queuedFrames];
    this.queuedFrames.length = 0;
    return Promise.resolve(frames);
  }
}

export class OverlayTimelineStore {
  private readonly batchesByStream = new Map<string, TimedMetadataBatch[]>();

  /**
   * Planned flow: store metadata batches in a bounded timeline keyed by presentation time.
   */
  public ingestBatch(
    batch: TimedMetadataBatch,
  ): Promise<void> {
    const existing = this.batchesByStream.get(batch.streamId) ?? [];
    existing.push(batch);
    existing.sort((left, right) => left.batchStartTimestampUs - right.batchStartTimestampUs);
    this.batchesByStream.set(batch.streamId, existing);
    return Promise.resolve();
  }

  /**
   * Planned flow: return only metadata that should be active at the chosen presentation time.
   */
  public queryActiveMetadata(
    streamId: string,
    presentationTimestampUs: number,
  ): Promise<TimedMetadataBatch[]> {
    const active = (this.batchesByStream.get(streamId) ?? []).filter(
      // Timed metadata windows are modeled as [start, end) so adjacent batches do not overlap.
      (batch) => batch.batchStartTimestampUs <= presentationTimestampUs && batch.batchEndTimestampUs > presentationTimestampUs,
    );
    return Promise.resolve(active);
  }

  /**
   * Planned flow: clear timeline data on teardown or discontinuity.
   */
  public clearWindow(
    streamId: string,
  ): Promise<void> {
    this.batchesByStream.delete(streamId);
    return Promise.resolve();
  }
}

export class PresentationScheduler {
  private readonly clockByStream = new Map<string, PlaybackClockSnapshot>();
  private readonly pendingFramesByStream = new Map<string, DecodedFramePlan[]>();
  private readonly lateThresholdUs = 50_000;
  private readonly futureLeadUs = 33_000;

  /**
   * Planned flow: combine decoded frames, clock state, and active metadata to decide whether
   * to render immediately, hold briefly, or drop late frames.
   */
  public scheduleFrame(
    frame: DecodedFramePlan,
    activeMetadata: TimedMetadataBatch[],
  ): Promise<PresentationDecision> {
    const clock = this.clockByStream.get(frame.streamId);
    const activeMetadataCount = countOverlayPrimitives(activeMetadata);

    if (clock && frame.presentationTimestampUs + this.lateThresholdUs < clock.mediaTimestampUs) {
      return Promise.resolve({
        streamId: frame.streamId,
        shouldRender: false,
        activeMetadataCount,
        droppedFrames: [
          {
            streamId: frame.streamId,
            sequenceNumber: frame.sequenceNumber,
            reason: "late",
          },
        ],
      });
    }

    if (clock && frame.presentationTimestampUs > clock.mediaTimestampUs + this.futureLeadUs) {
      const pending = this.pendingFramesByStream.get(frame.streamId) ?? [];
      pending.push(frame);
      this.pendingFramesByStream.set(frame.streamId, pending);

      return Promise.resolve({
        streamId: frame.streamId,
        shouldRender: false,
        activeMetadataCount,
        droppedFrames: [],
      });
    }

    return Promise.resolve({
      streamId: frame.streamId,
      selectedSequenceNumber: frame.sequenceNumber,
      shouldRender: true,
      activeMetadataCount,
      droppedFrames: [],
    });
  }

  /**
   * Planned flow: absorb clock updates derived from arrival, decode, and present timing.
   */
  public handleClockUpdate(
    snapshot: PlaybackClockSnapshot,
  ): Promise<void> {
    this.clockByStream.set(snapshot.streamId, snapshot);
    return Promise.resolve();
  }

  /**
   * Planned flow: apply the bounded latency policy by dropping frames that have already missed
   * their presentation deadline.
   */
  public dropExpiredFrames(
    streamId: string,
    referenceTimestampUs: number,
  ): Promise<DroppedFrameRecord[]> {
    const pending = this.pendingFramesByStream.get(streamId) ?? [];
    const remaining: DecodedFramePlan[] = [];
    const dropped: DroppedFrameRecord[] = [];

    for (const frame of pending) {
      if (frame.presentationTimestampUs < referenceTimestampUs) {
        dropped.push({
          streamId,
          sequenceNumber: frame.sequenceNumber,
          reason: "late",
        });
      } else {
        remaining.push(frame);
      }
    }

    this.pendingFramesByStream.set(streamId, remaining);
    return Promise.resolve(dropped);
  }
}

export class WebGpuRenderer {
  private readonly state: InternalRendererState = {
    disposed: false,
  };

  /**
   * Planned flow: configure the canvas surface and GPU resources needed for video and overlay
   * compositing.
   */
  public configureSurface(
    configuration: SurfaceConfigurationPlan,
  ): Promise<void> {
    this.state.configuredSurface = configuration;
    this.state.disposed = false;
    lookupCanvas(configuration.canvasId);
    return Promise.resolve();
  }

  /**
   * Planned flow: render one decoded frame and its aligned overlays in a GPU-driven pass.
   */
  public renderFrame(
    request: RenderFrameRequest,
  ): Promise<RenderFrameResult> {
    if (!this.state.configuredSurface || this.state.disposed) {
      return Promise.reject(new Error("Renderer surface must be configured before rendering."));
    }

    const canvas = lookupCanvas(this.state.configuredSurface.canvasId);
    if (canvas) {
      paintFrameOnCanvas(canvas, this.state.configuredSurface, request);
    }

    this.state.lastRenderedSequence = request.frame.sequenceNumber;

    return Promise.resolve({
      sessionId: request.sessionId,
      renderedSequenceNumber: request.frame.sequenceNumber,
      overlayPrimitiveCount: countOverlayPrimitives(request.activeMetadata),
    });
  }

  /**
   * Planned flow: release GPU resources when the player is disposed or the page is torn down.
   */
  public dispose(): Promise<void> {
    this.state.disposed = true;
    this.state.configuredSurface = undefined;
    this.state.lastRenderedSequence = undefined;
    return Promise.resolve();
  }
}

export class PlayerTelemetryCollector {
  private readonly eventsByStream = new Map<string, StageTimingEvent[]>();

  /**
   * Planned flow: record stage timings from transport, decode, scheduling, and render layers.
   */
  public recordStageEvent(
    event: StageTimingEvent,
  ): Promise<void> {
    const events = this.eventsByStream.get(event.streamId) ?? [];
    events.push(event);
    this.eventsByStream.set(event.streamId, events);
    return Promise.resolve();
  }

  /**
   * Planned flow: emit a point-in-time telemetry snapshot for debugging and automated tests.
   */
  public createSnapshot(
    streamId: string,
  ): Promise<TelemetrySnapshot> {
    return Promise.resolve({
      streamId,
      capturedAtIso: new Date().toISOString(),
      stages: [...(this.eventsByStream.get(streamId) ?? [])],
    });
  }
}
