import { Activity, MonitorPlay, Plus, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { BrowserDemoChannelSummary } from "../testing/browserDemoApi";
import {
  listDemoChannels,
  loadWebTransportCertificateHash,
} from "../testing/browserDemoApi";
import {
  createVideoPipeViewportSessionKey,
  VideoPipeViewport,
  type VideoPipeChannelGroup,
  type VideoPipeRenderClock,
  type VideoPipeRuntimeState,
} from "../video-pipe";
import { VmsTile, type LiveFanoutMetric } from "./VmsTile";

declare global {
  interface Window {
    __webvideoVmsState?: {
      status: string;
      channels: BrowserDemoChannelSummary[];
      activeChannels: string[];
      activeTiles: ActiveTileInstance[];
      metadataEnabledByTile: Record<string, boolean>;
      tiles: Record<string, VideoPipeRuntimeState>;
      serverMetrics: Record<string, LiveFanoutMetric>;
    };
  }
}

export interface RuntimeOptions {
  adaptiveRenderFrameRate: boolean;
  adaptiveSourceFrameRate: boolean;
  batchFrameCount: number;
  matrixCompositor: boolean;
  maxHighFrameRateRenderFrameRate?: number;
  maxHighSourceFrameRate?: number;
  maxRenderFrameRate?: number;
  maxSourceCodedWidth?: number;
  maxSourceCodedHeight?: number;
  maxSourceFrameRate?: number;
  targetLatencyMs?: number;
  chaosDisconnectAfterFrames?: number;
  chaosFrameDelayMs?: number;
  chaosDropEveryNFrames?: number;
  offscreenCanvas: boolean;
  renderClock: VideoPipeRenderClock;
  targetBatches?: number;
}

interface ActiveTileInstance {
  tileId: string;
  channelId: string;
  instanceNumber: number;
}

const MaxActiveTiles = 4;

export function VmsApp(): ReactElement {
  const [channels, setChannels] = useState<BrowserDemoChannelSummary[]>([]);
  const [activeTiles, setActiveTiles] = useState<ActiveTileInstance[]>([]);
  const [metadataEnabledByTile, setMetadataEnabledByTile] = useState<Record<string, boolean>>({});
  const [tiles, setTiles] = useState<Record<string, VideoPipeRuntimeState>>({});
  const [serverMetrics, setServerMetrics] = useState<Record<string, LiveFanoutMetric>>({});
  const [catalogStatus, setCatalogStatus] = useState("loading");
  const [error, setError] = useState<string>();
  const [certificateHash, setCertificateHash] = useState<string>();
  const nextTileSerialRef = useRef(2);
  const runtimeOptions = useMemo(readRuntimeOptions, []);
  const viewportOptions = useMemo(
    () => createViewportOptions(runtimeOptions, activeTiles.length),
    [activeTiles.length, runtimeOptions],
  );
  const viewportSessionKey = useMemo(
    () => createVideoPipeViewportSessionKey(viewportOptions),
    [viewportOptions],
  );
  const useDirectTileRender = useMemo(
    () => shouldUseDirectTileRender(runtimeOptions, activeTiles, tiles),
    [activeTiles, runtimeOptions, tiles],
  );
  const activeChannels = useMemo(() => activeTiles.map((tile) => tile.channelId), [activeTiles]);
  const tileCountsByChannel = useMemo(
    () => countTilesByChannel(activeTiles),
    [activeTiles],
  );
  const diagnosticTiles = useMemo(
    () => createDiagnosticTileMap(activeTiles, tiles),
    [activeTiles, tiles],
  );

  useEffect(() => {
    let cancelled = false;
    async function loadCatalog(): Promise<void> {
      try {
        const [loadedChannels, hash] = await Promise.all([
          listDemoChannels(),
          loadWebTransportCertificateHash(),
        ]);
        if (cancelled) {
          return;
        }

        setChannels(loadedChannels);
        setCertificateHash(hash);
        setCatalogStatus("ready");
      } catch (loadError) {
        if (cancelled) {
          return;
        }

        setCatalogStatus("error");
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }

    void loadCatalog();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.__webvideoVmsState = {
      status: catalogStatus,
      channels,
      activeTiles,
      activeChannels,
      metadataEnabledByTile,
      tiles: diagnosticTiles,
      serverMetrics,
    };
  }, [activeChannels, activeTiles, catalogStatus, channels, diagnosticTiles, metadataEnabledByTile, serverMetrics]);

  useEffect(() => {
    if (activeTiles.length === 0) {
      setServerMetrics({});
      return;
    }

    let cancelled = false;
    async function pollServerMetrics(): Promise<void> {
      try {
        const response = await fetch("/api/demo/live/metrics");
        if (!response.ok || cancelled) {
          return;
        }

        const metrics = await response.json() as LiveFanoutMetric[];
        if (!cancelled) {
          setServerMetrics(indexLiveFanoutMetrics(metrics));
        }
      } catch {
        // Server diagnostics are best-effort; playback should not depend on the metrics endpoint.
      }
    }

    void pollServerMetrics();
    const interval = window.setInterval(() => {
      void pollServerMetrics();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeTiles.length]);

  function addChannel(channelId: string): void {
    setActiveTiles((current) => {
      if (current.length >= MaxActiveTiles) {
        return current;
      }

      const existingForChannel = current.filter((tile) => tile.channelId === channelId);
      const tileId = existingForChannel.length > 0
        ? `${channelId}-${nextTileSerialRef.current++}`
        : channelId;
      const instanceNumber = existingForChannel.reduce(
        (currentMax, tile) => Math.max(currentMax, tile.instanceNumber),
        0,
      ) + 1;

      return [
        ...current,
        {
          tileId,
          channelId,
          instanceNumber,
        },
      ];
    });
  }

  function setTileMetadataEnabled(tileId: string, enabled: boolean): void {
    setMetadataEnabledByTile((current) => ({
      ...current,
      [tileId]: enabled,
    }));
  }

  function closeTile(tileId: string): void {
    setActiveTiles((current) => current.filter((candidate) => candidate.tileId !== tileId));
    setMetadataEnabledByTile((current) => {
      const next = { ...current };
      delete next[tileId];
      return next;
    });
    setTiles((current) => {
      const next = { ...current };
      delete next[tileId];
      return next;
    });
  }

  function updateChannelTiles(tileIds: string[], state: VideoPipeRuntimeState): void {
    setTiles((current) => {
      const next = { ...current };
      for (const tileId of tileIds) {
        next[tileId] = {
          ...state,
          tileId: `tile-${tileId}`,
        };
      }

      return next;
    });
  }

  const activeChannelGroups = createActiveChannelGroups(activeTiles, channels, viewportOptions.offscreenCanvas);
  const activeTileModels = activeTiles
    .map((tile) => ({
      tile,
      channel: channels.find((channel) => channel.channelId === tile.channelId),
    }))
    .filter((entry): entry is { tile: ActiveTileInstance; channel: BrowserDemoChannelSummary } => Boolean(entry.channel));
  const completedTiles = activeTiles.filter((tile) => tiles[tile.tileId]?.status === "playing" || tiles[tile.tileId]?.status === "holding").length;

  return (
    <main className="vms-shell">
      <aside className="channel-rail" data-testid="channel-picker">
        <div className="rail-header">
          <MonitorPlay size={20} aria-hidden="true" />
          <h1 data-testid="vms-title">WebVideo VMS</h1>
        </div>
        <div className="rail-status" data-testid="channel-picker-status">
          {catalogStatus === "ready" ? `${channels.length} channels` : catalogStatus}
        </div>
        {error ? <div className="rail-error" data-testid="channel-picker-error">{error}</div> : null}
        <div className="channel-list">
          {channels.map((channel) => (
            <div className="channel-row" data-testid={`channel-option-${channel.channelId}`} key={channel.channelId}>
              <div className="channel-copy">
                <strong>{channel.displayName}</strong>
                <span>{channel.streamId} | {channel.codec.codedWidth}x{channel.codec.codedHeight}</span>
              </div>
              <button
                aria-label={`Add ${channel.displayName}`}
                className="icon-button"
                data-testid={`add-channel-${channel.channelId}`}
                disabled={catalogStatus !== "ready" || activeTiles.length >= MaxActiveTiles}
                title="Add channel"
                type="button"
                onClick={() => addChannel(channel.channelId)}
              >
                <Plus size={17} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-bar">
          <div>
            <div className="section-kicker">Live matrix</div>
            <div className="summary-line" data-testid="vms-summary">
              {completedTiles}/{activeChannels.length} playing
            </div>
        </div>
        <div className="health-chip" data-testid="vms-batch-size">
          <Activity size={16} aria-hidden="true" />
          continuous WebTransport
        </div>
        </header>

        {activeTileModels.length === 0 ? (
          <div className="empty-state" data-testid="vms-empty-state">
            <Square size={18} aria-hidden="true" />
            <span>No active tiles</span>
          </div>
        ) : (
          <div className={useDirectTileRender ? "vms-grid-shell direct-render" : "vms-grid-shell"}>
            <VideoPipeViewport
              canvasIdForTile={canvasIdForTile}
              channelGroups={activeChannelGroups}
              metadataEnabledByTile={metadataEnabledByTile}
              matrixCanvasClassName="vms-matrix-canvas"
              matrixCanvasId="vms-matrix-canvas"
              matrixCanvasTestId="vms-matrix-canvas"
              options={viewportOptions}
              serverCertificateHash={certificateHash}
              onState={updateChannelTiles}
            >
              <div className="vms-grid" data-testid="vms-grid">
                {activeTileModels.map(({ tile, channel }) => (
                  <VmsTile
                    canvasResetKey={canvasResetKeyForTile(
                      tile,
                      tileCountsByChannel.get(tile.channelId) ?? 1,
                      viewportOptions.offscreenCanvas,
                      viewportSessionKey,
                    )}
                    channel={channel}
                    instanceNumber={tile.instanceNumber}
                    key={tile.tileId}
                    serverMetrics={selectLiveFanoutMetric(
                      serverMetrics,
                      channel.streamId,
                      tiles[tile.tileId]?.sourceRtspUrl,
                    )}
                    state={tiles[tile.tileId]}
                    tileId={tile.tileId}
                    metadataEnabled={metadataEnabledByTile[tile.tileId] !== false}
                    onMetadataEnabledChange={(enabled) => setTileMetadataEnabled(tile.tileId, enabled)}
                    onClose={() => closeTile(tile.tileId)}
                  />
                ))}
              </div>
            </VideoPipeViewport>
          </div>
        )}
      </section>
    </main>
  );
}

function countTilesByChannel(activeTiles: ActiveTileInstance[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tile of activeTiles) {
    counts.set(tile.channelId, (counts.get(tile.channelId) ?? 0) + 1);
  }

  return counts;
}

function canvasResetKeyForTile(
  tile: ActiveTileInstance,
  channelTileCount: number,
  offscreenCanvasEnabled: boolean,
  viewportSessionKey: string,
): string {
  const renderMode = offscreenCanvasEnabled ? "offscreen" : "shared";
  return `${tile.tileId}:${renderMode}:${channelTileCount}:${viewportSessionKey}`;
}

function createDiagnosticTileMap(
  activeTiles: ActiveTileInstance[],
  tiles: Record<string, VideoPipeRuntimeState>,
): Record<string, VideoPipeRuntimeState> {
  const diagnosticTiles: Record<string, VideoPipeRuntimeState> = {};
  const channelAliases = new Set<string>();

  for (const tile of activeTiles) {
    const state = tiles[tile.tileId];
    if (state) {
      diagnosticTiles[tile.tileId] = state;
    }

    if (state && !channelAliases.has(tile.channelId)) {
      diagnosticTiles[tile.channelId] = state;
      channelAliases.add(tile.channelId);
    }
  }

  return diagnosticTiles;
}

function createActiveChannelGroups(
  activeTiles: ActiveTileInstance[],
  channels: BrowserDemoChannelSummary[],
  splitTilesByInstance = false,
): VideoPipeChannelGroup[] {
  const groups: VideoPipeChannelGroup[] = [];
  if (splitTilesByInstance) {
    for (const tile of activeTiles) {
      const channel = channels.find((candidate) => candidate.channelId === tile.channelId);
      if (!channel) {
        continue;
      }

      groups.push({
        channel,
        tileIds: [tile.tileId],
      });
    }

    return groups;
  }

  for (const channelId of new Set(activeTiles.map((tile) => tile.channelId))) {
    const channel = channels.find((candidate) => candidate.channelId === channelId);
    if (!channel) {
      continue;
    }

    groups.push({
      channel,
      tileIds: activeTiles
        .filter((tile) => tile.channelId === channelId)
        .map((tile) => tile.tileId),
    });
  }

  return groups;
}

function canvasIdForTile(tileId: string): string {
  return `vms-canvas-${tileId}`;
}

function indexLiveFanoutMetrics(metrics: LiveFanoutMetric[]): Record<string, LiveFanoutMetric> {
  const indexed: Record<string, LiveFanoutMetric> = {};
  for (const metric of metrics) {
    indexed[liveFanoutMetricKey(metric.streamId, metric.rtspUrl)] = metric;
    const existingAlias = indexed[metric.streamId];
    if (!existingAlias || compareLiveFanoutMetrics(metric, existingAlias) > 0) {
      indexed[metric.streamId] = metric;
    }
  }

  return indexed;
}

function selectLiveFanoutMetric(
  indexed: Record<string, LiveFanoutMetric>,
  streamId: string,
  rtspUrl: string | undefined,
): LiveFanoutMetric | undefined {
  return indexed[liveFanoutMetricKey(streamId, rtspUrl)] ?? indexed[streamId];
}

function liveFanoutMetricKey(streamId: string, rtspUrl: string | undefined): string {
  return `${streamId}\n${rtspUrl ?? ""}`;
}

function compareLiveFanoutMetrics(left: LiveFanoutMetric, right: LiveFanoutMetric): number {
  if (left.subscriberCount !== right.subscriberCount) {
    return left.subscriberCount - right.subscriberCount;
  }

  return left.framesRead - right.framesRead;
}

function readRuntimeOptions(): RuntimeOptions {
  const params = new URLSearchParams(window.location.search);
  const adaptiveRenderFrameRate = !["0", "false"].includes((params.get("adaptiveRender") ?? "1").toLowerCase());
  const adaptiveSourceFrameRate = ["1", "true", "yes", "on"].includes((params.get("adaptiveSource") ?? "0").toLowerCase());
  const batchFrameCount = readPositiveInt(params.get("batchFrames"), 4);
  const targetBatches = readOptionalPositiveInt(params.get("targetBatches"));
  const matrixCompositor = !["0", "false"].includes((params.get("matrix") ?? "1").toLowerCase());
  const maxHighFrameRateRenderFrameRate = readOptionalRenderFrameRate(params.get("maxHighFpsRenderFps"));
  const maxHighSourceFrameRate = readOptionalRenderFrameRate(params.get("maxHighSourceFps"));
  const maxRenderFrameRate = readOptionalRenderFrameRate(params.get("maxRenderFps"));
  const maxSourceCodedWidth = readOptionalPositiveInt(params.get("maxSourceWidth"));
  const maxSourceCodedHeight = readOptionalPositiveInt(params.get("maxSourceHeight"));
  const maxSourceFrameRate = readOptionalRenderFrameRate(params.get("maxSourceFps"));
  const targetLatencyMs = readOptionalPositiveInt(params.get("targetLatencyMs") ?? params.get("targetLatency"));
  const chaosDisconnectAfterFrames = readOptionalPositiveInt(params.get("chaosDisconnectAfterFrames"));
  const chaosFrameDelayMs = readOptionalPositiveInt(params.get("chaosFrameDelayMs"));
  const chaosDropEveryNFrames = readOptionalPositiveInt(params.get("chaosDropEveryNFrames"));
  const offscreenCanvas = ["1", "true", "yes", "on", "tile", "per-tile"].includes(
    (params.get("offscreen") ?? "0").toLowerCase(),
  );
  const renderClock = readRenderClock(params.get("renderClock"));
  return {
    batchFrameCount,
    adaptiveRenderFrameRate,
    adaptiveSourceFrameRate,
    matrixCompositor,
    maxHighFrameRateRenderFrameRate,
    maxHighSourceFrameRate,
    maxRenderFrameRate,
    maxSourceCodedWidth,
    maxSourceCodedHeight,
    maxSourceFrameRate,
    targetLatencyMs,
    chaosDisconnectAfterFrames,
    chaosFrameDelayMs,
    chaosDropEveryNFrames,
    offscreenCanvas,
    renderClock,
    targetBatches,
  };
}

function readPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveInt(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readOptionalRenderFrameRate(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return parsed;
}

function readRenderClock(value: string | null): VideoPipeRenderClock {
  const normalized = (value ?? "frame-arrival").toLowerCase();
  return ["raf", "animation-frame"].includes(normalized) ? "animation-frame" : "frame-arrival";
}

export function createViewportOptions(
  options: RuntimeOptions,
  tileCount: number,
): RuntimeOptions {
  if (
    options.maxRenderFrameRate !== undefined
    || options.maxHighFrameRateRenderFrameRate !== undefined
    || options.maxHighSourceFrameRate !== undefined
    || options.maxSourceCodedWidth !== undefined
    || options.maxSourceCodedHeight !== undefined
    || options.maxSourceFrameRate !== undefined
    || options.targetLatencyMs !== undefined
  ) {
    return {
      ...options,
      offscreenCanvas: options.offscreenCanvas,
      maxHighFrameRateRenderFrameRate: normalizeRenderFrameRate(options.maxHighFrameRateRenderFrameRate),
      maxHighSourceFrameRate: normalizeRenderFrameRate(options.maxHighSourceFrameRate),
      maxRenderFrameRate: normalizeRenderFrameRate(options.maxRenderFrameRate),
      maxSourceCodedWidth: normalizePositiveInteger(options.maxSourceCodedWidth),
      maxSourceCodedHeight: normalizePositiveInteger(options.maxSourceCodedHeight),
      maxSourceFrameRate: normalizeRenderFrameRate(options.maxSourceFrameRate),
      targetLatencyMs: normalizePositiveInteger(options.targetLatencyMs),
    };
  }

  return {
    ...options,
    offscreenCanvas: options.offscreenCanvas,
    maxHighFrameRateRenderFrameRate: undefined,
    maxHighSourceFrameRate: undefined,
    maxRenderFrameRate: undefined,
    maxSourceCodedWidth: undefined,
    maxSourceCodedHeight: undefined,
    maxSourceFrameRate: undefined,
  };
}

function normalizeRenderFrameRate(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function shouldUseDirectTileRender(
  options: Pick<RuntimeOptions, "matrixCompositor" | "offscreenCanvas">,
  activeTiles: readonly Pick<ActiveTileInstance, "tileId">[],
  tiles: Record<string, Pick<VideoPipeRuntimeState, "gpuPresentation" | "matrixFallbackReason" | "renderBackend" | "webGpuDisabledReason"> | undefined>,
): boolean {
  if (!options.matrixCompositor || options.offscreenCanvas) {
    return true;
  }

  return activeTiles.some((tile) => {
    const state = tiles[tile.tileId];
    return state?.renderBackend === "canvas2d-fallback"
      || state?.gpuPresentation === "canvas2d-fallback"
      || Boolean(state?.matrixFallbackReason)
      || Boolean(state?.webGpuDisabledReason);
  });
}
