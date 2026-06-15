import { X } from "lucide-react";
import type { ReactElement } from "react";
import type { VideoPipeChannel, VideoPipeRuntimeState } from "../video-pipe";

export interface LiveFanoutSubscriberMetric {
  pendingFrames: number;
  framesRead: number;
  framesDropped: number;
}

export interface LiveFanoutMetric {
  streamId: string;
  rtspUrl?: string;
  processRunning: boolean;
  subscriberCount: number;
  framesRead: number;
  bytesRead: number;
  subscriberFramesDropped: number;
  lastFrameIntervalMs?: number;
  maxFrameIntervalMs?: number;
  lastKeyFrameIntervalMs?: number;
  readerRestartCount?: number;
  readerErrorCount?: number;
  ingressFps?: number;
  publishedFps?: number;
  subscriberReadFps?: number;
  recentIngressFps?: number;
  recentPublishedFps?: number;
  recentSubscriberReadFps?: number;
  subscribers: LiveFanoutSubscriberMetric[];
}

interface VmsTileProps {
  channel: VideoPipeChannel;
  instanceNumber: number;
  serverMetrics?: LiveFanoutMetric;
  state?: VideoPipeRuntimeState;
  tileId: string;
  onClose: () => void;
}

export function VmsTile({
  channel,
  instanceNumber,
  serverMetrics,
  state,
  tileId,
  onClose,
}: VmsTileProps): ReactElement {
  const canvasId = `vms-canvas-${tileId}`;
  const metrics = state?.metrics;
  return (
    <article className="vms-tile" data-testid={`tile-${tileId}`}>
      <header className="tile-bar">
        <div>
          <h2>
            {channel.displayName}
            {instanceNumber > 1 ? <span className="tile-instance">#{instanceNumber}</span> : null}
          </h2>
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
          data-testid={`tile-canvas-${tileId}`}
          height={channel.codec.codedHeight}
          id={canvasId}
          width={channel.codec.codedWidth}
        />
      </div>
      <div className="tile-quick-stats" data-testid="tile-quick-stats">
        <Metric label="Status" testId="tile-status" value={state?.status ?? "starting"} compact />
        <Metric label="Render FPS" testId="tile-render-fps" value={formatFps(metrics?.renderFps)} compact />
        <Metric label="S2R p95" testId="tile-metric-source-to-render-p95" value={formatMs(metrics?.sourceToRender.p95Ms)} compact />
        <Metric label="Drops" testId="tile-client-drops" value={formatNumber(metrics?.framesDropped)} compact />
      </div>
      <details className="tile-diagnostics" data-testid="tile-diagnostics">
        <summary data-testid="tile-stats-toggle">Stats for nerds</summary>
        <div className="tile-stats" data-testid="tile-stats">
          <Metric label="Transport" testId="tile-transport" value={state?.activeTransport ?? "pending"} />
          <Metric label="Bytes" testId="tile-bytes" value={formatNumber(metrics?.bytesReceived)} />
          <Metric label="Messages" testId="tile-messages" value={formatNumber(metrics?.messagesReceived)} />
          <Metric label="Decoded" testId="tile-decoded" value={formatNumber(metrics?.framesDecoded)} />
          <Metric label="Rate-limited" testId="tile-rate-limited" value={formatNumber(metrics?.framesRateLimited)} />
          <Metric label="Render attempts" testId="tile-render-attempts" value={formatNumber(metrics?.renderAttempts)} />
          <Metric label="Queue" testId="tile-server-queue" value={formatNumber(maxPendingFrames(serverMetrics))} />
          <Metric label="Server drops" testId="tile-server-drops" value={formatNumber(serverMetrics?.subscriberFramesDropped)} />
          <Metric label="Server FPS" testId="tile-server-fps" value={formatFps(serverMetrics?.publishedFps)} />
          <Metric label="Server recent FPS" testId="tile-server-recent-fps" value={formatFps(serverMetrics?.recentPublishedFps)} />
          <Metric label="Server frame max" testId="tile-server-frame-max" value={formatMs(serverMetrics?.maxFrameIntervalMs)} />
          <Metric label="Restarts" testId="tile-server-restarts" value={formatNumber(serverMetrics?.readerRestartCount)} />
          <Metric label="Seq gaps" testId="tile-sequence-gaps" value={formatNumber(metrics?.sequenceGapFrames)} />
          <Metric label="Hitches" testId="tile-frame-hitches" value={formatNumber(metrics?.frameHitches)} />
          <Metric label="Decode" testId="tile-decode" value={state?.decodeBackend ?? "pending"} />
          <Metric label="Decode pipe" testId="tile-decode-pipeline" value={state?.decodePipeline ?? "pending"} />
          <Metric label="Render clock" testId="tile-render-clock" value={state?.renderClock ?? "pending"} />
          <Metric label="Render cap" testId="tile-render-cap" value={formatFps(state?.renderFrameRateLimit)} />
          <Metric label="Adaptive pressure" testId="tile-adaptive-pressure" value={formatNumber(state?.adaptiveRenderPressureLevel)} />
          <Metric label="Render" testId="tile-render" value={state?.renderBackend ?? "pending"} />
          <Metric label="GPU path" testId="tile-gpu-path" value={formatGpuPath(state)} />
          <Metric label="GPU adapter" testId="tile-gpu-adapter" value={formatGpuAdapter(state)} />
          <Metric label="Source FPS" testId="tile-source-fps" value={formatFps(state?.sourceFrameRate)} />
          <Metric label="Frames" testId="tile-frames" value={formatNumber(metrics?.framesRendered)} />
          <Metric label="Frame p95" testId="tile-frame-interval-p95" value={formatMs(metrics?.frameInterval.p95Ms)} />
          <Metric label="Frame max" testId="tile-frame-interval-max" value={formatMs(metrics?.frameInterval.maxMs)} />
          <Metric label="Receive p95" testId="tile-receive-interval-p95" value={formatMs(metrics?.receiveInterval.p95Ms)} />
          <Metric label="RAF p95" testId="tile-raf-interval-p95" value={formatMs(metrics?.rafInterval.p95Ms)} />
          <Metric label="Decode backlog" testId="tile-decode-backlog" value={formatNumber(metrics?.decodeBacklog.maxMs)} />
          <Metric label="Render queue" testId="tile-render-queue" value={formatNumber(metrics?.renderQueue.maxMs)} />
          <Metric label="Connections" testId="tile-connections" value={formatNumber(state?.connectionOpenCount)} />
          <Metric label="Protocol ends" testId="tile-protocol-ends" value={formatNumber(state?.protocolEndFrameCount)} />
          <Metric label="Drop reason" testId="tile-drop-reason" value={state?.lastClientDropReason ?? "none"} />
          <Metric label="S2R latest" testId="tile-metric-source-to-render-latest" value={formatMs(metrics?.sourceToRender.latestMs)} />
          <Metric label="Server p95" testId="tile-metric-server-to-render-p95" value={formatMs(metrics?.serverToRender.p95Ms)} />
          <Metric label="Receive p95" testId="tile-metric-receive-to-render-p95" value={formatMs(metrics?.receiveToRender.p95Ms)} />
          <Metric label="Decode p95" testId="tile-metric-decode-p95" value={formatMs(metrics?.decode.p95Ms)} />
          <Metric label="Render p95" testId="tile-metric-render-p95" value={formatMs(metrics?.render.p95Ms)} />
          <Metric label="Error" testId="tile-error" value={state?.error ?? state?.gpuReadbackError ?? "none"} />
        </div>
      </details>
    </article>
  );
}

function Metric({ label, testId, value, compact = false }: { label: string; testId: string; value: string; compact?: boolean }): ReactElement {
  return (
    <div className={compact ? "metric metric-compact" : "metric"}>
      <span>{label}</span>
      <strong data-testid={testId}>{value}</strong>
    </div>
  );
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

function formatGpuPath(state: VideoPipeRuntimeState | undefined): string {
  if (state?.webGpuDisabledReason) {
    return `disabled (${state.webGpuDisabledReason})`;
  }

  if (!state?.gpuPresentation && !state?.gpuUploadSource) {
    return "pending";
  }

  return `${state.gpuUploadSource ?? "unknown"} / ${state.gpuPresentation ?? "unknown"}`;
}

function formatGpuAdapter(state: VideoPipeRuntimeState | undefined): string {
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
