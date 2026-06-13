using WebVideo.Backend.Contracts;
using WebVideo.Backend.TestKit;

namespace WebVideo.Backend.DemoHost;

public sealed record BrowserDemoStreamSummary(
    string StreamId,
    string DisplayName,
    string ScenarioId,
    string SourceRtspUrl,
    string Summary);

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
    bool KeyFrame,
    string CodecConfigVersion,
    byte[] Payload);

public sealed record BrowserDemoStreamResponse(
    string StreamId,
    string DisplayName,
    string ScenarioId,
    string SourceRtspUrl,
    string SourceSummary,
    int TargetLatencyMs,
    int FrameIntervalMs,
    string WebTransportUrl,
    bool MetadataChannelRequired,
    BrowserDemoCodecDescriptor Codec,
    IReadOnlyList<BrowserDemoVideoMessage> VideoMessages,
    IReadOnlyList<BrowserDemoMetadataMessage> MetadataMessages);

/// <summary>
/// Produces deterministic browser-facing demo payloads so the frontend can fetch a real
/// HTTP endpoint and render a visible synthetic stream before the RTSP/QUIC media path
/// is integrated.
/// </summary>
public sealed class BrowserDemoStreamCatalog
{
    private static readonly BrowserDemoStreamDefinition[] Definitions =
    [
        new(
            StreamId: "camera-001",
            DisplayName: "Synthetic Camera 001",
            Scenario: SyntheticRtspStreamCatalog.AllScenarios.Single(scenario => scenario.ScenarioId == "udp-h264-smoke")),
        new(
            StreamId: "camera-002",
            DisplayName: "Synthetic Camera 002",
            Scenario: SyntheticRtspStreamCatalog.AllScenarios.Single(scenario => scenario.ScenarioId == "tcp-h264-smoke"))
    ];

    public IReadOnlyList<BrowserDemoStreamSummary> ListStreams()
    {
        return Definitions
            .Select(definition => new BrowserDemoStreamSummary(
                definition.StreamId,
                definition.DisplayName,
                definition.Scenario.ScenarioId,
                definition.Scenario.Reservation.PublishUrl,
                definition.Scenario.Summary))
            .ToArray();
    }

    public BrowserDemoStreamResponse CreateStream(string streamId, int frameCount = 8)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(streamId);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(frameCount);

        var definition = Definitions.SingleOrDefault(candidate => string.Equals(candidate.StreamId, streamId, StringComparison.Ordinal));
        if (definition is null)
        {
            throw new KeyNotFoundException($"Unknown demo stream '{streamId}'.");
        }

        const long baseTimestampUs = 2_000_000;
        const long frameDurationUs = 33_333;
        var codec = new BrowserDemoCodecDescriptor(
            Codec: "avc1",
            CodedWidth: definition.Scenario.Definition.Width,
            CodedHeight: definition.Scenario.Definition.Height,
            Profile: definition.Scenario.Definition.Profile,
            FrameRate: definition.Scenario.Definition.FrameRate);

        var videoMessages = Enumerable.Range(0, frameCount)
            .Select(index =>
            {
                var payloadSeed = index + 1;
                return new BrowserDemoVideoMessage(
                    StreamId: definition.StreamId,
                    SequenceNumber: 101 + index,
                    PresentationTimestampUs: baseTimestampUs + index * frameDurationUs,
                    DecodeTimestampUs: baseTimestampUs + index * frameDurationUs,
                    KeyFrame: index == 0,
                    CodecConfigVersion: "cfg-demo-v1",
                    Payload: [unchecked((byte)payloadSeed), unchecked((byte)((payloadSeed + 2) * 3))]);
            })
            .ToArray();

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

        return new BrowserDemoStreamResponse(
            StreamId: definition.StreamId,
            DisplayName: definition.DisplayName,
            ScenarioId: definition.Scenario.ScenarioId,
            SourceRtspUrl: definition.Scenario.Reservation.PublishUrl,
            SourceSummary: definition.Scenario.Summary,
            TargetLatencyMs: 150,
            FrameIntervalMs: (int)Math.Round(1000.0 / definition.Scenario.Definition.FrameRate),
            WebTransportUrl: $"https://localhost:9443/live/{definition.StreamId}",
            MetadataChannelRequired: true,
            Codec: codec,
            VideoMessages: videoMessages,
            MetadataMessages: metadataMessages);
    }

    private sealed record BrowserDemoStreamDefinition(
        string StreamId,
        string DisplayName,
        SyntheticRtspScenario Scenario);
}
