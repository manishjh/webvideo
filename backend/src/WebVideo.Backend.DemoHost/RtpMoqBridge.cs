using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Threading.Channels;

namespace WebVideo.Backend.DemoHost;

internal readonly record struct RtpPacketView(
    byte PayloadType,
    bool Marker,
    ushort SequenceNumber,
    uint Timestamp,
    uint Ssrc,
    int HeaderLength,
    int PayloadOffset,
    int PayloadLength);

internal static class RtpPacketParser
{
    public static bool TryParse(ReadOnlySpan<byte> packet, out RtpPacketView view)
    {
        view = default;
        if (packet.Length < 12)
        {
            return false;
        }

        var first = packet[0];
        var version = first >> 6;
        if (version != 2)
        {
            return false;
        }

        var hasPadding = (first & 0x20) != 0;
        var hasExtension = (first & 0x10) != 0;
        var csrcCount = first & 0x0F;
        var headerLength = 12 + csrcCount * 4;
        if (packet.Length < headerLength)
        {
            return false;
        }

        if (hasExtension)
        {
            if (packet.Length < headerLength + 4)
            {
                return false;
            }

            var extensionWords = BinaryPrimitives.ReadUInt16BigEndian(packet.Slice(headerLength + 2, sizeof(ushort)));
            headerLength += 4 + extensionWords * 4;
            if (packet.Length < headerLength)
            {
                return false;
            }
        }

        var payloadLength = packet.Length - headerLength;
        if (hasPadding)
        {
            if (payloadLength <= 0)
            {
                return false;
            }

            var paddingBytes = packet[^1];
            if (paddingBytes == 0 || paddingBytes > payloadLength)
            {
                return false;
            }

            payloadLength -= paddingBytes;
        }

        if (payloadLength <= 0)
        {
            return false;
        }

        view = new RtpPacketView(
            PayloadType: (byte)(packet[1] & 0x7F),
            Marker: (packet[1] & 0x80) != 0,
            SequenceNumber: BinaryPrimitives.ReadUInt16BigEndian(packet.Slice(2, sizeof(ushort))),
            Timestamp: BinaryPrimitives.ReadUInt32BigEndian(packet.Slice(4, sizeof(uint))),
            Ssrc: BinaryPrimitives.ReadUInt32BigEndian(packet.Slice(8, sizeof(uint))),
            HeaderLength: headerLength,
            PayloadOffset: headerLength,
            PayloadLength: payloadLength);
        return true;
    }
}

internal readonly record struct RtpMoqRentedPacket(
    int CameraIndex,
    byte[] Buffer,
    int Length,
    long ReceivedTimestampNs,
    ArrayPool<byte> Pool)
{
    public ReadOnlySpan<byte> Span => Buffer.AsSpan(0, Length);

    public void Return()
        => Pool.Return(Buffer);
}

internal readonly record struct RtpMoqObject(
    int CameraIndex,
    RtpPacketView Rtp,
    ReadOnlyMemory<byte> Packet,
    long ReceivedTimestampNs)
{
    public ReadOnlyMemory<byte> Payload => Packet.Slice(Rtp.PayloadOffset, Rtp.PayloadLength);
}

internal static class RtpMoqObjectFrameWriter
{
    public const int PacketObjectHeaderLength = 64;
    public const byte Version = 1;
    public const byte RtpPayloadObjectKind = 2;

