import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const profileEnabled = process.env.WEBVIDEO_E2E_PROFILE === "1";
const durationMs = Number(process.env.WEBVIDEO_PROFILE_DURATION_MS ?? "20000");
const sampleIntervalMs = Number(process.env.WEBVIDEO_PROFILE_SAMPLE_INTERVAL_MS ?? "1000");
const warmupDiscardMs = Number(process.env.WEBVIDEO_PROFILE_WARMUP_DISCARD_MS ?? "5000");
const streamSets = parseStreamSets(process.env.WEBVIDEO_PROFILE_STREAM_SETS
  ?? "channel-001|channel-001,channel-002|channel-001,channel-002,channel-003");
const outputDir = path.resolve(process.cwd(), "../.run/profiles");
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
const captureUnreadyProfile = process.env.WEBVIDEO_PROFILE_CAPTURE_UNREADY === "1";
const playbackReadyMinFrames = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_READY_MIN_FRAMES) ?? 30;
const playbackReadyTimeoutMs = readOptionalPositiveNumber(process.env.WEBVIDEO_PROFILE_READY_TIMEOUT_MS) ?? 45_000;

test.describe("VMS profiling", () => {
  test.skip(!profileEnabled, "Set WEBVIDEO_E2E_PROFILE=1 to run browser/server profiling.");
  test.setTimeout(streamSets.length * (durationMs + 90_000));

  for (const channels of streamSets) {
    test(`profiles ${channels.length} continuous stream${channels.length === 1 ? "" : "s"}`, async ({ page }, testInfo) => {
      const cdp = await createCdpPerformanceSession(page);
      const workerCpuCapture = await startWorkerCpuProfileCapture(cdp);
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
        },
        summary,
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
          expect(["external-texture", "videoframe-copy"], `${target.tileId} GPU upload source`).toContain(finalTile?.canvasGpuUploadSource);
          expect(finalTile?.canvasGpuPresentation, `${target.tileId} GPU presentation`).toBe("webgpu-canvas");
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
  backendMetrics: BackendMetricSnapshot[];
  egressMetrics: EgressMetricSnapshot[];
  processMetrics?: ProcessMetricSnapshot;
  browserMetrics: Record<string, number>;
  longTasks: LongTaskSnapshot;
}

interface TileProfileSnapshot {
  channelId: string;
  streamId: string;
  status: string;
  sourceRtspUrl: string;
  activeTransport?: string;
  decodeBackend?: string;
  decodePipeline?: string;
  renderBackend?: string;
  sourceFrameRate: number;
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
  lastSequenceNumber: number;
  connectionOpenCount: number;
  protocolEndFrameCount: number;
  sourceSwitchCount: number;
  sourceSwitchReason?: string;
  canvasGpuUploadSource?: string;
  canvasGpuPresentation?: string;
  canvasGpuAdapterVendor?: string;
  canvasGpuAdapterArchitecture?: string;
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

interface CdpAttachedToTargetEvent {
  sessionId: string;
  targetInfo: {
    targetId: string;
    type: string;
    title: string;
    url: string;
  };
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
  if (process.env.WEBVIDEO_VMS_MATRIX_TEXTURE) {
    params.set("matrixTexture", process.env.WEBVIDEO_VMS_MATRIX_TEXTURE);
  }
  if (process.env.WEBVIDEO_VMS_MEDIA_WORKER) {
    params.set("mediaWorker", process.env.WEBVIDEO_VMS_MEDIA_WORKER);
  }
  if (process.env.WEBVIDEO_VMS_ADAPTIVE_RENDER) {
    params.set("adaptiveRender", process.env.WEBVIDEO_VMS_ADAPTIVE_RENDER);
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
      waitForDebuggerOnStart: true,
      flatten: true,
    });
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
  const [pageSnapshot, backendMetrics, egressMetrics, processMetrics, browserMetrics] = await Promise.all([
    capturePageSnapshot(page, targets),
    fetchJson<BackendMetricSnapshot[]>(page, "/api/demo/live/metrics", []),
    fetchJson<EgressMetricSnapshot[]>(page, "/api/demo/live/egress-metrics", []),
    fetchJson<ProcessMetricSnapshot | undefined>(page, "/api/demo/live/process-metrics", undefined),
    captureBrowserMetrics(cdp),
  ]);

  return {
    capturedAtUnixTimeMs: Date.now(),
    tiles: pageSnapshot.tiles,
    backendMetrics,
    egressMetrics,
    processMetrics,
    browserMetrics,
    longTasks: pageSnapshot.longTasks,
  };
}

async function capturePageSnapshot(
  page: Page,
  targets: readonly ProfileTileTarget[],
): Promise<{ tiles: Record<string, TileProfileSnapshot>; longTasks: LongTaskSnapshot }> {
  return await page.evaluate((expectedTargets) => {
    const tiles: Record<string, TileProfileSnapshot> = {};
    for (const target of expectedTargets) {
      const tile = window.__webvideoVmsState?.tiles[target.tileId];
      const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid='tile-canvas-${target.tileId}']`);
      tiles[target.tileId] = {
        channelId: target.channelId,
        streamId: tile?.streamId ?? "",
        status: tile?.status ?? "missing",
        sourceRtspUrl: tile?.sourceRtspUrl ?? "",
        activeTransport: tile?.activeTransport,
        decodeBackend: tile?.decodeBackend,
        decodePipeline: tile?.decodePipeline,
        renderBackend: tile?.renderBackend,
        sourceFrameRate: tile?.sourceFrameRate ?? 0,
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
        lastSequenceNumber: tile?.lastSequenceNumber ?? 0,
        connectionOpenCount: tile?.connectionOpenCount ?? 0,
        protocolEndFrameCount: tile?.protocolEndFrameCount ?? 0,
        sourceSwitchCount: tile?.sourceSwitchCount ?? 0,
        sourceSwitchReason: tile?.sourceSwitchReason,
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
    return {
      tiles,
      longTasks: {
        count: longTaskDurations.length,
        totalDurationMs: longTaskDurations.reduce((total, duration) => total + duration, 0),
        maxDurationMs: Math.max(0, ...longTaskDurations),
      },
    };
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

      return [target.tileId, {
        channelId: target.channelId,
        sourceFps: after.sourceFrameRate,
        sourceRtspUrl: after.sourceRtspUrl,
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
        backendDrops: (backend?.subscriberFramesDropped ?? 0) - (firstBackend?.subscriberFramesDropped ?? 0),
        egressSkippedStale: (egress?.framesSkippedStale ?? 0) - (firstEgress?.framesSkippedStale ?? 0),
        egressSkippedBeforeKeyFrame: (egress?.framesSkippedBeforeKeyFrame ?? 0) - (firstEgress?.framesSkippedBeforeKeyFrame ?? 0),
        backendMaxFrameIntervalMs: backend?.maxFrameIntervalMs ?? 0,
        backendPendingFrames: Math.max(0, ...(backend?.subscribers ?? []).map((subscriber) => subscriber.pendingFrames)),
        egressDequeueAgeP95Ms: egress?.dequeueAgeMs.p95 ?? 0,
        egressWriteP95Ms: egress?.writeMs.p95 ?? 0,
        egressWriteMaxMs: egress?.writeMs.max ?? 0,
        payloadAverageBytes: egress?.payloadBytes.average ?? 0,
        receiveIntervalP95Ms: maxTileMetric(timeline, target.tileId, "receiveIntervalP95Ms"),
        rafIntervalP95Ms: maxTileMetric(timeline, target.tileId, "rafIntervalP95Ms"),
        frameIntervalP95Ms: maxTileMetric(timeline, target.tileId, "frameIntervalP95Ms"),
        decodeP95Ms: maxTileMetric(timeline, target.tileId, "decodeP95Ms"),
        renderP95Ms: maxTileMetric(timeline, target.tileId, "renderP95Ms"),
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

function bytesToMegabytes(bytes: number): number {
  return bytes / (1024 * 1024);
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
