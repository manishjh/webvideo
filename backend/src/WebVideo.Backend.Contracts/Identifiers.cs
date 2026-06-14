namespace WebVideo.Backend.Contracts;

public readonly record struct StreamId(string Value);

public readonly record struct ChannelId(string Value);

public readonly record struct BrowserSinkId(string Value);

public readonly record struct IngestSessionId(string Value);

public readonly record struct BrowserSessionId(string Value);

public readonly record struct ProxySessionId(string Value);

public readonly record struct ArchiveWriterId(string Value);

public readonly record struct SubscriptionId(string Value);

public enum CameraTransportPreference
{
    PreferUdp,
    PreferTcp,
    ForceUdp,
    ForceTcp,
}

public enum VideoCodecKind
{
    H264,
    H265,
    Av1,
}

public enum MetadataTransportKind
{
    ReliableOrderedStream,
    Datagram,
}

public enum StopReason
{
    OperatorRequest,
    CameraDisconnected,
    FatalProtocolViolation,
    RollingRestart,
}

public enum SessionCloseReason
{
    ClientDisconnected,
    ServerDrain,
    BackpressureThresholdExceeded,
    StreamUnavailable,
}

public enum ExternalToolPreference
{
    MediaMtxAndFfmpeg,
    GStreamer,
    Custom,
}