    public static void WritePacketObjectHeader(Span<byte> target, RtpMoqObject moqObject)
    {
        if (target.Length < PacketObjectHeaderLength)
        {
            throw new ArgumentException("Target span is shorter than the RTP MoQ object header.", nameof(target));
        }

        target.Clear();
        target[0] = (byte)'M';
        target[1] = (byte)'O';
        target[2] = (byte)'Q';
        target[3] = (byte)'L';
        target[4] = Version;
        target[5] = RtpPayloadObjectKind;
        target[6] = moqObject.Rtp.Marker ? (byte)1 : (byte)0;
        target[7] = moqObject.Rtp.PayloadType;

        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(8, sizeof(long)), moqObject.CameraIndex + 1L);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(16, sizeof(long)), moqObject.Rtp.Timestamp);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(24, sizeof(long)), moqObject.Rtp.SequenceNumber);
        BinaryPrimitives.WriteUInt32LittleEndian(target.Slice(32, sizeof(uint)), moqObject.Rtp.Ssrc);
        BinaryPrimitives.WriteUInt32LittleEndian(target.Slice(36, sizeof(uint)), moqObject.Rtp.Timestamp);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(40, sizeof(ushort)), moqObject.Rtp.SequenceNumber);
        BinaryPrimitives.WriteUInt16LittleEndian(target.Slice(42, sizeof(ushort)), (ushort)moqObject.Rtp.HeaderLength);
        BinaryPrimitives.WriteUInt32LittleEndian(target.Slice(44, sizeof(uint)), (uint)moqObject.Rtp.PayloadLength);
        BinaryPrimitives.WriteInt64LittleEndian(target.Slice(48, sizeof(long)), moqObject.ReceivedTimestampNs);
    }
}

internal interface IRtpMoqObjectSink
{
    ValueTask WriteObjectAsync(RtpMoqObject moqObject, CancellationToken cancellationToken);
}

internal sealed class RtpMoqCountingSink : IRtpMoqObjectSink
{
    private long _objectsWritten;
    private long _bytesWritten;
    private long _payloadChecksum;

    public long ObjectsWritten => Interlocked.Read(ref _objectsWritten);

    public long BytesWritten => Interlocked.Read(ref _bytesWritten);

    public long PayloadChecksum => Interlocked.Read(ref _payloadChecksum);

    public ValueTask WriteObjectAsync(RtpMoqObject moqObject, CancellationToken cancellationToken)
    {
        Span<byte> header = stackalloc byte[RtpMoqObjectFrameWriter.PacketObjectHeaderLength];
        RtpMoqObjectFrameWriter.WritePacketObjectHeader(header, moqObject);
        var payload = moqObject.Payload.Span;
        var checksum = payload[0] + payload[^1] + header[0] + header[7];

        Interlocked.Increment(ref _objectsWritten);
        Interlocked.Add(ref _bytesWritten, header.Length + payload.Length);
        Interlocked.Add(ref _payloadChecksum, checksum);
        return ValueTask.CompletedTask;
    }
}

internal sealed class RtpMoqPipeWriterSink : IRtpMoqObjectSink
{
    private readonly PipeWriter _writer;
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public RtpMoqPipeWriterSink(PipeWriter writer)
    {
        _writer = writer;
    }

    public async ValueTask WriteObjectAsync(RtpMoqObject moqObject, CancellationToken cancellationToken)
    {
        await _writeGate.WaitAsync(cancellationToken);
        try
        {
            var header = _writer.GetSpan(RtpMoqObjectFrameWriter.PacketObjectHeaderLength);
            RtpMoqObjectFrameWriter.WritePacketObjectHeader(
                header.Slice(0, RtpMoqObjectFrameWriter.PacketObjectHeaderLength),
                moqObject);
            _writer.Advance(RtpMoqObjectFrameWriter.PacketObjectHeaderLength);
            var flush = await _writer.WriteAsync(moqObject.Payload, cancellationToken);
            if (flush.IsCanceled && !cancellationToken.IsCancellationRequested)
            {
                throw new IOException("RTP MoQ pipe writer flush was canceled.");
            }
        }
        finally
        {
            _writeGate.Release();
        }
    }
}

internal sealed record RtpMoqPacketBridgeOptions(
    int ChannelCapacity,
    int WorkerCount)
{
    public static RtpMoqPacketBridgeOptions CreateDefault()
        => new(ChannelCapacity: 8192, WorkerCount: Math.Max(1, Environment.ProcessorCount));
}

