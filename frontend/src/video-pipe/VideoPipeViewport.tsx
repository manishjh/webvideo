import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  type VideoPipeChannel,
  VideoPipePlayerController,
  type VideoPipeRenderClock,
  type VideoPipeRuntimeState,
  resolveTileSurfaceSize,
} from "./playerController";
import { createOffscreenMatrixRenderTarget } from "./offscreenMatrixRenderer";
import { createSharedVideoViewportRenderer } from "./sharedViewport";
import type { WorkerMatrixRenderTarget, WorkerOffscreenRenderTarget } from "./workerMediaPipelineClient";

export interface VideoPipeChannelGroup {
  channel: VideoPipeChannel;
  tileIds: string[];
}

export interface VideoPipeViewportRuntimeOptions {
  adaptiveRenderFrameRate?: boolean;
  adaptiveSourceFrameRate?: boolean;
  batchFrameCount: number;
  matrixCompositor: boolean;
  maxHighFrameRateRenderFrameRate?: number;
  maxHighSourceFrameRate?: number;
  maxRenderFrameRate?: number;
  maxSourceCodedWidth?: number;
  maxSourceCodedHeight?: number;
  maxSourceFrameRate?: number;
  chaosDisconnectAfterFrames?: number;
  chaosFrameDelayMs?: number;
  chaosDropEveryNFrames?: number;
  offscreenCanvas?: boolean;
  renderClock: VideoPipeRenderClock;
  targetBatches?: number;
  targetLatencyMs?: number;
}

export interface VideoPipeViewportProps {
  authToken?: string;
  canvasIdForTile?: (tileId: string) => string;
  channelGroups: VideoPipeChannelGroup[];
  children: ReactNode;
  metadataEnabledByTile?: Record<string, boolean>;
  matrixCanvasClassName?: string;
  matrixCanvasId: string;
  matrixCanvasTestId?: string;
  options: VideoPipeViewportRuntimeOptions;
  serverCertificateHash?: string;
  onState: (tileIds: string[], state: VideoPipeRuntimeState) => void;
}

export function VideoPipeViewport({
  authToken = "demo-token",
  canvasIdForTile = defaultCanvasIdForTile,
  channelGroups,
  children,
  metadataEnabledByTile = {},
  matrixCanvasClassName,
  matrixCanvasId,
  matrixCanvasTestId,
  options,
  serverCertificateHash,
  onState,
}: VideoPipeViewportProps): ReactElement {
  return (
    <>
      <canvas
        aria-hidden="true"
        className={matrixCanvasClassName}
        data-testid={matrixCanvasTestId}
        id={matrixCanvasId}
      />
      {channelGroups.map((group) => (
        <VideoPipeChannelSession
          authToken={authToken}
          canvasIdForTile={canvasIdForTile}
          channelGroup={group}
          metadataEnabledByTile={metadataEnabledByTile}
          key={`${group.channel.channelId}:${group.tileIds.join(",")}:${createVideoPipeViewportSessionKey(options)}`}
          matrixCanvasId={matrixCanvasId}
          options={options}
          serverCertificateHash={serverCertificateHash}
          onState={onState}
        />
      ))}
      {children}
    </>
  );
}

interface VideoPipeChannelSessionProps {
  authToken: string;
  canvasIdForTile: (tileId: string) => string;
  channelGroup: VideoPipeChannelGroup;
  metadataEnabledByTile: Record<string, boolean>;
  matrixCanvasId: string;
  options: VideoPipeViewportRuntimeOptions;
  serverCertificateHash?: string;
  onState: (tileIds: string[], state: VideoPipeRuntimeState) => void;
}

type MatrixRenderTargetLease = WorkerMatrixRenderTarget & {
  release: () => void;
};

