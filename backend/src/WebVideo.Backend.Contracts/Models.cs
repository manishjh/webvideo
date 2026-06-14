namespace WebVideo.Backend.Contracts;

public sealed record CameraEndpoint(
    Uri RtspUrl,
    string CameraName,
    string Username,
    string SecretReference);

public sealed record VideoCodecDescriptor(
    VideoCodecKind Codec,
    string Profile,
    int Width,
    int Height,
    double FrameRate,
    int TargetBitrateKbps);

public sealed record IngestStreamOptions(
    VideoCodecDescriptor ExpectedCodec,
    bool EnableArchival,
    bool EnableLegacyRtspProxy,
    int AccessUnitRingCapacity,
    TimeSpan MetadataRetentionWindow,
    TimeSpan ViewerJoinTimeout);

public sealed record ArchiveSinkOptions(
    string ContainerKind,
    string ArchivePathTemplate,
    TimeSpan SegmentDuration,
    bool WriteTimelineIndex);

public sealed record ProxySessionOptions(
    string ViewerId,
    bool EnableRtspInterleaving,
    TimeSpan SessionLeaseDuration);

public sealed record BrowserSessionRequest(
    StreamId StreamId,
    string ViewerId,
    Uri WebTransportEndpoint,
    string AuthToken,
    TimeSpan MaxLatencyBudget,
    bool EnableMetadata)
{
    public ChannelId ChannelId { get; init; } = new(StreamId.Value);
}

public sealed record BrowserSubscriberDescriptor(
    string SubscriberId,
    string UserAgent,
    TimeSpan MaxLatencyBudget,
    int MaxBufferedAccessUnits);

public sealed record FlowTimingContext(
    long CaptureTimestampUs,
    long ReceiveTimestampUs,
    long NormalizeTimestampUs,
    long PublishTimestampUs);

public sealed record EncodedAccessUnit(
    StreamId StreamId,
    long SequenceNumber,
    long PresentationTimestampUs,
    long? DecodeTimestampUs,
    bool IsKeyFrame,
    bool IsDiscontinuityBoundary,
    ReadOnlyMemory<byte> Payload);

public sealed record OverlayMetadataRecord(
    string EventId,
    string EventType,
    long StartTimestampUs,
    long EndTimestampUs,
    string CoordinateSpace,
    IReadOnlyDictionary<string, string> Tags);

public sealed record MetadataBatch(
    StreamId StreamId,
    MetadataTransportKind TransportKind,
    long BatchStartTimestampUs,
    long BatchEndTimestampUs,
    IReadOnlyList<OverlayMetadataRecord> Records);

public sealed record PresentationWindowQuery(
    long CenterTimestampUs,
    TimeSpan BackwardWindow,
    TimeSpan ForwardWindow);

public sealed record MetricPoint(
    string Name,
    double Value,
    string Unit,
    DateTimeOffset CapturedAt);

public sealed record TelemetrySnapshot(
    StreamId StreamId,
    DateTimeOffset CapturedAt,
    IReadOnlyList<MetricPoint> Metrics);

public sealed record MetadataTimelineSnapshot(
    StreamId StreamId,
    PresentationWindowQuery Query,
    IReadOnlyList<MetadataBatch> Batches);

public sealed record IngestSessionHandle(
    StreamId StreamId,
    IngestSessionId SessionId,
    CameraEndpoint CameraEndpoint,
    VideoCodecDescriptor Codec);

public sealed record ProxySessionHandle(
    ProxySessionId SessionId,
    StreamId StreamId,
    string ViewerId);

public sealed record ArchiveWriterHandle(
    ArchiveWriterId WriterId,
    StreamId StreamId,
    string ArchivePath);

public sealed record BrowserSessionHandle(
    BrowserSessionId SessionId,
    StreamId StreamId,
    string ViewerId)
{
    public ChannelId ChannelId { get; init; } = new(StreamId.Value);
}

public sealed record StreamSubscriptionHandle(
    SubscriptionId SubscriptionId,
    StreamId StreamId,
    string SubscriberId);

public sealed record BrowserStreamSinkHandle(
    BrowserSinkId SinkId,
    ChannelId ChannelId,
    StreamId StreamId,
    BrowserSessionHandle BrowserSession,
    StreamSubscriptionHandle Subscription);

public sealed record IngestStatusSnapshot(
    StreamId StreamId,
    IngestSessionId SessionId,
    bool IsHealthy,
    long LastAccessUnitSequenceNumber,
    DateTimeOffset ObservedAt);

public sealed record SyntheticRtspStreamDefinition(
    string StreamName,
    VideoCodecKind Codec,
    string Profile,
    int Width,
    int Height,
    double FrameRate,
    int KeyFrameInterval,
    int TargetBitrateKbps,
    CameraTransportPreference PublishTransport,
    string VideoPattern,
    bool EmitMonotonicOverlayTimecode);