internal sealed record RtpMoqPacketBridgeMetrics(
    long PacketsAccepted,
    long PacketsDropped,
    long PacketsProcessed,
    long PacketsRejected,
    long ParseErrors,
    long PayloadBytesProcessed,
    long ObjectsWritten,
    long ObjectBytesWritten);

internal sealed class RtpMoqPacketBridge : IAsyncDisposable
{
    private readonly Channel<RtpMoqRentedPacket> _channel;
    private readonly IRtpMoqObjectSink _sink;
    private readonly Task[] _workers;
    private readonly CancellationTokenSource _stop = new();
    private long _packetsAccepted;
    private long _packetsDropped;
    private long _packetsProcessed;
    private long _packetsRejected;
    private long _parseErrors;
    private long _payloadBytesProcessed;

    public RtpMoqPacketBridge(IRtpMoqObjectSink sink, RtpMoqPacketBridgeOptions options)
    {
        ArgumentNullException.ThrowIfNull(sink);
        if (options.ChannelCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Channel capacity must be positive.");
        }

        if (options.WorkerCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Worker count must be positive.");
        }

        _sink = sink;
        _channel = Channel.CreateBounded<RtpMoqRentedPacket>(new BoundedChannelOptions(options.ChannelCapacity)
        {
            AllowSynchronousContinuations = false,
            // TryWrite returns false in Wait mode when full, letting us return the rented buffer.
            // Channel drop modes can discard items internally without giving ownership back.
            FullMode = BoundedChannelFullMode.Wait,
            SingleReader = false,
            SingleWriter = false
        });
        _workers = Enumerable.Range(0, options.WorkerCount)
            .Select(_ => Task.Run(() => RunWorkerAsync(_stop.Token)))
            .ToArray();
    }

    public bool TryEnqueue(RtpMoqRentedPacket packet)
    {
        if (_channel.Writer.TryWrite(packet))
        {
            Interlocked.Increment(ref _packetsAccepted);
            return true;
        }

        Interlocked.Increment(ref _packetsDropped);
        packet.Return();
        return false;
    }

    public void Complete()
        => _channel.Writer.TryComplete();

    public Task Completion
        => Task.WhenAll(_workers);

    public RtpMoqPacketBridgeMetrics GetMetrics()
    {
        var objectsWritten = _sink is RtpMoqCountingSink countingSink ? countingSink.ObjectsWritten : 0;
        var objectBytesWritten = _sink is RtpMoqCountingSink countingSinkForBytes ? countingSinkForBytes.BytesWritten : 0;
        return new RtpMoqPacketBridgeMetrics(
            PacketsAccepted: Interlocked.Read(ref _packetsAccepted),
            PacketsDropped: Interlocked.Read(ref _packetsDropped),
            PacketsProcessed: Interlocked.Read(ref _packetsProcessed),
            PacketsRejected: Interlocked.Read(ref _packetsRejected),
            ParseErrors: Interlocked.Read(ref _parseErrors),
            PayloadBytesProcessed: Interlocked.Read(ref _payloadBytesProcessed),
            ObjectsWritten: objectsWritten,
            ObjectBytesWritten: objectBytesWritten);
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        await _stop.CancelAsync();
        try
        {
            await Task.WhenAll(_workers);
        }
        catch (OperationCanceledException)
        {
        }

        _stop.Dispose();
    }

