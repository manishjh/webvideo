namespace WebVideo.Backend.Contracts;

/// <summary>
/// Owns the authoritative RTSP/RTP ingest session for a camera stream.
/// Planned flow: connect to RTSP, negotiate UDP/TCP, depacketize RTP, normalize timestamps,
/// and publish encoded access units to archive, proxy, and browser fanout paths.
/// </summary>
public sealed class CameraStreamIngestCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<StreamId, IngestSessionState> _sessions = [];
    private long _sessionSequence;

    public Task<IngestSessionHandle> OpenCameraSessionAsync(
        CameraEndpoint endpoint,
        CameraTransportPreference transportPreference,
        IngestStreamOptions options,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(options);

        var streamId = CreateStreamId(endpoint);
        var sessionId = new IngestSessionId($"ingest-{Interlocked.Increment(ref _sessionSequence):D4}");
        var handle = new IngestSessionHandle(streamId, sessionId, endpoint, options.ExpectedCodec);
        var snapshot = new IngestStatusSnapshot(streamId, sessionId, true, 0, DateTimeOffset.UtcNow);

        lock (_gate)
        {
            _sessions[streamId] = new IngestSessionState(handle, transportPreference, options, snapshot);
        }

        return Task.FromResult(handle);
    }

    public Task StopCameraSessionAsync(
        StreamId streamId,
        StopReason reason,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            if (!_sessions.TryGetValue(streamId, out var state))
            {
                throw new KeyNotFoundException($"No ingest session exists for stream '{streamId.Value}'.");
            }

            state.IsHealthy = false;
            state.LastStopReason = reason;
            state.StatusSnapshot = state.StatusSnapshot with { IsHealthy = false, ObservedAt = DateTimeOffset.UtcNow };
        }

        return Task.CompletedTask;
    }

    public Task<IngestStatusSnapshot> GetIngestStatusAsync(
        StreamId streamId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            if (!_sessions.TryGetValue(streamId, out var state))
            {
                throw new KeyNotFoundException($"No ingest session exists for stream '{streamId.Value}'.");
            }

            state.StatusSnapshot = state.StatusSnapshot with { ObservedAt = DateTimeOffset.UtcNow };
            return Task.FromResult(state.StatusSnapshot);
        }
    }

    internal void RecordPublishedAccessUnit(StreamId streamId, EncodedAccessUnit accessUnit)
    {
        ArgumentNullException.ThrowIfNull(accessUnit);

        lock (_gate)
        {
            if (_sessions.TryGetValue(streamId, out var state))
            {
                state.StatusSnapshot = state.StatusSnapshot with
                {
                    LastAccessUnitSequenceNumber = accessUnit.SequenceNumber,
                    ObservedAt = DateTimeOffset.UtcNow
                };
            }
        }
    }

    private static StreamId CreateStreamId(CameraEndpoint endpoint)
    {
        if (!string.IsNullOrWhiteSpace(endpoint.CameraName))
        {
            return new StreamId(endpoint.CameraName.Trim());
        }

        var fallback = endpoint.RtspUrl.AbsolutePath.Trim('/');
        return new StreamId(string.IsNullOrWhiteSpace(fallback) ? "camera-stream" : fallback.Replace('/', '-'));
    }

    private sealed class IngestSessionState(
        IngestSessionHandle handle,
        CameraTransportPreference transportPreference,
        IngestStreamOptions options,
        IngestStatusSnapshot statusSnapshot)
    {
        public IngestSessionHandle Handle { get; } = handle;
        public CameraTransportPreference TransportPreference { get; } = transportPreference;
        public IngestStreamOptions Options { get; } = options;
        public IngestStatusSnapshot StatusSnapshot { get; set; } = statusSnapshot;
        public bool IsHealthy { get; set; } = true;
        public StopReason? LastStopReason { get; set; }
    }
}

