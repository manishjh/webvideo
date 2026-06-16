import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const profileEnabled = process.env.WEBVIDEO_E2E_PROFILE === "1";
const durationMs = Number(process.env.WEBVIDEO_PROFILE_DURATION_MS ?? "20000");
const sampleIntervalMs = Number(process.env.WEBVIDEO_PROFILE_SAMPLE_INTERVAL_MS ?? "1000");
const warmupDiscardMs = Number(process.env.WEBVIDEO_PROFILE_WARMUP_DISCARD_MS ?? "5000");
const streamSets = parseStreamSets(process.env.WEBVIDEO_PROFILE_STREAM_SETS
  ?? "channel-4k-crowd|channel-4k-crowd,channel-15116604|channel-4k-crowd,channel-15116604,channel-16147856");
const outputDir = path.resolve(process.cwd(), "../.run/profiles");
const workspaceProcessMarker = path.resolve(process.cwd(), "..");
const vmsQuery = createVmsQuery();
const requireHardwareWebGpu = process.env.WEBVIDEO_REQUIRE_HARDWARE_WEBGPU === "1";
const expectedRtspSourceMatchers = parseExpectedRtspSourceMatchers(
  process.env.WEBVIDEO_PROFILE_EXPECT_RTSP_SOURCES ?? "",
);
const assertStableProfile = process.env.WEBVIDEO_PROFILE_ASSERT_STABLE === "1";
const minStableRenderFps = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_MIN_RENDER_FPS);
const cpuProfileEnabled = process.env.WEBVIDEO_PROFILE_CPU === "1";
const cpuProfileSampleIntervalUs = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_CPU_INTERVAL_US) ?? 1000;
const cpuProfileTopLimit = Number.parseInt(process.env.WEBVIDEO_PROFILE_CPU_TOP_LIMIT ?? "25", 10);
const systemProcessProfileEnabled = process.env.WEBVIDEO_PROFILE_SYSTEM !== "0";
const captureUnreadyProfile = process.env.WEBVIDEO_PROFILE_CAPTURE_UNREADY === "1";
const playbackReadyMinFrames = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_READY_MIN_FRAMES) ?? 30;
const playbackReadyTimeoutMs = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_READY_TIMEOUT_MS) ?? 45_000;
const visualHashesEnabled = process.env.WEBVIDEO_PROFILE_VISUAL_HASHES !== "0";
const serviceBudget120FpsMs = 1000 / 120;
const serviceBudget100FpsMs = 10;
const serviceBudget60FpsMs = 1000 / 60;

test.describe("VMS profiling", () => {
  test.skip(!profileEnabled, "Set WEBVIDEO_E2E_PROFILE=1 to run browser/server profiling.");
  test.setTimeout(streamSets.length * (durationMs + 90_000));

  for (const channels of streamSets) {
    test(`profiles ${channels.length} continuous stream${channels.length === 1 ? "" : "s"}`, async ({ page }, testInfo) => {
      const cdp = await createCdpPerformanceSession(page);
      await installLongTaskObserver(page);

      await page.goto(`/vms.html${vmsQuery}`);
      await expect(page.getByTestId("channel-picker-status")).toContainText("channels");

      for (const channelId of channels) {
        await page.getByTestId(`add-channel-${channelId}`).click({ force: true });
      }

      const targets = await resolveProfileTileTargets(page, channels);
      const readiness = await waitForProfilePlayback(page, targets);
      if (!readiness.ready && !captureUnreadyProfile) {
        throw readiness.error;
      }
      if (!readiness.ready) {
        console.warn(`Capturing profile before all tiles reached readiness: ${readiness.error.message}`);
      }

      const workerCpuCapture = await startWorkerCpuProfileCapture(cdp);
      const cpuCapture = await startCpuProfile(cdp, workerCpuCapture);
      const timeline: ProfileSample[] = [];
      const deadline = Date.now() + durationMs;
      timeline.push(await captureProfileSample(page, targets, cdp));
      while (Date.now() < deadline) {
        await page.waitForTimeout(Math.min(sampleIntervalMs, Math.max(0, deadline - Date.now())));
        timeline.push(await captureProfileSample(page, targets, cdp));
      }
      const cpuProfile = await cpuCapture?.stop();

      const summary = summarizeProfile(targets, timeline);
      const systemProcessSummary = summarizeSystemProcesses(timeline);
      const artifact = {
        scenario: {
          channels,
          tiles: targets,
          durationMs,
          sampleIntervalMs,
          capturedAtUnixTimeMs: Date.now(),
          readyBeforeCapture: readiness.ready,
          readinessError: readiness.ready ? undefined : readiness.error.message,
          cpuProfileEnabled: Boolean(cpuProfile),
          cpuProfileSampleIntervalUs: cpuProfile ? cpuProfile.sampleIntervalUs : undefined,
          cpuProfileWorkerCount: cpuProfile?.workerProfiles.length ?? 0,
          systemProcessProfileEnabled,
        },
        summary,
        systemProcessSummary,
        cpuProfileSummary: cpuProfile?.summary,
        workerCpuProfileSummaries: cpuProfile?.workerProfiles.map((profile) => ({
          targetId: profile.targetId,
          type: profile.type,
          title: profile.title,
          url: profile.url,
          summary: profile.summary,
        })),
        timeline,
      };
      const fileName = `vms-profile-${channels.length}streams-${Date.now()}.json`;
      await mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, fileName);
      await writeFile(outputPath, JSON.stringify(artifact, null, 2));
      let cpuProfilePath: string | undefined;
      if (cpuProfile) {
        cpuProfilePath = outputPath.replace(/\.json$/, ".cpuprofile");
        await writeFile(cpuProfilePath, JSON.stringify(cpuProfile.profile));
      }
      let workerCpuProfilesPath: string | undefined;
      if (cpuProfile?.workerProfiles.length) {
        workerCpuProfilesPath = outputPath.replace(/\.json$/, ".workers.cpuprofiles.json");
        await writeFile(workerCpuProfilesPath, JSON.stringify(cpuProfile.workerProfiles, null, 2));
      }

      console.log(`VMS profile ${channels.length} stream(s): ${outputPath}`);
      if (cpuProfilePath) {
        console.log(`VMS CPU profile ${channels.length} stream(s): ${cpuProfilePath}`);
      }
      if (workerCpuProfilesPath) {
        console.log(`VMS worker CPU profiles ${channels.length} stream(s): ${workerCpuProfilesPath}`);
      }
      console.log(JSON.stringify(summary, null, 2));
      if (cpuProfile?.summary) {
        console.log(JSON.stringify({ cpuProfile: cpuProfile.summary }, null, 2));
      }
      if (systemProcessSummary.length > 0) {
        console.log(JSON.stringify({ systemProcesses: systemProcessSummary }, null, 2));
      }
      if (cpuProfile?.workerProfiles.length) {
        console.log(JSON.stringify({
          workerCpuProfiles: cpuProfile.workerProfiles.map((profile) => ({
            targetId: profile.targetId,
            type: profile.type,
            url: profile.url,
            summary: profile.summary,
          })),
        }, null, 2));
      }

      await testInfo.attach("vms-profile-summary.json", {
        body: JSON.stringify(summary, null, 2),
        contentType: "application/json",
      });
      if (cpuProfile?.summary) {
        await testInfo.attach("vms-cpu-profile-summary.json", {
          body: JSON.stringify(cpuProfile.summary, null, 2),
          contentType: "application/json",
        });
      }
      if (systemProcessSummary.length > 0) {
        await testInfo.attach("vms-system-process-summary.json", {
          body: JSON.stringify(systemProcessSummary, null, 2),
          contentType: "application/json",
        });
      }
      if (cpuProfilePath) {
        await testInfo.attach("vms-cpu-profile.cpuprofile", {
          path: cpuProfilePath,
          contentType: "application/json",
        });
      }
      if (workerCpuProfilesPath) {
        await testInfo.attach("vms-worker-cpu-profiles.json", {
          path: workerCpuProfilesPath,
          contentType: "application/json",
        });
      }
      await testInfo.attach("vms-profile-timeline.json", {
        body: JSON.stringify(timeline, null, 2),
        contentType: "application/json",
      });
      await testInfo.attach("vms-profile-page.png", {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });

      expect(timeline.length, "profile samples captured").toBeGreaterThan(1);
      if (assertStableProfile) {
        assertStableProfileWindow(targets, timeline);
      }
      for (const target of targets) {
        const finalTile = timeline[timeline.length - 1]?.tiles[target.tileId];
        expect(finalTile?.status, `${target.tileId} final status`).toMatch(/playing|holding/);
        expect(finalTile?.activeTransport, `${target.tileId} transport`).toBe("webtransport-quic");
        expect(finalTile?.decodeBackend, `${target.tileId} decode backend`).toBe("webcodecs");
        expect(finalTile?.framesRendered ?? 0, `${target.tileId} rendered frames`).toBeGreaterThan(0);
        expect(finalTile?.messagesReceived ?? 0, `${target.tileId} received frames`).toBeGreaterThan(0);
        const expectedRtspSource = expectedRtspSourceMatchers.get(target.channelId);
        if (expectedRtspSource) {
          const finalBackend = selectBackendMetric(
            timeline[timeline.length - 1]?.backendMetrics ?? [],
            finalTile?.streamId ?? "",
            expectedRtspSource,
          );
          expect(
            finalBackend?.rtspUrl ?? "",
            `${target.tileId} selected RTSP source`,
          ).toContain(expectedRtspSource);
        }
        if (requireHardwareWebGpu) {
          expect(finalTile?.renderBackend, `${target.tileId} render backend`).toBe("webgpu");
          expect(["external-texture", "videoframe-copy", "videoframe-bitmap-copy"], `${target.tileId} GPU upload source`).toContain(finalTile?.canvasGpuUploadSource);
          expect(["webgpu-canvas", "worker-offscreen-webgpu-canvas", "worker-offscreen-matrix-canvas"], `${target.tileId} GPU presentation`).toContain(finalTile?.canvasGpuPresentation);
          expect(finalTile?.canvasGpuAdapterVendor && finalTile.canvasGpuAdapterVendor !== "google", `${target.tileId} GPU vendor`).toBe(true);
          expect(finalTile?.canvasGpuAdapterArchitecture && finalTile.canvasGpuAdapterArchitecture !== "swiftshader", `${target.tileId} GPU architecture`).toBe(true);
        }
      }
    });
  }
});

