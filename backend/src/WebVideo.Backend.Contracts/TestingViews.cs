namespace WebVideo.Backend.Contracts;

internal sealed record ArchiveWriterSnapshot(
    ArchiveWriterHandle Handle,
    bool IsFinalized,
    IReadOnlyList<EncodedAccessUnit> AccessUnits);

internal sealed record ProxySessionSnapshot(
    ProxySessionHandle Handle,
    ProxySessionOptions Options,
    bool IsClosed);

internal sealed record FanoutStreamSnapshot(
    StreamId StreamId,
    IReadOnlyList<EncodedAccessUnit> AccessUnits,
    IReadOnlyList<BrowserSubscriberDescriptor> Subscribers);

internal sealed record BrowserSessionSnapshot(
    BrowserSessionHandle Handle,
    BrowserSessionRequest Request,
    bool IsClosed,
    SessionCloseReason? CloseReason,
    IReadOnlyList<EncodedAccessUnit> SentVideo,
    IReadOnlyList<MetadataBatch> SentMetadata);

