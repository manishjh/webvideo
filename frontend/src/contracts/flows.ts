import type {
  BehaviorSpecificationPlan,
  ContractMethodReference,
  E2eScenarioPlan,
  FlowPlan,
} from "./models";

function method(owner: string, methodName: string, ...parameterTypeNames: string[]): ContractMethodReference {
  return { owner, methodName, parameterTypeNames };
}

export const frontendFlowCatalog: FlowPlan[] = [
  {
    flowId: "player-session-bootstrap",
    summary: "Create the frontend player session and connect the transport pipeline.",
    steps: [
      {
        sequence: 1,
        title: "Initialize player session",
        owner: "WebPlayerBootstrap",
        description: "Create a player session and allocate the transport, decode, and render coordinators.",
        methods: [method("WebPlayerBootstrap", "initializeSession", "PlayerSessionRequest", "AbortSignal")],
        requiredMetrics: ["player.session.start", "player.bootstrap.latency"],
      },
      {
        sequence: 2,
        title: "Connect WebTransport",
        owner: "WebTransportIngestClient",
        description: "Open the browser transport session for the selected live stream.",
        methods: [method("WebTransportIngestClient", "connect", "TransportEndpointDescriptor", "AbortSignal")],
        requiredMetrics: ["transport.connect.latency", "transport.session.active"],
      },
      {
        sequence: 3,
        title: "Configure decoder",
        owner: "VideoDecodeCoordinator",
        description: "Configure WebCodecs for the active stream.",
        methods: [method("VideoDecodeCoordinator", "configureDecoder", "VideoCodecConfiguration")],
        requiredMetrics: ["decode.configure.latency"],
      },
      {
        sequence: 4,
        title: "Configure renderer",
        owner: "WebGpuRenderer",
        description: "Configure the GPU surface for the selected canvas.",
        methods: [method("WebGpuRenderer", "configureSurface", "SurfaceConfigurationPlan")],
        requiredMetrics: ["render.surface.configure"],
      },
    ],
  },
  {
    flowId: "transport-read-and-assembly",
    summary: "Read encoded transport messages and convert them into decode-ready chunks.",
    steps: [
      {
        sequence: 1,
        title: "Read video messages",
        owner: "WebTransportIngestClient",
        description: "Read video messages from the transport path incrementally.",
        methods: [method("WebTransportIngestClient", "readVideoMessages", "TransportConnectionHandle", "AbortSignal")],
        requiredMetrics: ["transport.video.bytes", "transport.video.read.latency"],
      },
      {
        sequence: 2,
        title: "Assemble encoded chunks",
        owner: "EncodedChunkAssembler",
        description: "Convert transport messages into decode-ready chunk emissions.",
        methods: [method("EncodedChunkAssembler", "applyTransportMessage", "VideoTransportMessage")],
        requiredMetrics: ["assembler.latency", "assembler.discontinuity.count"],
      },
      {
        sequence: 3,
        title: "Reset on discontinuity",
        owner: "EncodedChunkAssembler",
        description: "Clear assembly state on ingest restart or codec config change.",
        methods: [method("EncodedChunkAssembler", "resetForDiscontinuity", "StreamDiscontinuity")],
        requiredMetrics: ["assembler.reset.count"],
      },
    ],
  },
  {
    flowId: "metadata-ingest-and-timeline",
    summary: "Read timed metadata independently of video and align it to presentation time.",
    steps: [
      {
        sequence: 1,
        title: "Read metadata messages",
        owner: "WebTransportIngestClient",
        description: "Read metadata batches without blocking video delivery.",
        methods: [method("WebTransportIngestClient", "readMetadataMessages", "TransportConnectionHandle", "AbortSignal")],
        requiredMetrics: ["transport.metadata.bytes", "transport.metadata.read.latency"],
      },
      {
        sequence: 2,
        title: "Store metadata batches",
        owner: "OverlayTimelineStore",
        description: "Insert metadata into a bounded timeline window keyed by presentation time.",
        methods: [method("OverlayTimelineStore", "ingestBatch", "TimedMetadataBatch")],
        requiredMetrics: ["metadata.timeline.size", "metadata.batch.ingest.latency"],
      },
      {
        sequence: 3,
        title: "Query active metadata",
        owner: "OverlayTimelineStore",
        description: "Query only metadata active for a selected presentation timestamp.",
        methods: [method("OverlayTimelineStore", "queryActiveMetadata", "String", "Number")],
        requiredMetrics: ["metadata.query.latency"],
      },
    ],
  },
  {
    flowId: "decode-schedule-render",
    summary: "Decode frames, apply latency policy, and render video with overlays.",
    steps: [
      {
        sequence: 1,
        title: "Enqueue decode chunk",
        owner: "VideoDecodeCoordinator",
        description: "Submit a single encoded chunk to WebCodecs.",
        methods: [method("VideoDecodeCoordinator", "enqueueChunk", "EncodedChunkEmission")],
        requiredMetrics: ["decode.queue.depth", "decode.enqueue.latency"],
      },
      {
        sequence: 2,
        title: "Flush decoded frames",
        owner: "VideoDecodeCoordinator",
        description: "Flush decoded frames during drain or reset boundaries.",
        methods: [method("VideoDecodeCoordinator", "flush")],
        requiredMetrics: ["decode.flush.latency"],
      },
      {
        sequence: 3,
        title: "Schedule presentation",
        owner: "PresentationScheduler",
        description: "Choose the frame to render and drop late work explicitly.",
        methods: [method("PresentationScheduler", "scheduleFrame", "DecodedFramePlan", "Array")],
        requiredMetrics: ["scheduler.decision.latency", "scheduler.drop.count"],
      },
      {
        sequence: 4,
        title: "Drop expired frames",
        owner: "PresentationScheduler",
        description: "Enforce bounded latency by removing expired frames.",
        methods: [method("PresentationScheduler", "dropExpiredFrames", "String", "Number")],
        requiredMetrics: ["scheduler.expired.drop.count"],
      },
      {
        sequence: 5,
        title: "Render with WebGPU",
        owner: "WebGpuRenderer",
        description: "Render the selected frame and aligned overlays in a GPU-driven pass.",
        methods: [method("WebGpuRenderer", "renderFrame", "RenderFrameRequest")],
        requiredMetrics: ["render.frame.latency", "render.overlay.count"],
      },
    ],
  },
  {
    flowId: "clock-and-recovery",
    summary: "Keep the player on a bounded-latency clock and recover cleanly from discontinuities.",
    steps: [
      {
        sequence: 1,
        title: "Handle clock updates",
        owner: "PresentationScheduler",
        description: "Update the presentation clock from transport and decode timing.",
        methods: [method("PresentationScheduler", "handleClockUpdate", "PlaybackClockSnapshot")],
        requiredMetrics: ["scheduler.clock.skew"],
      },
      {
        sequence: 2,
        title: "Clear metadata window",
        owner: "OverlayTimelineStore",
        description: "Clear timeline state when the stream is reset or the viewer leaves.",
        methods: [method("OverlayTimelineStore", "clearWindow", "String")],
        requiredMetrics: ["metadata.window.clear.count"],
      },
      {
        sequence: 3,
        title: "Dispose player session",
        owner: "WebPlayerBootstrap",
        description: "Dispose all transport, decode, and GPU resources cleanly.",
        methods: [method("WebPlayerBootstrap", "disposeSession", "PlayerSessionHandle")],
        requiredMetrics: ["player.session.stop", "player.dispose.latency"],
      },
      {
        sequence: 4,
        title: "Dispose renderer",
        owner: "WebGpuRenderer",
        description: "Release GPU resources when the player drains or resets.",
        methods: [method("WebGpuRenderer", "dispose")],
        requiredMetrics: ["render.dispose.latency"],
      },
    ],
  },
  {
    flowId: "frontend-telemetry",
    summary: "Collect transport, decode, scheduler, and render stage telemetry.",
    steps: [
      {
        sequence: 1,
        title: "Record stage event",
        owner: "PlayerTelemetryCollector",
        description: "Store per-stage latency and queue measurements.",
        methods: [method("PlayerTelemetryCollector", "recordStageEvent", "StageTimingEvent")],
        requiredMetrics: ["telemetry.stage.event"],
      },
      {
        sequence: 2,
        title: "Create snapshot",
        owner: "PlayerTelemetryCollector",
        description: "Return a point-in-time snapshot used by tests and debugging tools.",
        methods: [method("PlayerTelemetryCollector", "createSnapshot", "String")],
        requiredMetrics: ["telemetry.snapshot"],
      },
    ],
  },
];