interface ProfileTileTarget {
  tileId: string;
  channelId: string;
}

interface ProfileSample {
  capturedAtUnixTimeMs: number;
  tiles: Record<string, TileProfileSnapshot>;
  matrix: MatrixProfileSnapshot;
  backendMetrics: BackendMetricSnapshot[];
  egressMetrics: EgressMetricSnapshot[];
  processMetrics?: ProcessMetricSnapshot;
  systemProcesses: SystemProcessSnapshot[];
  browserMetrics: Record<string, number>;
  longTasks: LongTaskSnapshot;
}

interface TileProfileSnapshot {
  channelId: string;
  streamId: string;
  status: string;
  error?: string;
  sourceRtspUrl: string;
  activeTransport?: string;
  decodeBackend?: string;
  decodePipeline?: string;
  renderBackend?: string;
  sourceFrameRate: number;
  desiredSourceFrameRate?: number;
  desiredMaxCodedWidth?: number;
  desiredMaxCodedHeight?: number;
  canvasBackingWidth: number;
  canvasBackingHeight: number;
  canvasCssWidth: number;
  canvasCssHeight: number;
  framesRendered: number;
  framesDropped: number;
  framesRateLimited: number;
  messagesReceived: number;
  bytesReceived: number;
  sequenceGapFrames: number;
  frameHitches: number;
  severeFrameHitches: number;
  renderFps: number;
  renderFrameRateLimit: number;
  adaptiveRenderPressureLevel: number;
  cumulativeFps: number;
  frameIntervalP95Ms: number;
  frameIntervalP99Ms: number;
  frameIntervalMaxMs: number;
  receiveIntervalP95Ms: number;
  rafIntervalP95Ms: number;
  decodeBacklogMaxFrames: number;
  renderQueueMaxFrames: number;
  sourceToRenderP50Ms: number;
  sourceToRenderP95Ms: number;
  serverToRenderP95Ms: number;
  receiveToRenderP50Ms: number;
  receiveToRenderP95Ms: number;
  decodeP95Ms: number;
  renderP95Ms: number;
  renderImportExternalTextureP95Ms: number;
  renderBindGroupP95Ms: number;
  renderUniformP95Ms: number;
  renderEncodeP95Ms: number;
  renderSubmitP95Ms: number;
  renderBudgetOverrun120Fps: number;
  renderBudgetOverrun100Fps: number;
  renderBudgetOverrun60Fps: number;
  renderImportBudgetOverrun120Fps: number;
  renderImportBudgetOverrun100Fps: number;
  renderImportBudgetOverrun60Fps: number;
  lastSequenceNumber: number;
  connectionOpenCount: number;
  protocolEndFrameCount: number;
  sourceSwitchCount: number;
  sourceSwitchReason?: string;
  visualHash?: string;
  matrixPresentMode?: string;
  matrixPresentPath?: string;
  matrixFlushCount?: number;
  matrixPresentCount?: number;
  matrixDrawCount?: number;
  matrixExternalImportCount?: number;
  matrixBindGroupCount?: number;
  matrixVideoFrameCopyCount?: number;
  matrixLastDirtySlotCount?: number;
  canvasMatrixFallbackReason?: string;
  canvasWebGpuError?: string;
  webGpuDisabledReason?: string;
  canvasGpuUploadSource?: string;
  canvasGpuPresentation?: string;
  canvasGpuAdapterVendor?: string;
  canvasGpuAdapterArchitecture?: string;
}

interface MatrixProfileSnapshot {
  presentMode?: string;
  presentPath?: string;
  flushCount: number;
  presentCount: number;
  drawCount: number;
  externalImportCount: number;
  bindGroupCount: number;
  videoFrameCopyCount: number;
  lastDirtySlotCount: number;
  slotCount: number;
}

interface BackendMetricSnapshot {
  streamId: string;
  rtspUrl: string;
  readerRunning?: boolean;
  processRunning?: boolean;
  subscriberCount: number;
  framesRead: number;
  bytesRead: number;
  subscriberFramesDropped: number;
  maxFrameIntervalMs?: number;
  lastFrameAgeMs?: number;
  recentFrameIntervalP95Ms?: number;
  recentFrameIntervalMaxMs?: number;
  recentFrameHitches?: number;
  recentSevereFrameHitches?: number;
  ingressFps?: number;
  publishedFps?: number;
  subscriberReadFps?: number;
  recentIngressFps?: number;
  recentPublishedFps?: number;
  recentSubscriberReadFps?: number;
  subscribers?: Array<{
    pendingFrames: number;
    framesRead: number;
    framesDropped: number;
    recentReadFps?: number;
  }>;
}

interface EgressMetricSnapshot {
  channelId: string;
  streamId: string;
  streamsOpened: number;
  framesDequeued: number;
  framesSent: number;
  framesSkippedBeforeKeyFrame: number;
  framesSkippedStale: number;
  sequenceGapEvents: number;
  sequenceGapFrames: number;
  writeErrors: number;
  bytesSent: number;
  recentSentFps: number;
  dequeueAgeMs: TimingSummary;
  writeMs: TimingSummary;
  payloadBytes: TimingSummary;
}

interface TimingSummary {
  count: number;
  average: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  latest: number;
}

interface ProcessMetricSnapshot {
  processId: number;
  totalProcessorTimeMs: number;
  workingSetBytes: number;
  privateMemoryBytes: number;
  gcHeapBytes: number;
  threadCount: number;
}

interface SystemProcessSnapshot {
  role: string;
  processId: number;
  parentProcessId: number;
  cpuPercent: number;
  memoryPercent: number;
  residentSetBytes: number;
  command: string;
  args: string;
}

interface SystemProcessSummary {
  role: string;
  processId: number;
  command: string;
  averageCpuPercent: number;
  maxCpuPercent: number;
  averageResidentSetMb: number;
  maxResidentSetMb: number;
  samples: number;
}

interface LongTaskSnapshot {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

interface CpuProfileCapture {
  stop(): Promise<CpuProfileArtifact | undefined>;
}

interface CpuProfileArtifact {
  profile: CdpCpuProfile;
  sampleIntervalUs: number;
  summary: CpuProfileSummary;
  workerProfiles: WorkerCpuProfileArtifact[];
}

interface WorkerCpuProfileArtifact {
  targetId: string;
  type: string;
  title: string;
  url: string;
  profile: CdpCpuProfile;
  sampleIntervalUs: number;
  summary: CpuProfileSummary;
}

interface CpuProfileSummary {
  sampledTimeMs: number;
  nodeCount: number;
  sampleCount: number;
  topSelfTime: CpuProfileNodeSummary[];
  topScriptSelfTime: CpuProfileScriptSummary[];
}

interface CpuProfileNodeSummary {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
  selfTimeMs: number;
  selfPercent: number;
  hitCount: number;
}

interface CpuProfileScriptSummary {
  url: string;
  selfTimeMs: number;
  selfPercent: number;
}

interface CdpCpuProfile {
  startTime: number;
  endTime: number;
  nodes: CdpCpuProfileNode[];
  samples?: number[];
  timeDeltas?: number[];
}

interface CdpCpuProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount?: number;
  children?: number[];
}

interface CdpTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface CdpAttachedToTargetEvent {
  sessionId: string;
  targetInfo: CdpTargetInfo;
}

interface CdpReceivedMessageFromTargetEvent {
  sessionId: string;
  message: string;
}

interface CdpDetachedFromTargetEvent {
  sessionId: string;
}

interface WorkerCpuProfileTarget {
  sessionId: string;
  targetId: string;
  type: string;
  title: string;
  url: string;
  started: boolean;
  detached: boolean;
}

interface CdpTargetMessagePayload {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

function parseStreamSets(value: string): string[][] {
  return value
    .split("|")
    .map((set) => set
      .split(",")
      .map((channel) => channel.trim())
      .filter((channel) => channel.length > 0))
    .filter((set) => set.length > 0);
}

function parseExpectedRtspSourceMatchers(value: string): Map<string, string> {
  const matchers = new Map<string, string>();
  for (const entry of value.split(/[|,]/)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.includes("=") ? trimmed.indexOf("=") : trimmed.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
      continue;
    }

    matchers.set(
      trimmed.slice(0, separatorIndex).trim(),
      trimmed.slice(separatorIndex + 1).trim(),
    );
  }