/// <summary>
/// Owns the custom archive container flow for live ingest.
/// Planned flow: open writer on ingest start, append encoded access units, flush indexes,
/// and finalize segments without decode/re-encode.
/// </summary>
public sealed class ArchiveContainerCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<ArchiveWriterId, ArchiveWriterState> _writers = [];
    private long _writerSequence;

    public Task<ArchiveWriterHandle> OpenArchiveWriterAsync(
        StreamId streamId,
        ArchiveSinkOptions options,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(options);

        var writerId = new ArchiveWriterId($"writer-{Interlocked.Increment(ref _writerSequence):D4}");
        var archivePath = ResolveArchivePath(options.ArchivePathTemplate, streamId, DateTimeOffset.UtcNow);
        Directory.CreateDirectory(Path.GetDirectoryName(archivePath) ?? ".");
        File.WriteAllText(archivePath, $"WVV1|stream={streamId.Value}|container={options.ContainerKind}{Environment.NewLine}");

        var handle = new ArchiveWriterHandle(writerId, streamId, archivePath);

        lock (_gate)
        {
            _writers[writerId] = new ArchiveWriterState(handle, options);
        }

        return Task.FromResult(handle);
    }

    public Task WriteAccessUnitAsync(
        ArchiveWriterHandle writerHandle,
        EncodedAccessUnit accessUnit,
        FlowTimingContext timingContext,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(accessUnit);
        ArgumentNullException.ThrowIfNull(timingContext);

        ArchiveWriterState state;
        lock (_gate)
        {
            state = GetWriterState(writerHandle.WriterId);
            if (state.IsFinalized)
            {
                throw new InvalidOperationException($"Archive writer '{writerHandle.WriterId.Value}' is already finalized.");
            }

            state.AccessUnits.Add(accessUnit);
        }

        var line = string.Join(
            '|',
            "AU",
            accessUnit.SequenceNumber,
            accessUnit.PresentationTimestampUs,
            accessUnit.DecodeTimestampUs?.ToString() ?? string.Empty,
            accessUnit.IsKeyFrame ? "K" : "D",
            Convert.ToBase64String(accessUnit.Payload.ToArray()),
            timingContext.PublishTimestampUs);

        File.AppendAllText(writerHandle.ArchivePath, line + Environment.NewLine);
        return Task.CompletedTask;
    }

    public Task FinalizeArchiveAsync(
        ArchiveWriterHandle writerHandle,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            var state = GetWriterState(writerHandle.WriterId);
            if (!state.IsFinalized)
            {
                File.AppendAllText(writerHandle.ArchivePath, "END" + Environment.NewLine);
                state.IsFinalized = true;
            }
        }

        return Task.CompletedTask;
    }

    internal ArchiveWriterSnapshot GetSnapshotForTesting(ArchiveWriterId writerId)
    {
        lock (_gate)
        {
            var state = GetWriterState(writerId);
            return new ArchiveWriterSnapshot(state.Handle, state.IsFinalized, state.AccessUnits.ToArray());
        }
    }

    private ArchiveWriterState GetWriterState(ArchiveWriterId writerId)
    {
        if (!_writers.TryGetValue(writerId, out var state))
        {
            throw new KeyNotFoundException($"No archive writer exists for '{writerId.Value}'.");
        }

        return state;
    }

    private static string ResolveArchivePath(string template, StreamId streamId, DateTimeOffset utcNow)
    {
        var resolved = template
            .Replace("{streamId}", streamId.Value, StringComparison.Ordinal)
            .Replace("{utc:yyyyMMddHHmmss}", utcNow.ToString("yyyyMMddHHmmss"), StringComparison.Ordinal);

        return Path.GetFullPath(resolved);
    }

    private sealed class ArchiveWriterState(ArchiveWriterHandle handle, ArchiveSinkOptions options)
    {
        public ArchiveWriterHandle Handle { get; } = handle;
        public ArchiveSinkOptions Options { get; } = options;
        public List<EncodedAccessUnit> AccessUnits { get; } = [];
        public bool IsFinalized { get; set; }
    }
}

