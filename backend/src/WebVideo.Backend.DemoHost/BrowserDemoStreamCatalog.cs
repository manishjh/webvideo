using WebVideo.Backend.Contracts;
using WebVideo.Backend.TestKit;

namespace WebVideo.Backend.DemoHost;

public sealed record BrowserDemoStreamSummary(
    string StreamId,
    string DisplayName,
    string ScenarioId,
    string SourceRtspUrl,
    string Summary);

public sealed record BrowserDemoChannelSummary(
    string ChannelId,
    string StreamId,
    string DisplayName,
    string ScenarioId,
    string SourceRtspUrl,
    string Summary,
    BrowserDemoCodecDescriptor Codec);

public sealed record BrowserDemoSessionOpenRequest(
    string? ViewerId,
    string? AuthToken,
    int? TargetLatencyMs,
    bool? EnableMetadata,
    int? FrameCount = null);

public sealed record BrowserDemoSinkDescriptor(
    string SinkId,
    string BrowserSessionId,
    string SubscriptionId,
    string ChannelId,
    string StreamId,
    string RequestedTransport,
    string ActiveTransport,
    string WebTransportUrl);

public sealed record BrowserDemoCodecDescriptor(
    string Codec,
    int CodedWidth,
    int CodedHeight,
    string Profile,
    double FrameRate);

public sealed record BrowserDemoOverlayRecord(
    string EventId,
    string EventType,
    long StartTimestampUs,
    long EndTimestampUs,
    string CoordinateSpace,
    IReadOnlyDictionary<string, string> Tags);

public sealed record BrowserDemoMetadataMessage(
    string StreamId,
    long BatchStartTimestampUs,
    long BatchEndTimestampUs,
    IReadOnlyList<BrowserDemoOverlayRecord> Records);

public sealed record BrowserDemoVideoMessage(
    string StreamId,
    long SequenceNumber,
    long PresentationTimestampUs,
    long DecodeTimestampUs,
    long SourceTimestampUnixTimeMs,
    long ServerTimestampUnixTimeMs,
    bool KeyFrame,
    string CodecConfigVersion,
    byte[] Payload);

public sealed record BrowserDemoStreamResponse(
    string ChannelId,
    string StreamId,
    string DisplayName,
    string ScenarioId,
    string SourceRtspUrl,
    string SourceSummary,
    string SourceMode,
    bool SourceVerified,
    string AccessUnitFormat,
    string SourceDiagnostics,
    int TargetLatencyMs,
    int FrameIntervalMs,
    string WebTransportUrl,
    string RequestedTransport,
    string ActiveTransport,
    bool MetadataChannelRequired,
    int RequestedFrameCount,
    BrowserDemoSinkDescriptor Sink,
    BrowserDemoCodecDescriptor Codec,
    IReadOnlyList<BrowserDemoVideoMessage> VideoMessages,
    IReadOnlyList<BrowserDemoMetadataMessage> MetadataMessages);

/// <summary>
/// Produces deterministic browser-facing demo payloads and records the same logical backend
/// work the real path will perform: resolve a client-provided channel id, attach a browser
/// sink to the chosen stream, and expose a QUIC/WebTransport endpoint plus fallback payloads.
/// </summary>
public sealed class BrowserDemoStreamCatalog
{
    private const string RequestedTransport = "webtransport-quic";
    private const string ActiveTransport = "http-seeded-fallback";
    private const string SyntheticSourceMode = "synthetic-fallback";
    private const string RtspSourceMode = "rtsp-h264-capture";
    private readonly EncodedAccessUnitFanoutCoordinator _fanout = new(defaultRingCapacity: 32);
    private readonly WebTransportSessionCoordinator _browserSessions = new();
    private readonly IReadOnlyList<BrowserDemoStreamDefinition> _definitions;
    private readonly RtspH264AccessUnitCapture? _rtspCapture;
    private long _sinkSequence;

    public BrowserDemoStreamCatalog()
        : this(null)
    {
    }

    public BrowserDemoStreamCatalog(RtspH264AccessUnitCapture? rtspCapture)
    {
        _rtspCapture = rtspCapture;
        _definitions = CreateDefaultDefinitions();
    }