function VideoPipeChannelSession({
  authToken,
  canvasIdForTile,
  channelGroup,
  metadataEnabledByTile,
  matrixCanvasId,
  options,
  serverCertificateHash,
  onState,
}: VideoPipeChannelSessionProps): null {
  const tileIdsRef = useRef(channelGroup.tileIds);
  const onStateRef = useRef(onState);
  const canvasIdForTileRef = useRef(canvasIdForTile);
  const metadataEnabledByTileRef = useRef(metadataEnabledByTile);
  const startupOptionsRef = useRef(options);
  const controllerRef = useRef<VideoPipePlayerController | undefined>(undefined);

  useEffect(() => {
    tileIdsRef.current = channelGroup.tileIds;
  }, [channelGroup.tileIds]);

  useEffect(() => {
    onStateRef.current = onState;
  }, [onState]);

  useEffect(() => {
    canvasIdForTileRef.current = canvasIdForTile;
  }, [canvasIdForTile]);

  useEffect(() => {
    metadataEnabledByTileRef.current = metadataEnabledByTile;
    const firstTileId = tileIdsRef.current[0];
    if (firstTileId) {
      controllerRef.current?.updateMetadataEnabled(metadataEnabledByTile[firstTileId] !== false);
    }
  }, [metadataEnabledByTile]);

  useEffect(() => {
    startupOptionsRef.current = options;
    controllerRef.current?.updateRuntimeOptions({
      adaptiveRenderFrameRate: options.adaptiveRenderFrameRate,
      adaptiveSourceFrameRate: options.adaptiveSourceFrameRate,
      maxHighFrameRateRenderFrameRate: options.maxHighFrameRateRenderFrameRate,
      maxHighSourceFrameRate: options.maxHighSourceFrameRate,
      maxRenderFrameRate: options.maxRenderFrameRate,
      maxSourceCodedWidth: options.maxSourceCodedWidth,
      maxSourceCodedHeight: options.maxSourceCodedHeight,
      maxSourceFrameRate: options.maxSourceFrameRate,
      targetLatencyMs: options.targetLatencyMs,
      renderClock: options.renderClock,
    });
  }, [
    options.adaptiveRenderFrameRate,
    options.adaptiveSourceFrameRate,
    options.maxHighFrameRateRenderFrameRate,
    options.maxHighSourceFrameRate,
    options.maxRenderFrameRate,
    options.maxSourceCodedWidth,
    options.maxSourceCodedHeight,
    options.maxSourceFrameRate,
    options.targetLatencyMs,
    options.renderClock,
  ]);

  useEffect(() => {
    let cancelled = false;
    const startupOptions = startupOptionsRef.current;
    const renderer = createSharedVideoViewportRenderer({
      getCanvasIds: () => tileIdsRef.current.map((tileId) => canvasIdForTileRef.current(tileId)),
      isMetadataEnabledForCanvasId: (canvasId) => {
        const tileId = tileIdsRef.current.find((candidate) => canvasIdForTileRef.current(candidate) === canvasId);
        return tileId ? metadataEnabledByTileRef.current[tileId] !== false : true;
      },
      matrixCanvasId,
      matrixCompositor: startupOptions.matrixCompositor,
    });
    const firstTileId = tileIdsRef.current[0] ?? channelGroup.channel.channelId;
    const firstCanvasId = canvasIdForTileRef.current(firstTileId);
    let controller: VideoPipePlayerController | undefined;
    let matrixRenderTargetLease: MatrixRenderTargetLease | undefined;

    void (async () => {
      const offscreenRenderTarget = createOffscreenRenderTarget(
        startupOptions.offscreenCanvas === true,
        firstCanvasId,
        channelGroup.channel,
        tileIdsRef.current.length,
      );
      matrixRenderTargetLease = await createMatrixRenderTarget(
        startupOptions.matrixCompositor === true && !offscreenRenderTarget,
        matrixCanvasId,
        () => tileIdsRef.current.map((tileId) => canvasIdForTileRef.current(tileId)),
        firstCanvasId,
        channelGroup.channel,
        tileIdsRef.current.length,
      );
      if (cancelled) {
        matrixRenderTargetLease?.port.close();
        matrixRenderTargetLease?.release();
        return;
      }

      controller = new VideoPipePlayerController({
        tileId: `tile-${channelGroup.channel.channelId}`,
        channel: channelGroup.channel,
        canvasId: firstCanvasId,
        renderer,
        authToken,
        serverCertificateHash,
        adaptiveRenderFrameRate: startupOptions.adaptiveRenderFrameRate,
        adaptiveSourceFrameRate: startupOptions.adaptiveSourceFrameRate,
        batchFrameCount: startupOptions.batchFrameCount,
        targetBatches: startupOptions.targetBatches,
        targetLatencyMs: startupOptions.targetLatencyMs ?? 75,
        maxHighFrameRateRenderFrameRate: startupOptions.maxHighFrameRateRenderFrameRate,
        maxHighSourceFrameRate: startupOptions.maxHighSourceFrameRate,
        maxRenderFrameRate: startupOptions.maxRenderFrameRate,
        maxSourceCodedWidth: startupOptions.maxSourceCodedWidth,
        maxSourceCodedHeight: startupOptions.maxSourceCodedHeight,
        maxSourceFrameRate: startupOptions.maxSourceFrameRate,
        chaosDisconnectAfterFrames: startupOptions.chaosDisconnectAfterFrames,
        chaosFrameDelayMs: startupOptions.chaosFrameDelayMs,
        chaosDropEveryNFrames: startupOptions.chaosDropEveryNFrames,
        metadataEnabled: metadataEnabledByTileRef.current[firstTileId] !== false,
        matrixRenderTarget: matrixRenderTargetLease
          ? {
            canvasId: matrixRenderTargetLease.canvasId,
            port: matrixRenderTargetLease.port,
          }
          : undefined,
        offscreenRenderTarget,
        renderClock: startupOptions.renderClock,
        onState: (nextState) => onStateRef.current(tileIdsRef.current, nextState),
      });
      controllerRef.current = controller;
      controller.start();
    })();

    return () => {
      cancelled = true;
      controllerRef.current = undefined;
      controller?.stop();
      matrixRenderTargetLease?.release();
    };
  }, [
    authToken,
    channelGroup.channel,
    channelGroup.tileIds.length,
    matrixCanvasId,
    options.matrixCompositor,
    options.offscreenCanvas,
    serverCertificateHash,
  ]);

  return null;
}

