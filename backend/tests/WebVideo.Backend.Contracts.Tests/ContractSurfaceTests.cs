using WebVideo.Backend.Contracts;
using Xunit;

namespace WebVideo.Backend.Contracts.Tests;

public sealed class ContractSurfaceTests
{
    [Fact]
    public void Coordinator_surface_matches_expected_public_methods()
    {
        var expected = new Dictionary<Type, string[]>
        {
            [typeof(CameraStreamIngestCoordinator)] =
            [
                nameof(CameraStreamIngestCoordinator.OpenCameraSessionAsync),
                nameof(CameraStreamIngestCoordinator.StopCameraSessionAsync),
                nameof(CameraStreamIngestCoordinator.GetIngestStatusAsync)
            ],
            [typeof(ArchiveContainerCoordinator)] =
            [
                nameof(ArchiveContainerCoordinator.OpenArchiveWriterAsync),
                nameof(ArchiveContainerCoordinator.WriteAccessUnitAsync),
                nameof(ArchiveContainerCoordinator.FinalizeArchiveAsync)
            ],
            [typeof(LegacyRtspProxyCoordinator)] =
            [
                nameof(LegacyRtspProxyCoordinator.CreateProxySessionAsync),
                nameof(LegacyRtspProxyCoordinator.CloseProxySessionAsync)
            ],
            [typeof(EncodedAccessUnitFanoutCoordinator)] =
            [
                nameof(EncodedAccessUnitFanoutCoordinator.PublishAccessUnitAsync),
                nameof(EncodedAccessUnitFanoutCoordinator.RegisterBrowserSubscriberAsync),
                nameof(EncodedAccessUnitFanoutCoordinator.RemoveBrowserSubscriberAsync)
            ],
            [typeof(WebTransportSessionCoordinator)] =
            [
                nameof(WebTransportSessionCoordinator.StartBrowserSessionAsync),
                nameof(WebTransportSessionCoordinator.SendVideoAccessUnitAsync),
                nameof(WebTransportSessionCoordinator.SendMetadataBatchAsync),
                nameof(WebTransportSessionCoordinator.CloseBrowserSessionAsync)
            ],
            [typeof(MetadataPublicationCoordinator)] =
            [
                nameof(MetadataPublicationCoordinator.PublishMetadataBatchAsync),
                nameof(MetadataPublicationCoordinator.GetMetadataWindowAsync)
            ],
            [typeof(OperationsTelemetryCoordinator)] =
            [
                nameof(OperationsTelemetryCoordinator.RecordStageMetricAsync),
                nameof(OperationsTelemetryCoordinator.CaptureSnapshotAsync)
            ],
            [typeof(RtspTestStreamCoordinator)] =
            [
                nameof(RtspTestStreamCoordinator.CreateSyntheticStreamAsync),
                nameof(RtspTestStreamCoordinator.SelectToolchainAsync)
            ]
        };

        foreach (var pair in expected)
        {
            var publicMethods = pair.Key
                .GetMethods()
                .Where(method => method.DeclaringType == pair.Key && method.IsPublic)
                .Select(method => method.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(pair.Value.OrderBy(name => name, StringComparer.Ordinal), publicMethods);
        }
    }

    [Fact]
    public async Task Camera_ingest_session_can_open_report_health_and_stop()
    {
        var streamId = new StreamId("camera-001");
        var endpoint = new CameraEndpoint(new Uri("rtsp://camera-001/live"), "camera-001", "user", "secret/camera-001");
        var codec = new VideoCodecDescriptor(VideoCodecKind.H264, "baseline", 1280, 720, 30.0, 4000);
        var ingestOptions = new IngestStreamOptions(codec, true, true, 64, TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(2));
        var coordinator = new CameraStreamIngestCoordinator();

        var handle = await coordinator.OpenCameraSessionAsync(
            endpoint,
            CameraTransportPreference.PreferUdp,
            ingestOptions,
            CancellationToken.None);

        Assert.Equal(streamId, handle.StreamId);
        Assert.Equal(codec, handle.Codec);

        coordinator.RecordPublishedAccessUnit(streamId, new EncodedAccessUnit(streamId, 42, 2_000_000, 2_000_000, true, false, ReadOnlyMemory<byte>.Empty));

        var healthyStatus = await coordinator.GetIngestStatusAsync(streamId, CancellationToken.None);
        Assert.True(healthyStatus.IsHealthy);
        Assert.Equal(42, healthyStatus.LastAccessUnitSequenceNumber);

        await coordinator.StopCameraSessionAsync(streamId, StopReason.OperatorRequest, CancellationToken.None);

        var stoppedStatus = await coordinator.GetIngestStatusAsync(streamId, CancellationToken.None);
        Assert.False(stoppedStatus.IsHealthy);
    }

    [Fact]
    public async Task Archive_writer_persists_access_units_and_finalizes()
    {
        var streamId = new StreamId("camera-001");
        var archivePath = Path.Combine(Path.GetTempPath(), $"webvideo-{Guid.NewGuid():N}", "{streamId}", "{utc:yyyyMMddHHmmss}.wvv");
        var options = new ArchiveSinkOptions("wvf1", archivePath, TimeSpan.FromSeconds(10), true);
        var coordinator = new ArchiveContainerCoordinator();
        var accessUnit = new EncodedAccessUnit(streamId, 7, 2_000_000, 2_000_000, true, false, new byte[] { 1, 2, 3 });
        var timing = new FlowTimingContext(1_000_000, 1_100_000, 1_200_000, 1_300_000);

        var handle = await coordinator.OpenArchiveWriterAsync(streamId, options, CancellationToken.None);
        await coordinator.WriteAccessUnitAsync(handle, accessUnit, timing, CancellationToken.None);
        await coordinator.FinalizeArchiveAsync(handle, CancellationToken.None);

        var snapshot = coordinator.GetSnapshotForTesting(handle.WriterId);
        var contents = await File.ReadAllTextAsync(handle.ArchivePath);

        Assert.True(File.Exists(handle.ArchivePath));
        Assert.Single(snapshot.AccessUnits);
        Assert.True(snapshot.IsFinalized);
        Assert.Contains("WVV1|stream=camera-001|container=wvf1", contents, StringComparison.Ordinal);
        Assert.Contains("AU|7|2000000|2000000|K|AQID|1300000", contents, StringComparison.Ordinal);
        Assert.Contains("END", contents, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Proxy_and_browser_session_paths_track_lifecycle_and_payloads()
    {
        var streamId = new StreamId("camera-001");
        var proxyCoordinator = new LegacyRtspProxyCoordinator();
        var sessionCoordinator = new WebTransportSessionCoordinator();
        var proxyOptions = new ProxySessionOptions("viewer-vlc", true, TimeSpan.FromMinutes(5));
        var browserRequest = new BrowserSessionRequest(streamId, "viewer-browser", new Uri("https://localhost:9443/live/channel-001"), "token", TimeSpan.FromMilliseconds(150), true)
        {
            ChannelId = new ChannelId("channel-001")
        };
        var accessUnit = new EncodedAccessUnit(streamId, 5, 2_000_000, 2_000_000, false, false, new byte[] { 9 });
        var metadata = new MetadataBatch(
            streamId,
            MetadataTransportKind.ReliableOrderedStream,
            2_000_000,
            2_033_333,
            [
                new OverlayMetadataRecord("evt-1", "box2d", 2_000_000, 2_033_333, "normalized-video", new Dictionary<string, string> { ["label"] = "ball" })
            ]);

        var proxyHandle = await proxyCoordinator.CreateProxySessionAsync(streamId, proxyOptions, CancellationToken.None);
        await proxyCoordinator.CloseProxySessionAsync(proxyHandle, CancellationToken.None);

        var proxySnapshot = proxyCoordinator.GetSnapshotForTesting(proxyHandle.SessionId);
        Assert.True(proxySnapshot.IsClosed);
        Assert.Equal("viewer-vlc", proxySnapshot.Options.ViewerId);

        var browserHandle = await sessionCoordinator.StartBrowserSessionAsync(browserRequest, CancellationToken.None);
        await sessionCoordinator.SendVideoAccessUnitAsync(browserHandle, accessUnit, CancellationToken.None);
        await sessionCoordinator.SendMetadataBatchAsync(browserHandle, metadata, CancellationToken.None);
        await sessionCoordinator.CloseBrowserSessionAsync(browserHandle, SessionCloseReason.ServerDrain, CancellationToken.None);

        var browserSnapshot = sessionCoordinator.GetSnapshotForTesting(browserHandle.SessionId);
        Assert.True(browserSnapshot.IsClosed);
        Assert.Equal(new ChannelId("channel-001"), browserSnapshot.Request.ChannelId);
        Assert.Equal(new ChannelId("channel-001"), browserSnapshot.Handle.ChannelId);
        Assert.Equal(SessionCloseReason.ServerDrain, browserSnapshot.CloseReason);
        Assert.Single(browserSnapshot.SentVideo);
        Assert.Single(browserSnapshot.SentMetadata);
    }

    [Fact]
    public async Task Fanout_metadata_telemetry_and_rtsp_definition_paths_behave_consistently()
    {
        var streamId = new StreamId("camera-001");
        var fanout = new EncodedAccessUnitFanoutCoordinator(defaultRingCapacity: 3);
        var metadataCoordinator = new MetadataPublicationCoordinator();
        var telemetryCoordinator = new OperationsTelemetryCoordinator();
        var rtspCoordinator = new RtspTestStreamCoordinator();
        var timing = new FlowTimingContext(1_000_000, 1_100_000, 1_200_000, 1_300_000);

        for (var i = 1; i <= 5; i++)
        {
            await fanout.PublishAccessUnitAsync(
                streamId,
                new EncodedAccessUnit(streamId, i, i * 1_000, i * 1_000, i == 1, false, new byte[] { (byte)i }),
                timing,
                CancellationToken.None);
        }

        var subscription = await fanout.RegisterBrowserSubscriberAsync(
            streamId,
            new BrowserSubscriberDescriptor("viewer-browser", "Playwright", TimeSpan.FromMilliseconds(150), 4),
            CancellationToken.None);

        var fanoutSnapshot = fanout.GetSnapshotForTesting(streamId);
        Assert.Equal([3L, 4L, 5L], fanoutSnapshot.AccessUnits.Select(unit => unit.SequenceNumber).ToArray());
        Assert.Single(fanoutSnapshot.Subscribers);

        await fanout.RemoveBrowserSubscriberAsync(subscription, CancellationToken.None);
        Assert.Empty(fanout.GetSnapshotForTesting(streamId).Subscribers);

        var activeBatch = new MetadataBatch(
            streamId,
            MetadataTransportKind.ReliableOrderedStream,
            1_950_000,
            2_050_000,
            [new OverlayMetadataRecord("evt-a", "box2d", 1_950_000, 2_050_000, "normalized-video", new Dictionary<string, string>())]);
        var futureBatch = new MetadataBatch(
            streamId,
            MetadataTransportKind.ReliableOrderedStream,
            2_500_000,
            2_600_000,
            [new OverlayMetadataRecord("evt-b", "box2d", 2_500_000, 2_600_000, "normalized-video", new Dictionary<string, string>())]);

        await metadataCoordinator.PublishMetadataBatchAsync(streamId, activeBatch, CancellationToken.None);
        await metadataCoordinator.PublishMetadataBatchAsync(streamId, futureBatch, CancellationToken.None);

        var metadataWindow = await metadataCoordinator.GetMetadataWindowAsync(
            streamId,
            new PresentationWindowQuery(2_000_000, TimeSpan.FromMilliseconds(100), TimeSpan.FromMilliseconds(10)),
            CancellationToken.None);

        Assert.Single(metadataWindow.Batches);
        Assert.Equal("evt-a", metadataWindow.Batches[0].Records[0].EventId);

        await telemetryCoordinator.RecordStageMetricAsync(
            streamId,
            new MetricPoint("fanout.queue.depth", 1.0, "count", DateTimeOffset.UtcNow),
            CancellationToken.None);
        await telemetryCoordinator.RecordStageMetricAsync(
            streamId,
            new MetricPoint("egress.video.latency", 3.4, "ms", DateTimeOffset.UtcNow),
            CancellationToken.None);

        var telemetry = await telemetryCoordinator.CaptureSnapshotAsync(streamId, CancellationToken.None);
        Assert.Equal(2, telemetry.Metrics.Count);

        var rtspDefinition = await rtspCoordinator.CreateSyntheticStreamAsync("udp-h264-smoke", CameraTransportPreference.ForceUdp, CancellationToken.None);
        var toolchain = await rtspCoordinator.SelectToolchainAsync(CancellationToken.None);
        Assert.Equal(VideoCodecKind.H264, rtspDefinition.Codec);
        Assert.Equal("baseline", rtspDefinition.Profile);
        Assert.Equal(ExternalToolPreference.MediaMtxAndFfmpeg, toolchain);
    }
}