    private static BrowserDemoStreamDefinition[] CreateDefaultDefinitions()
    {
        BrowserDemoStreamDefinition[] definitions =
        [
        new(
            ChannelId: "channel-001",
            StreamId: "camera-001",
            DisplayName: "CCTV Lobby 720p",
            ScenarioId: "cctv-lobby-720p",
            SourceRtspUrl: "rtsp://127.0.0.1:8554/live/cctv-lobby-720p",
            SourceSummary: "CCTV-style 720p lobby feed for browser tile testing.",
            CodedWidth: 1280,
            CodedHeight: 720,
            Profile: "baseline",
            FrameRate: 30.0),
        new(
            ChannelId: "channel-002",
            StreamId: "camera-002",
            DisplayName: "CCTV Entrance 720p",
            ScenarioId: "cctv-entrance-720p",
            SourceRtspUrl: "rtsp://127.0.0.1:8554/live/cctv-entrance-720p",
            SourceSummary: "CCTV-style 720p entrance feed for independent channel tile testing.",
            CodedWidth: 1280,
            CodedHeight: 720,
            Profile: "baseline",
            FrameRate: 30.0),
        new(
            ChannelId: "channel-003",
            StreamId: "camera-003",
            DisplayName: "CCTV Floor 1080p",
            ScenarioId: "cctv-floor-1080p",
            SourceRtspUrl: "rtsp://127.0.0.1:8554/live/cctv-floor-1080p",
            SourceSummary: "CCTV-style 1080p floor feed for higher-resolution browser tile testing.",
            CodedWidth: 1920,
            CodedHeight: 1080,
            Profile: "baseline",
            FrameRate: 30.0),
        new(
            ChannelId: "channel-4k",
            StreamId: "camera-4k",
            DisplayName: "CCTV Parking 4K",
            ScenarioId: "cctv-parking-4k",
            SourceRtspUrl: "rtsp://127.0.0.1:8554/live/cctv-parking-4k",
            SourceSummary: "CCTV-style 4K parking feed for high-resolution browser stress testing.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Profile: "baseline",
            FrameRate: 15.0)
        ];

        return definitions.Select(ApplyEnvironmentOverrides).ToArray();
    }

    public IReadOnlyList<BrowserDemoStreamSummary> ListStreams()
    {
        return _definitions
            .Select(definition => new BrowserDemoStreamSummary(
                definition.StreamId,
                definition.DisplayName,
                definition.ScenarioId,
                definition.SourceRtspUrl,
                definition.SourceSummary))
            .ToArray();
    }

    public IReadOnlyList<BrowserDemoChannelSummary> ListChannels()
    {
        return _definitions
            .Select(definition => new BrowserDemoChannelSummary(
                definition.ChannelId,
                definition.StreamId,
                definition.DisplayName,
                definition.ScenarioId,
                definition.SourceRtspUrl,
                definition.SourceSummary,
                CreateCodecDescriptor(definition)))
            .ToArray();
    }

    public BrowserDemoChannelSummary GetChannel(string channelId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(channelId);
        var definition = _definitions.SingleOrDefault(candidate => string.Equals(candidate.ChannelId, channelId, StringComparison.Ordinal));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown demo channel '{channelId}'.");
        }

