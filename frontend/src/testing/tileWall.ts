import {
  EncodedChunkAssembler,
  OverlayTimelineStore,
  PresentationScheduler,
  VideoDecodeCoordinator,
  WebGpuRenderer,
  WebPlayerBootstrap,
  WebTransportIngestClient,
} from "../contracts/services";
import {
  normalizeVideoMessages,
  openChannelSession,
} from "./browserDemoApi";
import type {
  BrowserTransportMode,
  DecodeBackend,
  MetadataTransportMessage,
  RenderBackend,
  TimedMetadataBatch,
} from "../contracts/models";

interface TileState {
  channelId: string;
  status: string;
  streamId?: string;
  sinkId?: string;
  displayName?: string;
  sourceRtspUrl?: string;
  sourceMode?: string;
  sourceVerified?: boolean;
  requestedTransport?: BrowserTransportMode;
  activeTransport?: BrowserTransportMode;
  webTransportBytesReceived?: number;
  webTransportMessagesReceived?: number;
  decodeBackend?: DecodeBackend;
  renderBackend?: RenderBackend;
  renderedSequences: number[];
  width?: number;
  height?: number;
  gpuUploadSource?: string;
  gpuPresentation?: string;
  gpuSampleRgba?: string;
  error?: string;
}

declare global {
  interface Window {
    __webvideoTileWallState?: {
      status: string;
      requestedFrameCount: number;
      channels: string[];
      tiles: Record<string, TileState>;
    };
  }
}

function getChannels(): string[] {
  const params = new URLSearchParams(window.location.search);
  return (params.get("channels") ?? "channel-001,channel-002,channel-003")
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
}