  return matchers;
}

function readOptionalPositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function createVmsQuery(): string {
  const params = new URLSearchParams();
  if (process.env.WEBVIDEO_VMS_MATRIX === "0") {
    params.set("matrix", "0");
  }
  if (process.env.WEBVIDEO_VMS_RENDER_CLOCK) {
    params.set("renderClock", process.env.WEBVIDEO_VMS_RENDER_CLOCK);
  }
  if (process.env.WEBVIDEO_VMS_MATRIX_FLUSH) {
    params.set("matrixFlush", process.env.WEBVIDEO_VMS_MATRIX_FLUSH);
  }
  if (process.env.WEBVIDEO_VMS_MATRIX_PRESENT) {
    params.set("matrixPresent", process.env.WEBVIDEO_VMS_MATRIX_PRESENT);
  }
  if (process.env.WEBVIDEO_VMS_MATRIX_TEXTURE) {
    params.set("matrixTexture", process.env.WEBVIDEO_VMS_MATRIX_TEXTURE);
  }
  if (process.env.WEBVIDEO_VMS_MATRIX_RETAIN) {
    params.set("matrixRetain", process.env.WEBVIDEO_VMS_MATRIX_RETAIN);
  }
  if (process.env.WEBVIDEO_VMS_MEDIA_WORKER) {
    params.set("mediaWorker", process.env.WEBVIDEO_VMS_MEDIA_WORKER);
  }
  if (process.env.WEBVIDEO_VMS_DECODE_WORKER) {
    params.set("decodeWorker", process.env.WEBVIDEO_VMS_DECODE_WORKER);
  }
  if (process.env.WEBVIDEO_VMS_OFFSCREEN) {
    params.set("offscreen", process.env.WEBVIDEO_VMS_OFFSCREEN);
  }
  if (process.env.WEBVIDEO_VMS_OFFSCREEN_VIEWPORT) {
    params.set("offscreenViewport", process.env.WEBVIDEO_VMS_OFFSCREEN_VIEWPORT);
  }
  if (process.env.WEBVIDEO_VMS_WORKER_TEXTURE) {
    params.set("workerTexture", process.env.WEBVIDEO_VMS_WORKER_TEXTURE);
  }
  if (process.env.WEBVIDEO_VMS_PREDECODE_ADMISSION) {
    params.set("predecodeFrameAdmission", process.env.WEBVIDEO_VMS_PREDECODE_ADMISSION);
  }
  if (process.env.WEBVIDEO_VMS_GPU_POWER) {
    params.set("webgpuPower", process.env.WEBVIDEO_VMS_GPU_POWER);
  }
  if (process.env.WEBVIDEO_VMS_ADAPTIVE_RENDER) {
    params.set("adaptiveRender", process.env.WEBVIDEO_VMS_ADAPTIVE_RENDER);
  }
  if (process.env.WEBVIDEO_VMS_ADAPTIVE_SOURCE) {
    params.set("adaptiveSource", process.env.WEBVIDEO_VMS_ADAPTIVE_SOURCE);
  }
  if (process.env.WEBVIDEO_VMS_MAX_RENDER_FPS) {
    params.set("maxRenderFps", process.env.WEBVIDEO_VMS_MAX_RENDER_FPS);
  }
  if (process.env.WEBVIDEO_VMS_MAX_HIGH_FPS_RENDER_FPS) {
    params.set("maxHighFpsRenderFps", process.env.WEBVIDEO_VMS_MAX_HIGH_FPS_RENDER_FPS);
  }
  if (process.env.WEBVIDEO_VMS_MAX_HIGH_SOURCE_FPS) {
    params.set("maxHighSourceFps", process.env.WEBVIDEO_VMS_MAX_HIGH_SOURCE_FPS);
  }
  if (process.env.WEBVIDEO_VMS_MAX_SOURCE_FPS) {
    params.set("maxSourceFps", process.env.WEBVIDEO_VMS_MAX_SOURCE_FPS);
  }
  if (process.env.WEBVIDEO_VMS_MAX_SOURCE_WIDTH) {
    params.set("maxSourceWidth", process.env.WEBVIDEO_VMS_MAX_SOURCE_WIDTH);
  }
  if (process.env.WEBVIDEO_VMS_MAX_SOURCE_HEIGHT) {
    params.set("maxSourceHeight", process.env.WEBVIDEO_VMS_MAX_SOURCE_HEIGHT);
  }
  if (process.env.WEBVIDEO_VMS_TARGET_LATENCY_MS) {
    params.set("targetLatencyMs", process.env.WEBVIDEO_VMS_TARGET_LATENCY_MS);
  }

  const query = params.toString();
  return query.length > 0 ? `?${query}` : "";
}

function assertStableProfileWindow(targets: readonly ProfileTileTarget[], timeline: readonly ProfileSample[]): void {
  const firstSample = timeline[0];
  if (!firstSample) {
    throw new Error("No profile samples captured.");
  }

  const firstSteadyIndex = Math.max(
    0,
    timeline.findIndex((sample) => sample.capturedAtUnixTimeMs - firstSample.capturedAtUnixTimeMs >= warmupDiscardMs),
  );
  const first = timeline[firstSteadyIndex] ?? firstSample;
  const last = timeline[timeline.length - 1] ?? first;
  const elapsedSeconds = Math.max((last.capturedAtUnixTimeMs - first.capturedAtUnixTimeMs) / 1000, 0.001);
  const firstEgressByChannel = new Map(first.egressMetrics.map((metric) => [metric.channelId, metric]));
  const lastEgressByChannel = new Map(last.egressMetrics.map((metric) => [metric.channelId, metric]));

  for (const target of targets) {
    const before = first.tiles[target.tileId];
    const after = last.tiles[target.tileId];
    const backendAfter = selectBackendMetric(last.backendMetrics, after.streamId);
    const backendBefore = selectBackendMetric(first.backendMetrics, after.streamId, backendAfter?.rtspUrl);
    const egressBefore = firstEgressByChannel.get(target.channelId);
    const egressAfter = lastEgressByChannel.get(target.channelId);
    const renderedFps = (after.framesRendered - before.framesRendered) / elapsedSeconds;

    expect(after.status, `${target.tileId} stable status`).toMatch(/playing|holding/);
    expect(after.framesDropped - before.framesDropped, `${target.tileId} client drops`).toBe(0);
    expect(after.sequenceGapFrames - before.sequenceGapFrames, `${target.tileId} sequence gap frames`).toBe(0);
    expect(after.severeFrameHitches - before.severeFrameHitches, `${target.tileId} severe hitches`).toBe(0);
    expect(
      (backendAfter?.subscriberFramesDropped ?? 0) - (backendBefore?.subscriberFramesDropped ?? 0),
      `${target.tileId} backend subscriber drops`,
    ).toBe(0);
    expect(
      (egressAfter?.framesSkippedBeforeKeyFrame ?? 0) - (egressBefore?.framesSkippedBeforeKeyFrame ?? 0),
      `${target.tileId} egress pre-key skips`,
    ).toBe(0);
    expect(
      (egressAfter?.framesSkippedStale ?? 0) - (egressBefore?.framesSkippedStale ?? 0),
      `${target.tileId} egress stale skips`,
    ).toBe(0);
    if (minStableRenderFps !== undefined) {
      expect(renderedFps, `${target.tileId} stable rendered FPS`).toBeGreaterThanOrEqual(minStableRenderFps);
    }
    if (visualHashesEnabled) {
      const visualMotion = summarizeVisualHashes(timeline.slice(firstSteadyIndex), target.tileId);
      expect(visualMotion.uniqueHashes, `${target.tileId} visible video changed`).toBeGreaterThan(1);
      expect(visualMotion.changes, `${target.tileId} visible video hash changes`).toBeGreaterThan(0);
    }
  }
}

async function createCdpPerformanceSession(page: Page): Promise<CDPSession | undefined> {
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    return session;
  } catch {
    return undefined;
  }
}

class CdpTargetSessionRouter {
  private nextMessageId = 1;
  private readonly pending = new Map<string, Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>>();

  public constructor(private readonly cdp: CDPSession) {
    this.cdp.on("Target.receivedMessageFromTarget", (event: CdpReceivedMessageFromTargetEvent) => {
      this.handleMessage(event);
    });
    this.cdp.on("Target.detachedFromTarget", (event: CdpDetachedFromTargetEvent) => {
      this.rejectSession(event.sessionId, new Error(`CDP target session '${event.sessionId}' detached.`));
    });
  }

