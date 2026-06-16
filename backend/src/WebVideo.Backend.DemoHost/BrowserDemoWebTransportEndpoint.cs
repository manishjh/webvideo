using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipelines;
using System.Text;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Http.Features;

namespace WebVideo.Backend.DemoHost;

public static class BrowserDemoWebTransportEndpoint
{
    private static readonly TimeSpan SessionDrainGracePeriod = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan MinimumFrameWriteTimeout = TimeSpan.FromMilliseconds(250);
    private static readonly TimeSpan MaximumFrameWriteTimeout = TimeSpan.FromSeconds(1);
    private static readonly ConcurrentDictionary<string, BrowserDemoContinuousEgressProfiler> EgressProfilers = new(StringComparer.Ordinal);

    internal static IReadOnlyList<BrowserDemoContinuousEgressMetrics> GetEgressMetrics()
        => EgressProfilers.Values
            .Select(profiler => profiler.GetMetrics())
            .OrderBy(metrics => metrics.ChannelId, StringComparer.Ordinal)
            .ToArray();

    public static async Task HandleAsync(
        HttpContext context,
        string channelId,
        BrowserDemoStreamCatalog catalog,
        ContinuousRtspStreamFanout liveFanout)
    {
        var cancellationToken = context.RequestAborted;
        var feature = context.Features.Get<IHttpWebTransportFeature>();
        if (feature is null || !feature.IsWebTransportRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsJsonAsync(new
            {
                error = "Request is not a WebTransport CONNECT request.",
                channelId
            }, cancellationToken);
            return;
        }

        var webTransportSession = await feature.AcceptAsync(cancellationToken);

        try
        {
            var stream = await webTransportSession.AcceptStreamAsync(cancellationToken);
            if (stream is null)
            {
                return;
            }

            await HandleClientStreamAsync(channelId, catalog, liveFanout, webTransportSession, stream, cancellationToken);
            await DrainSessionAsync(webTransportSession, channelId, catalog, liveFanout, cancellationToken);
        }
        catch (KeyNotFoundException)
        {
            webTransportSession.Abort(StatusCodes.Status404NotFound);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            webTransportSession.Abort(StatusCodes.Status503ServiceUnavailable);
        }
    }