function getFrameCount(): number {
  const params = new URLSearchParams(window.location.search);
  const parsed = Number.parseInt(params.get("frames") ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function updateSummary(): void {
  const state = window.__webvideoTileWallState;
  const summary = document.querySelector<HTMLElement>("[data-testid='tile-wall-summary']");
  if (!state || !summary) {
    return;
  }

  const completed = Object.values(state.tiles).filter((tile) => tile.status === "completed").length;
  summary.textContent = `${completed}/${state.channels.length} completed`;
}

function bind(tile: HTMLElement, testId: string, value: string): void {
  const element = tile.querySelector<HTMLElement>(`[data-testid='${testId}']`);
  if (element) {
    element.textContent = value;
  }
}

function createTile(channelId: string, index: number): { tile: HTMLElement; canvasId: string } {
  const grid = document.querySelector<HTMLElement>("#tile-grid");
  if (!grid) {
    throw new Error("Tile grid is missing.");
  }

  const canvasId = `tile-canvas-${index}`;
  const tile = document.createElement("article");
  tile.className = "tile";
  tile.dataset.testid = `tile-${channelId}`;
  tile.innerHTML = `
    <header>
      <h2 data-testid="tile-title">${channelId}</h2>
      <div class="meta" data-testid="tile-stream">pending</div>
    </header>
    <div class="surface">
      <canvas id="${canvasId}" data-testid="tile-canvas-${channelId}" width="1280" height="720" hidden></canvas>
    </div>
    <dl>
      <dt>Status</dt><dd data-testid="tile-status">booting</dd>
      <dt>Sink</dt><dd data-testid="tile-sink">pending</dd>
      <dt>Source</dt><dd data-testid="tile-source">pending</dd>
      <dt>Transport</dt><dd data-testid="tile-transport">pending</dd>
      <dt>Bytes</dt><dd data-testid="tile-bytes">0</dd>
      <dt>Messages</dt><dd data-testid="tile-messages">0</dd>
      <dt>Decode</dt><dd data-testid="tile-decode">pending</dd>
      <dt>Render</dt><dd data-testid="tile-render">pending</dd>
      <dt>Resolution</dt><dd data-testid="tile-resolution">pending</dd>
      <dt>Frames</dt><dd data-testid="tile-frames">0</dd>
      <dt>GPU</dt><dd data-testid="tile-gpu">pending</dd>
      <dt>Error</dt><dd data-testid="tile-error">none</dd>
    </dl>
  `;
  grid.appendChild(tile);
  return { tile, canvasId };
}

async function playTile(channelId: string, index: number, frameCount: number): Promise<void> {
  const { tile, canvasId } = createTile(channelId, index);
  const state = window.__webvideoTileWallState;
  if (!state) {
    throw new Error("Tile wall state is missing.");
  }

  state.tiles[channelId] = {
    channelId,
    status: "requesting-channel",
    renderedSequences: [],
  };
  bind(tile, "tile-status", "requesting-channel");
  updateSummary();

  try {
    const payload = await openChannelSession(channelId, {
      viewerId: `tile-wall-${channelId}`,
      authToken: "demo-token",
      targetLatencyMs: 150,
      enableMetadata: true,
      frameCount,
    });
    const videoMessages = normalizeVideoMessages(payload.videoMessages);
    const metadataMessages: MetadataTransportMessage[] = payload.metadataMessages;
    const bootstrap = new WebPlayerBootstrap();
    const transport = new WebTransportIngestClient({
      videoMessagesByStream: { [payload.streamId]: videoMessages },
      metadataMessagesByStream: { [payload.streamId]: metadataMessages },
    });
    const assembler = new EncodedChunkAssembler();
    const decoder = new VideoDecodeCoordinator();
    const metadataStore = new OverlayTimelineStore();
    const scheduler = new PresentationScheduler();
    const renderer = new WebGpuRenderer();

    bind(tile, "tile-title", payload.displayName);
    bind(tile, "tile-stream", `${payload.channelId} / ${payload.streamId}`);
    bind(tile, "tile-sink", payload.sink.sinkId);
    bind(tile, "tile-source", `${payload.sourceMode} ${payload.sourceVerified ? "verified" : "fallback"}`);
    bind(tile, "tile-resolution", `${payload.codec.codedWidth}x${payload.codec.codedHeight}`);

    const session = await bootstrap.initializeSession({
      channelId: payload.channelId,
      streamId: payload.streamId,
      viewerId: `tile-wall-${channelId}`,
      targetLatencyMs: payload.targetLatencyMs,
      enableMetadata: true,
    });
    const connection = await transport.connect({
      channelId: payload.channelId,
      streamId: payload.streamId,
      webTransportUrl: payload.webTransportUrl,
      authToken: "demo-token",
      metadataChannelRequired: payload.metadataChannelRequired,
      requestedTransport: payload.requestedTransport,
      allowHttpFallback: true,
      serverCertificateHash: payload.webTransportCertificateHash,
      frameCount: payload.requestedFrameCount,
    });
    const receivedVideoMessages = await transport.readVideoMessages(connection);
    const receivedMetadataMessages = await transport.readMetadataMessages(connection);
    const chunks = [];
    for (const message of receivedVideoMessages) {
      chunks.push(...await assembler.applyTransportMessage(message));
    }

    await decoder.configureDecoder(payload.codec);
    for (const chunk of chunks) {
      await decoder.enqueueChunk(chunk);
    }

    for (const message of receivedMetadataMessages) {
      const batch: TimedMetadataBatch = {
        streamId: message.streamId,
        batchStartTimestampUs: message.batchStartTimestampUs,
        batchEndTimestampUs: message.batchEndTimestampUs,
        records: message.records,
      };
      await metadataStore.ingestBatch(batch);
    }

    await renderer.configureSurface({
      canvasId,
      canvasWidth: payload.codec.codedWidth,
      canvasHeight: payload.codec.codedHeight,
      outputColorSpace: "srgb",
    });
    const frames = await decoder.flush();
    const decodeBackend = frames[0]?.decodeBackend ?? "synthetic-frame-plan";
    let renderBackend: RenderBackend = "canvas2d-fallback";
    const renderedSequences: number[] = [];

    for (const frame of frames) {
      await scheduler.handleClockUpdate({
        streamId: frame.streamId,
        mediaTimestampUs: frame.presentationTimestampUs - 20_000,
        monotonicNowMs: performance.now(),
        clockSkewMs: 2,
      });
      const activeMetadata = await metadataStore.queryActiveMetadata(frame.streamId, frame.presentationTimestampUs);
      const decision = await scheduler.scheduleFrame(frame, activeMetadata);
      if (!decision.shouldRender) {
        continue;
      }

      const renderResult = await renderer.renderFrame({
        sessionId: session.sessionId,
        frame,
        activeMetadata,
        debugOverlayEnabled: true,
      });
      renderBackend = renderResult.renderBackend;
      renderedSequences.push(renderResult.renderedSequenceNumber);
    }

    const canvas = document.querySelector<HTMLCanvasElement>(`#${canvasId}`);
    if (canvas) {
      await waitForGpuSample(canvas);
    }
    const tileState: TileState = {
      channelId: payload.channelId,
      status: "completed",
      streamId: payload.streamId,
      sinkId: payload.sink.sinkId,
      displayName: payload.displayName,
      sourceRtspUrl: payload.sourceRtspUrl,
      sourceMode: payload.sourceMode,
      sourceVerified: payload.sourceVerified,
      requestedTransport: connection.requestedTransport,
      activeTransport: connection.activeTransport,
      webTransportBytesReceived: connection.webTransportBytesReceived,
      webTransportMessagesReceived: connection.webTransportMessagesReceived,
      decodeBackend,
      renderBackend,
      renderedSequences,
      width: canvas?.width,
      height: canvas?.height,
      gpuUploadSource: canvas?.dataset.gpuUploadSource,
      gpuPresentation: canvas?.dataset.gpuPresentation,
      gpuSampleRgba: canvas?.dataset.gpuSampleRgba,
    };
    state.tiles[channelId] = tileState;

    bind(tile, "tile-status", "completed");
    bind(tile, "tile-transport", `${connection.requestedTransport} -> ${connection.activeTransport}`);
    bind(tile, "tile-bytes", String(connection.webTransportBytesReceived));
    bind(tile, "tile-messages", String(connection.webTransportMessagesReceived));
    bind(tile, "tile-decode", decodeBackend);
    bind(tile, "tile-render", renderBackend);
    bind(tile, "tile-frames", String(renderedSequences.length));
    bind(tile, "tile-gpu", `${tileState.gpuUploadSource ?? "unknown"} / ${tileState.gpuPresentation ?? "unknown"}`);
    bind(tile, "tile-error", "none");
    await bootstrap.disposeSession(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.tiles[channelId] = {
      channelId,
      status: "error",
      renderedSequences: [],
      error: message,
    };
    bind(tile, "tile-status", "error");
    bind(tile, "tile-error", message);
  } finally {
    updateSummary();
  }
}

async function waitForGpuSample(canvas: HTMLCanvasElement): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (canvas.dataset.gpuSampleRgba || canvas.dataset.gpuReadbackError) {
      return;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 16);
    });
  }
}

async function bootTileWall(): Promise<void> {
  const channels = getChannels();
  const requestedFrameCount = getFrameCount();
  window.__webvideoTileWallState = {
    status: "running",
    requestedFrameCount,
    channels,
    tiles: {},
  };
  updateSummary();

  await Promise.all(channels.map((channelId, index) => playTile(channelId, index + 1, requestedFrameCount)));

  const state = window.__webvideoTileWallState;
  if (state) {
    state.status = Object.values(state.tiles).every((tile) => tile.status === "completed")
      ? "completed"
      : "error";
  }
  updateSummary();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootTileWall();
  }, { once: true });
} else {
  void bootTileWall();
}
