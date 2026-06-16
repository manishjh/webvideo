using System.Buffers;
using System.Buffers.Binary;
using System.IO.Pipelines;
using System.Text;
using System.Text.Json;

namespace WebVideo.Backend.DemoHost;

public sealed record BrowserDemoWebTransportOpenRequest(
    string? ChannelId,
    string? StreamId,
    string? ViewerId,
    string? AuthToken,
    int? TargetLatencyMs,
    bool? EnableMetadata,
    int? FrameCount = null,
    string? StreamMode = null,
    double? DesiredEgressFrameRate = null,
    int? DesiredMaxCodedWidth = null,
    int? DesiredMaxCodedHeight = null,
    int? ChaosDisconnectAfterFrames = null,
    int? ChaosFrameDelayMs = null,
    int? ChaosDropEveryNFrames = null);

public static class BrowserDemoWebTransportFrameCodec
{
    private const int MoqVideoObjectFrameHeaderLength = 88;
    private const byte MoqVideoObjectFrameVersion = 1;
    private const byte MoqVideoObjectFrameKind = 1;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static IReadOnlyList<string> EncodeResponse(BrowserDemoStreamResponse response)
    {
        var frames = new List<string>(response.VideoMessages.Count + response.MetadataMessages.Count + 1);

        foreach (var message in response.VideoMessages)
        {
            frames.Add(JsonSerializer.Serialize(new
            {
                kind = "video",
                message
            }, JsonOptions));
        }

        foreach (var message in response.MetadataMessages)
        {
            frames.Add(JsonSerializer.Serialize(new
            {
                kind = "metadata",
                message
            }, JsonOptions));
        }

        frames.Add(JsonSerializer.Serialize(new
        {
            kind = "end",
            response.ChannelId,
            response.StreamId,
            response.Sink.SinkId,
            response.Sink.BrowserSessionId,
            response.Sink.SubscriptionId
        }, JsonOptions));

        return frames;
    }

    public static BrowserDemoWebTransportOpenRequest DecodeOpenRequest(ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return new BrowserDemoWebTransportOpenRequest(null, null, null, null, null, null);
        }

