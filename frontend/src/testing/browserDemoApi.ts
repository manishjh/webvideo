import type {
  BrowserTransportMode,
  MetadataTransportMessage,
  VideoCodecConfiguration,
  VideoTransportMessage,
} from "../contracts/models";

export interface BrowserDemoSinkDescriptor {
  sinkId: string;
  browserSessionId: string;
  subscriptionId: string;
  channelId: string;
  streamId: string;
  requestedTransport: BrowserTransportMode;
  activeTransport: BrowserTransportMode;
  webTransportUrl: string;
}

export interface BrowserDemoChannelSummary {
  channelId: string;
  streamId: string;
  displayName: string;
  scenarioId: string;
  sourceRtspUrl: string;
  summary: string;
  codec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
}

export interface BrowserDemoSessionRequest {
  viewerId: string;
  authToken: string;
  targetLatencyMs: number;
  enableMetadata: boolean;
  frameCount?: number;
  desiredEgressFrameRate?: number;
  desiredMaxCodedWidth?: number;
  desiredMaxCodedHeight?: number;
}

export interface BrowserDemoApiResponse {
  channelId: string;
  streamId: string;
  displayName: string;
  scenarioId: string;
  sourceRtspUrl: string;
  sourceSummary: string;
  sourceMode: string;
  sourceVerified: boolean;
  accessUnitFormat: string;
  sourceDiagnostics: string;
  targetLatencyMs: number;
  frameIntervalMs: number;
  webTransportUrl: string;
  requestedTransport: BrowserTransportMode;
  activeTransport: BrowserTransportMode;
  webTransportCertificateHash?: string;
  metadataChannelRequired: boolean;
  requestedFrameCount: number;
  sink: BrowserDemoSinkDescriptor;
  codec: VideoCodecConfiguration & { profile?: string; frameRate?: number };
  videoMessages: Array<Omit<VideoTransportMessage, "payload"> & { payload: number[] | string }>;
  metadataMessages: MetadataTransportMessage[];
}

interface BrowserDemoCertificateHashResponse {
  algorithm: "sha-256";
  valueBase64: string;
}

const defaultSessionRequest: BrowserDemoSessionRequest = {
  viewerId: "browser-demo-viewer",
  authToken: "demo-token",
  targetLatencyMs: 150,
  enableMetadata: true,
};

export async function openChannelSession(
  channelId: string,
  request: BrowserDemoSessionRequest = defaultSessionRequest,
): Promise<BrowserDemoApiResponse> {
  const response = await fetch(`/api/demo/channels/${encodeURIComponent(channelId)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Backend returned ${response.status} for channel '${channelId}'.`);
  }

  const payload = await response.json() as BrowserDemoApiResponse;
  payload.webTransportCertificateHash = await loadWebTransportCertificateHash();
  return payload;
}

export async function listDemoChannels(): Promise<BrowserDemoChannelSummary[]> {
  const response = await fetch("/api/demo/channels");
  if (!response.ok) {
    throw new Error(`Backend returned ${response.status} while listing channels.`);
  }

  return await response.json() as BrowserDemoChannelSummary[];
}

export async function loadWebTransportCertificateHash(): Promise<string | undefined> {
  const response = await fetch("/api/demo/webtransport/certificate-hash");
  if (!response.ok) {
    return undefined;
  }

  const payload = await response.json() as BrowserDemoCertificateHashResponse;
  return payload.valueBase64 || undefined;
}

function decodePayload(payload: number[] | string): Uint8Array {
  if (Array.isArray(payload)) {
    return new Uint8Array(payload);
  }

  const binary = globalThis.atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

export function normalizeVideoMessages(messages: BrowserDemoApiResponse["videoMessages"]): VideoTransportMessage[] {
  return messages.map((message) => ({
    ...message,
    payload: decodePayload(message.payload),
  }));
}

export function describeCapabilities(): string {
  const webTransport = typeof (globalThis as { WebTransport?: unknown }).WebTransport === "function"
    ? "webtransport"
    : "no-webtransport";
  const webCodecs = typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function"
    ? "webcodecs"
    : "no-webcodecs";
  const webGpu = typeof navigator !== "undefined" && "gpu" in navigator
    ? "webgpu"
    : "no-webgpu";
  return `${webTransport}, ${webCodecs}, ${webGpu}`;
}
