export type StreamId = string;
export type ChannelId = string;

export type BrowserTransportMode = "webtransport-quic" | "http-seeded-fallback";

export interface TransportEndpointDescriptor {
  channelId: ChannelId;
  streamId: StreamId;
  webTransportUrl: string;
  authToken: string;
  metadataChannelRequired: boolean;
  requestedTransport: BrowserTransportMode;
  allowHttpFallback: boolean;
  serverCertificateHash?: string;
  frameCount?: number;
  streamMode?: "bounded" | "continuous" | "continuous-binary" | "continuous-moq";
}

export interface PlayerSessionRequest {
  channelId: ChannelId;
  streamId: StreamId;
  viewerId: string;
  targetLatencyMs: number;
  enableMetadata: boolean;
}

export interface PlayerSessionHandle {
  sessionId: string;
  channelId: ChannelId;
  streamId: StreamId;
  viewerId: string;
}

export interface TransportConnectionHandle {
  connectionId: string;
  channelId: ChannelId;
  streamId: StreamId;
  requestedTransport: BrowserTransportMode;
  activeTransport: BrowserTransportMode;
  webTransportReady: boolean;
  webTransportBytesReceived: number;
  webTransportMessagesReceived: number;
}

export interface VideoTransportMessage {
  streamId: StreamId;
  sequenceNumber: number;
  presentationTimestampUs: number;
  decodeTimestampUs?: number;
  sourceTimestampUnixTimeMs?: number;
  serverTimestampUnixTimeMs?: number;
  moqTrackAlias?: number;
  moqGroupId?: number;
  moqObjectId?: number;
  moqSubgroupId?: number;
  moqPublisherPriority?: number;
  keyFrame: boolean;
  codecConfigVersion: string;
  payload: Uint8Array;
}

export interface MetadataTransportMessage {
  streamId: StreamId;
  batchStartTimestampUs: number;
  batchEndTimestampUs: number;
  records: TimedMetadataRecord[];
}

export interface EncodedChunkEmission {
  streamId: StreamId;
  sequenceNumber: number;
  encodedChunkType: "key" | "delta";
  presentationTimestampUs: number;
  payload: Uint8Array;
}

export interface StreamDiscontinuity {
  streamId: StreamId;
  reason: "ingest-restart" | "packet-loss" | "codec-config-change" | "operator-drain";
  sequenceNumber?: number;
}

export interface VideoCodecConfiguration {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}

export type DecodeBackend = "webcodecs" | "synthetic-frame-plan";
export type RenderBackend = "webgpu" | "canvas2d-fallback";

export interface DecodedFramePlan {
  streamId: StreamId;
  sequenceNumber: number;
  presentationTimestampUs: number;
  width: number;
  height: number;
  decodeBackend: DecodeBackend;
  videoFrame?: unknown;
}

export interface TimedMetadataRecord {
  eventId: string;
  eventType: string;
  startTimestampUs: number;
  endTimestampUs: number;
  coordinateSpace: string;
  tags: Record<string, string>;
}

export interface TimedMetadataBatch {
  streamId: StreamId;
  batchStartTimestampUs: number;
  batchEndTimestampUs: number;
  records: TimedMetadataRecord[];
}

export interface PlaybackClockSnapshot {
  streamId: StreamId;
  mediaTimestampUs: number;
  monotonicNowMs: number;
  clockSkewMs: number;
}

export interface DroppedFrameRecord {
  streamId: StreamId;
  sequenceNumber: number;
  reason: "late" | "dependency-missing" | "gpu-overload";
}

export interface PresentationDecision {
  streamId: StreamId;
  selectedSequenceNumber?: number;
  shouldRender: boolean;
  activeMetadataCount: number;
  droppedFrames: DroppedFrameRecord[];
}

export interface SurfaceConfigurationPlan {
  canvasId: string;
  canvasWidth: number;
  canvasHeight: number;
  outputColorSpace: "srgb" | "display-p3";
}

export interface RenderFrameRequest {
  sessionId: string;
  frame: DecodedFramePlan;
  activeMetadata: TimedMetadataBatch[];
  debugOverlayEnabled: boolean;
}

export interface RenderFrameResult {
  sessionId: string;
  renderedSequenceNumber: number;
  overlayPrimitiveCount: number;
  renderBackend: RenderBackend;
  gpuPresentation?: string;
  gpuUploadSource?: string;
  gpuAdapterVendor?: string;
  gpuAdapterArchitecture?: string;
  gpuReadbackError?: string;
  webGpuDisabledReason?: string;
}

export interface StageTimingEvent {
  streamId: StreamId;
  stageName: string;
  latencyMs: number;
  queueDepth: number;
}

export interface TelemetrySnapshot {
  streamId: StreamId;
  capturedAtIso: string;
  stages: StageTimingEvent[];
}

export interface ContractMethodReference {
  owner: string;
  methodName: string;
  parameterTypeNames: string[];
}

export interface FlowStepPlan {
  sequence: number;
  title: string;
  owner: string;
  description: string;
  methods: ContractMethodReference[];
  requiredMetrics: string[];
}

export interface FlowPlan {
  flowId: string;
  summary: string;
  steps: FlowStepPlan[];
}

export interface BehaviorSpecificationPlan {
  specificationId: string;
  summary: string;
  requiredOutcomes: string[];
  requiredMethods: ContractMethodReference[];
  coveredFlowIds: string[];
}

export interface E2eScenarioPlan {
  scenarioId: string;
  summary: string;
  linkedBehaviorIds: string[];
  requiredAssertions: string[];
  syntheticRtspScenarioId: string;
}