  public send(sessionId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextMessageId++;
    const message = JSON.stringify({
      id,
      method,
      params: params ?? {},
    });
    let sessionPending = this.pending.get(sessionId);
    if (!sessionPending) {
      sessionPending = new Map();
      this.pending.set(sessionId, sessionPending);
    }

    const response = new Promise<unknown>((resolve, reject) => {
      sessionPending!.set(id, { resolve, reject });
    });
    void this.cdp.send("Target.sendMessageToTarget", { sessionId, message }).catch((error: unknown) => {
      const pending = sessionPending!.get(id);
      sessionPending!.delete(id);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return response;
  }

  private handleMessage(event: CdpReceivedMessageFromTargetEvent): void {
    let payload: CdpTargetMessagePayload;
    try {
      payload = JSON.parse(event.message) as CdpTargetMessagePayload;
    } catch {
      return;
    }
    if (payload.id === undefined) {
      return;
    }

    const sessionPending = this.pending.get(event.sessionId);
    const pending = sessionPending?.get(payload.id);
    if (!pending) {
      return;
    }

    sessionPending?.delete(payload.id);
    if (payload.error) {
      pending.reject(new Error(payload.error.message ?? "CDP target command failed."));
      return;
    }

    pending.resolve(payload.result);
  }

  private rejectSession(sessionId: string, error: Error): void {
    const sessionPending = this.pending.get(sessionId);
    if (!sessionPending) {
      return;
    }

    this.pending.delete(sessionId);
    for (const pending of sessionPending.values()) {
      pending.reject(error);
    }
  }
}

class WorkerCpuProfileCapture {
  private readonly router: CdpTargetSessionRouter;
  private readonly targets = new Map<string, WorkerCpuProfileTarget>();
  private profilingActive = false;

  public constructor(private readonly cdp: CDPSession) {
    this.router = new CdpTargetSessionRouter(cdp);
    this.cdp.on("Target.detachedFromTarget", (event: CdpDetachedFromTargetEvent) => {
      const target = this.targets.get(event.sessionId);
      if (target) {
        target.detached = true;
      }
    });
  }

  public async start(): Promise<void> {
    this.cdp.on("Target.attachedToTarget", (event: CdpAttachedToTargetEvent) => {
      void this.startTarget(event);
    });
    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await this.attachExistingWorkerTargets();
  }

  public async startProfiling(): Promise<void> {
    this.profilingActive = true;
    await Promise.all([...this.targets.values()].map((target) => this.startProfilerOnTarget(target)));
  }

  public async stop(): Promise<WorkerCpuProfileArtifact[]> {
    const wasProfilingActive = this.profilingActive;
    this.profilingActive = false;
    try {
      await this.cdp.send("Target.setAutoAttach", {
        autoAttach: false,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
    } catch {
      // Worker auto-attach is profiling-only; failing to detach should not fail the scenario.
    }

    const profiles: WorkerCpuProfileArtifact[] = [];
    if (!wasProfilingActive) {
      return profiles;
    }

    for (const target of this.targets.values()) {
      if (!target.started || target.detached) {
        continue;
      }

      try {
        const response = await this.router.send(target.sessionId, "Profiler.stop") as { profile?: CdpCpuProfile };
        if (!response.profile) {
          continue;
        }

        profiles.push({
          targetId: target.targetId,
          type: target.type,
          title: target.title,
          url: normalizeCpuProfileUrl(target.url),
          profile: response.profile,
          sampleIntervalUs: cpuProfileSampleIntervalUs,
          summary: summarizeCpuProfile(response.profile),
        });
      } catch {
        // Detached or crashed workers are useful to know about in the timeline, but not worth failing profiling.
      }
    }

    return profiles;
  }

  private async startTarget(event: CdpAttachedToTargetEvent): Promise<void> {
    const target = {
      sessionId: event.sessionId,
      targetId: event.targetInfo.targetId,
      type: event.targetInfo.type,
      title: event.targetInfo.title,
      url: event.targetInfo.url,
      started: false,
      detached: false,
    };

    if (!isProfiledWorkerTarget(target.type)) {
      await this.runIfWaitingForDebugger(target.sessionId);
      return;
    }

    this.targets.set(target.sessionId, target);
    if (this.profilingActive) {
      await this.startProfilerOnTarget(target);
    }
    await this.runIfWaitingForDebugger(target.sessionId);
  }

  private async startProfilerOnTarget(target: WorkerCpuProfileTarget): Promise<void> {
    if (target.started || target.detached) {
      return;
    }

    try {
      await this.router.send(target.sessionId, "Profiler.enable");
      await this.router.send(target.sessionId, "Profiler.setSamplingInterval", {
        interval: Math.max(100, Math.floor(cpuProfileSampleIntervalUs)),
      });
      await this.router.send(target.sessionId, "Profiler.start");
      target.started = true;
    } catch {
      // Keep the worker running even if profiling this target is unavailable.
    }
  }

  private async runIfWaitingForDebugger(sessionId: string): Promise<void> {
    try {
      await this.router.send(sessionId, "Runtime.runIfWaitingForDebugger");
    } catch {
      // Some targets may detach before the command lands.
    }
  }

  private async attachExistingWorkerTargets(): Promise<void> {
    let response: { targetInfos?: CdpTargetInfo[] };
    try {
      response = await this.cdp.send("Target.getTargets") as { targetInfos?: CdpTargetInfo[] };
    } catch {
      return;
    }

    const attachedTargetIds = new Set([...this.targets.values()].map((target) => target.targetId));
    for (const targetInfo of response.targetInfos ?? []) {
      if (!isProfiledWorkerTarget(targetInfo.type) || attachedTargetIds.has(targetInfo.targetId)) {
        continue;
      }

      try {
        const attachResponse = await this.cdp.send("Target.attachToTarget", {
          targetId: targetInfo.targetId,
          flatten: true,
        }) as { sessionId?: string };
        if (!attachResponse.sessionId) {
          continue;
        }

        attachedTargetIds.add(targetInfo.targetId);
        await this.startTarget({
          sessionId: attachResponse.sessionId,
          targetInfo,
        });
      } catch {
        // Worker targets can disappear while the page is changing tile state.
      }
    }
  }
}

function isProfiledWorkerTarget(type: string): boolean {
  return type === "worker" || type === "shared_worker" || type === "service_worker";
}

async function startWorkerCpuProfileCapture(cdp?: CDPSession): Promise<WorkerCpuProfileCapture | undefined> {
  if (!cpuProfileEnabled || !cdp) {
    return undefined;
  }

  try {
    const capture = new WorkerCpuProfileCapture(cdp);
    await capture.start();
    return capture;
  } catch {
    return undefined;
  }
}

async function startCpuProfile(
  cdp?: CDPSession,
  workerCapture?: WorkerCpuProfileCapture,
): Promise<CpuProfileCapture | undefined> {
  if (!cpuProfileEnabled || !cdp) {
    return undefined;
  }

  try {
    await workerCapture?.startProfiling();
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", {
      interval: Math.max(100, Math.floor(cpuProfileSampleIntervalUs)),
    });
    await cdp.send("Profiler.start");
    return {
      async stop(): Promise<CpuProfileArtifact | undefined> {
        try {
          const response = await cdp.send("Profiler.stop") as { profile: CdpCpuProfile };
          const workerProfiles = await workerCapture?.stop() ?? [];
          return {
            profile: response.profile,
            sampleIntervalUs: cpuProfileSampleIntervalUs,
            summary: summarizeCpuProfile(response.profile),
            workerProfiles,
          };
        } catch {
          await workerCapture?.stop();
          return undefined;
        }
      },
    };
  } catch {
    await workerCapture?.stop();
    return undefined;
  }
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const target = window as typeof window & {
      __webvideoProfileLongTasks?: Array<{ duration: number; startTime: number }>;
    };
    target.__webvideoProfileLongTasks = [];
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          target.__webvideoProfileLongTasks?.push({
            duration: entry.duration,
            startTime: entry.startTime,
          });
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Browser long-task support is best-effort profiling metadata.
    }
  });
}