    private static async Task HandleClientStreamAsync(
        string routeChannelId,
        BrowserDemoStreamCatalog catalog,
        ContinuousRtspStreamFanout liveFanout,
        IWebTransportSession webTransportSession,
        ConnectionContext stream,
        CancellationToken cancellationToken)
    {
        try
        {
            var request = await BrowserDemoWebTransportFrameCodec.ReadOpenRequestAsync(stream.Transport.Input, cancellationToken);

            var requestedChannelId = string.IsNullOrWhiteSpace(request.ChannelId) ? routeChannelId : request.ChannelId.Trim();
            if (!string.Equals(routeChannelId, requestedChannelId, StringComparison.Ordinal))
            {
                throw new KeyNotFoundException($"Route channel '{routeChannelId}' does not match requested channel '{requestedChannelId}'.");
            }

            if (string.Equals(request.StreamMode, "continuous", StringComparison.OrdinalIgnoreCase)
                || string.Equals(request.StreamMode, "continuous-binary", StringComparison.OrdinalIgnoreCase)
                || string.Equals(request.StreamMode, "continuous-moq", StringComparison.OrdinalIgnoreCase))
            {
                var moqFrames = string.Equals(request.StreamMode, "continuous-binary", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(request.StreamMode, "continuous-moq", StringComparison.OrdinalIgnoreCase);
                await using var mediaStream = await webTransportSession.OpenUnidirectionalStreamAsync(cancellationToken);
                try
                {
                    await HandleContinuousClientStreamAsync(
                        requestedChannelId,
                        catalog,
                        liveFanout,
                        mediaStream.Transport.Output,
                        moqFrames,
                        request.TargetLatencyMs,
                        request.DesiredEgressFrameRate,
                        request.DesiredMaxCodedWidth,
                        request.DesiredMaxCodedHeight,
                        request.EnableMetadata.GetValueOrDefault(true),
                        request.ChaosDisconnectAfterFrames,
                        request.ChaosFrameDelayMs,
                        request.ChaosDropEveryNFrames,
                        cancellationToken);
                }
                finally
                {
                    await CompletePipeAsync(mediaStream.Transport.Output);
                }
            }
            else
            {
                var response = await catalog.OpenChannelSessionAsync(
                    requestedChannelId,
                    BrowserDemoWebTransportFrameCodec.ToSessionOpenRequest(request),
                    cancellationToken: cancellationToken);

                await BrowserDemoWebTransportFrameCodec.WriteResponseAsync(stream.Transport.Output, response, cancellationToken);
            }
        }
        finally
        {
            await CompletePipeAsync(stream.Transport.Output);
            await CompletePipeAsync(stream.Transport.Input);
        }
    }

    private static async Task HandleContinuousClientStreamAsync(
        string channelId,
        BrowserDemoStreamCatalog catalog,
        ContinuousRtspStreamFanout liveFanout,
        PipeWriter writer,
        bool moqFrames,
        int? targetLatencyMs,
        double? desiredEgressFrameRate,
        int? desiredMaxCodedWidth,
        int? desiredMaxCodedHeight,
        bool enableMetadata,
        int? chaosDisconnectAfterFrames,
        int? chaosFrameDelayMs,
        int? chaosDropEveryNFrames,
        CancellationToken cancellationToken)
    {
        var channel = catalog.GetChannel(channelId, desiredEgressFrameRate, desiredMaxCodedWidth, desiredMaxCodedHeight);
        await using var subscription = await liveFanout.SubscribeAsync(
            channel.StreamId,
            channel.SourceRtspUrl,
            channel.Codec.FrameRate,
            targetLatencyMs,
            cancellationToken);
        await BrowserDemoWebTransportFrameCodec.WriteSelectedSourceFrameAsync(writer, channel, cancellationToken);

        var hasStartedAtKeyFrame = false;
        var objectTimeline = new BrowserDemoMoqObjectTimeline();
        var lastDequeuedSequenceNumber = 0L;
        var frameAgeBudgetMs = Math.Max(500, (targetLatencyMs ?? 150) * 3);
        var codecConfigVersion = "rtsp-annexb-continuous-v1";
        var streamIdBytes = Encoding.UTF8.GetBytes(channel.StreamId);
        var codecConfigVersionBytes = Encoding.UTF8.GetBytes(codecConfigVersion);
        var profiler = EgressProfilers.GetOrAdd(
            channelId,
            _ => new BrowserDemoContinuousEgressProfiler(channelId, channel.StreamId));
        profiler.RecordStreamOpened();
        var framesSentInSession = 0;
        var chaosDisconnectFrameBudget = NormalizePositive(chaosDisconnectAfterFrames);
        var chaosFrameDelay = NormalizePositive(chaosFrameDelayMs);
        var chaosDropCadence = NormalizePositive(chaosDropEveryNFrames);
        var metadataCadenceFrames = Math.Max(1, (int)Math.Round(channel.Codec.FrameRate / 4.0));
        var frameDurationUs = (long)Math.Round(1_000_000.0 / Math.Max(1.0, channel.Codec.FrameRate));
        var metadataDurationUs = Math.Max(250_000L, frameDurationUs * metadataCadenceFrames);
        var frameWriteTimeout = ResolveFrameWriteTimeout(targetLatencyMs);
        using var writeTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await foreach (var frame in subscription.Frames.ReadAllAsync(cancellationToken))
        {
            try
            {
                var dequeuedAtUnixTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                profiler.RecordFrameDequeued(dequeuedAtUnixTimeMs - frame.ServerTimestampUnixTimeMs);
                var hasSequenceGap = lastDequeuedSequenceNumber > 0
                    && frame.SequenceNumber != lastDequeuedSequenceNumber + 1;
                if (hasSequenceGap)
                {
                    profiler.RecordSequenceGap(frame.SequenceNumber - lastDequeuedSequenceNumber - 1);
                    hasStartedAtKeyFrame = false;
                }

                var frameAgeMs = dequeuedAtUnixTimeMs - frame.ServerTimestampUnixTimeMs;
                if (!frame.KeyFrame && frameAgeMs > frameAgeBudgetMs)
                {
                    hasStartedAtKeyFrame = false;
                    profiler.RecordStaleFrameSkipped();
                    continue;
                }

                if (!hasStartedAtKeyFrame)
                {
                    if (!frame.KeyFrame)
                    {
                        profiler.RecordPreKeyFrameSkipped();
                        continue;
                    }

                    hasStartedAtKeyFrame = true;
                }

                if (chaosDropCadence is > 0 && frame.SequenceNumber % chaosDropCadence.Value == 0)
                {
                    profiler.RecordStaleFrameSkipped();
                    continue;
                }

                if (chaosFrameDelay is > 0)
                {
                    await Task.Delay(chaosFrameDelay.Value, cancellationToken);
                }

                var objectIdentity = objectTimeline.Advance(frame);
                var writeStartTimestamp = Stopwatch.GetTimestamp();

                if (enableMetadata && framesSentInSession % metadataCadenceFrames == 0)
                {
                    var metadataMessage = CreateContinuousMetadataMessage(channel, frame, metadataDurationUs);
                    ArmFrameWriteTimeout(writeTimeout, frameWriteTimeout);
                    try
                    {
                        var flush = await BrowserDemoWebTransportFrameCodec.WriteMetadataFrameAsync(
                            writer,
                            metadataMessage,
                            writeTimeout.Token);
                        ThrowIfFrameWriteCanceled(flush, cancellationToken);
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        throw CreateFrameWriteTimeoutException();
                    }
                    finally
                    {
                        DisarmFrameWriteTimeout(writeTimeout);
                    }
                }

                if (moqFrames)
                {
                    ArmFrameWriteTimeout(writeTimeout, frameWriteTimeout);
                    try
                    {
                        var flush = await BrowserDemoWebTransportFrameCodec.WriteMoqVideoObjectFrameAsync(
                            writer,
                            streamIdBytes,
                            frame.SequenceNumber,
                            frame.PresentationTimestampUs,
                            frame.DecodeTimestampUs,
                            frame.SourceTimestampUnixTimeMs,
                            frame.ServerTimestampUnixTimeMs,
                            frame.KeyFrame,
                            codecConfigVersionBytes,
                            frame.Payload,
                            objectIdentity.GroupId,
                            objectIdentity.ObjectId,
                            writeTimeout.Token);
                        ThrowIfFrameWriteCanceled(flush, cancellationToken);
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        throw CreateFrameWriteTimeoutException();
                    }
                    finally
                    {
                        DisarmFrameWriteTimeout(writeTimeout);
                    }

                    profiler.RecordFrameSent(
                        Stopwatch.GetElapsedTime(writeStartTimestamp).TotalMilliseconds,
                        BrowserDemoWebTransportFrameCodec.ComputeMoqVideoObjectFrameLength(
                            streamIdBytes.Length,
                            codecConfigVersionBytes.Length,
                            frame.Payload.Length));
                }
                else
                {
                    var message = new BrowserDemoVideoMessage(
                        StreamId: channel.StreamId,
                        SequenceNumber: frame.SequenceNumber,
                        PresentationTimestampUs: frame.PresentationTimestampUs,
                        DecodeTimestampUs: frame.DecodeTimestampUs,
                        SourceTimestampUnixTimeMs: frame.SourceTimestampUnixTimeMs,
                        ServerTimestampUnixTimeMs: frame.ServerTimestampUnixTimeMs,
                        KeyFrame: frame.KeyFrame,
                        CodecConfigVersion: codecConfigVersion,
                        Payload: frame.Payload);

                    ArmFrameWriteTimeout(writeTimeout, frameWriteTimeout);
                    try
                    {
                        var flush = await BrowserDemoWebTransportFrameCodec.WriteVideoFrameAsync(
                            writer,
                            message,
                            writeTimeout.Token);
                        ThrowIfFrameWriteCanceled(flush, cancellationToken);
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        throw CreateFrameWriteTimeoutException();
                    }
                    finally
                    {
                        DisarmFrameWriteTimeout(writeTimeout);
                    }

                    profiler.RecordFrameSent(Stopwatch.GetElapsedTime(writeStartTimestamp).TotalMilliseconds, frame.Payload.Length);
                }

                framesSentInSession += 1;
                if (chaosDisconnectFrameBudget is > 0 && framesSentInSession >= chaosDisconnectFrameBudget.Value)
                {
                    await BrowserDemoWebTransportFrameCodec.WriteEndFrameAsync(
                        writer,
                        channel.ChannelId,
                        channel.StreamId,
                        "chaos-disconnect-after-frames",
                        cancellationToken);
                    return;
                }
            }
            catch
            {
                profiler.RecordWriteError();
                throw;
            }
            finally
            {
                lastDequeuedSequenceNumber = frame.SequenceNumber;
                subscription.MarkFrameRead();
            }
        }
    }

    internal static BrowserDemoMetadataMessage CreateContinuousMetadataMessage(
        BrowserDemoChannelSummary channel,
        ContinuousRtspFrame frame,
        long durationUs)
    {
        var phase = (frame.SequenceNumber % 97) / 97.0;
        var x = Math.Min(0.74, 0.04 + phase * 0.62);
        var y = Math.Min(0.72, 0.10 + ((frame.SequenceNumber / 17) % 5) * 0.10);
        var width = 0.22;
        var height = 0.16;
        var resolution = $"{channel.Codec.CodedWidth}x{channel.Codec.CodedHeight}";
        var ptsMs = Math.Max(0, frame.PresentationTimestampUs / 1000);
        var endTimestampUs = frame.PresentationTimestampUs + Math.Max(1, durationUs);
        var tags = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["label"] = "OSD",
            ["text"] = $"OSD {resolution.ToUpperInvariant()} T{ptsMs}",
            ["resolution"] = resolution,
            ["sourceResolution"] = resolution,
            ["x"] = FormatCoordinate(x),
            ["y"] = FormatCoordinate(y),
            ["w"] = FormatCoordinate(width),
            ["h"] = FormatCoordinate(height),
            ["sequence"] = frame.SequenceNumber.ToString(CultureInfo.InvariantCulture),
            ["ptsUs"] = frame.PresentationTimestampUs.ToString(CultureInfo.InvariantCulture),
            ["ptsMs"] = ptsMs.ToString(CultureInfo.InvariantCulture),
            ["sourceUnixMs"] = frame.SourceTimestampUnixTimeMs.ToString(CultureInfo.InvariantCulture),
            ["serverUnixMs"] = frame.ServerTimestampUnixTimeMs.ToString(CultureInfo.InvariantCulture)
        };

        var record = new BrowserDemoOverlayRecord(
            EventId: $"osd-{channel.ChannelId}-{frame.SequenceNumber}",
            EventType: "osd",
            StartTimestampUs: frame.PresentationTimestampUs,
            EndTimestampUs: endTimestampUs,
            CoordinateSpace: "normalized-video",
            Tags: tags);

        return new BrowserDemoMetadataMessage(
            channel.StreamId,
            frame.PresentationTimestampUs,
            endTimestampUs,
            [record]);
    }