    private async Task RunWorkerAsync(CancellationToken cancellationToken)
    {
        await foreach (var packet in _channel.Reader.ReadAllAsync(cancellationToken))
        {
            try
            {
                if (!RtpPacketParser.TryParse(packet.Span, out var rtp))
                {
                    Interlocked.Increment(ref _parseErrors);
                    continue;
                }

                var moqObject = new RtpMoqObject(
                    packet.CameraIndex,
                    rtp,
                    packet.Buffer.AsMemory(0, packet.Length),
                    packet.ReceivedTimestampNs);
                await _sink.WriteObjectAsync(moqObject, cancellationToken);
                Interlocked.Increment(ref _packetsProcessed);
                Interlocked.Add(ref _payloadBytesProcessed, rtp.PayloadLength);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch
            {
                Interlocked.Increment(ref _packetsRejected);
            }
            finally
            {
                packet.Return();
            }
        }
    }
}

internal sealed record RtpMoqBridgeBenchmarkOptions(
    int CameraCount,
    int FramesPerSecond,
    int DurationSeconds,
    int PayloadBytes,
    int ChannelCapacity,
    int WorkerCount)
{
    public static RtpMoqBridgeBenchmarkOptions CreateDefault()
        => new(
            CameraCount: 200,
            FramesPerSecond: 30,
            DurationSeconds: 10,
            PayloadBytes: 1200,
            ChannelCapacity: 16384,
            WorkerCount: Math.Max(1, Environment.ProcessorCount));
}

internal sealed record RtpMoqBridgeBenchmarkResult(
    RtpMoqBridgeBenchmarkOptions Options,
    long TargetPackets,
    long AcceptedPackets,
    long DroppedPackets,
    long ProcessedPackets,
    long ParseErrors,
    long PayloadBytesProcessed,
    long ObjectBytesWritten,
    double ElapsedMs,
    double CpuMs,
    double CpuPercentOfOneCore,
    double PacketsPerSecond,
    double TargetPacketsPerSecond,
    double PayloadGbps,
    long AllocatedBytes,
    long Gen0Collections,
    long Gen1Collections,
    long Gen2Collections,
    long WorkingSetStartBytes,
    long WorkingSetEndBytes,
    long WorkingSetDeltaBytes,
    long ManagedHeapEndBytes);

internal static class RtpMoqBridgeBenchmark
{
    private const int RtpHeaderLength = 12;

    public static async Task<RtpMoqBridgeBenchmarkResult> RunAsync(
        RtpMoqBridgeBenchmarkOptions options,
        CancellationToken cancellationToken)
    {
        Validate(options);
        WarmBufferPool(options);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        var process = Process.GetCurrentProcess();
        process.Refresh();
        var cpuStart = process.TotalProcessorTime;
        var workingSetStart = process.WorkingSet64;
        var allocatedStart = GC.GetTotalAllocatedBytes(precise: true);
        var gen0Start = GC.CollectionCount(0);
        var gen1Start = GC.CollectionCount(1);
        var gen2Start = GC.CollectionCount(2);
        var sink = new RtpMoqCountingSink();
        await using var bridge = new RtpMoqPacketBridge(
            sink,
            new RtpMoqPacketBridgeOptions(options.ChannelCapacity, options.WorkerCount));

        var pool = ArrayPool<byte>.Shared;
        var targetPackets = checked((long)options.CameraCount * options.FramesPerSecond * options.DurationSeconds);
        var packetLength = checked(RtpHeaderLength + options.PayloadBytes);
        var stopwatch = Stopwatch.StartNew();

        var sequenceNumbers = new ushort[options.CameraCount];
        for (var frameIndex = 0; frameIndex < options.FramesPerSecond * options.DurationSeconds; frameIndex += 1)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var timestamp = checked((uint)((long)frameIndex * 90_000 / options.FramesPerSecond));
            for (var cameraIndex = 0; cameraIndex < options.CameraCount; cameraIndex += 1)
            {
                var buffer = pool.Rent(packetLength);
                WriteSyntheticRtpPacket(
                    buffer.AsSpan(0, packetLength),
                    sequenceNumbers[cameraIndex]++,
                    timestamp,
                    ssrc: (uint)(cameraIndex + 1),
                    payloadSeed: (byte)(cameraIndex + frameIndex));
                bridge.TryEnqueue(new RtpMoqRentedPacket(
                    cameraIndex,
                    buffer,
                    packetLength,
                    Stopwatch.GetTimestamp(),
                    pool));
            }
        }

        bridge.Complete();
        await bridge.Completion;
        stopwatch.Stop();