        return JsonSerializer.Deserialize<BrowserDemoWebTransportOpenRequest>(bytes, JsonOptions)
            ?? new BrowserDemoWebTransportOpenRequest(null, null, null, null, null, null);
    }

    public static BrowserDemoSessionOpenRequest ToSessionOpenRequest(BrowserDemoWebTransportOpenRequest request)
        => new(
            request.ViewerId,
            request.AuthToken,
            request.TargetLatencyMs,
            request.EnableMetadata,
            request.FrameCount,
            request.DesiredEgressFrameRate,
            request.DesiredMaxCodedWidth,
            request.DesiredMaxCodedHeight);

    public static async ValueTask<BrowserDemoWebTransportOpenRequest> ReadOpenRequestAsync(
        PipeReader reader,
        CancellationToken cancellationToken)
    {
        while (true)
        {
            var result = await reader.ReadAsync(cancellationToken);
            var buffer = result.Buffer;

            if (TryReadLine(ref buffer, out var line))
            {
                reader.AdvanceTo(buffer.Start, buffer.End);
                return DecodeOpenRequest(line);
            }

            if (result.IsCompleted)
            {
                reader.AdvanceTo(buffer.End);
                return new BrowserDemoWebTransportOpenRequest(null, null, null, null, null, null);
            }

            reader.AdvanceTo(buffer.Start, buffer.End);
        }
    }

    public static async Task WriteResponseAsync(
        PipeWriter writer,
        BrowserDemoStreamResponse response,
        CancellationToken cancellationToken)
    {
        foreach (var frame in EncodeResponse(response))
        {
            await writer.WriteAsync(Encoding.UTF8.GetBytes($"{frame}\n"), cancellationToken);
        }

        await writer.FlushAsync(cancellationToken);
        await writer.CompleteAsync();
    }

    public static ValueTask<FlushResult> WriteVideoFrameAsync(
        PipeWriter writer,
        BrowserDemoVideoMessage message,
        CancellationToken cancellationToken)
        => WriteFrameAsync(writer, new
        {
            kind = "video",
            message
        }, cancellationToken);

    public static ValueTask<FlushResult> WriteMoqVideoObjectFrameAsync(
        PipeWriter writer,
        BrowserDemoVideoMessage message,
        long groupId,
        long objectId,
        CancellationToken cancellationToken)
    {
        var streamIdBytes = Encoding.UTF8.GetBytes(message.StreamId);
        var codecConfigVersionBytes = Encoding.UTF8.GetBytes(message.CodecConfigVersion);
        return WriteMoqVideoObjectFrameAsync(
            writer,
            streamIdBytes,
            message.SequenceNumber,
            message.PresentationTimestampUs,
            message.DecodeTimestampUs,
            message.SourceTimestampUnixTimeMs,
            message.ServerTimestampUnixTimeMs,
            message.KeyFrame,
            codecConfigVersionBytes,
            message.Payload,
            groupId,
            objectId,
            cancellationToken);
    }

    public static ValueTask<FlushResult> WriteMoqVideoObjectFrameAsync(
        PipeWriter writer,
        ReadOnlyMemory<byte> streamIdBytes,
        long sequenceNumber,
        long presentationTimestampUs,
        long decodeTimestampUs,
        long sourceTimestampUnixTimeMs,
        long serverTimestampUnixTimeMs,
        bool keyFrame,
        ReadOnlyMemory<byte> codecConfigVersionBytes,
        ReadOnlyMemory<byte> payload,
        long groupId,
        long objectId,
        CancellationToken cancellationToken)
    {
        if (streamIdBytes.Length > ushort.MaxValue || codecConfigVersionBytes.Length > ushort.MaxValue)
        {
            throw new InvalidOperationException("MoQ video object string fields exceed UInt16 length.");
        }

        var payloadLength = checked((uint)payload.Length);
        var headerLength = checked(MoqVideoObjectFrameHeaderLength + streamIdBytes.Length + codecConfigVersionBytes.Length);
        var target = writer.GetSpan(headerLength);
        var offset = 0;

        target[offset++] = (byte)'M';
        target[offset++] = (byte)'O';
        target[offset++] = (byte)'Q';
        target[offset++] = (byte)'L';
        target[offset++] = MoqVideoObjectFrameVersion;
        target[offset++] = MoqVideoObjectFrameKind;
        target[offset++] = keyFrame ? (byte)1 : (byte)0;
        target[offset++] = 0; // Publisher Priority. Zero is highest priority in the current MoQ drafts.

        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), 1); // Track Alias
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), groupId);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), objectId);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), 0); // Subgroup ID
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), sequenceNumber);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), presentationTimestampUs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), decodeTimestampUs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), sourceTimestampUnixTimeMs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), serverTimestampUnixTimeMs);
        offset += sizeof(long);
        BinaryPrimitives.WriteUInt32LittleEndian(target.Slice(offset, sizeof(uint)), payloadLength);
        offset += sizeof(uint);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(offset, sizeof(ushort)), (ushort)streamIdBytes.Length);
        offset += sizeof(ushort);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(offset, sizeof(ushort)), (ushort)codecConfigVersionBytes.Length);
        offset += sizeof(ushort);

        streamIdBytes.Span.CopyTo(target.Slice(offset, streamIdBytes.Length));
        offset += streamIdBytes.Length;
        codecConfigVersionBytes.Span.CopyTo(target.Slice(offset, codecConfigVersionBytes.Length));
        offset += codecConfigVersionBytes.Length;

        writer.Advance(offset);
        if (payload.Length > 0)
        {
            return writer.WriteAsync(payload, cancellationToken);
        }

        return writer.FlushAsync(cancellationToken);
    }

    public static long ComputeMoqVideoObjectFrameLength(
        int streamIdBytesLength,
        int codecConfigVersionBytesLength,
        int payloadBytesLength)
        => checked(MoqVideoObjectFrameHeaderLength
            + streamIdBytesLength
            + codecConfigVersionBytesLength
            + payloadBytesLength);

    public static ValueTask<FlushResult> WriteMetadataFrameAsync(
        PipeWriter writer,
        BrowserDemoMetadataMessage message,
        CancellationToken cancellationToken)
        => WriteFrameAsync(writer, new
        {
            kind = "metadata",
            message
        }, cancellationToken);

    public static ValueTask<FlushResult> WriteSelectedSourceFrameAsync(
        PipeWriter writer,
        BrowserDemoChannelSummary channel,
        CancellationToken cancellationToken)
        => WriteFrameAsync(writer, new
        {
            kind = "source",
            message = new
            {
                channel.ChannelId,
                channel.StreamId,
                channel.SourceRtspUrl,
                channel.Codec
            }
        }, cancellationToken);

    public static ValueTask<FlushResult> WriteEndFrameAsync(
        PipeWriter writer,
        string channelId,
        string streamId,
        string reason,
        CancellationToken cancellationToken)
        => WriteFrameAsync(writer, new
        {
            kind = "end",
            channelId,
            streamId,
            reason
        }, cancellationToken);

    private static ValueTask<FlushResult> WriteFrameAsync(
        PipeWriter writer,
        object frame,
        CancellationToken cancellationToken)
    {
        using var jsonWriter = new Utf8JsonWriter(writer);
        JsonSerializer.Serialize(jsonWriter, frame, JsonOptions);
        jsonWriter.Flush();

        var newline = writer.GetSpan(1);
        newline[0] = (byte)'\n';
        writer.Advance(1);
        return writer.FlushAsync(cancellationToken);
    }

    private static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out byte[] line)
    {
        var reader = new SequenceReader<byte>(buffer);
        if (!reader.TryReadTo(out ReadOnlySequence<byte> lineSequence, (byte)'\n'))
        {
            line = [];
            return false;
        }

        line = lineSequence.ToArray();
        buffer = buffer.Slice(reader.Position);
        return true;
    }
}