    private static string FormatCoordinate(double value)
        => value.ToString("0.###", CultureInfo.InvariantCulture);

    private static int? NormalizePositive(int? value)
        => value is > 0 ? value.Value : null;

    private static void ArmFrameWriteTimeout(CancellationTokenSource writeTimeout, TimeSpan timeout)
        => writeTimeout.CancelAfter(timeout);

    private static void DisarmFrameWriteTimeout(CancellationTokenSource writeTimeout)
    {
        if (!writeTimeout.IsCancellationRequested)
        {
            writeTimeout.CancelAfter(Timeout.InfiniteTimeSpan);
        }
    }

    private static void ThrowIfFrameWriteCanceled(FlushResult flush, CancellationToken cancellationToken)
    {
        if (flush.IsCanceled && !cancellationToken.IsCancellationRequested)
        {
            throw CreateFrameWriteTimeoutException();
        }
    }

    private static TimeoutException CreateFrameWriteTimeoutException()
        => new("WebTransport client did not accept a video frame within the low-latency write budget.");

    private static TimeSpan ResolveFrameWriteTimeout(int? targetLatencyMs)
    {
        if (targetLatencyMs is null or <= 0)
        {
            return TimeSpan.FromMilliseconds(500);
        }

        var requested = TimeSpan.FromMilliseconds(targetLatencyMs.Value * 2);
        if (requested < MinimumFrameWriteTimeout)
        {
            return MinimumFrameWriteTimeout;
        }

        return requested > MaximumFrameWriteTimeout ? MaximumFrameWriteTimeout : requested;
    }

    private static async Task CompletePipeAsync(PipeWriter writer)
    {
        try
        {
            await writer.CompleteAsync();
        }
        catch
        {
            // The transport may already have been reset by the browser or Kestrel.
        }
    }

    private static async Task CompletePipeAsync(PipeReader reader)
    {
        try
        {
            await reader.CompleteAsync();
        }
        catch
        {
            // The transport may already have been reset by the browser or Kestrel.
        }
    }

    private static async Task DrainSessionAsync(
        IWebTransportSession webTransportSession,
        string channelId,
        BrowserDemoStreamCatalog catalog,
        ContinuousRtspStreamFanout liveFanout,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(SessionDrainGracePeriod);

        try
        {
            while (!timeout.IsCancellationRequested)
            {
                var stream = await webTransportSession.AcceptStreamAsync(timeout.Token);
                if (stream is null)
                {
                    return;
                }

                await HandleClientStreamAsync(channelId, catalog, liveFanout, webTransportSession, stream, timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // The browser did not explicitly close the session during the local
            // demo drain window. Returning lets Kestrel reclaim the preview API session.
        }
    }
}
