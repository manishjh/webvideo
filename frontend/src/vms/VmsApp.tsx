import { Activity, MonitorPlay, Plus, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { BrowserDemoChannelSummary } from "../testing/browserDemoApi";
import {
  listDemoChannels,
  loadWebTransportCertificateHash,
} from "../testing/browserDemoApi";
import {
  VmsTileController,
  type VmsTileRuntimeState,
} from "./playerController";

declare global {
  interface Window {
    __webvideoVmsState?: {
      status: string;
      channels: BrowserDemoChannelSummary[];
      activeChannels: string[];
      tiles: Record<string, VmsTileRuntimeState>;
      serverMetrics: Record<string, LiveFanoutMetric>;
    };
  }
}

interface RuntimeOptions {
  batchFrameCount: number;
  targetBatches?: number;
}

interface LiveFanoutSubscriberMetric {
  pendingFrames: number;
  framesRead: number;
  framesDropped: number;
}

interface LiveFanoutMetric {
  streamId: string;
  processRunning: boolean;
  subscriberCount: number;
  framesRead: number;
  bytesRead: number;
  subscriberFramesDropped: number;
  subscribers: LiveFanoutSubscriberMetric[];
}

export function VmsApp(): ReactElement {
  const [channels, setChannels] = useState<BrowserDemoChannelSummary[]>([]);
  const [activeChannels, setActiveChannels] = useState<string[]>([]);
  const [tiles, setTiles] = useState<Record<string, VmsTileRuntimeState>>({});
  const [serverMetrics, setServerMetrics] = useState<Record<string, LiveFanoutMetric>>({});
  const [catalogStatus, setCatalogStatus] = useState("loading");
  const [error, setError] = useState<string>();
  const [certificateHash, setCertificateHash] = useState<string>();
  const runtimeOptions = useMemo(readRuntimeOptions, []);

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
      activeChannels,
      tiles,
      serverMetrics,
    };
  }, [activeChannels, catalogStatus, channels, serverMetrics, tiles]);

  useEffect(() => {
    if (activeChannels.length === 0) {
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
          setServerMetrics(Object.fromEntries(metrics.map((metric) => [metric.streamId, metric])));
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
  }, [activeChannels.length]);

  function addChannel(channelId: string): void {
    setActiveChannels((current) => current.includes(channelId) ? current : [...current, channelId]);
  }

  function closeChannel(channelId: string): void {
    setActiveChannels((current) => current.filter((candidate) => candidate !== channelId));
    setTiles((current) => {
      const next = { ...current };
      delete next[channelId];
      return next;
    });
  }

  function updateTile(channelId: string, state: VmsTileRuntimeState): void {
    setTiles((current) => ({
      ...current,
      [channelId]: state,
    }));
  }

  const activeSet = new Set(activeChannels);
  const activeChannelModels = activeChannels
    .map((channelId) => channels.find((channel) => channel.channelId === channelId))
    .filter((channel): channel is BrowserDemoChannelSummary => Boolean(channel));
  const completedTiles = activeChannels.filter((channelId) => tiles[channelId]?.status === "playing" || tiles[channelId]?.status === "holding").length;

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
                disabled={activeSet.has(channel.channelId) || catalogStatus !== "ready"}
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

        {activeChannelModels.length === 0 ? (
          <div className="empty-state" data-testid="vms-empty-state">
            <Square size={18} aria-hidden="true" />
            <span>No active tiles</span>
          </div>
        ) : (
          <div className="vms-grid" data-testid="vms-grid">
            {activeChannelModels.map((channel) => (
              <VmsTile
                certificateHash={certificateHash}
                channel={channel}
                key={channel.channelId}
                options={runtimeOptions}
                serverMetrics={serverMetrics[channel.streamId]}
                state={tiles[channel.channelId]}
                onClose={() => closeChannel(channel.channelId)}
                onState={(state) => updateTile(channel.channelId, state)}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

interface VmsTileProps {
  certificateHash?: string;
  channel: BrowserDemoChannelSummary;
  options: RuntimeOptions;
  serverMetrics?: LiveFanoutMetric;
  state?: VmsTileRuntimeState;
  onClose: () => void;
  onState: (state: VmsTileRuntimeState) => void;
}

function VmsTile({
  certificateHash,
  channel,
  options,
  serverMetrics,
  state,
  onClose,
  onState,
}: VmsTileProps): ReactElement {
  const canvasId = `vms-canvas-${channel.channelId}`;
  const controllerRef = useRef<VmsTileController | undefined>(undefined);
  const onStateRef = useRef(onState);

  useEffect(() => {
    onStateRef.current = onState;
  }, [onState]);

  useEffect(() => {
    const controller = new VmsTileController({
      tileId: `tile-${channel.channelId}`,
      channel,
      canvasId,
      authToken: "demo-token",
      serverCertificateHash: certificateHash,
      batchFrameCount: options.batchFrameCount,
      targetBatches: options.targetBatches,
      targetLatencyMs: 150,
      onState: (nextState) => onStateRef.current(nextState),
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      controllerRef.current = undefined;
    };
  }, [canvasId, certificateHash, channel, options.batchFrameCount, options.targetBatches]);

  const metrics = state?.metrics;
  return (
    <article className="vms-tile" data-testid={`tile-${channel.channelId}`}>
      <header className="tile-bar">
        <div>
          <h2>{channel.displayName}</h2>
          <span data-testid="tile-stream">{channel.channelId} / {channel.streamId}</span>
        </div>
        <button
          aria-label={`Close ${channel.displayName}`}
          className="icon-button danger"
          data-testid="tile-close"
          title="Close stream"
          type="button"
          onClick={onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="video-surface">
        <canvas
          data-testid={`tile-canvas-${channel.channelId}`}
          height={channel.codec.codedHeight}
          id={canvasId}
          width={channel.codec.codedWidth}
        />
      </div>
      <div className="tile-stats">
        <Metric label="Status" testId="tile-status" value={state?.status ?? "starting"} />
        <Metric label="Transport" testId="tile-transport" value={state?.activeTransport ?? "pending"} />
        <Metric label="Bytes" testId="tile-bytes" value={formatNumber(metrics?.bytesReceived)} />
        <Metric label="Messages" testId="tile-messages" value={formatNumber(metrics?.messagesReceived)} />
        <Metric label="Queue" testId="tile-server-queue" value={formatNumber(maxPendingFrames(serverMetrics))} />
        <Metric label="Server drops" testId="tile-server-drops" value={formatNumber(serverMetrics?.subscriberFramesDropped)} />
        <Metric label="Client drops" testId="tile-client-drops" value={formatNumber(metrics?.framesDropped)} />
        <Metric label="Seq gaps" testId="tile-sequence-gaps" value={formatNumber(metrics?.sequenceGapFrames)} />
        <Metric label="Hitches" testId="tile-frame-hitches" value={formatNumber(metrics?.frameHitches)} />
        <Metric label="Decode" testId="tile-decode" value={state?.decodeBackend ?? "pending"} />
        <Metric label="Render" testId="tile-render" value={state?.renderBackend ?? "pending"} />
        <Metric label="GPU path" testId="tile-gpu-path" value={formatGpuPath(state)} />
        <Metric label="GPU adapter" testId="tile-gpu-adapter" value={formatGpuAdapter(state)} />
        <Metric label="Source FPS" testId="tile-source-fps" value={formatFps(state?.sourceFrameRate)} />
        <Metric label="Frames" testId="tile-frames" value={formatNumber(metrics?.framesRendered)} />
        <Metric label="Render FPS" testId="tile-render-fps" value={formatFps(metrics?.renderFps)} />
        <Metric label="Frame p95" testId="tile-frame-interval-p95" value={formatMs(metrics?.frameInterval.p95Ms)} />
        <Metric label="Connections" testId="tile-connections" value={formatNumber(state?.connectionOpenCount)} />
        <Metric label="Protocol ends" testId="tile-protocol-ends" value={formatNumber(state?.protocolEndFrameCount)} />
        <Metric label="S2R latest" testId="tile-metric-source-to-render-latest" value={formatMs(metrics?.sourceToRender.latestMs)} />
        <Metric label="S2R p95" testId="tile-metric-source-to-render-p95" value={formatMs(metrics?.sourceToRender.p95Ms)} />
        <Metric label="Server p95" testId="tile-metric-server-to-render-p95" value={formatMs(metrics?.serverToRender.p95Ms)} />
        <Metric label="Receive p95" testId="tile-metric-receive-to-render-p95" value={formatMs(metrics?.receiveToRender.p95Ms)} />
        <Metric label="Decode p95" testId="tile-metric-decode-p95" value={formatMs(metrics?.decode.p95Ms)} />
        <Metric label="Render p95" testId="tile-metric-render-p95" value={formatMs(metrics?.render.p95Ms)} />
        <Metric label="Error" testId="tile-error" value={state?.error ?? state?.gpuReadbackError ?? "none"} />
      </div>
    </article>
  );
}

function Metric({ label, testId, value }: { label: string; testId: string; value: string }): ReactElement {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong data-testid={testId}>{value}</strong>
    </div>
  );
}

function readRuntimeOptions(): RuntimeOptions {
  const params = new URLSearchParams(window.location.search);
  const batchFrameCount = readPositiveInt(params.get("batchFrames"), 4);
  const targetBatches = readOptionalPositiveInt(params.get("targetBatches"));
  return { batchFrameCount, targetBatches };
}

function readPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readOptionalPositiveInt(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "0" : String(Math.round(value));
}

function formatMs(value: number | undefined): string {
  return `${(value ?? 0).toFixed(1)} ms`;
}

function formatFps(value: number | undefined): string {
  return `${(value ?? 0).toFixed(1)} fps`;
}

function formatGpuPath(state: VmsTileRuntimeState | undefined): string {
  if (state?.webGpuDisabledReason) {
    return `disabled (${state.webGpuDisabledReason})`;
  }

  if (!state?.gpuPresentation && !state?.gpuUploadSource) {
    return "pending";
  }

  return `${state.gpuUploadSource ?? "unknown"} / ${state.gpuPresentation ?? "unknown"}`;
}

function formatGpuAdapter(state: VmsTileRuntimeState | undefined): string {
  if (!state?.gpuAdapterVendor && !state?.gpuAdapterArchitecture) {
    return "pending";
  }

  return `${state.gpuAdapterVendor || "unknown"} ${state.gpuAdapterArchitecture || "unknown"}`;
}

function maxPendingFrames(metrics: LiveFanoutMetric | undefined): number | undefined {
  return metrics?.subscribers.reduce(
    (currentMax, subscriber) => Math.max(currentMax, subscriber.pendingFrames),
    0,
  );
}