/// <summary>
/// Owns the legacy RTSP proxy path used by thick players such as VLC.
/// Planned flow: reuse normalized ingest state, attach viewer-specific RTSP session control,
/// and preserve encoded media without decode/re-encode.
/// </summary>
public sealed class LegacyRtspProxyCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<ProxySessionId, ProxySessionState> _sessions = [];
    private long _sessionSequence;

    public Task<ProxySessionHandle> CreateProxySessionAsync(
        StreamId streamId,
        ProxySessionOptions options,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(options);

        var handle = new ProxySessionHandle(
            new ProxySessionId($"proxy-{Interlocked.Increment(ref _sessionSequence):D4}"),
            streamId,
            options.ViewerId);

        lock (_gate)
        {
            _sessions[handle.SessionId] = new ProxySessionState(handle, options);
        }

        return Task.FromResult(handle);
    }

    public Task CloseProxySessionAsync(
        ProxySessionHandle sessionHandle,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            var state = GetSession(sessionHandle.SessionId);
            state.IsClosed = true;
        }

        return Task.CompletedTask;
    }

    internal ProxySessionSnapshot GetSnapshotForTesting(ProxySessionId sessionId)
    {
        lock (_gate)
        {
            var state = GetSession(sessionId);
            return new ProxySessionSnapshot(state.Handle, state.Options, state.IsClosed);
        }
    }

    private ProxySessionState GetSession(ProxySessionId sessionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var state))
        {
            throw new KeyNotFoundException($"No proxy session exists for '{sessionId.Value}'.");
        }

        return state;
    }

    private sealed class ProxySessionState(ProxySessionHandle handle, ProxySessionOptions options)
    {
        public ProxySessionHandle Handle { get; } = handle;
        public ProxySessionOptions Options { get; } = options;
        public bool IsClosed { get; set; }
    }
}

/// <summary>
/// Owns the shared in-memory live ring buffer and browser subscriber registration flow.
/// Planned flow: publish each encoded access unit once, retain a short keyframe-anchored window,
/// and allow many browser viewers to subscribe without repeating ingest work.
/// </summary>
public sealed class EncodedAccessUnitFanoutCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<StreamId, FanoutStreamState> _streams = [];
    private readonly Dictionary<SubscriptionId, StreamId> _subscriptionIndex = [];
    private readonly int _defaultRingCapacity;
    private long _subscriptionSequence;

    public EncodedAccessUnitFanoutCoordinator(int defaultRingCapacity = 64)
    {
        if (defaultRingCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(defaultRingCapacity));
        }

        _defaultRingCapacity = defaultRingCapacity;
    }

    public Task PublishAccessUnitAsync(
        StreamId streamId,
        EncodedAccessUnit accessUnit,
        FlowTimingContext timingContext,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(accessUnit);
        ArgumentNullException.ThrowIfNull(timingContext);

        lock (_gate)
        {
            var state = GetOrCreateState(streamId);
            state.AccessUnits.Add(accessUnit);

            while (state.AccessUnits.Count > state.Capacity)
            {
                state.AccessUnits.RemoveAt(0);
            }
        }

        return Task.CompletedTask;
    }

    public Task<StreamSubscriptionHandle> RegisterBrowserSubscriberAsync(
        StreamId streamId,
        BrowserSubscriberDescriptor subscriber,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(subscriber);

        var handle = new StreamSubscriptionHandle(
            new SubscriptionId($"sub-{Interlocked.Increment(ref _subscriptionSequence):D4}"),
            streamId,
            subscriber.SubscriberId);

        lock (_gate)
        {
            var state = GetOrCreateState(streamId);
            state.Subscribers[handle.SubscriptionId] = subscriber;
            _subscriptionIndex[handle.SubscriptionId] = streamId;
        }

        return Task.FromResult(handle);
    }

    public Task RemoveBrowserSubscriberAsync(
        StreamSubscriptionHandle subscriptionHandle,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            if (_subscriptionIndex.TryGetValue(subscriptionHandle.SubscriptionId, out var streamId) &&
                _streams.TryGetValue(streamId, out var state))
            {
                state.Subscribers.Remove(subscriptionHandle.SubscriptionId);
                _subscriptionIndex.Remove(subscriptionHandle.SubscriptionId);
            }
        }

        return Task.CompletedTask;
    }

    internal FanoutStreamSnapshot GetSnapshotForTesting(StreamId streamId)
    {
        lock (_gate)
        {
            var state = GetOrCreateState(streamId);
            return new FanoutStreamSnapshot(
                streamId,
                state.AccessUnits.ToArray(),
                state.Subscribers.Values.ToArray());
        }
    }

    private FanoutStreamState GetOrCreateState(StreamId streamId)
    {
        if (!_streams.TryGetValue(streamId, out var state))
        {
            state = new FanoutStreamState(_defaultRingCapacity);
            _streams[streamId] = state;
        }

        return state;
    }

    private sealed class FanoutStreamState(int capacity)
    {
        public int Capacity { get; } = capacity;
        public List<EncodedAccessUnit> AccessUnits { get; } = [];
        public Dictionary<SubscriptionId, BrowserSubscriberDescriptor> Subscribers { get; } = [];
    }
}

