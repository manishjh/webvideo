import { useEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import {
  type VideoPipeChannel,
  VideoPipePlayerController,
  type VideoPipeRenderClock,
  type VideoPipeRuntimeState,
} from "./playerController";
import { createSharedVideoViewportRenderer } from "./sharedViewport";

export interface VideoPipeChannelGroup {
  channel: VideoPipeChannel;
  tileIds: string[];
}

export interface VideoPipeViewportRuntimeOptions {
  adaptiveRenderFrameRate?: boolean;
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
  renderClock: VideoPipeRenderClock;
  targetBatches?: number;
  targetLatencyMs?: number;
}

export interface VideoPipeViewportProps {
  authToken?: string;
  canvasIdForTile?: (tileId: string) => string;
  channelGroups: VideoPipeChannelGroup[];
  children: ReactNode;
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
          key={group.channel.channelId}
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
  matrixCanvasId: string;
  options: VideoPipeViewportRuntimeOptions;
  serverCertificateHash?: string;
  onState: (tileIds: string[], state: VideoPipeRuntimeState) => void;
}

function VideoPipeChannelSession({
  authToken,
  canvasIdForTile,
  channelGroup,
  matrixCanvasId,
  options,
  serverCertificateHash,
  onState,
}: VideoPipeChannelSessionProps): null {
  const tileIdsRef = useRef(channelGroup.tileIds);
  const onStateRef = useRef(onState);
  const canvasIdForTileRef = useRef(canvasIdForTile);
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
    controllerRef.current?.updateRuntimeOptions({
      adaptiveRenderFrameRate: options.adaptiveRenderFrameRate,
      maxHighFrameRateRenderFrameRate: options.maxHighFrameRateRenderFrameRate,
      maxHighSourceFrameRate: options.maxHighSourceFrameRate,
      maxRenderFrameRate: options.maxRenderFrameRate,
      maxSourceCodedWidth: options.maxSourceCodedWidth,
      maxSourceCodedHeight: options.maxSourceCodedHeight,
      maxSourceFrameRate: options.maxSourceFrameRate,
      renderClock: options.renderClock,
    });
  }, [
    options.adaptiveRenderFrameRate,
    options.maxHighFrameRateRenderFrameRate,
    options.maxHighSourceFrameRate,
    options.maxRenderFrameRate,
    options.maxSourceCodedWidth,
    options.maxSourceCodedHeight,
    options.maxSourceFrameRate,
    options.renderClock,
  ]);

  useEffect(() => {
    const startupOptions = startupOptionsRef.current;
    const renderer = createSharedVideoViewportRenderer({
      getCanvasIds: () => tileIdsRef.current.map((tileId) => canvasIdForTileRef.current(tileId)),
      matrixCanvasId,
      matrixCompositor: startupOptions.matrixCompositor,
    });
    const firstTileId = tileIdsRef.current[0] ?? channelGroup.channel.channelId;
    const controller = new VideoPipePlayerController({
      tileId: `tile-${channelGroup.channel.channelId}`,
      channel: channelGroup.channel,
      canvasId: canvasIdForTileRef.current(firstTileId),
      renderer,
      authToken,
      serverCertificateHash,
      adaptiveRenderFrameRate: startupOptions.adaptiveRenderFrameRate,
      batchFrameCount: startupOptions.batchFrameCount,
      targetBatches: startupOptions.targetBatches,
      targetLatencyMs: startupOptions.targetLatencyMs ?? 150,
      maxHighFrameRateRenderFrameRate: startupOptions.maxHighFrameRateRenderFrameRate,
      maxHighSourceFrameRate: startupOptions.maxHighSourceFrameRate,
      maxRenderFrameRate: startupOptions.maxRenderFrameRate,
      maxSourceCodedWidth: startupOptions.maxSourceCodedWidth,
      maxSourceCodedHeight: startupOptions.maxSourceCodedHeight,
      maxSourceFrameRate: startupOptions.maxSourceFrameRate,
      chaosDisconnectAfterFrames: startupOptions.chaosDisconnectAfterFrames,
      chaosFrameDelayMs: startupOptions.chaosFrameDelayMs,
      chaosDropEveryNFrames: startupOptions.chaosDropEveryNFrames,
      renderClock: startupOptions.renderClock,
      onState: (nextState) => onStateRef.current(tileIdsRef.current, nextState),
    });
    controllerRef.current = controller;
    controller.start();

    return () => {
      controllerRef.current = undefined;
      controller.stop();
    };
  }, [
    authToken,
    channelGroup.channel,
    matrixCanvasId,
    serverCertificateHash,
  ]);

  return null;
}

function defaultCanvasIdForTile(tileId: string): string {
  return `video-pipe-canvas-${tileId}`;
}
