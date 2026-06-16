using System.Buffers;
using System.Buffers.Binary;
using WebVideo.Backend.DemoHost;
using Xunit;

namespace WebVideo.Backend.DemoHost.Tests;

public sealed class RtpMoqBridgeTests
{
    [Fact]
    public void Rtp_parser_reads_fixed_header_without_allocating_payload()
    {
        Span<byte> packet = stackalloc byte[16];
        packet[0] = 0x80;
        packet[1] = 0x80 | 96;
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(2, 2), 0x1234);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(4, 4), 90_000);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(8, 4), 0x01020304);
        packet.Slice(12).Fill(0xAA);

        var parsed = RtpPacketParser.TryParse(packet, out var view);

        Assert.True(parsed);
        Assert.Equal(96, view.PayloadType);
        Assert.True(view.Marker);
        Assert.Equal(0x1234, view.SequenceNumber);
        Assert.Equal(90_000u, view.Timestamp);
        Assert.Equal(0x01020304u, view.Ssrc);
        Assert.Equal(12, view.HeaderLength);
        Assert.Equal(12, view.PayloadOffset);
        Assert.Equal(4, view.PayloadLength);
    }

    [Fact]
    public void Rtp_parser_skips_csrc_extension_and_padding()
    {
        Span<byte> packet = stackalloc byte[32];
        packet.Clear();
        packet[0] = 0x80 | 0x20 | 0x10 | 0x01;
        packet[1] = 97;
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(2, 2), 77);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(4, 4), 1234);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(8, 4), 5678);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(12, 4), 999);
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(16, 2), 0xBEDE);
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(18, 2), 1);
        packet.Slice(20, 4).Fill(0xEE);
        packet.Slice(24, 6).Fill(0xAB);
        packet[31] = 2;

        var parsed = RtpPacketParser.TryParse(packet, out var view);

        Assert.True(parsed);
        Assert.Equal(24, view.HeaderLength);
        Assert.Equal(24, view.PayloadOffset);
        Assert.Equal(6, view.PayloadLength);
    }

    [Fact]
    public void Rtp_parser_rejects_invalid_packets()
    {
        Assert.False(RtpPacketParser.TryParse([0x40, 0, 0], out _));

        Span<byte> padded = stackalloc byte[13];
        padded[0] = 0x80 | 0x20;
        padded[12] = 9;
        Assert.False(RtpPacketParser.TryParse(padded, out _));
    }

    [Fact]
    public void Moq_packet_object_header_preserves_rtp_identity()
    {
        var packet = new byte[16];
        packet[12] = 0xCA;
        packet[15] = 0xFE;
        var view = new RtpPacketView(
            PayloadType: 96,
            Marker: true,
            SequenceNumber: 12,
            Timestamp: 34,
            Ssrc: 56,
            HeaderLength: 12,
            PayloadOffset: 12,
            PayloadLength: 4);
        var moqObject = new RtpMoqObject(3, view, packet, ReceivedTimestampNs: 99);
        Span<byte> header = stackalloc byte[RtpMoqObjectFrameWriter.PacketObjectHeaderLength];

        RtpMoqObjectFrameWriter.WritePacketObjectHeader(header, moqObject);

        Assert.Equal((byte)'M', header[0]);
        Assert.Equal((byte)'O', header[1]);
        Assert.Equal((byte)'Q', header[2]);
        Assert.Equal((byte)'L', header[3]);
        Assert.Equal(RtpMoqObjectFrameWriter.Version, header[4]);
        Assert.Equal(RtpMoqObjectFrameWriter.RtpPayloadObjectKind, header[5]);
        Assert.Equal(1, header[6]);
        Assert.Equal(96, header[7]);
        Assert.Equal(4, BinaryPrimitives.ReadInt64LittleEndian(header.Slice(8, 8)));
        Assert.Equal(34, BinaryPrimitives.ReadInt64LittleEndian(header.Slice(16, 8)));
        Assert.Equal(12, BinaryPrimitives.ReadInt64LittleEndian(header.Slice(24, 8)));
        Assert.Equal(56u, BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(32, 4)));
        Assert.Equal(4u, BinaryPrimitives.ReadUInt32LittleEndian(header.Slice(44, 4)));
        Assert.Equal(99, BinaryPrimitives.ReadInt64LittleEndian(header.Slice(48, 8)));
    }

    [Fact]
    public async Task Rtp_moq_bridge_processes_rented_packets_and_returns_buffers()
    {
        var pool = new TrackingArrayPool(128);
        var sink = new RtpMoqCountingSink();
        await using var bridge = new RtpMoqPacketBridge(
            sink,
            new RtpMoqPacketBridgeOptions(ChannelCapacity: 16, WorkerCount: 2));

        for (var index = 0; index < 8; index += 1)
        {
            var buffer = pool.Rent(32);
            WritePacket(buffer.AsSpan(0, 32), (ushort)index);
            Assert.True(bridge.TryEnqueue(new RtpMoqRentedPacket(
                CameraIndex: index % 2,
                Buffer: buffer,
                Length: 32,
                ReceivedTimestampNs: index,
                Pool: pool)));
        }

        bridge.Complete();
        await bridge.Completion;

        var metrics = bridge.GetMetrics();
        Assert.Equal(8, metrics.PacketsAccepted);
        Assert.Equal(8, metrics.PacketsProcessed);
        Assert.Equal(0, metrics.ParseErrors);
        Assert.Equal(8, sink.ObjectsWritten);
        Assert.Equal(8, pool.Returned);
    }

    [Fact]
    public async Task Rtp_moq_bridge_drops_and_returns_buffer_when_queue_is_full()
    {
        var pool = new TrackingArrayPool(128);
        var sink = new BlockingSink();
        await using var bridge = new RtpMoqPacketBridge(
            sink,
            new RtpMoqPacketBridgeOptions(ChannelCapacity: 1, WorkerCount: 1));

        var first = pool.Rent(32);
        WritePacket(first.AsSpan(0, 32), 1);
        Assert.True(bridge.TryEnqueue(new RtpMoqRentedPacket(0, first, 32, 1, pool)));
        await sink.FirstWriteStarted.WaitAsync(TimeSpan.FromSeconds(5));

        var second = pool.Rent(32);
        WritePacket(second.AsSpan(0, 32), 2);
        Assert.True(bridge.TryEnqueue(new RtpMoqRentedPacket(0, second, 32, 2, pool)));

        var third = pool.Rent(32);
        WritePacket(third.AsSpan(0, 32), 3);
        Assert.False(bridge.TryEnqueue(new RtpMoqRentedPacket(0, third, 32, 3, pool)));
        Assert.Equal(1, pool.Returned);

        sink.Release();
        bridge.Complete();
        await bridge.Completion.WaitAsync(TimeSpan.FromSeconds(5));

        var metrics = bridge.GetMetrics();
        Assert.Equal(2, metrics.PacketsAccepted);
        Assert.Equal(1, metrics.PacketsDropped);
        Assert.Equal(2, metrics.PacketsProcessed);
        Assert.Equal(0, metrics.ParseErrors);
        Assert.Equal(3, pool.Returned);
    }

    private static void WritePacket(Span<byte> packet, ushort sequence)
    {
        packet[0] = 0x80;
        packet[1] = 0x80 | 96;
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(2, 2), sequence);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(4, 4), 3000);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(8, 4), 123);
        packet.Slice(12).Fill((byte)(sequence + 1));
    }

    private sealed class TrackingArrayPool : ArrayPool<byte>
    {
        private readonly int _bufferLength;
        private int _returned;

        public TrackingArrayPool(int bufferLength)
        {
            _bufferLength = bufferLength;
        }

        public int Returned => _returned;

        public override byte[] Rent(int minimumLength)
            => new byte[Math.Max(_bufferLength, minimumLength)];

        public override void Return(byte[] array, bool clearArray = false)
            => Interlocked.Increment(ref _returned);
    }

    private sealed class BlockingSink : IRtpMoqObjectSink
    {
        private readonly TaskCompletionSource _firstWriteStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _writes;

        public Task FirstWriteStarted => _firstWriteStarted.Task;

        public ValueTask WriteObjectAsync(RtpMoqObject moqObject, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _writes) == 1)
            {
                _firstWriteStarted.TrySetResult();
                return new ValueTask(_release.Task.WaitAsync(cancellationToken));
            }

            return ValueTask.CompletedTask;
        }

        public void Release()
            => _release.TrySetResult();
    }
}