/// <summary>
/// Owns WebTransport session lifecycle and browser egress framing.
/// Planned flow: authenticate viewer, open video and metadata streams, pace access units,
/// and close sessions with explicit backpressure and drain semantics.
/// </summary>
public sealed class WebTransportSessionCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<BrowserSessionId, BrowserSessionState> _sessions = [];
    private long _sessionSequence;

    public Task<BrowserSessionHandle> StartBrowserSessionAsync(
        BrowserSessionRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(request);

        var handle = new BrowserSessionHandle(
            new BrowserSessionId($"browser-{Interlocked.Increment(ref _sessionSequence):D4}"),
            request.StreamId,
            request.ViewerId);

        lock (_gate)
        {
            _sessions[handle.SessionId] = new BrowserSessionState(handle, request);
        }

        return Task.FromResult(handle);
    }

    public Task SendVideoAccessUnitAsync(
        BrowserSessionHandle sessionHandle,
        EncodedAccessUnit accessUnit,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(accessUnit);

        lock (_gate)
        {
            var state = GetState(sessionHandle.SessionId);
            EnsureOpen(state);
            state.SentVideo.Add(accessUnit);
        }

        return Task.CompletedTask;
    }

    public Task SendMetadataBatchAsync(
        BrowserSessionHandle sessionHandle,
        MetadataBatch batch,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(batch);

        lock (_gate)
        {
            var state = GetState(sessionHandle.SessionId);
            EnsureOpen(state);
            state.SentMetadata.Add(batch);
        }

        return Task.CompletedTask;
    }

    public Task CloseBrowserSessionAsync(
        BrowserSessionHandle sessionHandle,
        SessionCloseReason reason,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            var state = GetState(sessionHandle.SessionId);
            state.IsClosed = true;
            state.CloseReason = reason;
        }

        return Task.CompletedTask;
    }

    internal BrowserSessionSnapshot GetSnapshotForTesting(BrowserSessionId sessionId)
    {
        lock (_gate)
        {
            var state = GetState(sessionId);
            return new BrowserSessionSnapshot(
                state.Handle,
                state.Request,
                state.IsClosed,
                state.CloseReason,
                state.SentVideo.ToArray(),
                state.SentMetadata.ToArray());
        }
    }

    private BrowserSessionState GetState(BrowserSessionId sessionId)
    {
        if (!_sessions.TryGetValue(sessionId, out var state))
        {
            throw new KeyNotFoundException($"No browser session exists for '{sessionId.Value}'.");
        }

        return state;
    }

    private static void EnsureOpen(BrowserSessionState state)
    {
        if (state.IsClosed)
        {
            throw new InvalidOperationException($"Browser session '{state.Handle.SessionId.Value}' is closed.");
        }
    }

    private sealed class BrowserSessionState(BrowserSessionHandle handle, BrowserSessionRequest request)
    {
        public BrowserSessionHandle Handle { get; } = handle;
        public BrowserSessionRequest Request { get; } = request;
        public bool IsClosed { get; set; }
        public SessionCloseReason? CloseReason { get; set; }
        public List<EncodedAccessUnit> SentVideo { get; } = [];
        public List<MetadataBatch> SentMetadata { get; } = [];
    }
}