export const frontendBehaviorCatalog: BehaviorSpecificationPlan[] = [
  {
    specificationId: "viewer-starts-live-session",
    summary: "A viewer can bootstrap a live browser session and connect the transport path.",
    requiredOutcomes: ["session-bootstrap", "transport-connect", "decoder-configured", "renderer-configured"],
    requiredMethods: [
      method("WebPlayerBootstrap", "initializeSession", "PlayerSessionRequest", "AbortSignal"),
      method("WebTransportIngestClient", "connect", "TransportEndpointDescriptor", "AbortSignal"),
      method("VideoDecodeCoordinator", "configureDecoder", "VideoCodecConfiguration"),
      method("WebGpuRenderer", "configureSurface", "SurfaceConfigurationPlan"),
    ],
    coveredFlowIds: ["player-session-bootstrap"],
  },
  {
    specificationId: "browser-session-uses-rtsp-captured-payloads",
    summary: "A browser-owned channel session exposes a backend sink and RTSP-captured H.264 payloads before decode.",
    requiredOutcomes: ["client-channel-id", "backend-sink-created", "rtsp-source-verified", "annexb-payloads-present", "http-fallback-declared"],
    requiredMethods: [
      method("WebPlayerBootstrap", "initializeSession", "PlayerSessionRequest", "AbortSignal"),
      method("WebTransportIngestClient", "connect", "TransportEndpointDescriptor", "AbortSignal"),
      method("WebTransportIngestClient", "readVideoMessages", "TransportConnectionHandle", "AbortSignal"),
      method("EncodedChunkAssembler", "applyTransportMessage", "VideoTransportMessage"),
    ],
    coveredFlowIds: ["player-session-bootstrap", "transport-read-and-assembly"],
  },
  {
    specificationId: "video-chunks-are-assembled-before-decode",
    summary: "Transport messages are assembled and normalized before they reach WebCodecs.",
    requiredOutcomes: ["incremental-video-read", "encoded-chunk-assembly", "discontinuity-reset"],
    requiredMethods: [
      method("WebTransportIngestClient", "readVideoMessages", "TransportConnectionHandle", "AbortSignal"),
      method("EncodedChunkAssembler", "applyTransportMessage", "VideoTransportMessage"),
      method("EncodedChunkAssembler", "resetForDiscontinuity", "StreamDiscontinuity"),
    ],
    coveredFlowIds: ["transport-read-and-assembly"],
  },
  {
    specificationId: "metadata-overlays-align-to-presentation-time",
    summary: "Metadata remains independent from video transport and is aligned only at presentation time.",
    requiredOutcomes: ["metadata-read", "timeline-store", "active-metadata-query"],
    requiredMethods: [
      method("WebTransportIngestClient", "readMetadataMessages", "TransportConnectionHandle", "AbortSignal"),
      method("OverlayTimelineStore", "ingestBatch", "TimedMetadataBatch"),
      method("OverlayTimelineStore", "queryActiveMetadata", "String", "Number"),
    ],
    coveredFlowIds: ["metadata-ingest-and-timeline"],
  },
  {
    specificationId: "player-enforces-bounded-latency",
    summary: "The scheduler explicitly drops stale frames instead of silently building latency.",
    requiredOutcomes: ["decode-submit", "late-frame-drop", "gpu-render"],
    requiredMethods: [
      method("VideoDecodeCoordinator", "enqueueChunk", "EncodedChunkEmission"),
      method("PresentationScheduler", "scheduleFrame", "DecodedFramePlan", "Array"),
      method("PresentationScheduler", "dropExpiredFrames", "String", "Number"),
      method("WebGpuRenderer", "renderFrame", "RenderFrameRequest"),
    ],
    coveredFlowIds: ["decode-schedule-render"],
  },
  {
    specificationId: "player-recovers-from-discontinuity",
    summary: "Discontinuities force explicit resets across assembler, scheduler, metadata, and resources.",
    requiredOutcomes: ["clock-update", "timeline-clear", "session-dispose", "renderer-dispose"],
    requiredMethods: [
      method("PresentationScheduler", "handleClockUpdate", "PlaybackClockSnapshot"),
      method("OverlayTimelineStore", "clearWindow", "String"),
      method("WebPlayerBootstrap", "disposeSession", "PlayerSessionHandle"),
      method("WebGpuRenderer", "dispose"),
    ],
    coveredFlowIds: ["clock-and-recovery"],
  },
  {
    specificationId: "frontend-telemetry-is-queryable",
    summary: "Tests and operators can query a point-in-time telemetry snapshot from the browser side.",
    requiredOutcomes: ["stage-event-recorded", "telemetry-snapshot-created"],
    requiredMethods: [
      method("PlayerTelemetryCollector", "recordStageEvent", "StageTimingEvent"),
      method("PlayerTelemetryCollector", "createSnapshot", "String"),
    ],
    coveredFlowIds: ["frontend-telemetry"],
  },
];