function defaultCanvasIdForTile(tileId: string): string {
  return `video-pipe-canvas-${tileId}`;
}

export function createVideoPipeViewportSessionKey(options: VideoPipeViewportRuntimeOptions): string {
  return [
    options.offscreenCanvas === true ? "offscreen" : "canvas",
    options.adaptiveRenderFrameRate === false ? "fixed-render" : "adaptive-render",
    options.adaptiveSourceFrameRate === true ? "adaptive-source" : "fixed-source",
    options.batchFrameCount,
    options.maxHighFrameRateRenderFrameRate ?? "auto",
    options.maxHighSourceFrameRate ?? "auto",
    options.maxRenderFrameRate ?? "auto",
    options.maxSourceCodedWidth ?? "auto",
    options.maxSourceCodedHeight ?? "auto",
    options.maxSourceFrameRate ?? "auto",
    options.renderClock,
    options.targetBatches ?? "auto",
    options.targetLatencyMs ?? "auto",
    options.chaosDisconnectAfterFrames ?? "none",
    options.chaosFrameDelayMs ?? "none",
    options.chaosDropEveryNFrames ?? "none",
  ].join(":");
}

async function createMatrixRenderTarget(
  enabled: boolean,
  matrixCanvasId: string,
  getCanvasIds: () => string[],
  canvasId: string,
  channel: VideoPipeChannel,
  tileCount: number,
): Promise<MatrixRenderTargetLease | undefined> {
  if (!enabled || tileCount !== 1 || typeof document === "undefined") {
    return undefined;
  }

  const surfaceSize = resolveTileSurfaceSize(canvasId, channel.codec.codedWidth, channel.codec.codedHeight);
  try {
    return await createOffscreenMatrixRenderTarget(matrixCanvasId, getCanvasIds, {
      canvasId,
      canvasWidth: surfaceSize.width,
      canvasHeight: surfaceSize.height,
      outputColorSpace: "srgb",
    });
  } catch {
    return undefined;
  }
}

function createOffscreenRenderTarget(
  enabled: boolean,
  canvasId: string,
  channel: VideoPipeChannel,
  tileCount: number,
): WorkerOffscreenRenderTarget | undefined {
  if (!enabled || tileCount !== 1 || typeof document === "undefined") {
    return undefined;
  }

  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!canvas || typeof canvas.transferControlToOffscreen !== "function") {
    return undefined;
  }

  const surfaceSize = resolveTileSurfaceSize(canvasId, channel.codec.codedWidth, channel.codec.codedHeight);
  canvas.width = surfaceSize.width;
  canvas.height = surfaceSize.height;
  canvas.hidden = false;
  canvas.style.display = "block";
  canvas.dataset.renderBackend = "webgpu";
  canvas.dataset.gpuPresentation = "worker-offscreen-pending";
  canvas.dataset.gpuUploadSource = "external-texture";
  canvas.dataset.matrixFallbackReason = "matrix-disabled: worker-offscreen";

  try {
    return {
      canvas: canvas.transferControlToOffscreen(),
      canvasWidth: surfaceSize.width,
      canvasHeight: surfaceSize.height,
    };
  } catch {
    return undefined;
  }
}