/// <summary>
/// Owns timed metadata publication and query semantics.
/// Planned flow: accept metadata batches from analytics or operator inputs, keep a bounded
/// timeline window, and expose explicit queries aligned to presentation timestamps.
/// </summary>
public sealed class MetadataPublicationCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<StreamId, List<MetadataBatch>> _batchesByStream = [];

    public Task PublishMetadataBatchAsync(
        StreamId streamId,
        MetadataBatch batch,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(batch);

        lock (_gate)
        {
            if (!_batchesByStream.TryGetValue(streamId, out var batches))
            {
                batches = [];
                _batchesByStream[streamId] = batches;
            }

            batches.Add(batch);
            batches.Sort((left, right) => left.BatchStartTimestampUs.CompareTo(right.BatchStartTimestampUs));
        }

        return Task.CompletedTask;
    }

    public Task<MetadataTimelineSnapshot> GetMetadataWindowAsync(
        StreamId streamId,
        PresentationWindowQuery query,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(query);

        lock (_gate)
        {
            _batchesByStream.TryGetValue(streamId, out var batches);
            var start = query.CenterTimestampUs - (long)query.BackwardWindow.TotalMilliseconds * 1000L;
            var end = query.CenterTimestampUs + (long)query.ForwardWindow.TotalMilliseconds * 1000L;

            var relevant = (batches ?? [])
                .Where(batch => batch.BatchEndTimestampUs >= start && batch.BatchStartTimestampUs <= end)
                .ToArray();

            return Task.FromResult(new MetadataTimelineSnapshot(streamId, query, relevant));
        }
    }
}

/// <summary>
/// Owns service-level telemetry snapshots used by tests, debugging, and production dashboards.
/// Planned flow: emit stage timings during ingest, fanout, archive, and egress, then provide
/// a point-in-time snapshot for operational review.
/// </summary>
public sealed class OperationsTelemetryCoordinator
{
    private readonly Lock _gate = new();
    private readonly Dictionary<StreamId, List<MetricPoint>> _metricsByStream = [];

    public Task RecordStageMetricAsync(
        StreamId streamId,
        MetricPoint metric,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentNullException.ThrowIfNull(metric);

        lock (_gate)
        {
            if (!_metricsByStream.TryGetValue(streamId, out var metrics))
            {
                metrics = [];
                _metricsByStream[streamId] = metrics;
            }

            metrics.Add(metric);
        }

        return Task.CompletedTask;
    }

    public Task<TelemetrySnapshot> CaptureSnapshotAsync(
        StreamId streamId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        lock (_gate)
        {
            _metricsByStream.TryGetValue(streamId, out var metrics);
            return Task.FromResult(new TelemetrySnapshot(streamId, DateTimeOffset.UtcNow, (metrics ?? []).ToArray()));
        }
    }
}

/// <summary>
/// Owns the developer-facing RTSP test stream plan.
/// Planned flow: reserve ports, generate a synthetic camera profile, and return launch instructions
/// for a local publisher that can feed ingest and browser e2e tests.
/// </summary>
public sealed class RtspTestStreamCoordinator
{
    public Task<SyntheticRtspStreamDefinition> CreateSyntheticStreamAsync(
        string streamName,
        CameraTransportPreference publishTransport,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ArgumentException.ThrowIfNullOrWhiteSpace(streamName);

        var profile = publishTransport == CameraTransportPreference.ForceTcp ? "main" : "baseline";
        var definition = new SyntheticRtspStreamDefinition(
            StreamName: streamName,
            Codec: VideoCodecKind.H264,
            Profile: profile,
            Width: 1280,
            Height: 720,
            FrameRate: 30.0,
            KeyFrameInterval: 30,
            TargetBitrateKbps: 4000,
            PublishTransport: publishTransport,
            VideoPattern: "testsrc2",
            EmitMonotonicOverlayTimecode: true);

        return Task.FromResult(definition);
    }

    public Task<ExternalToolPreference> SelectToolchainAsync(
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(ExternalToolPreference.MediaMtxAndFfmpeg);
    }
}