        return new BrowserDemoChannelSummary(
            definition.ChannelId,
            definition.StreamId,
            definition.DisplayName,
            definition.ScenarioId,
            definition.SourceRtspUrl,
            definition.SourceSummary,
            CreateCodecDescriptor(definition));
    }

    public BrowserDemoStreamResponse CreateStream(string streamId, int frameCount = 8)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(streamId);
        var definition = _definitions.SingleOrDefault(candidate => string.Equals(candidate.StreamId, streamId, StringComparison.Ordinal));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown demo stream '{streamId}'.");
        }

        return OpenSessionCoreAsync(definition.ChannelId, definition, CreateDefaultRequest(), frameCount, CancellationToken.None)
            .GetAwaiter()
            .GetResult();
    }

    public async Task<BrowserDemoStreamResponse> OpenChannelSessionAsync(
        string channelId,
        BrowserDemoSessionOpenRequest? request,
        int frameCount = 8,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(channelId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(frameCount);
        cancellationToken.ThrowIfCancellationRequested();

        var definition = _definitions.SingleOrDefault(candidate => string.Equals(candidate.ChannelId, channelId, StringComparison.Ordinal));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown demo channel '{channelId}'.");
        }

        return await OpenSessionCoreAsync(channelId, definition, request ?? CreateDefaultRequest(), frameCount, cancellationToken);
    }

    private async Task<BrowserDemoStreamResponse> OpenSessionCoreAsync(
        string channelIdValue,
        BrowserDemoStreamDefinition definition,
        BrowserDemoSessionOpenRequest request,
        int frameCount,
        CancellationToken cancellationToken)
    {
        const long baseTimestampUs = 2_000_000;
        var frameDurationUs = (long)Math.Round(1_000_000.0 / definition.FrameRate);
        var requestedFrameCount = request.FrameCount.GetValueOrDefault(frameCount);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(requestedFrameCount);
        var streamId = new StreamId(definition.StreamId);
        var channelId = new ChannelId(channelIdValue);
        var targetLatency = TimeSpan.FromMilliseconds(request.TargetLatencyMs.GetValueOrDefault(150));
        var viewerId = string.IsNullOrWhiteSpace(request.ViewerId) ? "browser-demo-viewer" : request.ViewerId.Trim();
        var authToken = string.IsNullOrWhiteSpace(request.AuthToken) ? "demo-token" : request.AuthToken.Trim();
        var enableMetadata = request.EnableMetadata.GetValueOrDefault(true);
        var webTransportUrl = $"https://127.0.0.1:9443/live/{Uri.EscapeDataString(channelId.Value)}";

        var codec = CreateCodecDescriptor(definition);

        var browserRequest = new BrowserSessionRequest(
            streamId,
            viewerId,
            new Uri(webTransportUrl),
            authToken,
            targetLatency,
            enableMetadata)
        {
            ChannelId = channelId
        };

        var subscription = await _fanout.RegisterBrowserSubscriberAsync(
            streamId,
            new BrowserSubscriberDescriptor(
                viewerId,
                "browser-demo",
                targetLatency,
                MaxBufferedAccessUnits: 4),
            cancellationToken);

        var browserSession = await _browserSessions.StartBrowserSessionAsync(browserRequest, cancellationToken);
        var sink = new BrowserStreamSinkHandle(
            new BrowserSinkId($"sink-{Interlocked.Increment(ref _sinkSequence):D4}"),
            channelId,
            streamId,
            browserSession,
            subscription);

        var sourceMode = SyntheticSourceMode;
        var sourceVerified = false;
        var sourceDiagnostics = "using deterministic synthetic payloads";
        var videoMessages = CreateSyntheticVideoMessages(definition.StreamId, requestedFrameCount, baseTimestampUs, frameDurationUs);

        if (_rtspCapture is { IsEnabled: true })
        {
            try
            {
                videoMessages = (await _rtspCapture.CaptureAsync(
                    definition.StreamId,
                    definition.SourceRtspUrl,
                    requestedFrameCount,
                    baseTimestampUs,
                    frameDurationUs,
                    cancellationToken)).ToArray();
                sourceMode = RtspSourceMode;
                sourceVerified = true;
                sourceDiagnostics = $"captured {videoMessages.Length} Annex B H.264 access units from RTSP";
            }
            catch when (!_rtspCapture.IsRequired)
            {
                sourceDiagnostics = "RTSP capture failed; using deterministic synthetic payloads";
            }
        }

        foreach (var message in videoMessages)
        {
            var accessUnit = new EncodedAccessUnit(
                streamId,
                message.SequenceNumber,
                message.PresentationTimestampUs,
                message.DecodeTimestampUs,
                message.KeyFrame,
                message.KeyFrame,
                message.Payload);
            var timing = new FlowTimingContext(
                message.PresentationTimestampUs - 10_000,
                message.PresentationTimestampUs - 5_000,
                message.PresentationTimestampUs - 2_000,
                message.PresentationTimestampUs);

            await _fanout.PublishAccessUnitAsync(streamId, accessUnit, timing, cancellationToken);
            await _browserSessions.SendVideoAccessUnitAsync(browserSession, accessUnit, cancellationToken);
        }

        var metadataMessages = videoMessages
            .Select((message, index) =>
            {
                var label = index % 2 == 0 ? "ball" : "player";
                var x = 0.1 + index * 0.07;
                var y = 0.12 + (index % 3) * 0.12;

                return new BrowserDemoMetadataMessage(
                    StreamId: definition.StreamId,
                    BatchStartTimestampUs: message.PresentationTimestampUs,
                    BatchEndTimestampUs: message.PresentationTimestampUs + frameDurationUs,
                    Records:
                    [
                        new BrowserDemoOverlayRecord(
                            EventId: $"evt-{index + 1}",
                            EventType: "box2d",
                            StartTimestampUs: message.PresentationTimestampUs,
                            EndTimestampUs: message.PresentationTimestampUs + frameDurationUs,
                            CoordinateSpace: "normalized-video",
                            Tags: new Dictionary<string, string>(StringComparer.Ordinal)
                            {
                                ["label"] = label,
                                ["x"] = x.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
                                ["y"] = y.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture),
                                ["w"] = "0.14",
                                ["h"] = "0.18"
                            })
                    ]);
            })
            .ToArray();

        foreach (var message in metadataMessages)
        {
            var batch = new MetadataBatch(
                streamId,
                MetadataTransportKind.ReliableOrderedStream,
                message.BatchStartTimestampUs,
                message.BatchEndTimestampUs,
                message.Records.Select(record => new OverlayMetadataRecord(
                    record.EventId,
                    record.EventType,
                    record.StartTimestampUs,
                    record.EndTimestampUs,
                    record.CoordinateSpace,
                    record.Tags)).ToArray());

            await _browserSessions.SendMetadataBatchAsync(browserSession, batch, cancellationToken);
        }

        return new BrowserDemoStreamResponse(
            ChannelId: channelId.Value,
            StreamId: definition.StreamId,
            DisplayName: definition.DisplayName,
            ScenarioId: definition.ScenarioId,
            SourceRtspUrl: definition.SourceRtspUrl,
            SourceSummary: definition.SourceSummary,
            SourceMode: sourceMode,
            SourceVerified: sourceVerified,
            AccessUnitFormat: sourceVerified ? "annexb-h264" : "synthetic-bytes",
            SourceDiagnostics: sourceDiagnostics,
            TargetLatencyMs: (int)targetLatency.TotalMilliseconds,
            FrameIntervalMs: (int)Math.Round(1000.0 / definition.FrameRate),
            WebTransportUrl: webTransportUrl,
            RequestedTransport: RequestedTransport,
            ActiveTransport: ActiveTransport,
            MetadataChannelRequired: enableMetadata,
            RequestedFrameCount: requestedFrameCount,
            Sink: new BrowserDemoSinkDescriptor(
                sink.SinkId.Value,
                sink.BrowserSession.SessionId.Value,
                sink.Subscription.SubscriptionId.Value,
                sink.ChannelId.Value,
                sink.StreamId.Value,
                RequestedTransport,
                ActiveTransport,
                webTransportUrl),
            Codec: codec,
            VideoMessages: videoMessages,
            MetadataMessages: metadataMessages);
    }

    private static BrowserDemoSessionOpenRequest CreateDefaultRequest()
        => new("browser-demo-viewer", "demo-token", 150, true);

    private static BrowserDemoCodecDescriptor CreateCodecDescriptor(BrowserDemoStreamDefinition definition)
        => new(
            Codec: "avc1.42C01F",
            CodedWidth: definition.CodedWidth,
            CodedHeight: definition.CodedHeight,
            Profile: definition.Profile,
            FrameRate: definition.FrameRate);

    private static BrowserDemoVideoMessage[] CreateSyntheticVideoMessages(
        string streamId,
        int frameCount,
        long baseTimestampUs,
        long frameDurationUs)
    {
        var sourceTimestampUnixTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return Enumerable.Range(0, frameCount)
            .Select(index =>
            {
                var payloadSeed = index + 1;
                var frameTimestampUnixTimeMs = sourceTimestampUnixTimeMs + (long)Math.Round(index * frameDurationUs / 1000.0);
                return new BrowserDemoVideoMessage(
                    StreamId: streamId,
                    SequenceNumber: 101 + index,
                    PresentationTimestampUs: baseTimestampUs + index * frameDurationUs,
                    DecodeTimestampUs: baseTimestampUs + index * frameDurationUs,
                    SourceTimestampUnixTimeMs: frameTimestampUnixTimeMs,
                    ServerTimestampUnixTimeMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    KeyFrame: index == 0,
                    CodecConfigVersion: "cfg-demo-v1",
                    Payload: [unchecked((byte)payloadSeed), unchecked((byte)((payloadSeed + 2) * 3))]);
            })
            .ToArray();
    }

    private static BrowserDemoStreamDefinition ApplyEnvironmentOverrides(BrowserDemoStreamDefinition definition)
    {
        var suffix = definition.ChannelId
            .ToUpperInvariant()
            .Replace("-", "_", StringComparison.Ordinal);
        var prefix = $"WEBVIDEO_{suffix}";
        return definition with
        {
            SourceRtspUrl = GetString($"{prefix}_RTSP_URL", definition.SourceRtspUrl),
            DisplayName = GetString($"{prefix}_DISPLAY_NAME", definition.DisplayName),
            CodedWidth = GetInt32($"{prefix}_WIDTH", definition.CodedWidth),
            CodedHeight = GetInt32($"{prefix}_HEIGHT", definition.CodedHeight),
            FrameRate = GetDouble($"{prefix}_FRAMERATE", definition.FrameRate),
            Profile = GetString($"{prefix}_PROFILE", definition.Profile),
            SourceSummary = GetString($"{prefix}_SUMMARY", definition.SourceSummary)
        };
    }

    private static string GetString(string name, string fallback)
        => string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(name))
            ? fallback
            : Environment.GetEnvironmentVariable(name)!.Trim();

    private static int GetInt32(string name, int fallback)
        => int.TryParse(Environment.GetEnvironmentVariable(name), out var value) && value > 0 ? value : fallback;

    private static double GetDouble(string name, double fallback)
        => double.TryParse(
            Environment.GetEnvironmentVariable(name),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out var value) && value > 0
            ? value
            : fallback;

    private sealed record BrowserDemoStreamDefinition(
        string ChannelId,
        string StreamId,
        string DisplayName,
        string ScenarioId,
        string SourceRtspUrl,
        string SourceSummary,
        int CodedWidth,
        int CodedHeight,
        string Profile,
        double FrameRate);
}
