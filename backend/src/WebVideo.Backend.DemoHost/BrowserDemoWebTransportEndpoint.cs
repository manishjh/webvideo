using System.IO.Pipelines;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.Http.Features;

namespace WebVideo.Backend.DemoHost;

public static class BrowserDemoWebTransportEndpoint
{
    private static readonly TimeSpan SessionDrainGracePeriod = TimeSpan.FromSeconds(2);

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

            await HandleClientStreamAsync(channelId, catalog, liveFanout, stream, cancellationToken);
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
        ConnectionContext stream,
        CancellationToken cancellationToken)
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
            await HandleContinuousClientStreamAsync(requestedChannelId, catalog, liveFanout, stream.Transport.Output, moqFrames, cancellationToken);
        }
        else
        {
            var response = await catalog.OpenChannelSessionAsync(
                requestedChannelId,
                BrowserDemoWebTransportFrameCodec.ToSessionOpenRequest(request),
                cancellationToken: cancellationToken);

            await BrowserDemoWebTransportFrameCodec.WriteResponseAsync(stream.Transport.Output, response, cancellationToken);
        }

        await stream.Transport.Input.CompleteAsync();
    }

    private static async Task HandleContinuousClientStreamAsync(
        string channelId,
        BrowserDemoStreamCatalog catalog,
        ContinuousRtspStreamFanout liveFanout,
        PipeWriter writer,
        bool moqFrames,
        CancellationToken cancellationToken)
    {
        var channel = catalog.GetChannel(channelId);
        await using var subscription = await liveFanout.SubscribeAsync(
            channel.StreamId,
            channel.SourceRtspUrl,
            channel.Codec.FrameRate,
            cancellationToken);

        var hasStartedAtKeyFrame = false;
        var currentGroupId = 0L;
        var currentObjectId = -1L;
        await foreach (var frame in subscription.Frames.ReadAllAsync(cancellationToken))
        {
            subscription.MarkFrameRead();
            if (!hasStartedAtKeyFrame)
            {
                if (!frame.KeyFrame)
                {
                    continue;
                }

                hasStartedAtKeyFrame = true;
            }

            if (frame.KeyFrame)
            {
                currentGroupId = frame.SourceTimestampUnixTimeMs;
                currentObjectId = 0;
            }
            else
            {
                currentObjectId += 1;
            }

            var message = new BrowserDemoVideoMessage(
                StreamId: channel.StreamId,
                SequenceNumber: frame.SequenceNumber,
                PresentationTimestampUs: frame.PresentationTimestampUs,
                DecodeTimestampUs: frame.DecodeTimestampUs,
                SourceTimestampUnixTimeMs: frame.SourceTimestampUnixTimeMs,
                ServerTimestampUnixTimeMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                KeyFrame: frame.KeyFrame,
                CodecConfigVersion: "rtsp-annexb-continuous-v1",
                Payload: frame.Payload);

            if (moqFrames)
            {
                await BrowserDemoWebTransportFrameCodec.WriteMoqVideoObjectFrameAsync(writer, message, currentGroupId, currentObjectId, cancellationToken);
            }
            else
            {
                await BrowserDemoWebTransportFrameCodec.WriteVideoFrameAsync(writer, message, cancellationToken);
            }
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

                await HandleClientStreamAsync(channelId, catalog, liveFanout, stream, timeout.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // The browser did not explicitly close the session during the local
            // demo drain window. Returning lets Kestrel reclaim the preview API session.
        }
    }
}
