using System.Reflection;

namespace WebVideo.Backend.Contracts;

public sealed record ContractMethodReference(
    string TypeName,
    string MethodName,
    IReadOnlyList<string> ParameterTypeNames);

public sealed record FlowStepPlan(
    int Sequence,
    string Title,
    string Owner,
    string Description,
    IReadOnlyList<ContractMethodReference> Methods,
    IReadOnlyList<string> RequiredMetrics);

public sealed record FlowPlan(
    string FlowId,
    string Summary,
    IReadOnlyList<FlowStepPlan> Steps);

public sealed record BehaviorSpecificationPlan(
    string SpecificationId,
    string Summary,
    IReadOnlyList<string> RequiredOutcomes,
    IReadOnlyList<ContractMethodReference> RequiredMethods,
    IReadOnlyList<string> CoveredFlowIds);

public static class BackendSpecificationCatalog
{
    private static ContractMethodReference Method(string typeName, string methodName, params string[] parameterTypeNames)
        => new(typeName, methodName, parameterTypeNames);

    public static IReadOnlyList<FlowPlan> Flows { get; } =
    [
        new(
            "camera-live-ingest",
            "Connect to a camera, depacketize RTP, and normalize encoded access units for downstream consumers.",
            [
                new(
                    1,
                    "Open RTSP session",
                    "CameraStreamIngestCoordinator",
                    "Resolve camera settings and start the authoritative ingest session.",
                    [Method(nameof(CameraStreamIngestCoordinator), nameof(CameraStreamIngestCoordinator.OpenCameraSessionAsync), nameof(CameraEndpoint), nameof(CameraTransportPreference), nameof(IngestStreamOptions), nameof(CancellationToken))],
                    ["ingest.session.start", "ingest.handshake.latency"]),
                new(
                    2,
                    "Track ingest health",
                    "CameraStreamIngestCoordinator",
                    "Continuously expose health and sequence progress for operational checks.",
                    [Method(nameof(CameraStreamIngestCoordinator), nameof(CameraStreamIngestCoordinator.GetIngestStatusAsync), nameof(StreamId), nameof(CancellationToken))],
                    ["ingest.health", "ingest.sequence"])
            ]),
        new(
            "archive-write-path",
            "Persist encoded access units to the custom container format without decode/re-encode.",
            [
                new(
                    1,
                    "Open archive writer",
                    "ArchiveContainerCoordinator",
                    "Create a writer at ingest start with the configured segment policy.",
                    [Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.OpenArchiveWriterAsync), nameof(StreamId), nameof(ArchiveSinkOptions), nameof(CancellationToken))],
                    ["archive.writer.start", "archive.segment.target"]),
                new(
                    2,
                    "Append encoded access units",
                    "ArchiveContainerCoordinator",
                    "Write normalized encoded payloads and timeline metadata to the archive.",
                    [Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.WriteAccessUnitAsync), nameof(ArchiveWriterHandle), nameof(EncodedAccessUnit), nameof(FlowTimingContext), nameof(CancellationToken))],
                    ["archive.bytes", "archive.write.latency"]),
                new(
                    3,
                    "Finalize archive state",
                    "ArchiveContainerCoordinator",
                    "Close writers on stream stop or rolling restart boundaries.",
                    [Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.FinalizeArchiveAsync), nameof(ArchiveWriterHandle), nameof(CancellationToken))],
                    ["archive.finalize.latency"])
            ]),
        new(
            "legacy-rtsp-proxy",
            "Serve thick RTSP clients from the normalized ingest owner without a second camera pull.",
            [
                new(
                    1,
                    "Open proxy session",
                    "LegacyRtspProxyCoordinator",
                    "Create a viewer-specific proxy session for a thick client.",
                    [Method(nameof(LegacyRtspProxyCoordinator), nameof(LegacyRtspProxyCoordinator.CreateProxySessionAsync), nameof(StreamId), nameof(ProxySessionOptions), nameof(CancellationToken))],
                    ["proxy.session.start", "proxy.viewer.count"]),
                new(
                    2,
                    "Close proxy session",
                    "LegacyRtspProxyCoordinator",
                    "Tear down a viewer-specific proxy session when the client disconnects.",
                    [Method(nameof(LegacyRtspProxyCoordinator), nameof(LegacyRtspProxyCoordinator.CloseProxySessionAsync), nameof(ProxySessionHandle), nameof(CancellationToken))],
                    ["proxy.session.stop"])
            ]),
        new(
            "browser-fanout-and-egress",
            "Publish encoded access units once and serve many browser sessions from a shared live buffer.",
            [
                new(
                    1,
                    "Publish to live ring buffer",
                    "EncodedAccessUnitFanoutCoordinator",
                    "Store each encoded access unit once for live browser fanout.",
                    [Method(nameof(EncodedAccessUnitFanoutCoordinator), nameof(EncodedAccessUnitFanoutCoordinator.PublishAccessUnitAsync), nameof(StreamId), nameof(EncodedAccessUnit), nameof(FlowTimingContext), nameof(CancellationToken))],
                    ["fanout.queue.depth", "fanout.publish.latency"]),
                new(
                    2,
                    "Register browser subscriber",
                    "EncodedAccessUnitFanoutCoordinator",
                    "Attach a browser viewer to the live ring buffer at a keyframe-safe join point.",
                    [Method(nameof(EncodedAccessUnitFanoutCoordinator), nameof(EncodedAccessUnitFanoutCoordinator.RegisterBrowserSubscriberAsync), nameof(StreamId), nameof(BrowserSubscriberDescriptor), nameof(CancellationToken))],
                    ["fanout.subscriber.count", "fanout.join.latency"]),
                new(
                    3,
                    "Start browser egress session",
                    "WebTransportSessionCoordinator",
                    "Create the authenticated WebTransport session for a browser viewer.",
                    [Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.StartBrowserSessionAsync), nameof(BrowserSessionRequest), nameof(CancellationToken))],
                    ["egress.session.start", "egress.auth.latency"]),
                new(
                    4,
                    "Send encoded video",
                    "WebTransportSessionCoordinator",
                    "Push video access units on the browser session with bounded queueing.",
                    [Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendVideoAccessUnitAsync), nameof(BrowserSessionHandle), nameof(EncodedAccessUnit), nameof(CancellationToken))],
                    ["egress.video.bytes", "egress.video.latency"]),
                new(
                    5,
                    "Close browser egress session",
                    "WebTransportSessionCoordinator",
                    "Close browser sessions explicitly on drain, error, or client disconnect.",
                    [Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.CloseBrowserSessionAsync), nameof(BrowserSessionHandle), nameof(SessionCloseReason), nameof(CancellationToken))],
                    ["egress.session.stop"])
            ]),
        new(
            "metadata-publication",
            "Accept timed metadata and serve bounded timeline queries aligned to presentation time.",
            [
                new(
                    1,
                    "Publish metadata",
                    "MetadataPublicationCoordinator",
                    "Store metadata batches on the stream timeline with explicit validity windows.",
                    [Method(nameof(MetadataPublicationCoordinator), nameof(MetadataPublicationCoordinator.PublishMetadataBatchAsync), nameof(StreamId), nameof(MetadataBatch), nameof(CancellationToken))],
                    ["metadata.publish.latency", "metadata.record.count"]),
                new(
                    2,
                    "Query metadata window",
                    "MetadataPublicationCoordinator",
                    "Return the metadata relevant to a presentation window for renderer alignment.",
                    [Method(nameof(MetadataPublicationCoordinator), nameof(MetadataPublicationCoordinator.GetMetadataWindowAsync), nameof(StreamId), nameof(PresentationWindowQuery), nameof(CancellationToken))],
                    ["metadata.query.latency"]),
                new(
                    3,
                    "Send metadata to browser session",
                    "WebTransportSessionCoordinator",
                    "Emit metadata batches over the browser metadata path.",
                    [Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendMetadataBatchAsync), nameof(BrowserSessionHandle), nameof(MetadataBatch), nameof(CancellationToken))],
                    ["egress.metadata.bytes", "egress.metadata.latency"])
            ]),
        new(
            "observability-and-recovery",
            "Track metrics and expose recovery hooks for discontinuities, restarts, and overload.",
            [
                new(
                    1,
                    "Record stage metrics",
                    "OperationsTelemetryCoordinator",
                    "Capture queue depth, latency, and drop metrics from every stage.",
                    [Method(nameof(OperationsTelemetryCoordinator), nameof(OperationsTelemetryCoordinator.RecordStageMetricAsync), nameof(StreamId), nameof(MetricPoint), nameof(CancellationToken))],
                    ["telemetry.point.ingest"]),
                new(
                    2,
                    "Capture stream snapshot",
                    "OperationsTelemetryCoordinator",
                    "Provide a point-in-time operational view for a single stream.",
                    [Method(nameof(OperationsTelemetryCoordinator), nameof(OperationsTelemetryCoordinator.CaptureSnapshotAsync), nameof(StreamId), nameof(CancellationToken))],
                    ["telemetry.snapshot"]),
                new(
                    3,
                    "Stop ingest session",
                    "CameraStreamIngestCoordinator",
                    "Allow controlled stop and restart flows on disconnects or protocol violations.",
                    [Method(nameof(CameraStreamIngestCoordinator), nameof(CameraStreamIngestCoordinator.StopCameraSessionAsync), nameof(StreamId), nameof(StopReason), nameof(CancellationToken))],
                    ["ingest.session.stop"])
            ]),
        new(
            "synthetic-rtsp-test-stream",
            "Provide a synthetic RTSP source for smoke, load, and e2e validation.",
            [
                new(
                    1,
                    "Create synthetic stream definition",
                    "RtspTestStreamCoordinator",
                    "Generate the test source definition used by local and CI test harnesses.",
                    [Method(nameof(RtspTestStreamCoordinator), nameof(RtspTestStreamCoordinator.CreateSyntheticStreamAsync), nameof(String), nameof(CameraTransportPreference), nameof(CancellationToken))],
                    ["teststream.definition"]),
                new(
                    2,
                    "Select local toolchain",
                    "RtspTestStreamCoordinator",
                    "Choose the preferred external toolchain used to publish the RTSP test stream.",
                    [Method(nameof(RtspTestStreamCoordinator), nameof(RtspTestStreamCoordinator.SelectToolchainAsync), nameof(CancellationToken))],
                    ["teststream.toolchain"])
            ])
    ];

    public static IReadOnlyList<BehaviorSpecificationPlan> Specifications { get; } =
    [
        new(
            "camera-rtsp-ingest-starts-once-per-stream",
            "The service maintains one authoritative camera session per stream and reuses it for archive, RTSP proxy, and browser fanout.",
            ["single-ingest-owner", "camera-session-reuse"],
            [
                Method(nameof(CameraStreamIngestCoordinator), nameof(CameraStreamIngestCoordinator.OpenCameraSessionAsync), nameof(CameraEndpoint), nameof(CameraTransportPreference), nameof(IngestStreamOptions), nameof(CancellationToken)),
                Method(nameof(LegacyRtspProxyCoordinator), nameof(LegacyRtspProxyCoordinator.CreateProxySessionAsync), nameof(StreamId), nameof(ProxySessionOptions), nameof(CancellationToken)),
                Method(nameof(EncodedAccessUnitFanoutCoordinator), nameof(EncodedAccessUnitFanoutCoordinator.RegisterBrowserSubscriberAsync), nameof(StreamId), nameof(BrowserSubscriberDescriptor), nameof(CancellationToken))
            ],
            ["camera-live-ingest", "legacy-rtsp-proxy", "browser-fanout-and-egress"]),
        new(
            "archive-persists-normalized-access-units",
            "The archive path receives the normalized encoded stream and never requires decode/re-encode.",
            ["archive-no-transcode", "archive-segment-finalization"],
            [
                Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.OpenArchiveWriterAsync), nameof(StreamId), nameof(ArchiveSinkOptions), nameof(CancellationToken)),
                Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.WriteAccessUnitAsync), nameof(ArchiveWriterHandle), nameof(EncodedAccessUnit), nameof(FlowTimingContext), nameof(CancellationToken)),
                Method(nameof(ArchiveContainerCoordinator), nameof(ArchiveContainerCoordinator.FinalizeArchiveAsync), nameof(ArchiveWriterHandle), nameof(CancellationToken))
            ],
            ["archive-write-path"]),
        new(
            "browser-fanout-reuses-shared-live-buffer",
            "Browser viewers join a shared live ring buffer instead of repeating ingest and depacketization work.",
            ["shared-ring-buffer", "keyframe-safe-join"],
            [
                Method(nameof(EncodedAccessUnitFanoutCoordinator), nameof(EncodedAccessUnitFanoutCoordinator.PublishAccessUnitAsync), nameof(StreamId), nameof(EncodedAccessUnit), nameof(FlowTimingContext), nameof(CancellationToken)),
                Method(nameof(EncodedAccessUnitFanoutCoordinator), nameof(EncodedAccessUnitFanoutCoordinator.RegisterBrowserSubscriberAsync), nameof(StreamId), nameof(BrowserSubscriberDescriptor), nameof(CancellationToken)),
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendVideoAccessUnitAsync), nameof(BrowserSessionHandle), nameof(EncodedAccessUnit), nameof(CancellationToken))
            ],
            ["browser-fanout-and-egress"]),
        new(
            "metadata-remains-timeline-aligned",
            "Timed metadata is published and queried against the same presentation timeline used by video playback.",
            ["metadata-validity-window", "overlay-time-alignment"],
            [
                Method(nameof(MetadataPublicationCoordinator), nameof(MetadataPublicationCoordinator.PublishMetadataBatchAsync), nameof(StreamId), nameof(MetadataBatch), nameof(CancellationToken)),
                Method(nameof(MetadataPublicationCoordinator), nameof(MetadataPublicationCoordinator.GetMetadataWindowAsync), nameof(StreamId), nameof(PresentationWindowQuery), nameof(CancellationToken)),
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendMetadataBatchAsync), nameof(BrowserSessionHandle), nameof(MetadataBatch), nameof(CancellationToken))
            ],
            ["metadata-publication", "browser-fanout-and-egress"]),
        new(
            "browser-session-lifecycle-is-explicit",
            "Browser sessions open with authentication, send video and metadata independently, and close with explicit reasons.",
            ["session-authentication", "bounded-egress-queues", "explicit-session-close"],
            [
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.StartBrowserSessionAsync), nameof(BrowserSessionRequest), nameof(CancellationToken)),
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendVideoAccessUnitAsync), nameof(BrowserSessionHandle), nameof(EncodedAccessUnit), nameof(CancellationToken)),
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.SendMetadataBatchAsync), nameof(BrowserSessionHandle), nameof(MetadataBatch), nameof(CancellationToken)),
                Method(nameof(WebTransportSessionCoordinator), nameof(WebTransportSessionCoordinator.CloseBrowserSessionAsync), nameof(BrowserSessionHandle), nameof(SessionCloseReason), nameof(CancellationToken))
            ],
            ["browser-fanout-and-egress", "metadata-publication"]),
        new(
            "telemetry-covers-all-critical-stages",
            "The service records timing and queue metrics for ingest, archive, fanout, metadata, and browser egress.",
            ["full-stage-telemetry", "snapshot-debugging"],
            [
                Method(nameof(OperationsTelemetryCoordinator), nameof(OperationsTelemetryCoordinator.RecordStageMetricAsync), nameof(StreamId), nameof(MetricPoint), nameof(CancellationToken)),
                Method(nameof(OperationsTelemetryCoordinator), nameof(OperationsTelemetryCoordinator.CaptureSnapshotAsync), nameof(StreamId), nameof(CancellationToken)),
                Method(nameof(CameraStreamIngestCoordinator), nameof(CameraStreamIngestCoordinator.GetIngestStatusAsync), nameof(StreamId), nameof(CancellationToken))
            ],
            ["camera-live-ingest", "archive-write-path", "browser-fanout-and-egress", "metadata-publication", "observability-and-recovery"]),
        new(
            "synthetic-rtsp-source-is-runnable",
            "The repository defines a synthetic RTSP source plan that can be used by backend and browser test harnesses.",
            ["udp-smoke-source", "tcp-smoke-source", "toolchain-selection"],
            [
                Method(nameof(RtspTestStreamCoordinator), nameof(RtspTestStreamCoordinator.CreateSyntheticStreamAsync), nameof(String), nameof(CameraTransportPreference), nameof(CancellationToken)),
                Method(nameof(RtspTestStreamCoordinator), nameof(RtspTestStreamCoordinator.SelectToolchainAsync), nameof(CancellationToken))
            ],
            ["synthetic-rtsp-test-stream"])
    ];

    public static IReadOnlyList<string> RequiredFlowIds =>
        Flows.Select(flow => flow.FlowId).OrderBy(flowId => flowId, StringComparer.Ordinal).ToArray();

    public static bool MethodExists(Assembly assembly, ContractMethodReference reference)
    {
        var type = assembly.GetTypes().SingleOrDefault(candidate => candidate.Name == reference.TypeName);
        if (type is null)
        {
            return false;
        }

        return type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Any(method =>
                method.Name == reference.MethodName &&
                method.GetParameters().Select(parameter => parameter.ParameterType.Name).SequenceEqual(reference.ParameterTypeNames));
    }
}