        process.Refresh();
        var cpu = process.TotalProcessorTime - cpuStart;
        var allocatedBytes = GC.GetTotalAllocatedBytes(precise: true) - allocatedStart;
        var metrics = bridge.GetMetrics();
        var elapsedSeconds = Math.Max(stopwatch.Elapsed.TotalSeconds, 0.000001);
        var cpuPercentOfOneCore = cpu.TotalMilliseconds / Math.Max(stopwatch.Elapsed.TotalMilliseconds, 0.001) * 100.0;
        return new RtpMoqBridgeBenchmarkResult(
            Options: options,
            TargetPackets: targetPackets,
            AcceptedPackets: metrics.PacketsAccepted,
            DroppedPackets: metrics.PacketsDropped,
            ProcessedPackets: metrics.PacketsProcessed,
            ParseErrors: metrics.ParseErrors,
            PayloadBytesProcessed: metrics.PayloadBytesProcessed,
            ObjectBytesWritten: metrics.ObjectBytesWritten,
            ElapsedMs: stopwatch.Elapsed.TotalMilliseconds,
            CpuMs: cpu.TotalMilliseconds,
            CpuPercentOfOneCore: cpuPercentOfOneCore,
            PacketsPerSecond: metrics.PacketsProcessed / elapsedSeconds,
            TargetPacketsPerSecond: options.CameraCount * options.FramesPerSecond,
            PayloadGbps: metrics.PayloadBytesProcessed * 8.0 / elapsedSeconds / 1_000_000_000.0,
            AllocatedBytes: allocatedBytes,
            Gen0Collections: GC.CollectionCount(0) - gen0Start,
            Gen1Collections: GC.CollectionCount(1) - gen1Start,
            Gen2Collections: GC.CollectionCount(2) - gen2Start,
            WorkingSetStartBytes: workingSetStart,
            WorkingSetEndBytes: process.WorkingSet64,
            WorkingSetDeltaBytes: process.WorkingSet64 - workingSetStart,
            ManagedHeapEndBytes: GC.GetGCMemoryInfo().HeapSizeBytes);
    }

    private static void WarmBufferPool(RtpMoqBridgeBenchmarkOptions options)
    {
        var packetLength = checked(RtpHeaderLength + options.PayloadBytes);
        var pool = ArrayPool<byte>.Shared;
        var warmupBufferCount = Math.Min(
            checked(options.ChannelCapacity + options.WorkerCount),
            checked(options.CameraCount * options.FramesPerSecond * options.DurationSeconds));
        var buffers = new byte[warmupBufferCount][];
        for (var index = 0; index < buffers.Length; index += 1)
        {
            buffers[index] = pool.Rent(packetLength);
        }

        for (var index = 0; index < buffers.Length; index += 1)
        {
            pool.Return(buffers[index]);
        }
    }

    private static void Validate(RtpMoqBridgeBenchmarkOptions options)
    {
        if (options.CameraCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Camera count must be positive.");
        }

        if (options.FramesPerSecond <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Frame rate must be positive.");
        }

        if (options.DurationSeconds <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Duration must be positive.");
        }

        if (options.PayloadBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Payload size must be positive.");
        }

        if (options.ChannelCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Channel capacity must be positive.");
        }

        if (options.WorkerCount <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Worker count must be positive.");
        }
    }

    private static void WriteSyntheticRtpPacket(
        Span<byte> packet,
        ushort sequenceNumber,
        uint timestamp,
        uint ssrc,
        byte payloadSeed)
    {
        packet[0] = 0x80;
        packet[1] = 0x80 | 96;
        BinaryPrimitives.WriteUInt16BigEndian(packet.Slice(2, sizeof(ushort)), sequenceNumber);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(4, sizeof(uint)), timestamp);
        BinaryPrimitives.WriteUInt32BigEndian(packet.Slice(8, sizeof(uint)), ssrc);
        packet.Slice(RtpHeaderLength).Fill(payloadSeed);
    }
}