async function waitForProfilePlayback(
  page: Page,
  targets: readonly ProfileTileTarget[],
): Promise<{ ready: true } | { ready: false; error: Error }> {
  try {
    await page.waitForFunction(
    ({ expectedTargets, minFrames }) => expectedTargets.every(({ tileId }) => {
      const tile = window.__webvideoVmsState?.tiles[tileId];
      return tile
        && (tile.status === "playing" || tile.status === "holding")
        && tile.activeTransport === "webtransport-quic"
        && tile.decodeBackend === "webcodecs"
        && Boolean(tile.renderBackend)
        && tile.connectionOpenCount === 1
        && tile.protocolEndFrameCount === 0
        && tile.metrics.framesRendered >= minFrames
        && tile.metrics.messagesReceived >= minFrames;
    }),
    { expectedTargets: targets, minFrames: playbackReadyMinFrames },
    { timeout: playbackReadyTimeoutMs },
    );
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

async function resolveProfileTileTargets(page: Page, channels: readonly string[]): Promise<ProfileTileTarget[]> {
  await page.waitForFunction(
    (expectedTileCount) => (window.__webvideoVmsState?.activeTiles.length ?? 0) >= expectedTileCount,
    channels.length,
    { timeout: 10_000 },
  );
  const targets = await page.evaluate(() => window.__webvideoVmsState?.activeTiles.map((tile) => ({
    tileId: tile.tileId,
    channelId: tile.channelId,
  })) ?? []);
  return targets.slice(-channels.length);
}

async function captureProfileSample(
  page: Page,
  targets: readonly ProfileTileTarget[],
  cdp?: CDPSession,
): Promise<ProfileSample> {
  const [pageSnapshot, backendMetrics, egressMetrics, processMetrics, browserMetrics, systemProcesses] = await Promise.all([
    capturePageSnapshot(page, targets),
    fetchJson<BackendMetricSnapshot[]>(page, "/api/demo/live/metrics", []),
    fetchJson<EgressMetricSnapshot[]>(page, "/api/demo/live/egress-metrics", []),
    fetchJson<ProcessMetricSnapshot | undefined>(page, "/api/demo/live/process-metrics", undefined),
    captureBrowserMetrics(cdp),
    captureSystemProcesses(),
  ]);
  const visualHashes = visualHashesEnabled ? await captureTileVisualHashes(page, targets) : {};
  for (const [tileId, visualHash] of Object.entries(visualHashes)) {
    if (pageSnapshot.tiles[tileId]) {
      pageSnapshot.tiles[tileId].visualHash = visualHash;
    }
  }

  return {
    capturedAtUnixTimeMs: Date.now(),
    tiles: pageSnapshot.tiles,
    matrix: pageSnapshot.matrix,
    backendMetrics,
    egressMetrics,
    processMetrics,
    systemProcesses,
    browserMetrics,
    longTasks: pageSnapshot.longTasks,
  };
}

async function capturePageSnapshot(
  page: Page,
  targets: readonly ProfileTileTarget[],
): Promise<{ tiles: Record<string, TileProfileSnapshot>; matrix: MatrixProfileSnapshot; longTasks: LongTaskSnapshot }> {
  return await page.evaluate((expectedTargets) => {
    const tiles: Record<string, TileProfileSnapshot> = {};
    const readDatasetNumber = (element: HTMLElement | undefined | null, name: string): number | undefined => {
      const parsed = Number(element?.dataset[name] ?? "");
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    for (const target of expectedTargets) {
      const tile = window.__webvideoVmsState?.tiles[target.tileId];
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${target.tileId}']`);
      const rect = canvas?.getBoundingClientRect();
      tiles[target.tileId] = {
        channelId: target.channelId,
        streamId: tile?.streamId ?? "",
        status: tile?.status ?? "missing",
        error: tile?.error,
        sourceRtspUrl: tile?.sourceRtspUrl ?? "",
        activeTransport: tile?.activeTransport,
        decodeBackend: tile?.decodeBackend,
        decodePipeline: tile?.decodePipeline,
        renderBackend: tile?.renderBackend,
        sourceFrameRate: tile?.sourceFrameRate ?? 0,
        desiredSourceFrameRate: tile?.desiredSourceFrameRate,
        desiredMaxCodedWidth: tile?.desiredMaxCodedWidth,
        desiredMaxCodedHeight: tile?.desiredMaxCodedHeight,
        canvasBackingWidth: canvas?.width ?? 0,
        canvasBackingHeight: canvas?.height ?? 0,
        canvasCssWidth: rect?.width ?? 0,
        canvasCssHeight: rect?.height ?? 0,
        framesRendered: tile?.metrics.framesRendered ?? 0,
        framesDropped: tile?.metrics.framesDropped ?? 0,
        framesRateLimited: tile?.metrics.framesRateLimited ?? 0,
        messagesReceived: tile?.metrics.messagesReceived ?? 0,
        bytesReceived: tile?.metrics.bytesReceived ?? 0,
        sequenceGapFrames: tile?.metrics.sequenceGapFrames ?? 0,
        frameHitches: tile?.metrics.frameHitches ?? 0,
        severeFrameHitches: tile?.metrics.severeFrameHitches ?? 0,
        renderFps: tile?.metrics.renderFps ?? 0,
        renderFrameRateLimit: tile?.renderFrameRateLimit ?? 0,
        adaptiveRenderPressureLevel: tile?.adaptiveRenderPressureLevel ?? 0,
        cumulativeFps: tile?.metrics.fps ?? 0,
        frameIntervalP95Ms: tile?.metrics.frameInterval.p95Ms ?? 0,
        frameIntervalP99Ms: tile?.metrics.frameInterval.p99Ms ?? 0,
        frameIntervalMaxMs: tile?.metrics.frameInterval.maxMs ?? 0,
        receiveIntervalP95Ms: tile?.metrics.receiveInterval.p95Ms ?? 0,
        rafIntervalP95Ms: tile?.metrics.rafInterval.p95Ms ?? 0,
        decodeBacklogMaxFrames: tile?.metrics.decodeBacklog.maxMs ?? 0,
        renderQueueMaxFrames: tile?.metrics.renderQueue.maxMs ?? 0,
        sourceToRenderP50Ms: tile?.metrics.sourceToRender.p50Ms ?? 0,
        sourceToRenderP95Ms: tile?.metrics.sourceToRender.p95Ms ?? 0,
        serverToRenderP95Ms: tile?.metrics.serverToRender.p95Ms ?? 0,
        receiveToRenderP50Ms: tile?.metrics.receiveToRender.p50Ms ?? 0,
        receiveToRenderP95Ms: tile?.metrics.receiveToRender.p95Ms ?? 0,
        decodeP95Ms: tile?.metrics.decode.p95Ms ?? 0,
        renderP95Ms: tile?.metrics.render.p95Ms ?? 0,
        renderImportExternalTextureP95Ms: tile?.metrics.renderImportExternalTexture.p95Ms ?? 0,
        renderBindGroupP95Ms: tile?.metrics.renderBindGroup.p95Ms ?? 0,
        renderUniformP95Ms: tile?.metrics.renderUniform.p95Ms ?? 0,
        renderEncodeP95Ms: tile?.metrics.renderEncode.p95Ms ?? 0,
        renderSubmitP95Ms: tile?.metrics.renderSubmit.p95Ms ?? 0,
        renderBudgetOverrun120Fps: tile?.metrics.renderBudgetOverrun120Fps ?? 0,
        renderBudgetOverrun100Fps: tile?.metrics.renderBudgetOverrun100Fps ?? 0,
        renderBudgetOverrun60Fps: tile?.metrics.renderBudgetOverrun60Fps ?? 0,
        renderImportBudgetOverrun120Fps: tile?.metrics.renderImportBudgetOverrun120Fps ?? 0,
        renderImportBudgetOverrun100Fps: tile?.metrics.renderImportBudgetOverrun100Fps ?? 0,
        renderImportBudgetOverrun60Fps: tile?.metrics.renderImportBudgetOverrun60Fps ?? 0,
        lastSequenceNumber: tile?.lastSequenceNumber ?? 0,
        connectionOpenCount: tile?.connectionOpenCount ?? 0,
        protocolEndFrameCount: tile?.protocolEndFrameCount ?? 0,
        sourceSwitchCount: tile?.sourceSwitchCount ?? 0,
        sourceSwitchReason: tile?.sourceSwitchReason,
        matrixPresentMode: tile?.matrixPresentMode ?? canvas?.dataset.matrixPresentMode,
        matrixPresentPath: tile?.matrixPresentPath ?? canvas?.dataset.matrixPresentPath,
        matrixFlushCount: tile?.matrixFlushCount ?? readDatasetNumber(canvas, "matrixFlushCount"),
        matrixPresentCount: tile?.matrixPresentCount ?? readDatasetNumber(canvas, "matrixPresentCount"),
        matrixDrawCount: tile?.matrixDrawCount ?? readDatasetNumber(canvas, "matrixDrawCount"),
        matrixExternalImportCount: tile?.matrixExternalImportCount ?? readDatasetNumber(canvas, "matrixExternalImportCount"),
        matrixBindGroupCount: tile?.matrixBindGroupCount ?? readDatasetNumber(canvas, "matrixBindGroupCount"),
        matrixVideoFrameCopyCount: tile?.matrixVideoFrameCopyCount ?? readDatasetNumber(canvas, "matrixVideoFrameCopyCount"),
        matrixLastDirtySlotCount: tile?.matrixLastDirtySlotCount ?? readDatasetNumber(canvas, "matrixLastDirtySlotCount"),
        canvasMatrixFallbackReason: canvas?.dataset.matrixFallbackReason,
        canvasWebGpuError: canvas?.dataset.webGpuError,
        webGpuDisabledReason: tile?.webGpuDisabledReason ?? canvas?.dataset.webGpuDisabledReason,
        canvasGpuUploadSource: canvas?.dataset.gpuUploadSource,
        canvasGpuPresentation: canvas?.dataset.gpuPresentation,
        canvasGpuAdapterVendor: canvas?.dataset.gpuAdapterVendor,
        canvasGpuAdapterArchitecture: canvas?.dataset.gpuAdapterArchitecture,
      };
    }

    const longTaskEntries = ((window as typeof window & {
      __webvideoProfileLongTasks?: Array<{ duration: number }>;
    }).__webvideoProfileLongTasks ?? []);
    const longTaskDurations = longTaskEntries.map((entry) => entry.duration);
    const matrixCanvas = document.querySelector<HTMLCanvasElement>("[data-testid='vms-matrix-canvas']");
    const readMatrixNumber = (name: string): number => {
      const parsed = Number(matrixCanvas?.dataset[name] ?? "0");
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const tileValues = Object.values(tiles);
    const maxTileNumber = (name: keyof TileProfileSnapshot): number => Math.max(
      0,
      ...tileValues.map((tile) => {
        const value = tile[name];
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
      }),
    );
    return {
      tiles,
      matrix: {
        presentMode: matrixCanvas?.dataset.matrixPresentMode ?? tileValues.find((tile) => tile.matrixPresentMode)?.matrixPresentMode,
        presentPath: matrixCanvas?.dataset.matrixPresentPath ?? tileValues.find((tile) => tile.matrixPresentPath)?.matrixPresentPath,
        flushCount: Math.max(readMatrixNumber("matrixFlushCount"), maxTileNumber("matrixFlushCount")),
        presentCount: Math.max(readMatrixNumber("matrixPresentCount"), maxTileNumber("matrixPresentCount")),
        drawCount: Math.max(readMatrixNumber("matrixDrawCount"), maxTileNumber("matrixDrawCount")),
        externalImportCount: Math.max(readMatrixNumber("matrixExternalImportCount"), maxTileNumber("matrixExternalImportCount")),
        bindGroupCount: Math.max(readMatrixNumber("matrixBindGroupCount"), maxTileNumber("matrixBindGroupCount")),
        videoFrameCopyCount: Math.max(readMatrixNumber("matrixVideoFrameCopyCount"), maxTileNumber("matrixVideoFrameCopyCount")),
        lastDirtySlotCount: Math.max(readMatrixNumber("matrixLastDirtySlotCount"), maxTileNumber("matrixLastDirtySlotCount")),
        slotCount: readMatrixNumber("matrixSlotCount"),
      },
      longTasks: {
        count: longTaskDurations.length,
        totalDurationMs: longTaskDurations.reduce((total, duration) => total + duration, 0),
        maxDurationMs: Math.max(0, ...longTaskDurations),
      },
    };
  }, targets);
}

async function captureTileVisualHashes(
  page: Page,
  targets: readonly ProfileTileTarget[],
): Promise<Record<string, string>> {
  return await page.evaluate((expectedTargets) => {
    const hashes: Record<string, string> = {};
    const matrixCanvas = document.querySelector<HTMLCanvasElement>("[data-testid='vms-matrix-canvas']");
    const matrixStyle = matrixCanvas ? getComputedStyle(matrixCanvas) : undefined;
    const matrixVisible = Boolean(
      matrixCanvas
      && !matrixCanvas.hidden
      && matrixStyle?.display !== "none"
      && matrixCanvas.width > 1
      && matrixCanvas.height > 1,
    );
    const matrixRect = matrixCanvas?.getBoundingClientRect();

    const hashString = (value: string): string => {
      let hash = 2166136261;
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }

      return (hash >>> 0).toString(16).padStart(8, "0");
    };

    const hashCanvas = (sourceCanvas: HTMLCanvasElement): string | undefined => {
      if (sourceCanvas.width < 2 || sourceCanvas.height < 2) {
        return undefined;
      }

      try {
        return hashString(sourceCanvas.toDataURL("image/png"));
      } catch {
        return undefined;
      }
    };

    const matrixHash = matrixVisible && matrixCanvas ? hashCanvas(matrixCanvas) : undefined;

    for (const target of expectedTargets) {
      const tileCanvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${target.tileId}']`);
      if (!tileCanvas || tileCanvas.width < 2 || tileCanvas.height < 2) {
        continue;
      }

      if (matrixHash && matrixRect && matrixRect.width > 0 && matrixRect.height > 0) {
        hashes[target.tileId] = `matrix:${matrixHash}`;
        continue;
      }

      const hash = hashCanvas(tileCanvas);
      if (hash) {
        hashes[target.tileId] = `tile:${hash}`;
      }
    }

    return hashes;
  }, targets);
}

async function fetchJson<T>(
  page: Page,
  url: string,
  fallback: T,
): Promise<T> {
  try {
    return await page.evaluate(async (targetUrl) => {
      const response = await fetch(targetUrl);
      return response.ok ? await response.json() : undefined;
    }, url) ?? fallback;
  } catch {
    return fallback;
  }
}

async function captureBrowserMetrics(cdp?: CDPSession): Promise<Record<string, number>> {
  if (!cdp) {
    return {};
  }

  try {
    const response = await cdp.send("Performance.getMetrics");
    return Object.fromEntries(response.metrics.map((metric: { name: string; value: number }) => [metric.name, metric.value]));
  } catch {
    return {};
  }
}

async function captureSystemProcesses(): Promise<SystemProcessSnapshot[]> {
  if (!systemProcessProfileEnabled) {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("ps", [
      "-eo",
      "pid=,ppid=,pcpu=,pmem=,rss=,comm=,args=",
    ], {
      maxBuffer: 2 * 1024 * 1024,
    });

    return String(stdout)
      .split("\n")
      .map(parseSystemProcessLine)
      .filter((snapshot): snapshot is SystemProcessSnapshot => Boolean(snapshot));
  } catch {
    return [];
  }
}

function parseSystemProcessLine(line: string): SystemProcessSnapshot | undefined {
  const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
  if (!match) {
    return undefined;
  }

  const [, pid, parentPid, cpuPercent, memoryPercent, residentSetKb, command, args] = match;
  const role = classifySystemProcess(command, args);
  if (!role) {
    return undefined;
  }

  return {
    role,
    processId: Number.parseInt(pid, 10),
    parentProcessId: Number.parseInt(parentPid, 10),
    cpuPercent: Number.parseFloat(cpuPercent),
    memoryPercent: Number.parseFloat(memoryPercent),
    residentSetBytes: Number.parseInt(residentSetKb, 10) * 1024,
    command,
    args,
  };
}

function classifySystemProcess(command: string, args: string): string | undefined {
  const haystack = `${command} ${args}`;
  if (!haystack.includes(workspaceProcessMarker) && !haystack.includes("WebVideo.Backend.DemoHost")) {
    return undefined;
  }

  if (command.includes("mediamtx") || haystack.includes("/mediamtx ")) {
    return "rtsp-server";
  }

  if (command.includes("ffmpeg") || haystack.includes("/ffmpeg ")) {
    if (haystack.includes("pipe:1")) {
      return "backend-rtsp-reader";
    }

    if (haystack.includes(" -f rtsp ") || haystack.includes("rtsp://127.0.0.1:")) {
      return "rtsp-publisher";
    }

    return "ffmpeg";
  }

  if (command.includes("dotnet") || haystack.includes("WebVideo.Backend.DemoHost")) {
    return "backend";
  }

  if (haystack.includes("vite preview") || haystack.includes("npm run preview")) {
    return "frontend-server";
  }

  return undefined;
}

function summarizeSystemProcesses(timeline: readonly ProfileSample[]): SystemProcessSummary[] {
  const grouped = new Map<string, SystemProcessSnapshot[]>();
  for (const sample of timeline) {
    for (const process of sample.systemProcesses) {
      const key = `${process.role}:${process.processId}`;
      const group = grouped.get(key) ?? [];
      group.push(process);
      grouped.set(key, group);
    }
  }

  return [...grouped.values()]
    .map((samples) => {
      const first = samples[0];
      const cpuValues = samples.map((sample) => sample.cpuPercent);
      const residentValues = samples.map((sample) => sample.residentSetBytes);
      return {
        role: first.role,
        processId: first.processId,
        command: first.command,
        averageCpuPercent: average(cpuValues),
        maxCpuPercent: Math.max(...cpuValues),
        averageResidentSetMb: bytesToMegabytes(average(residentValues)),
        maxResidentSetMb: bytesToMegabytes(Math.max(...residentValues)),
        samples: samples.length,
      } satisfies SystemProcessSummary;
    })
    .sort((left, right) => {
      const cpuDelta = right.maxCpuPercent - left.maxCpuPercent;
      return cpuDelta !== 0 ? cpuDelta : left.role.localeCompare(right.role);
    });
}

function summarizeProfile(targets: readonly ProfileTileTarget[], timeline: readonly ProfileSample[]): Record<string, unknown> {
  const fullRun = summarizeProfileWindow(targets, timeline);
  const first = timeline[0];
  const steadyTimeline = first
    ? timeline.filter((sample) => sample.capturedAtUnixTimeMs - first.capturedAtUnixTimeMs >= warmupDiscardMs)
    : [];
  if (steadyTimeline.length < 2) {
    return {
      ...fullRun,
      warmupDiscardMs,
      steadyState: { error: "not enough samples after warm-up discard" },
    };
  }

  return {
    ...fullRun,
    warmupDiscardMs,
    steadyState: summarizeProfileWindow(targets, steadyTimeline),
  };
}

function summarizeProfileWindow(targets: readonly ProfileTileTarget[], timeline: readonly ProfileSample[]): Record<string, unknown> {
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  if (!first || !last) {
    return { error: "no samples" };
  }

  const elapsedSeconds = Math.max((last.capturedAtUnixTimeMs - first.capturedAtUnixTimeMs) / 1000, 0.001);
  const egressByChannel = new Map(last.egressMetrics.map((metric) => [metric.channelId, metric]));
  const firstEgressByChannel = new Map(first.egressMetrics.map((metric) => [metric.channelId, metric]));

  const serverCpuPercent = first.processMetrics && last.processMetrics
    ? ((last.processMetrics.totalProcessorTimeMs - first.processMetrics.totalProcessorTimeMs) / (elapsedSeconds * 1000)) * 100
    : 0;
  const browserTaskPercent = metricDelta(first, last, "TaskDuration") / elapsedSeconds * 100;

  return {
    elapsedSeconds,
    server: {
      processCpuPercent: serverCpuPercent,
      workingSetMb: bytesToMegabytes(last.processMetrics?.workingSetBytes ?? 0),
      privateMemoryMb: bytesToMegabytes(last.processMetrics?.privateMemoryBytes ?? 0),
      gcHeapMb: bytesToMegabytes(last.processMetrics?.gcHeapBytes ?? 0),
      threadCount: last.processMetrics?.threadCount ?? 0,
    },
    browser: {
      taskPercent: browserTaskPercent,
      scriptMs: metricDelta(first, last, "ScriptDuration") * 1000,
      layoutMs: metricDelta(first, last, "LayoutDuration") * 1000,
      styleMs: metricDelta(first, last, "RecalcStyleDuration") * 1000,
      jsHeapUsedMb: bytesToMegabytes(last.browserMetrics.JSHeapUsedSize ?? 0),
      longTaskCount: last.longTasks.count - first.longTasks.count,
      longTaskTotalMs: last.longTasks.totalDurationMs - first.longTasks.totalDurationMs,
      longTaskMaxMs: last.longTasks.maxDurationMs,
    },
    matrix: summarizeMatrixWindow(first.matrix, last.matrix, elapsedSeconds),
    tiles: Object.fromEntries(targets.map((target) => {
      const before = first.tiles[target.tileId];
      const after = last.tiles[target.tileId];
      const backend = selectBackendMetric(last.backendMetrics, after.streamId);
      const firstBackend = selectBackendMetric(first.backendMetrics, after.streamId, backend?.rtspUrl);
      const egress = egressByChannel.get(target.channelId);
      const firstEgress = firstEgressByChannel.get(target.channelId);
      const renderedDelta = sumTileCounterDeltas(timeline, target.tileId, "framesRendered");
      const messageDelta = sumTileCounterDeltas(timeline, target.tileId, "messagesReceived");
      const backendFrameDelta = (backend?.framesRead ?? 0) - (firstBackend?.framesRead ?? 0);
      const egressFrameDelta = (egress?.framesSent ?? 0) - (firstEgress?.framesSent ?? 0);
      const visualMotion = summarizeVisualHashes(timeline, target.tileId);
      const renderP95Ms = maxTileMetric(timeline, target.tileId, "renderP95Ms");
      const importExternalTextureP95Ms = maxTileMetric(timeline, target.tileId, "renderImportExternalTextureP95Ms");
      const renderBudgetOverrun120Fps = sumTileCounterDeltas(timeline, target.tileId, "renderBudgetOverrun120Fps");
      const renderBudgetOverrun100Fps = sumTileCounterDeltas(timeline, target.tileId, "renderBudgetOverrun100Fps");
      const renderBudgetOverrun60Fps = sumTileCounterDeltas(timeline, target.tileId, "renderBudgetOverrun60Fps");
      const importBudgetOverrun120Fps = sumTileCounterDeltas(timeline, target.tileId, "renderImportBudgetOverrun120Fps");
      const importBudgetOverrun100Fps = sumTileCounterDeltas(timeline, target.tileId, "renderImportBudgetOverrun100Fps");
      const importBudgetOverrun60Fps = sumTileCounterDeltas(timeline, target.tileId, "renderImportBudgetOverrun60Fps");
      const renderedFrameCount = Math.max(1, renderedDelta);

      return [target.tileId, {
        channelId: target.channelId,
        error: after.error,
        sourceFps: after.sourceFrameRate,
        sourceRtspUrl: after.sourceRtspUrl,
        desiredSourceFps: after.desiredSourceFrameRate,
        desiredMaxCodedWidth: after.desiredMaxCodedWidth,
        desiredMaxCodedHeight: after.desiredMaxCodedHeight,
        canvasBackingWidth: after.canvasBackingWidth,
        canvasBackingHeight: after.canvasBackingHeight,
        canvasCssWidth: after.canvasCssWidth,
        canvasCssHeight: after.canvasCssHeight,
        decodePipeline: after.decodePipeline,
        renderedFps: renderedDelta / elapsedSeconds,
        receivedFps: messageDelta / elapsedSeconds,
        backendReadFps: backendFrameDelta / elapsedSeconds,
        egressSentFps: egressFrameDelta / elapsedSeconds,
        uiRecentRenderFps: after.renderFps,
        renderFrameRateLimit: after.renderFrameRateLimit,
        adaptiveRenderPressureLevel: after.adaptiveRenderPressureLevel,
        backendRecentPublishedFps: backend?.recentPublishedFps ?? 0,
        backendRtspUrl: backend?.rtspUrl ?? "",
        egressRecentSentFps: egress?.recentSentFps ?? 0,
        clientDrops: sumTileCounterDeltas(timeline, target.tileId, "framesDropped"),
        rateLimitedFrames: sumTileCounterDeltas(timeline, target.tileId, "framesRateLimited"),
        sequenceGapFrames: sumTileCounterDeltas(timeline, target.tileId, "sequenceGapFrames"),
        frameHitches: sumTileCounterDeltas(timeline, target.tileId, "frameHitches"),
        severeFrameHitches: sumTileCounterDeltas(timeline, target.tileId, "severeFrameHitches"),
        connectionOpens: sumTileCounterDeltas(timeline, target.tileId, "connectionOpenCount"),
        protocolEnds: sumTileCounterDeltas(timeline, target.tileId, "protocolEndFrameCount"),
        sourceSwitches: sumTileCounterDeltas(timeline, target.tileId, "sourceSwitchCount"),
        sourceSwitchReason: after.sourceSwitchReason,
        visualHashChanges: visualMotion.changes,
        visualUniqueHashes: visualMotion.uniqueHashes,
        matrixFallbackReason: after.canvasMatrixFallbackReason,
        webGpuDisabledReason: after.webGpuDisabledReason,
        canvasWebGpuError: after.canvasWebGpuError,
        backendDrops: (backend?.subscriberFramesDropped ?? 0) - (firstBackend?.subscriberFramesDropped ?? 0),
        egressSkippedStale: (egress?.framesSkippedStale ?? 0) - (firstEgress?.framesSkippedStale ?? 0),
        egressSkippedBeforeKeyFrame: (egress?.framesSkippedBeforeKeyFrame ?? 0) - (firstEgress?.framesSkippedBeforeKeyFrame ?? 0),
        backendMaxFrameIntervalMs: backend?.maxFrameIntervalMs ?? 0,
        backendRecentFrameIntervalP95Ms: backend?.recentFrameIntervalP95Ms ?? 0,
        backendRecentFrameIntervalMaxMs: backend?.recentFrameIntervalMaxMs ?? 0,
        backendRecentFrameHitches: backend?.recentFrameHitches ?? 0,
        backendRecentSevereFrameHitches: backend?.recentSevereFrameHitches ?? 0,
        backendLastFrameAgeMs: backend?.lastFrameAgeMs ?? 0,
        backendPendingFrames: Math.max(0, ...(backend?.subscribers ?? []).map((subscriber) => subscriber.pendingFrames)),
        egressDequeueAgeP95Ms: egress?.dequeueAgeMs.p95 ?? 0,
        egressWriteP95Ms: egress?.writeMs.p95 ?? 0,
        egressWriteMaxMs: egress?.writeMs.max ?? 0,
        payloadAverageBytes: egress?.payloadBytes.average ?? 0,
        receiveIntervalP95Ms: maxTileMetric(timeline, target.tileId, "receiveIntervalP95Ms"),
        rafIntervalP95Ms: maxTileMetric(timeline, target.tileId, "rafIntervalP95Ms"),
        frameIntervalP95Ms: maxTileMetric(timeline, target.tileId, "frameIntervalP95Ms"),
        decodeP95Ms: maxTileMetric(timeline, target.tileId, "decodeP95Ms"),
        renderP95Ms,
        renderImportExternalTextureP95Ms: importExternalTextureP95Ms,
        renderBindGroupP95Ms: maxTileMetric(timeline, target.tileId, "renderBindGroupP95Ms"),
        renderUniformP95Ms: maxTileMetric(timeline, target.tileId, "renderUniformP95Ms"),
        renderEncodeP95Ms: maxTileMetric(timeline, target.tileId, "renderEncodeP95Ms"),
        renderSubmitP95Ms: maxTileMetric(timeline, target.tileId, "renderSubmitP95Ms"),
        serviceBudget: {
          target120FpsMs: serviceBudget120FpsMs,
          target100FpsMs: serviceBudget100FpsMs,
          target60FpsMs: serviceBudget60FpsMs,
          renderP95Headroom120FpsMs: serviceBudget120FpsMs - renderP95Ms,
          renderP95Headroom100FpsMs: serviceBudget100FpsMs - renderP95Ms,
          renderP95Headroom60FpsMs: serviceBudget60FpsMs - renderP95Ms,
          importP95Headroom120FpsMs: serviceBudget120FpsMs - importExternalTextureP95Ms,
          importP95Headroom100FpsMs: serviceBudget100FpsMs - importExternalTextureP95Ms,
          importP95Headroom60FpsMs: serviceBudget60FpsMs - importExternalTextureP95Ms,
          renderOverrun120Fps: renderBudgetOverrun120Fps,
          renderOverrun100Fps: renderBudgetOverrun100Fps,
          renderOverrun60Fps: renderBudgetOverrun60Fps,
          importOverrun120Fps: importBudgetOverrun120Fps,
          importOverrun100Fps: importBudgetOverrun100Fps,
          importOverrun60Fps: importBudgetOverrun60Fps,
          renderOverrun120FpsPerSecond: renderBudgetOverrun120Fps / elapsedSeconds,
          renderOverrun100FpsPerSecond: renderBudgetOverrun100Fps / elapsedSeconds,
          renderOverrun60FpsPerSecond: renderBudgetOverrun60Fps / elapsedSeconds,
          importOverrun120FpsPerSecond: importBudgetOverrun120Fps / elapsedSeconds,
          importOverrun100FpsPerSecond: importBudgetOverrun100Fps / elapsedSeconds,
          importOverrun60FpsPerSecond: importBudgetOverrun60Fps / elapsedSeconds,
          renderOverrun120FpsRatio: renderBudgetOverrun120Fps / renderedFrameCount,
          renderOverrun100FpsRatio: renderBudgetOverrun100Fps / renderedFrameCount,
          renderOverrun60FpsRatio: renderBudgetOverrun60Fps / renderedFrameCount,
          importOverrun120FpsRatio: importBudgetOverrun120Fps / renderedFrameCount,
          importOverrun100FpsRatio: importBudgetOverrun100Fps / renderedFrameCount,
          importOverrun60FpsRatio: importBudgetOverrun60Fps / renderedFrameCount,
        },
        sourceToRenderP50Ms: maxTileMetric(timeline, target.tileId, "sourceToRenderP50Ms"),
        sourceToRenderP95Ms: maxTileMetric(timeline, target.tileId, "sourceToRenderP95Ms"),
        serverToRenderP95Ms: maxTileMetric(timeline, target.tileId, "serverToRenderP95Ms"),
        receiveToRenderP50Ms: maxTileMetric(timeline, target.tileId, "receiveToRenderP50Ms"),
        receiveToRenderP95Ms: maxTileMetric(timeline, target.tileId, "receiveToRenderP95Ms"),
        decodeBacklogMaxFrames: maxTileMetric(timeline, target.tileId, "decodeBacklogMaxFrames"),
        renderQueueMaxFrames: maxTileMetric(timeline, target.tileId, "renderQueueMaxFrames"),
        gpuUploadSource: after.canvasGpuUploadSource,
        gpuPresentation: after.canvasGpuPresentation,
        gpuAdapter: `${after.canvasGpuAdapterVendor ?? ""} ${after.canvasGpuAdapterArchitecture ?? ""}`.trim(),
      }];
    })),
  };
}

function summarizeMatrixWindow(
  first: MatrixProfileSnapshot,
  last: MatrixProfileSnapshot,
  elapsedSeconds: number,
): Record<string, unknown> {
  const flushes = Math.max(0, last.flushCount - first.flushCount);
  const presents = Math.max(0, last.presentCount - first.presentCount);
  const draws = Math.max(0, last.drawCount - first.drawCount);
  const imports = Math.max(0, last.externalImportCount - first.externalImportCount);
  const bindGroups = Math.max(0, last.bindGroupCount - first.bindGroupCount);
  const videoFrameCopies = Math.max(0, last.videoFrameCopyCount - first.videoFrameCopyCount);

  return {
    presentMode: last.presentMode,
    presentPath: last.presentPath,
    slotCount: last.slotCount,
    flushes,
    presents,
    draws,
    externalImports: imports,
    bindGroups,
    videoFrameCopies,
    flushesPerSecond: flushes / elapsedSeconds,
    presentsPerSecond: presents / elapsedSeconds,
    drawsPerSecond: draws / elapsedSeconds,
    importsPerSecond: imports / elapsedSeconds,
    bindGroupsPerSecond: bindGroups / elapsedSeconds,
    drawsPerPresent: presents > 0 ? draws / presents : 0,
    importsPerDraw: draws > 0 ? imports / draws : 0,
  };
}

function selectBackendMetric(
  metrics: readonly BackendMetricSnapshot[],
  streamId: string,
  rtspUrlIncludes?: string,
): BackendMetricSnapshot | undefined {
  const candidates = metrics.filter((metric) => metric.streamId === streamId
    && (rtspUrlIncludes === undefined || metric.rtspUrl.includes(rtspUrlIncludes)));
  return candidates
    .sort((left, right) => {
      const subscriberDelta = right.subscriberCount - left.subscriberCount;
      if (subscriberDelta !== 0) {
        return subscriberDelta;
      }

      const runningDelta = Number(Boolean(right.readerRunning)) - Number(Boolean(left.readerRunning));
      if (runningDelta !== 0) {
        return runningDelta;
      }

      return right.framesRead - left.framesRead;
    })[0];
}

function metricDelta(first: ProfileSample, last: ProfileSample, name: string): number {
  return (last.browserMetrics[name] ?? 0) - (first.browserMetrics[name] ?? 0);
}

function maxTileMetric<K extends keyof TileProfileSnapshot>(
  timeline: readonly ProfileSample[],
  tileId: string,
  key: K,
): number {
  return Math.max(0, ...timeline.map((sample) => {
    const value = sample.tiles[tileId]?.[key];
    return typeof value === "number" ? value : 0;
  }));
}

function sumTileCounterDeltas<K extends keyof TileProfileSnapshot>(
  timeline: readonly ProfileSample[],
  tileId: string,
  key: K,
): number {
  let total = 0;
  let previous: number | undefined;
  for (const sample of timeline) {
    const value = sample.tiles[tileId]?.[key];
    if (typeof value !== "number") {
      continue;
    }

    if (previous !== undefined) {
      total += value >= previous ? value - previous : value;
    }
    previous = value;
  }

  return total;
}

function summarizeVisualHashes(
  timeline: readonly ProfileSample[],
  tileId: string,
): { changes: number; uniqueHashes: number } {
  const hashes = timeline
    .map((sample) => sample.tiles[tileId]?.visualHash)
    .filter((hash): hash is string => typeof hash === "string" && hash.length > 0);
  let changes = 0;
  let previous: string | undefined;
  for (const hash of hashes) {
    if (previous !== undefined && hash !== previous) {
      changes += 1;
    }
    previous = hash;
  }

  return {
    changes,
    uniqueHashes: new Set(hashes).size,
  };
}

function bytesToMegabytes(bytes: number): number {
  return bytes / (1024 * 1024);
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeCpuProfile(profile: CdpCpuProfile): CpuProfileSummary {
  const limit = Number.isFinite(cpuProfileTopLimit) && cpuProfileTopLimit > 0
    ? cpuProfileTopLimit
    : 25;
  const nodesById = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfTimeByNode = new Map<number, number>();
  const samples = profile.samples ?? [];
  const timeDeltas = profile.timeDeltas ?? [];
  let sampledTimeMs = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const nodeId = samples[index];
    const deltaMs = (timeDeltas[index] ?? cpuProfileSampleIntervalUs) / 1000;
    sampledTimeMs += deltaMs;
    selfTimeByNode.set(nodeId, (selfTimeByNode.get(nodeId) ?? 0) + deltaMs);
  }

  if (sampledTimeMs <= 0) {
    sampledTimeMs = Math.max(0, (profile.endTime - profile.startTime) / 1000);
    for (const node of profile.nodes) {
      const hitCount = node.hitCount ?? 0;
      if (hitCount > 0) {
        selfTimeByNode.set(node.id, hitCount * cpuProfileSampleIntervalUs / 1000);
      }
    }
  }

  const safeSampledTimeMs = Math.max(sampledTimeMs, 0.001);
  const topSelfTime = [...selfTimeByNode.entries()]
    .map(([nodeId, selfTimeMs]) => {
      const node = nodesById.get(nodeId);
      return node
        ? createCpuProfileNodeSummary(node, selfTimeMs, safeSampledTimeMs)
        : undefined;
    })
    .filter((entry): entry is CpuProfileNodeSummary => entry !== undefined && entry.selfTimeMs > 0)
    .sort((left, right) => right.selfTimeMs - left.selfTimeMs)
    .slice(0, limit);

  const scriptTimeByUrl = new Map<string, number>();
  for (const [nodeId, selfTimeMs] of selfTimeByNode.entries()) {
    const node = nodesById.get(nodeId);
    if (!node || selfTimeMs <= 0) {
      continue;
    }

    const url = normalizeCpuProfileUrl(node.callFrame.url);
    scriptTimeByUrl.set(url, (scriptTimeByUrl.get(url) ?? 0) + selfTimeMs);
  }

  const topScriptSelfTime = [...scriptTimeByUrl.entries()]
    .map(([url, selfTimeMs]) => ({
      url,
      selfTimeMs,
      selfPercent: selfTimeMs / safeSampledTimeMs * 100,
    }))
    .sort((left, right) => right.selfTimeMs - left.selfTimeMs)
    .slice(0, limit);

  return {
    sampledTimeMs,
    nodeCount: profile.nodes.length,
    sampleCount: samples.length,
    topSelfTime,
    topScriptSelfTime,
  };
}

function createCpuProfileNodeSummary(
  node: CdpCpuProfileNode,
  selfTimeMs: number,
  sampledTimeMs: number,
): CpuProfileNodeSummary {
  return {
    functionName: node.callFrame.functionName || "(anonymous)",
    url: normalizeCpuProfileUrl(node.callFrame.url),
    lineNumber: node.callFrame.lineNumber,
    columnNumber: node.callFrame.columnNumber,
    selfTimeMs,
    selfPercent: selfTimeMs / sampledTimeMs * 100,
    hitCount: node.hitCount ?? 0,
  };
}

function normalizeCpuProfileUrl(url: string): string {
  if (!url) {
    return "(browser/native)";
  }

  try {
    const parsed = new URL(url);
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      return parsed.pathname;
    }
  } catch {
    // Keep non-URL script labels intact.
  }

  return url;
}
