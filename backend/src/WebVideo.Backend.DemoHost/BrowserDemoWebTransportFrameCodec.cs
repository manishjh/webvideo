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
    string? StreamMode = null);

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
        => new(request.ViewerId, request.AuthToken, request.TargetLatencyMs, request.EnableMetadata, request.FrameCount);

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

    public static async Task WriteVideoFrameAsync(
        PipeWriter writer,
        BrowserDemoVideoMessage message,
        CancellationToken cancellationToken)
    {
        await WriteFrameAsync(writer, new
        {
            kind = "video",
            message
        }, cancellationToken);
    }

    public static async Task WriteMoqVideoObjectFrameAsync(
        PipeWriter writer,
        BrowserDemoVideoMessage message,
        long groupId,
        long objectId,
        CancellationToken cancellationToken)
    {
        var streamIdBytes = Encoding.UTF8.GetBytes(message.StreamId);
        var codecConfigVersionBytes = Encoding.UTF8.GetBytes(message.CodecConfigVersion);
        if (streamIdBytes.Length > ushort.MaxValue || codecConfigVersionBytes.Length > ushort.MaxValue)
        {
            throw new InvalidOperationException("MoQ video object string fields exceed UInt16 length.");
        }

        var payloadLength = checked((uint)message.Payload.Length);
        var totalLength = checked(MoqVideoObjectFrameHeaderLength + streamIdBytes.Length + codecConfigVersionBytes.Length + message.Payload.Length);
        var target = writer.GetSpan(totalLength);
        var offset = 0;

        target[offset++] = (byte)'M';
        target[offset++] = (byte)'O';
        target[offset++] = (byte)'Q';
        target[offset++] = (byte)'L';
        target[offset++] = MoqVideoObjectFrameVersion;
        target[offset++] = MoqVideoObjectFrameKind;
        target[offset++] = message.KeyFrame ? (byte)1 : (byte)0;
        target[offset++] = 0; // Publisher Priority. Zero is highest priority in the current MoQ drafts.

        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), 1); // Track Alias
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), groupId);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), objectId);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), 0); // Subgroup ID
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), message.SequenceNumber);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), message.PresentationTimestampUs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), message.DecodeTimestampUs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), message.SourceTimestampUnixTimeMs);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(offset, sizeof(long)), message.ServerTimestampUnixTimeMs);
        offset += sizeof(long);
        BinaryPrimitives.WriteUInt32LittleEndian(target.Slice(offset, sizeof(uint)), payloadLength);
        offset += sizeof(uint);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(offset, sizeof(ushort)), (ushort)streamIdBytes.Length);
        offset += sizeof(ushort);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(offset, sizeof(ushort)), (ushort)codecConfigVersionBytes.Length);
        offset += sizeof(ushort);

        streamIdBytes.CopyTo(target.Slice(offset, streamIdBytes.Length));
        offset += streamIdBytes.Length;
        codecConfigVersionBytes.CopyTo(target.Slice(offset, codecConfigVersionBytes.Length));
        offset += codecConfigVersionBytes.Length;
        message.Payload.CopyTo(target.Slice(offset, message.Payload.Length));
        offset += message.Payload.Length;

        writer.Advance(offset);
        await writer.FlushAsync(cancellationToken);
    }

    public static async Task WriteMetadataFrameAsync(
        PipeWriter writer,
        BrowserDemoMetadataMessage message,
        CancellationToken cancellationToken)
    {
        await WriteFrameAsync(writer, new
        {
            kind = "metadata",
            message
        }, cancellationToken);
    }

    public static async Task WriteEndFrameAsync(
        PipeWriter writer,
        string channelId,
        string streamId,
        string reason,
        CancellationToken cancellationToken)
    {
        await WriteFrameAsync(writer, new
        {
            kind = "end",
            channelId,
            streamId,
            reason
        }, cancellationToken);
    }

    private static async Task WriteFrameAsync(
        PipeWriter writer,
        object frame,
        CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(frame, JsonOptions);
        await writer.WriteAsync(Encoding.UTF8.GetBytes($"{json}\n"), cancellationToken);
        await writer.FlushAsync(cancellationToken);
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
