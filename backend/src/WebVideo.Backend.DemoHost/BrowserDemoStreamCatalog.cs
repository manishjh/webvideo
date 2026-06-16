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
    int? FrameCount = null,
    double? DesiredEgressFrameRate = null,
    int? DesiredMaxCodedWidth = null,
    int? DesiredMaxCodedHeight = null);

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
    private readonly int _webTransportPort;
    private long _sinkSequence;

    public BrowserDemoStreamCatalog()
        : this(null)
    {
    }

    public BrowserDemoStreamCatalog(RtspH264AccessUnitCapture? rtspCapture, int webTransportPort = 9443, int rtspPort = 8554)
    {
        _rtspCapture = rtspCapture;
        _webTransportPort = webTransportPort;
        _definitions = CreateDefaultDefinitions(rtspPort);
    }

    private static BrowserDemoStreamDefinition[] CreateDefaultDefinitions(int rtspPort)
    {
        static string Rtsp(int port, string path) => $"rtsp://127.0.0.1:{port}/live/{path}";

        BrowserDemoStreamDefinition[] definitions =
        [
        new(
            ChannelId: "channel-4k-crowd",
            StreamId: "camera-4k-crowd",
            DisplayName: "CCTV Road Crowd 4K60",
            ScenarioId: "cctv-road-crowd-4k60",
            SourceRtspUrl: Rtsp(rtspPort, "cctv-road-crowd-4k60"),
            SourceSummary: "Crowd-heavy road junction 4K60 feed retained from the original demo set.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.42C034",
            Profile: "baseline",
            FrameRate: 60.0),
        new(
            ChannelId: "channel-13535786",
            StreamId: "camera-13535786",
            DisplayName: "Clip 13535786 4K60",
            ScenarioId: "download-13535786-4k60",
            SourceRtspUrl: Rtsp(rtspPort, "download-13535786-4k60"),
            SourceSummary: "Downloaded 3840x2160 60 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640034",
            Profile: "high",
            FrameRate: 60.0),
        new(
            ChannelId: "channel-15116604",
            StreamId: "camera-15116604",
            DisplayName: "Clip 15116604 4K30",
            ScenarioId: "download-15116604-4k30",
            SourceRtspUrl: Rtsp(rtspPort, "download-15116604-4k30"),
            SourceSummary: "Downloaded 3840x2160 30 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640033",
            Profile: "high",
            FrameRate: 30.0),
        new(
            ChannelId: "channel-15139494",
            StreamId: "camera-15139494",
            DisplayName: "Clip 15139494 4K60",
            ScenarioId: "download-15139494-4k60",
            SourceRtspUrl: Rtsp(rtspPort, "download-15139494-4k60"),
            SourceSummary: "Downloaded 3840x2160 60 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640034",
            Profile: "high",
            FrameRate: 60.0),
        new(
            ChannelId: "channel-15300856",
            StreamId: "camera-15300856",
            DisplayName: "Clip 15300856 4K60",
            ScenarioId: "download-15300856-4k60",
            SourceRtspUrl: Rtsp(rtspPort, "download-15300856-4k60"),
            SourceSummary: "Downloaded 3840x2160 59.94 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640034",
            Profile: "high",
            FrameRate: 59.94),
        new(
            ChannelId: "channel-15956743",
            StreamId: "camera-15956743",
            DisplayName: "Clip 15956743 4K60",
            ScenarioId: "download-15956743-4k60",
            SourceRtspUrl: Rtsp(rtspPort, "download-15956743-4k60"),
            SourceSummary: "Downloaded 3840x2160 59.94 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640034",
            Profile: "high",
            FrameRate: 59.94),
        new(
            ChannelId: "channel-16147856",
            StreamId: "camera-16147856",
            DisplayName: "Clip 16147856 4K24",
            ScenarioId: "download-16147856-4k24",
            SourceRtspUrl: Rtsp(rtspPort, "download-16147856-4k24"),
            SourceSummary: "Downloaded 3840x2160 23.98 fps H.264 clip.",
            CodedWidth: 3840,
            CodedHeight: 2160,
            Codec: "avc1.640033",
            Profile: "high",
            FrameRate: 23.98)
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
        => GetChannel(channelId, desiredEgressFrameRate: null);

    public BrowserDemoChannelSummary GetChannel(
        string channelId,
        double? desiredEgressFrameRate,
        int? desiredMaxCodedWidth = null,
        int? desiredMaxCodedHeight = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(channelId);
        var definition = _definitions.SingleOrDefault(candidate => string.Equals(candidate.ChannelId, channelId, StringComparison.Ordinal));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown demo channel '{channelId}'.");
        }

        var source = SelectSourceVariant(definition, desiredEgressFrameRate, desiredMaxCodedWidth, desiredMaxCodedHeight);
        return new BrowserDemoChannelSummary(
            definition.ChannelId,
            definition.StreamId,
            definition.DisplayName,
            definition.ScenarioId,
            source.SourceRtspUrl,
            definition.SourceSummary,
            CreateCodecDescriptor(definition, source));
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
        var source = SelectSourceVariant(
            definition,
            request.DesiredEgressFrameRate,
            request.DesiredMaxCodedWidth,
            request.DesiredMaxCodedHeight);
        var frameDurationUs = (long)Math.Round(1_000_000.0 / source.FrameRate);
        var requestedFrameCount = request.FrameCount.GetValueOrDefault(frameCount);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(requestedFrameCount);
        var streamId = new StreamId(definition.StreamId);
        var channelId = new ChannelId(channelIdValue);
        var targetLatency = TimeSpan.FromMilliseconds(request.TargetLatencyMs.GetValueOrDefault(150));
        var viewerId = string.IsNullOrWhiteSpace(request.ViewerId) ? "browser-demo-viewer" : request.ViewerId.Trim();
        var authToken = string.IsNullOrWhiteSpace(request.AuthToken) ? "demo-token" : request.AuthToken.Trim();
        var enableMetadata = request.EnableMetadata.GetValueOrDefault(true);
        var webTransportUrl = $"https://127.0.0.1:{_webTransportPort}/live/{Uri.EscapeDataString(channelId.Value)}";

        var codec = CreateCodecDescriptor(definition, source);

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
                    source.SourceRtspUrl,
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
            SourceRtspUrl: source.SourceRtspUrl,
            SourceSummary: definition.SourceSummary,
            SourceMode: sourceMode,
            SourceVerified: sourceVerified,
            AccessUnitFormat: sourceVerified ? "annexb-h264" : "synthetic-bytes",
            SourceDiagnostics: sourceDiagnostics,
            TargetLatencyMs: (int)targetLatency.TotalMilliseconds,
            FrameIntervalMs: (int)Math.Round(1000.0 / source.FrameRate),
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
        => CreateCodecDescriptor(definition, definition.FrameRate);

    private static BrowserDemoCodecDescriptor CreateCodecDescriptor(BrowserDemoStreamDefinition definition, double frameRate)
        => new(
            Codec: definition.Codec,
            CodedWidth: definition.CodedWidth,
            CodedHeight: definition.CodedHeight,
            Profile: definition.Profile,
            FrameRate: frameRate);

    private static BrowserDemoCodecDescriptor CreateCodecDescriptor(BrowserDemoStreamDefinition definition, BrowserDemoSourceVariant source)
        => new(
            Codec: definition.Codec,
            CodedWidth: source.CodedWidth ?? definition.CodedWidth,
            CodedHeight: source.CodedHeight ?? definition.CodedHeight,
            Profile: definition.Profile,
            FrameRate: source.FrameRate);

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
            Codec = GetString($"{prefix}_CODEC", definition.Codec),
            FrameRate = GetDouble($"{prefix}_FRAMERATE", definition.FrameRate),
            Profile = GetString($"{prefix}_PROFILE", definition.Profile),
            SourceSummary = GetString($"{prefix}_SUMMARY", definition.SourceSummary),
            SourceVariants = SourceVariantsEnabled() ? definition.SourceVariants : []
        };
    }

    private static bool SourceVariantsEnabled()
        => !IsFalse(Environment.GetEnvironmentVariable("WEBVIDEO_DEMO_SOURCE_VARIANTS"));

    private static bool IsFalse(string? value)
        => value is not null
            && (value.Equals("0", StringComparison.OrdinalIgnoreCase)
                || value.Equals("false", StringComparison.OrdinalIgnoreCase)
                || value.Equals("no", StringComparison.OrdinalIgnoreCase)
                || value.Equals("off", StringComparison.OrdinalIgnoreCase));

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

    private static BrowserDemoSourceVariant SelectSourceVariant(
        BrowserDemoStreamDefinition definition,
        double? desiredEgressFrameRate,
        int? desiredMaxCodedWidth = null,
        int? desiredMaxCodedHeight = null)
    {
        var primary = new BrowserDemoSourceVariant(
            definition.SourceRtspUrl,
            definition.FrameRate,
            definition.CodedWidth,
            definition.CodedHeight);
        if (definition.SourceVariants is not { Count: > 0 })
        {
            return primary;
        }

        var candidates = definition.SourceVariants.Prepend(primary).ToArray();
        if (desiredEgressFrameRate is > 0)
        {
            var frameRateTolerance = desiredEgressFrameRate.Value * 1.05;
            var frameRateCandidates = candidates
                .Where(source => source.FrameRate <= frameRateTolerance)
                .ToArray();
            if (frameRateCandidates.Length > 0)
            {
                candidates = frameRateCandidates;
            }
        }

        if (desiredMaxCodedWidth is > 0 || desiredMaxCodedHeight is > 0)
        {
            var maxWidth = desiredMaxCodedWidth.GetValueOrDefault(int.MaxValue);
            var maxHeight = desiredMaxCodedHeight.GetValueOrDefault(int.MaxValue);
            var widthTolerance = maxWidth == int.MaxValue ? int.MaxValue : (int)Math.Ceiling(maxWidth * 1.05);
            var heightTolerance = maxHeight == int.MaxValue ? int.MaxValue : (int)Math.Ceiling(maxHeight * 1.05);
            var sizeCandidates = candidates
                .Where(source => (source.CodedWidth ?? definition.CodedWidth) <= widthTolerance
                    && (source.CodedHeight ?? definition.CodedHeight) <= heightTolerance)
                .ToArray();

            if (sizeCandidates.Length > 0)
            {
                return sizeCandidates
                    .OrderByDescending(source => source.FrameRate)
                    .ThenByDescending(source => source.PixelCount(definition))
                    .First();
            }

            return candidates
                .OrderBy(source => source.PixelCount(definition))
                .ThenByDescending(source => source.FrameRate)
                .First();
        }

        return candidates
            .OrderByDescending(source => source.FrameRate)
            .ThenByDescending(source => source.PixelCount(definition))
            .First();
    }

    private sealed record BrowserDemoSourceVariant(
        string SourceRtspUrl,
        double FrameRate,
        int? CodedWidth = null,
        int? CodedHeight = null)
    {
        public long PixelCount(BrowserDemoStreamDefinition definition)
            => (long)(CodedWidth ?? definition.CodedWidth) * (CodedHeight ?? definition.CodedHeight);
    }

    private sealed record BrowserDemoStreamDefinition(
        string ChannelId,
        string StreamId,
        string DisplayName,
        string ScenarioId,
        string SourceRtspUrl,
        string SourceSummary,
        int CodedWidth,
        int CodedHeight,
        string Codec,
        string Profile,
        double FrameRate,
        IReadOnlyList<BrowserDemoSourceVariant>? SourceVariants = null);
}