export const e2eScenarioCatalog: E2eScenarioPlan[] = [
  {
    scenarioId: "viewer-starts-live-stream",
    summary: "A viewer opens the contract harness and sees the live session bootstrap flow represented.",
    linkedBehaviorIds: ["viewer-starts-live-session"],
    requiredAssertions: ["bootstrap flow present", "transport flow present", "renderer flow present"],
    syntheticRtspScenarioId: "download-13535786-4k60",
  },
  {
    scenarioId: "viewer-joins-at-keyframe-boundary",
    summary: "The harness documents that join behavior is keyframe-safe and uses the shared live buffer path.",
    linkedBehaviorIds: ["video-chunks-are-assembled-before-decode", "player-enforces-bounded-latency"],
    requiredAssertions: ["assembler flow present", "scheduler flow present", "late-frame policy present"],
    syntheticRtspScenarioId: "download-13535786-4k60",
  },
  {
    scenarioId: "metadata-overlay-aligns-to-frame-pts",
    summary: "The harness documents metadata alignment against the presentation timeline.",
    linkedBehaviorIds: ["metadata-overlays-align-to-presentation-time"],
    requiredAssertions: ["metadata flow present", "active metadata query present", "overlay alignment outcome present"],
    syntheticRtspScenarioId: "download-13535786-4k60",
  },
  {
    scenarioId: "player-recovers-from-stream-discontinuity",
    summary: "The harness documents the reset and cleanup path used after discontinuity.",
    linkedBehaviorIds: ["player-recovers-from-discontinuity"],
    requiredAssertions: ["clock recovery flow present", "timeline clear present", "renderer dispose present"],
    syntheticRtspScenarioId: "download-15116604-4k30",
  },
  {
    scenarioId: "rtsp-h264-source-feeds-browser-session",
    summary: "The harness requests a browser channel session backed by MediaMTX and FFmpeg-captured Annex B H.264 payloads.",
    linkedBehaviorIds: ["browser-session-uses-rtsp-captured-payloads", "metadata-overlays-align-to-presentation-time"],
    requiredAssertions: ["channel session POST observed", "RTSP capture source verified", "Annex B payload bytes present"],
    syntheticRtspScenarioId: "download-13535786-4k60",
  },
  {
    scenarioId: "tile-wall-renders-independent-channels",
    summary: "The tile wall opens separate browser channel sessions and renders multiple RTSP-backed streams on one page.",
    linkedBehaviorIds: ["viewer-starts-live-session", "browser-session-uses-rtsp-captured-payloads"],
    requiredAssertions: ["multiple channel session POSTs observed", "independent sinks created", "all tiles render WebGPU frames"],
    syntheticRtspScenarioId: "download-15139494-4k60",
  },
  {
    scenarioId: "high-resolution-4k-channel-is-declared",
    summary: "The browser catalog exposes a 4K channel shape for stress testing high-resolution decode and render.",
    linkedBehaviorIds: ["viewer-starts-live-session"],
    requiredAssertions: ["4K channel present", "3840x2160 codec dimensions present", "single-frame 4K probe supported"],
    syntheticRtspScenarioId: "download-15116604-4k30",
  },
  {
    scenarioId: "high-stress-4k60-crowd-channel-is-declared",
    summary: "The browser catalog exposes a crowd-heavy 4K60 channel shape for decode and render stress testing.",
    linkedBehaviorIds: ["viewer-starts-live-session"],
    requiredAssertions: ["4K60 channel present", "3840x2160 codec dimensions present", "60 fps source rate present"],
    syntheticRtspScenarioId: "cctv-road-crowd-4k60",
  },
];

export const requiredFrontendFlowIds = frontendFlowCatalog
  .map((flow) => flow.flowId)
  .sort((left, right) => left.localeCompare(right));

export const requiredE2eScenarioIds = e2eScenarioCatalog
  .map((scenario) => scenario.scenarioId)
  .sort((left, right) => left.localeCompare(right));
