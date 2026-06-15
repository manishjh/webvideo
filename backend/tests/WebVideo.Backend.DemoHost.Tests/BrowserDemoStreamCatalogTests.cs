using WebVideo.Backend.DemoHost;
using Xunit;
using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipelines;
using System.Text;
using System.Text.Json;

namespace WebVideo.Backend.DemoHost.Tests;

public sealed class BrowserDemoStreamCatalogTests
{
    [Fact]
    public void ListStreams_exposes_expected_demo_catalog()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var streams = catalog.ListStreams();

        Assert.Collection(
            streams,
            first =>
            {
                Assert.Equal("camera-001", first.StreamId);
                Assert.Equal("cctv-lobby-720p", first.ScenarioId);
            },
            second =>
            {
                Assert.Equal("camera-002", second.StreamId);
                Assert.Equal("cctv-entrance-720p", second.ScenarioId);
            },
            third =>
            {
                Assert.Equal("camera-003", third.StreamId);
                Assert.Equal("cctv-floor-1080p", third.ScenarioId);
            },
            fourth =>
            {
                Assert.Equal("camera-4k", fourth.StreamId);
                Assert.Equal("cctv-parking-4k", fourth.ScenarioId);
            },
            fifth =>
            {
                Assert.Equal("camera-4k-crowd", fifth.StreamId);
                Assert.Equal("cctv-road-crowd-4k60", fifth.ScenarioId);
            });
    }

    [Fact]
    public void ListChannels_exposes_client_visible_channel_routes()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var channels = catalog.ListChannels();

        Assert.Collection(
            channels,
            first =>
            {
                Assert.Equal("channel-001", first.ChannelId);
                Assert.Equal("camera-001", first.StreamId);
                Assert.Equal("cctv-lobby-720p", first.ScenarioId);
                Assert.Equal(1280, first.Codec.CodedWidth);
                Assert.Equal(720, first.Codec.CodedHeight);
            },
            second =>
            {
                Assert.Equal("channel-002", second.ChannelId);
                Assert.Equal("camera-002", second.StreamId);
                Assert.Equal("cctv-entrance-720p", second.ScenarioId);
            },
            third =>
            {
                Assert.Equal("channel-003", third.ChannelId);
                Assert.Equal("camera-003", third.StreamId);
                Assert.Equal("cctv-floor-1080p", third.ScenarioId);
            },
            fourth =>
            {
                Assert.Equal("channel-4k", fourth.ChannelId);
                Assert.Equal("camera-4k", fourth.StreamId);
                Assert.Equal("cctv-parking-4k", fourth.ScenarioId);
                Assert.Equal(3840, fourth.Codec.CodedWidth);
                Assert.Equal(2160, fourth.Codec.CodedHeight);
            },
            fifth =>
            {
                Assert.Equal("channel-4k-crowd", fifth.ChannelId);
                Assert.Equal("camera-4k-crowd", fifth.StreamId);
                Assert.Equal("cctv-road-crowd-4k60", fifth.ScenarioId);
                Assert.Equal(3840, fifth.Codec.CodedWidth);
                Assert.Equal(2160, fifth.Codec.CodedHeight);
                Assert.Equal(60.0, fifth.Codec.FrameRate);
            });
    }

    [Fact]
    public void GetChannel_selects_adaptive_source_variant_when_desired_frame_rate_is_lower()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var channel = catalog.GetChannel("channel-4k-crowd", desiredEgressFrameRate: 24);

        Assert.Equal("channel-4k-crowd", channel.ChannelId);
        Assert.Equal("camera-4k-crowd", channel.StreamId);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-1080p24", channel.SourceRtspUrl);
        Assert.Equal(1920, channel.Codec.CodedWidth);
        Assert.Equal(1080, channel.Codec.CodedHeight);
        Assert.Equal(24, channel.Codec.FrameRate);
    }

    [Fact]
    public void GetChannel_preserves_high_frame_rate_when_only_resolution_is_limited()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var channel = catalog.GetChannel(
            "channel-4k-crowd",
            desiredEgressFrameRate: null,
            desiredMaxCodedWidth: 1920,
            desiredMaxCodedHeight: 1080);

        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-1080p60", channel.SourceRtspUrl);
        Assert.Equal(1920, channel.Codec.CodedWidth);
        Assert.Equal(1080, channel.Codec.CodedHeight);
        Assert.Equal(60, channel.Codec.FrameRate);
    }

    [Fact]
    public void GetChannel_selects_resolution_limited_source_variants_for_grid_views()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var crowd = catalog.GetChannel(
            "channel-4k-crowd",
            desiredEgressFrameRate: 15,
            desiredMaxCodedWidth: 1280,
            desiredMaxCodedHeight: 720);
        var parking = catalog.GetChannel(
            "channel-4k",
            desiredEgressFrameRate: 15,
            desiredMaxCodedWidth: 1280,
            desiredMaxCodedHeight: 720);

        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-720p15", crowd.SourceRtspUrl);
        Assert.Equal(1280, crowd.Codec.CodedWidth);
        Assert.Equal(720, crowd.Codec.CodedHeight);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-parking-720p15", parking.SourceRtspUrl);
        Assert.Equal(1280, parking.Codec.CodedWidth);
        Assert.Equal(720, parking.Codec.CodedHeight);
    }

    [Fact]
    public void GetChannel_selects_low_rate_source_variants_for_dense_wall_requests()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var lobby = catalog.GetChannel("channel-001", desiredEgressFrameRate: 15);
        var floor = catalog.GetChannel("channel-003", desiredEgressFrameRate: 15);
        var crowd = catalog.GetChannel("channel-4k-crowd", desiredEgressFrameRate: 15);

        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-lobby-720p15", lobby.SourceRtspUrl);
        Assert.Equal(15, lobby.Codec.FrameRate);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-floor-1080p15", floor.SourceRtspUrl);
        Assert.Equal(15, floor.Codec.FrameRate);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-720p15", crowd.SourceRtspUrl);
        Assert.Equal(15, crowd.Codec.FrameRate);
    }

    [Fact]
    public void GetChannel_selects_emergency_source_variants_for_severe_pressure()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var lobby = catalog.GetChannel("channel-001", desiredEgressFrameRate: 5);
        var floor = catalog.GetChannel("channel-003", desiredEgressFrameRate: 2);
        var crowd = catalog.GetChannel(
            "channel-4k-crowd",
            desiredEgressFrameRate: 5,
            desiredMaxCodedWidth: 1280,
            desiredMaxCodedHeight: 720);

        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-lobby-720p5", lobby.SourceRtspUrl);
        Assert.Equal(5, lobby.Codec.FrameRate);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-floor-1080p2", floor.SourceRtspUrl);
        Assert.Equal(2, floor.Codec.FrameRate);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-720p5", crowd.SourceRtspUrl);
        Assert.Equal(5, crowd.Codec.FrameRate);
    }

    [Fact]
    public void CreateStream_returns_a_renderable_browser_payload()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var response = catalog.CreateStream("camera-001");

        Assert.Equal("channel-001", response.ChannelId);
        Assert.Equal("camera-001", response.StreamId);
        Assert.Equal("CCTV Lobby 720p", response.DisplayName);
        Assert.Equal("cctv-lobby-720p", response.ScenarioId);
        Assert.Equal("synthetic-fallback", response.SourceMode);
        Assert.False(response.SourceVerified);
        Assert.Equal("synthetic-bytes", response.AccessUnitFormat);
        Assert.Equal("avc1.42C01F", response.Codec.Codec);
        Assert.Equal(1280, response.Codec.CodedWidth);
        Assert.Equal(720, response.Codec.CodedHeight);
        Assert.Equal("webtransport-quic", response.RequestedTransport);
        Assert.Equal("http-seeded-fallback", response.ActiveTransport);
        Assert.Equal(response.ChannelId, response.Sink.ChannelId);
        Assert.Equal(response.StreamId, response.Sink.StreamId);
        Assert.Equal(8, response.VideoMessages.Count);
        Assert.Equal(8, response.MetadataMessages.Count);
        Assert.Equal(8, response.RequestedFrameCount);
        Assert.Equal(101, response.VideoMessages[0].SequenceNumber);
        Assert.True(response.VideoMessages[0].KeyFrame);
        Assert.Equal("ball", response.MetadataMessages[0].Records[0].Tags["label"]);
        Assert.Equal("player", response.MetadataMessages[1].Records[0].Tags["label"]);
    }

    [Fact]
    public void Annex_b_splitter_groups_access_units_by_delimiter()
    {
        byte[] annexB =
        [
            0, 0, 0, 1, 0x09, 0x10,
            0, 0, 0, 1, 0x65, 0x80,
            0, 0, 0, 1, 0x09, 0x10,
            0, 0, 0, 1, 0x41, 0x80
        ];

        var accessUnits = RtspH264AccessUnitCapture.SplitAnnexBAccessUnitsForTesting(annexB);

        Assert.Equal(2, accessUnits.Count);
        Assert.Equal(new byte[] { 0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x65, 0x80 }, accessUnits[0]);
        Assert.Equal(new byte[] { 0, 0, 0, 1, 0x09, 0x10, 0, 0, 0, 1, 0x41, 0x80 }, accessUnits[1]);
    }

    [Fact]
    public void WebTransport_frame_codec_serializes_video_metadata_and_end_frames()
    {
        var catalog = new BrowserDemoStreamCatalog();
        var response = catalog.CreateStream("camera-001", frameCount: 1);

        var frames = BrowserDemoWebTransportFrameCodec.EncodeResponse(response);

        Assert.Equal(3, frames.Count);

        using var videoFrame = JsonDocument.Parse(frames[0]);
        Assert.Equal("video", videoFrame.RootElement.GetProperty("kind").GetString());
        Assert.Equal("camera-001", videoFrame.RootElement.GetProperty("message").GetProperty("streamId").GetString());
        Assert.True(videoFrame.RootElement.GetProperty("message").GetProperty("payload").GetString()?.Length > 0);

        using var metadataFrame = JsonDocument.Parse(frames[1]);
        Assert.Equal("metadata", metadataFrame.RootElement.GetProperty("kind").GetString());
        Assert.Equal("evt-1", metadataFrame.RootElement.GetProperty("message").GetProperty("records")[0].GetProperty("eventId").GetString());

        using var endFrame = JsonDocument.Parse(frames[2]);
        Assert.Equal("end", endFrame.RootElement.GetProperty("kind").GetString());
        Assert.Equal("channel-001", endFrame.RootElement.GetProperty("channelId").GetString());
        Assert.Equal("camera-001", endFrame.RootElement.GetProperty("streamId").GetString());
    }

    [Fact]
    public void WebTransport_open_request_preserves_adaptive_source_intent()
    {
        var bytes = Encoding.UTF8.GetBytes("""
            {
              "channelId": "channel-4k-crowd",
              "streamId": "camera-4k-crowd",
              "viewerId": "viewer-1",
              "authToken": "demo-token",
              "targetLatencyMs": 150,
              "enableMetadata": true,
              "streamMode": "continuous-moq",
              "desiredEgressFrameRate": 24,
              "desiredMaxCodedWidth": 1920,
              "desiredMaxCodedHeight": 1080,
              "chaosDisconnectAfterFrames": 30,
              "chaosFrameDelayMs": 15,
              "chaosDropEveryNFrames": 7
            }
            """);

        var request = BrowserDemoWebTransportFrameCodec.DecodeOpenRequest(bytes);
        var sessionRequest = BrowserDemoWebTransportFrameCodec.ToSessionOpenRequest(request);

        Assert.Equal("channel-4k-crowd", request.ChannelId);
        Assert.Equal("continuous-moq", request.StreamMode);
        Assert.Equal(24.0, sessionRequest.DesiredEgressFrameRate.GetValueOrDefault());
        Assert.Equal(1920, sessionRequest.DesiredMaxCodedWidth);
        Assert.Equal(1080, sessionRequest.DesiredMaxCodedHeight);
        Assert.Equal(30, request.ChaosDisconnectAfterFrames);
        Assert.Equal(15, request.ChaosFrameDelayMs);
        Assert.Equal(7, request.ChaosDropEveryNFrames);
    }

    [Fact]
    public async Task Continuous_fanout_metrics_are_empty_before_live_subscriptions()
    {
        await using var fanout = new ContinuousRtspStreamFanout("ffmpeg");

        var metrics = fanout.GetMetrics();

        Assert.Empty(metrics);
    }

    [Fact]
    public async Task Continuous_fanout_publishes_fake_annex_b_source_to_multiple_subscribers()
    {
        var sourceGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fanout = new ContinuousRtspStreamFanout(
            CreateSingleRunSource(CreateAnnexBAccessUnitSequence(4), sourceGate.Task),
            TimeSpan.FromSeconds(2));

        await using var first = await fanout.SubscribeAsync("camera-001", "rtsp://fake.local/live/one", 30, targetLatencyMs: 150, CancellationToken.None);
        await using var second = await fanout.SubscribeAsync("camera-001", "rtsp://fake.local/live/one", 30, targetLatencyMs: 150, CancellationToken.None);

        sourceGate.SetResult();
        var firstFrame = await ReadFrameAsync(first);
        var secondFrame = await ReadFrameAsync(second);
        await ReadFrameAsync(first);
        await ReadFrameAsync(second);
        var metrics = await WaitForFanoutMetricAsync(
            fanout,
            metrics => metrics.StreamId == "camera-001" && metrics.FramesPublished >= 2 && metrics.SubscriberCount == 2);

        Assert.True(firstFrame.KeyFrame);
        Assert.True(secondFrame.KeyFrame);
        Assert.Equal(firstFrame.SequenceNumber, secondFrame.SequenceNumber);
        Assert.Equal(firstFrame.Payload, secondFrame.Payload);
        Assert.Equal("rtsp://fake.local/live/one", metrics.RtspUrl);
        Assert.Equal(2, metrics.SubscriberCount);
        Assert.True(metrics.ReaderRunning);
        Assert.False(metrics.ProcessRunning);
        Assert.True(metrics.FramesRead >= 2);
        Assert.True(metrics.KeyFramesRead >= 1);
        Assert.True(metrics.BytesRead > 0);
        Assert.True(metrics.SubscriberFramesWritten >= 4);
        Assert.Equal(0, metrics.SubscriberFramesDropped);
        Assert.True(metrics.RecentPublishedFps >= 0);
        Assert.True(metrics.RecentSubscriberReadFps >= 0);
        Assert.All(metrics.Subscribers, subscriber => Assert.InRange(subscriber.PendingFrames, 0, 10));
        Assert.All(metrics.Subscribers, subscriber => Assert.True(subscriber.RecentReadFps >= 0));
    }

    [Fact]
    public async Task Continuous_fanout_absorbs_short_low_fps_source_bursts()
    {
        await using var fanout = new ContinuousRtspStreamFanout(
            CreateSingleRunSource(CreateAnnexBAccessUnitSequence(10)),
            TimeSpan.FromSeconds(2));

        await using var subscription = await fanout.SubscribeAsync("camera-002", "rtsp://fake.local/live/two", 15, targetLatencyMs: 150, CancellationToken.None);

        var metrics = await WaitForFanoutMetricAsync(
            fanout,
            metrics => metrics.StreamId == "camera-002" && metrics.FramesPublished >= 10 && metrics.SubscriberCount == 1);

        Assert.Equal(0, metrics.SubscriberFramesDropped);
        Assert.Single(metrics.Subscribers);
        Assert.InRange(metrics.Subscribers[0].PendingFrames, 10, 12);
    }

    [Fact]
    public async Task Continuous_fanout_drops_oldest_frames_when_a_subscriber_lags()
    {
        await using var fanout = new ContinuousRtspStreamFanout(
            CreateSingleRunSource(CreateAnnexBAccessUnitSequence(24)),
            TimeSpan.FromSeconds(2));

        await using var subscription = await fanout.SubscribeAsync("camera-002", "rtsp://fake.local/live/two", 30, targetLatencyMs: 100, CancellationToken.None);

        var metrics = await WaitForFanoutMetricAsync(
            fanout,
            metrics => metrics.StreamId == "camera-002" && metrics.SubscriberFramesDropped > 0);
        var firstReadableFrame = await ReadFrameAsync(subscription);

        Assert.True(metrics.FramesPublished > 6);
        Assert.True(metrics.SubscriberFramesDropped > 0);
        Assert.True(metrics.RecentPublishedFps >= 0);
        Assert.Single(metrics.Subscribers);
        Assert.InRange(metrics.Subscribers[0].PendingFrames, 0, 12);
        Assert.True(firstReadableFrame.SequenceNumber > 1);
    }

    [Fact]
    public async Task Continuous_fanout_stops_worker_when_last_subscriber_disposes()
    {
        var sourceGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        await using var fanout = new ContinuousRtspStreamFanout(
            CreateSingleRunSource(CreateAnnexBAccessUnitSequence(4), sourceGate.Task),
            TimeSpan.FromSeconds(2));

        var subscription = await fanout.SubscribeAsync("camera-003", "rtsp://fake.local/live/three", 30, targetLatencyMs: 150, CancellationToken.None);
        var runningMetrics = await WaitForFanoutMetricAsync(
            fanout,
            metrics => metrics.StreamId == "camera-003" && metrics.ReaderRunning && metrics.SubscriberCount == 1);

        await subscription.DisposeAsync();
        var stoppedMetrics = await WaitForFanoutMetricAsync(
            fanout,
            metrics => metrics.StreamId == "camera-003" && !metrics.ReaderRunning && metrics.SubscriberCount == 0);

        Assert.True(runningMetrics.ReaderRunning);
        Assert.Equal(1, runningMetrics.SubscriberCount);
        Assert.False(stoppedMetrics.ReaderRunning);
        Assert.False(stoppedMetrics.ProcessRunning);
        Assert.Equal(0, stoppedMetrics.SubscriberCount);
    }

    [Fact]
    public async Task WebTransport_frame_codec_serializes_moq_shaped_video_objects()
    {
        var catalog = new BrowserDemoStreamCatalog();
        var message = catalog.CreateStream("camera-001", frameCount: 1).VideoMessages[0];
        var pipe = new Pipe();

        await BrowserDemoWebTransportFrameCodec.WriteMoqVideoObjectFrameAsync(
            pipe.Writer,
            message,
            groupId: 77,
            objectId: 3,
            CancellationToken.None);
        await pipe.Writer.CompleteAsync();

        var result = await pipe.Reader.ReadAsync();
        var bytes = result.Buffer.ToArray();

        Assert.Equal((byte)'M', bytes[0]);
        Assert.Equal((byte)'O', bytes[1]);
        Assert.Equal((byte)'Q', bytes[2]);
        Assert.Equal((byte)'L', bytes[3]);
        Assert.Equal(1, bytes[4]);
        Assert.Equal(1, bytes[5]);
        Assert.Equal(1, bytes[6]);
        Assert.Equal(0, bytes[7]);
        Assert.Equal(1, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(8, 8)));
        Assert.Equal(77, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(16, 8)));
        Assert.Equal(3, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(24, 8)));
        Assert.Equal(message.SequenceNumber, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(40, 8)));
        Assert.Equal(message.PresentationTimestampUs, BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(48, 8)));
        Assert.Equal((uint)message.Payload.Length, BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(80, 4)));
        Assert.Equal((ushort)"camera-001".Length, BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(84, 2)));

        pipe.Reader.AdvanceTo(result.Buffer.End);
        await pipe.Reader.CompleteAsync();
    }

    [Fact]
    public async Task WebTransport_moq_video_object_writer_rejects_oversized_string_fields()
    {
        var message = new BrowserDemoVideoMessage(
            StreamId: new string('s', ushort.MaxValue + 1),
            SequenceNumber: 1,
            PresentationTimestampUs: 1,
            DecodeTimestampUs: 1,
            SourceTimestampUnixTimeMs: 1,
            ServerTimestampUnixTimeMs: 1,
            KeyFrame: true,
            CodecConfigVersion: "cfg",
            Payload: []);
        var pipe = new Pipe();

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            BrowserDemoWebTransportFrameCodec.WriteMoqVideoObjectFrameAsync(
                pipe.Writer,
                message,
                groupId: 1,
                objectId: 0,
                CancellationToken.None));

        Assert.Contains("UInt16 length", exception.Message, StringComparison.Ordinal);
        await pipe.Writer.CompleteAsync();
        await pipe.Reader.CompleteAsync();
    }

    [Fact]
    public void Moq_object_timeline_starts_groups_on_keyframes_and_advances_delta_objects()
    {
        var timeline = new BrowserDemoMoqObjectTimeline();

        var firstKey = timeline.Advance(CreateContinuousFrame(sequenceNumber: 1, sourceTimestampMs: 10_000, keyFrame: true));
        var firstDelta = timeline.Advance(CreateContinuousFrame(sequenceNumber: 2, sourceTimestampMs: 10_033, keyFrame: false));
        var secondDelta = timeline.Advance(CreateContinuousFrame(sequenceNumber: 3, sourceTimestampMs: 10_066, keyFrame: false));
        var nextKey = timeline.Advance(CreateContinuousFrame(sequenceNumber: 30, sourceTimestampMs: 11_000, keyFrame: true));

        Assert.Equal(new BrowserDemoMoqObjectIdentity(10_000, 0), firstKey);
        Assert.Equal(new BrowserDemoMoqObjectIdentity(10_000, 1), firstDelta);
        Assert.Equal(new BrowserDemoMoqObjectIdentity(10_000, 2), secondDelta);
        Assert.Equal(new BrowserDemoMoqObjectIdentity(11_000, 0), nextKey);
    }

    [Fact]
    public async Task OpenChannelSession_resolves_channel_and_creates_a_browser_sink()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var response = await catalog.OpenChannelSessionAsync(
            "channel-002",
            new BrowserDemoSessionOpenRequest("viewer-42", "token-42", 120, true, FrameCount: 5),
            frameCount: 3,
            CancellationToken.None);

        Assert.Equal("channel-002", response.ChannelId);
        Assert.Equal("camera-002", response.StreamId);
        Assert.Equal("cctv-entrance-720p", response.ScenarioId);
        Assert.Equal("webtransport-quic", response.Sink.RequestedTransport);
        Assert.Equal("http-seeded-fallback", response.Sink.ActiveTransport);
        Assert.StartsWith("sink-", response.Sink.SinkId, StringComparison.Ordinal);
        Assert.StartsWith("browser-", response.Sink.BrowserSessionId, StringComparison.Ordinal);
        Assert.StartsWith("sub-", response.Sink.SubscriptionId, StringComparison.Ordinal);
        Assert.Equal(5, response.RequestedFrameCount);
        Assert.Equal(5, response.VideoMessages.Count);
        Assert.Equal(5, response.MetadataMessages.Count);
        Assert.Contains("/live/channel-002", response.WebTransportUrl, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OpenChannelSession_exposes_a_4k_high_resolution_channel_shape()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var response = await catalog.OpenChannelSessionAsync(
            "channel-4k",
            new BrowserDemoSessionOpenRequest("viewer-4k", "token-4k", 150, true, FrameCount: 1),
            cancellationToken: CancellationToken.None);

        Assert.Equal("channel-4k", response.ChannelId);
        Assert.Equal("camera-4k", response.StreamId);
        Assert.Equal("cctv-parking-4k", response.ScenarioId);
        Assert.Equal(3840, response.Codec.CodedWidth);
        Assert.Equal(2160, response.Codec.CodedHeight);
        Assert.Equal(1, response.RequestedFrameCount);
        Assert.Single(response.VideoMessages);
        Assert.Single(response.MetadataMessages);
    }

    [Fact]
    public async Task OpenChannelSession_exposes_a_4k60_crowd_stress_channel_shape()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var response = await catalog.OpenChannelSessionAsync(
            "channel-4k-crowd",
            new BrowserDemoSessionOpenRequest("viewer-4k60", "token-4k60", 150, true, FrameCount: 1),
            cancellationToken: CancellationToken.None);

        Assert.Equal("channel-4k-crowd", response.ChannelId);
        Assert.Equal("camera-4k-crowd", response.StreamId);
        Assert.Equal("cctv-road-crowd-4k60", response.ScenarioId);
        Assert.Equal("rtsp://127.0.0.1:8554/live/cctv-road-crowd-4k60", response.SourceRtspUrl);
        Assert.Equal(3840, response.Codec.CodedWidth);
        Assert.Equal(2160, response.Codec.CodedHeight);
        Assert.Equal(60.0, response.Codec.FrameRate);
        Assert.Equal(1, response.RequestedFrameCount);
        Assert.Single(response.VideoMessages);
        Assert.Single(response.MetadataMessages);
    }

    [Fact]
    public void ListChannels_allows_rtsp_source_overrides_from_environment()
    {
        var previousUrl = Environment.GetEnvironmentVariable("WEBVIDEO_CHANNEL_001_RTSP_URL");
        var previousWidth = Environment.GetEnvironmentVariable("WEBVIDEO_CHANNEL_001_WIDTH");
        var previousHeight = Environment.GetEnvironmentVariable("WEBVIDEO_CHANNEL_001_HEIGHT");

        try
        {
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_RTSP_URL", "rtsp://camera.example.local/live/main");
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_WIDTH", "2560");
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_HEIGHT", "1440");
            var catalog = new BrowserDemoStreamCatalog();

            var channel = Assert.Single(catalog.ListChannels(), candidate => candidate.ChannelId == "channel-001");
            var response = catalog.CreateStream("camera-001", frameCount: 1);

            Assert.Equal("rtsp://camera.example.local/live/main", channel.SourceRtspUrl);
            Assert.Equal("rtsp://camera.example.local/live/main", response.SourceRtspUrl);
            Assert.Equal(2560, response.Codec.CodedWidth);
            Assert.Equal(1440, response.Codec.CodedHeight);
        }
        finally
        {
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_RTSP_URL", previousUrl);
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_WIDTH", previousWidth);
            Environment.SetEnvironmentVariable("WEBVIDEO_CHANNEL_001_HEIGHT", previousHeight);
        }
    }

    [Fact]
    public void CreateStream_throws_for_unknown_stream_id()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var exception = Assert.Throws<KeyNotFoundException>(() => catalog.CreateStream("camera-999"));

        Assert.Contains("camera-999", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OpenChannelSession_throws_for_unknown_channel_id()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var exception = await Assert.ThrowsAsync<KeyNotFoundException>(() => catalog.OpenChannelSessionAsync("channel-999", null));

        Assert.Contains("channel-999", exception.Message, StringComparison.Ordinal);
    }

    private static byte[] CreateAnnexBAccessUnitSequence(int accessUnitCount)
    {
        var bytes = new List<byte>(accessUnitCount * 16);
        for (var index = 0; index < accessUnitCount; index++)
        {
            var isKeyFrame = index == 0 || index % 30 == 0;
            bytes.AddRange([0, 0, 0, 1, 0x09, 0x10]);
            bytes.AddRange([0, 0, 0, 1, (byte)(isKeyFrame ? 0x65 : 0x41), 0x80, (byte)index]);
        }

        return bytes.ToArray();
    }

    private static ContinuousRtspFrame CreateContinuousFrame(long sequenceNumber, long sourceTimestampMs, bool keyFrame)
        => new(
            SequenceNumber: sequenceNumber,
            PresentationTimestampUs: sequenceNumber * 33_333,
            DecodeTimestampUs: sequenceNumber * 33_333,
            SourceTimestampUnixTimeMs: sourceTimestampMs,
            ServerTimestampUnixTimeMs: sourceTimestampMs,
            KeyFrame: keyFrame,
            Payload: []);

    private static ContinuousRtspFrameSourceFactory CreateSingleRunSource(byte[] bytes, Task? firstReadGate = null)
    {
        var callCount = 0;
        var restartGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        return (_, _, _) =>
        {
            var currentCall = Interlocked.Increment(ref callCount);
            return Task.FromResult<Stream>(currentCall == 1
                ? new GatedReadStream(bytes, firstReadGate ?? Task.CompletedTask)
                : new GatedReadStream([], restartGate.Task));
        };
    }

    private static async Task<ContinuousRtspFrame> ReadFrameAsync(ContinuousRtspSubscription subscription)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        var frame = await subscription.Frames.ReadAsync(timeout.Token);
        subscription.MarkFrameRead();
        return frame;
    }

    private static async Task<ContinuousRtspFanoutMetrics> WaitForFanoutMetricAsync(
        ContinuousRtspStreamFanout fanout,
        Func<ContinuousRtspFanoutMetrics, bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!timeout.IsCancellationRequested)
        {
            var metrics = fanout.GetMetrics().FirstOrDefault(predicate);
            if (metrics is not null)
            {
                return metrics;
            }

            try
            {
                await Task.Delay(25, timeout.Token);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        throw new TimeoutException("Timed out waiting for continuous RTSP fanout metrics.");
    }

    private sealed class GatedReadStream : Stream
    {
        private readonly MemoryStream _inner;
        private readonly Task _gate;

        public GatedReadStream(byte[] bytes, Task gate)
        {
            _inner = new MemoryStream(bytes);
            _gate = gate;
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => _inner.Length;

        public override long Position
        {
            get => _inner.Position;
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await _gate.WaitAsync(cancellationToken);
            return await _inner.ReadAsync(buffer, cancellationToken);
        }

        public override long Seek(long offset, SeekOrigin origin)
            => throw new NotSupportedException();

        public override void SetLength(long value)
            => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count)
            => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
