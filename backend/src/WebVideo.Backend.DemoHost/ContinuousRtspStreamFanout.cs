using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading.Channels;

namespace WebVideo.Backend.DemoHost;

internal delegate Task<Stream> ContinuousRtspFrameSourceFactory(
    string streamId,
    string rtspUrl,
    CancellationToken cancellationToken);

public sealed record ContinuousRtspFrame(
    long SequenceNumber,
    long PresentationTimestampUs,
    long DecodeTimestampUs,
    long SourceTimestampUnixTimeMs,
    long ServerTimestampUnixTimeMs,
    bool KeyFrame,
    byte[] Payload);

public sealed record ContinuousRtspFanoutMetrics(
    string StreamId,
    string RtspUrl,
    bool ReaderRunning,
    bool ProcessRunning,
    int SubscriberCount,
    long FramesRead,
    long KeyFramesRead,
    long BytesRead,
    long FramesPublished,
    long SubscriberFramesWritten,
    long SubscriberFramesDropped,
    long LastFrameUnixTimeMs,
    long LastKeyFrameUnixTimeMs,
    IReadOnlyList<ContinuousRtspSubscriberMetrics> Subscribers);

public sealed record ContinuousRtspSubscriberMetrics(
    Guid SubscriptionId,
    long FramesWritten,
    long FramesRead,
    long FramesDropped,
    int PendingFrames);

public sealed class ContinuousRtspStreamFanout : IAsyncDisposable
{
    private readonly string _ffmpegPath;
    private readonly ContinuousRtspFrameSourceFactory? _sourceFactory;
    private readonly TimeSpan _startupTimeout;
    private readonly ConcurrentDictionary<string, StreamWorker> _workers = new(StringComparer.Ordinal);

    public ContinuousRtspStreamFanout(string ffmpegPath, TimeSpan? startupTimeout = null)
        : this(ffmpegPath, sourceFactory: null, startupTimeout)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffmpegPath);
    }

    internal ContinuousRtspStreamFanout(ContinuousRtspFrameSourceFactory sourceFactory, TimeSpan? startupTimeout = null)
        : this("test-source", sourceFactory, startupTimeout)
    {
        ArgumentNullException.ThrowIfNull(sourceFactory);
    }

    private ContinuousRtspStreamFanout(
        string ffmpegPath,
        ContinuousRtspFrameSourceFactory? sourceFactory,
        TimeSpan? startupTimeout)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffmpegPath);

        _ffmpegPath = ffmpegPath;
        _sourceFactory = sourceFactory;
        _startupTimeout = startupTimeout ?? TimeSpan.FromSeconds(8);
    }

    public async Task<ContinuousRtspSubscription> SubscribeAsync(
        string streamId,
        string rtspUrl,
        double frameRate,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(streamId);
        ArgumentException.ThrowIfNullOrWhiteSpace(rtspUrl);

        var worker = _workers.GetOrAdd(
            streamId,
            _ => new StreamWorker(_ffmpegPath, _sourceFactory, streamId, rtspUrl, frameRate, _startupTimeout));
        return await worker.SubscribeAsync(cancellationToken);
    }

    public IReadOnlyList<ContinuousRtspFanoutMetrics> GetMetrics()
        => _workers.Values
            .Select(worker => worker.GetMetrics())
            .OrderBy(metrics => metrics.StreamId, StringComparer.Ordinal)
            .ToArray();

    public async ValueTask DisposeAsync()
    {
        foreach (var worker in _workers.Values)
        {
            await worker.DisposeAsync();
        }

        _workers.Clear();
    }

    private sealed class StreamWorker : IAsyncDisposable
    {
        private const int MaxSubscriberQueue = 6;
        private readonly object _gate = new();
        private readonly string _ffmpegPath;
        private readonly ContinuousRtspFrameSourceFactory? _sourceFactory;
        private readonly string _streamId;
        private readonly string _rtspUrl;
        private readonly long _frameDurationUs;
        private readonly TimeSpan _startupTimeout;
        private readonly Dictionary<Guid, SubscriberState> _subscribers = [];
        private CancellationTokenSource? _stop;
        private Task? _readerTask;
        private Process? _process;
        private long _sequence;
        private long _framesRead;
        private long _keyFramesRead;
        private long _bytesRead;
        private long _framesPublished;
        private long _subscriberFramesWritten;
        private long _subscriberFramesDropped;
        private long _lastFrameUnixTimeMs;
        private long _lastKeyFrameUnixTimeMs;

        public StreamWorker(
            string ffmpegPath,
            ContinuousRtspFrameSourceFactory? sourceFactory,
            string streamId,
            string rtspUrl,
            double frameRate,
            TimeSpan startupTimeout)
        {
            _ffmpegPath = ffmpegPath;
            _sourceFactory = sourceFactory;
            _streamId = streamId;
            _rtspUrl = rtspUrl;
            _frameDurationUs = (long)Math.Round(1_000_000.0 / frameRate);
            _startupTimeout = startupTimeout;
        }

        public Task<ContinuousRtspSubscription> SubscribeAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var id = Guid.NewGuid();
            var channel = Channel.CreateBounded<ContinuousRtspFrame>(new BoundedChannelOptions(MaxSubscriberQueue)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });
            var subscriber = new SubscriberState(id, channel);

            lock (_gate)
            {
                _subscribers[id] = subscriber;
                EnsureStarted();
            }

            return Task.FromResult(new ContinuousRtspSubscription(
                id,
                channel.Reader,
                subscriber.MarkFrameRead,
                () =>
                {
                    Task? readerTask = null;
                    lock (_gate)
                    {
                        if (_subscribers.Remove(id, out var removed))
                        {
                            removed.Channel.Writer.TryComplete();
                        }

                        if (_subscribers.Count == 0)
                        {
                            _stop?.Cancel();
                            TryKill(_process);
                            readerTask = _readerTask;
                        }
                    }

                    _ = readerTask?.ContinueWith(_ => { }, TaskScheduler.Default);
                }));
        }

        public ContinuousRtspFanoutMetrics GetMetrics()
        {
            SubscriberState[] subscribers;
            Process? process;
            Task? readerTask;
            lock (_gate)
            {
                subscribers = _subscribers.Values.ToArray();
                process = _process;
                readerTask = _readerTask;
            }

            var subscriberMetrics = subscribers
                .Select(subscriber => subscriber.GetMetrics())
                .OrderBy(metrics => metrics.SubscriptionId)
                .ToArray();

            return new ContinuousRtspFanoutMetrics(
                StreamId: _streamId,
                RtspUrl: _rtspUrl,
                ReaderRunning: readerTask is { IsCompleted: false },
                ProcessRunning: IsProcessRunning(process),
                SubscriberCount: subscriberMetrics.Length,
                FramesRead: Interlocked.Read(ref _framesRead),
                KeyFramesRead: Interlocked.Read(ref _keyFramesRead),
                BytesRead: Interlocked.Read(ref _bytesRead),
                FramesPublished: Interlocked.Read(ref _framesPublished),
                SubscriberFramesWritten: Interlocked.Read(ref _subscriberFramesWritten),
                SubscriberFramesDropped: Interlocked.Read(ref _subscriberFramesDropped),
                LastFrameUnixTimeMs: Interlocked.Read(ref _lastFrameUnixTimeMs),
                LastKeyFrameUnixTimeMs: Interlocked.Read(ref _lastKeyFrameUnixTimeMs),
                Subscribers: subscriberMetrics);
        }

        public async ValueTask DisposeAsync()
        {
            Task? readerTask;
            lock (_gate)
            {
                foreach (var subscriber in _subscribers.Values)
                {
                    subscriber.Channel.Writer.TryComplete();
                }

                _subscribers.Clear();
                _stop?.Cancel();
                TryKill(_process);
                readerTask = _readerTask;
            }

            if (readerTask is not null)
            {
                try
                {
                    await readerTask;
                }
                catch
                {
                    // Disposal is best-effort; the demo host will restart workers on demand.
                }
            }
        }

        private void EnsureStarted()
        {
            if (_readerTask is { IsCompleted: false } && _stop is { IsCancellationRequested: false })
            {
                return;
            }

            _stop = new CancellationTokenSource();
            _readerTask = Task.Run(() => RunAsync(_stop.Token));
        }

        private async Task RunAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    await RunFfmpegAsync(cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch
                {
                    await Task.Delay(250, cancellationToken);
                }
            }
        }

        private async Task RunFfmpegAsync(CancellationToken cancellationToken)
        {
            if (_sourceFactory is not null)
            {
                await RunSourceFactoryAsync(cancellationToken);
                return;
            }

            var processStart = new ProcessStartInfo
            {
                FileName = _ffmpegPath,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                UseShellExecute = false
            };

            foreach (var argument in new[]
            {
                "-hide_banner",
                "-loglevel", "error",
                "-rtsp_transport", "tcp",
                "-i", _rtspUrl,
                "-map", "0:v:0",
                "-an",
                "-c:v", "copy",
                "-bsf:v", "h264_metadata=aud=insert",
                "-f", "h264",
                "pipe:1"
            })
            {
                processStart.ArgumentList.Add(argument);
            }

            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(_startupTimeout);
            using var process = Process.Start(processStart)
                ?? throw new InvalidOperationException($"Failed to start ffmpeg at '{_ffmpegPath}'.");

            lock (_gate)
            {
                _process = process;
            }

            _ = process.StandardError.ReadToEndAsync(cancellationToken);
            try
            {
                await ReadAnnexBStreamAsync(process.StandardOutput.BaseStream, startup.Token, cancellationToken);
                await process.WaitForExitAsync(cancellationToken);
            }
            finally
            {
                TryKill(process);
                lock (_gate)
                {
                    if (ReferenceEquals(_process, process))
                    {
                        _process = null;
                    }
                }
            }
        }

        private async Task RunSourceFactoryAsync(CancellationToken cancellationToken)
        {
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(_startupTimeout);

            await using var source = await _sourceFactory!(_streamId, _rtspUrl, startup.Token);
            await ReadAnnexBStreamAsync(source, startup.Token, cancellationToken);
        }

        private async Task ReadAnnexBStreamAsync(
            Stream source,
            CancellationToken startupToken,
            CancellationToken cancellationToken)
        {
            var buffer = new byte[64 * 1024];
            var pending = new List<byte>(256 * 1024);
            var hasSeenBytes = false;
            while (!cancellationToken.IsCancellationRequested)
            {
                var bytesRead = await source.ReadAsync(buffer, cancellationToken);
                if (bytesRead == 0)
                {
                    return;
                }
                Interlocked.Add(ref _bytesRead, bytesRead);

                if (!hasSeenBytes)
                {
                    startupToken.ThrowIfCancellationRequested();
                    hasSeenBytes = true;
                }

                pending.AddRange(buffer.AsSpan(0, bytesRead).ToArray());
                EmitCompleteUnits(pending);
            }
        }

        private void EmitCompleteUnits(List<byte> pending)
        {
            var bytes = pending.ToArray();
            var units = RtspH264AccessUnitCapture.SplitAnnexBAccessUnits(bytes)
                .Where(unit => unit.HasVideoSlice)
                .ToArray();
            if (units.Length <= 1)
            {
                return;
            }

            var consumed = bytes.Length - units[^1].Payload.Length;
            foreach (var unit in units.Take(units.Length - 1))
            {
                Publish(unit);
            }

            pending.RemoveRange(0, Math.Min(consumed, pending.Count));
        }

        private void Publish(RtspCapturedAccessUnit unit)
        {
            var sequence = Interlocked.Increment(ref _sequence);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Interlocked.Increment(ref _framesRead);
            Interlocked.Exchange(ref _lastFrameUnixTimeMs, now);
            if (unit.IsKeyFrame)
            {
                Interlocked.Increment(ref _keyFramesRead);
                Interlocked.Exchange(ref _lastKeyFrameUnixTimeMs, now);
            }

            var frame = new ContinuousRtspFrame(
                SequenceNumber: sequence,
                PresentationTimestampUs: sequence * _frameDurationUs,
                DecodeTimestampUs: sequence * _frameDurationUs,
                SourceTimestampUnixTimeMs: now,
                ServerTimestampUnixTimeMs: now,
                KeyFrame: unit.IsKeyFrame,
                Payload: unit.Payload);

            lock (_gate)
            {
                Interlocked.Increment(ref _framesPublished);
                foreach (var subscriber in _subscribers.Values)
                {
                    var writeResult = subscriber.TryWrite(frame, MaxSubscriberQueue);
                    if (writeResult.Written)
                    {
                        Interlocked.Increment(ref _subscriberFramesWritten);
                    }

                    if (writeResult.DroppedOldest)
                    {
                        Interlocked.Increment(ref _subscriberFramesDropped);
                    }
                }
            }
        }

        private static void TryKill(Process? process)
        {
            if (process is null || process.HasExited)
            {
                return;
            }

            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best-effort cleanup only.
            }
        }

        private static bool IsProcessRunning(Process? process)
        {
            if (process is null)
            {
                return false;
            }

            try
            {
                return !process.HasExited;
            }
            catch
            {
                return false;
            }
        }

        private sealed class SubscriberState
        {
            public SubscriberState(Guid id, Channel<ContinuousRtspFrame> channel)
            {
                Id = id;
                Channel = channel;
            }

            public Guid Id { get; }

            public Channel<ContinuousRtspFrame> Channel { get; }

            private long _framesWritten;
            private long _framesRead;
            private long _framesDropped;
            private int _pendingFrames;

            public (bool Written, bool DroppedOldest) TryWrite(ContinuousRtspFrame frame, int maxQueue)
            {
                var pendingBeforeWrite = Volatile.Read(ref _pendingFrames);
                var willDropOldest = pendingBeforeWrite >= maxQueue;
                if (!willDropOldest)
                {
                    Interlocked.Increment(ref _pendingFrames);
                }

                if (!Channel.Writer.TryWrite(frame))
                {
                    if (!willDropOldest)
                    {
                        DecrementPendingFrame();
                    }

                    return (false, false);
                }

                Interlocked.Increment(ref _framesWritten);
                if (willDropOldest)
                {
                    Interlocked.Increment(ref _framesDropped);
                }

                return (true, willDropOldest);
            }

            public void MarkFrameRead()
            {
                DecrementPendingFrame();
                Interlocked.Increment(ref _framesRead);
            }

            public ContinuousRtspSubscriberMetrics GetMetrics()
                => new(
                    SubscriptionId: Id,
                    FramesWritten: Interlocked.Read(ref _framesWritten),
                    FramesRead: Interlocked.Read(ref _framesRead),
                    FramesDropped: Interlocked.Read(ref _framesDropped),
                    PendingFrames: Math.Max(0, Volatile.Read(ref _pendingFrames)));

            private void DecrementPendingFrame()
            {
                while (true)
                {
                    var current = Volatile.Read(ref _pendingFrames);
                    if (current <= 0)
                    {
                        return;
                    }

                    if (Interlocked.CompareExchange(ref _pendingFrames, current - 1, current) == current)
                    {
                        return;
                    }
                }
            }
        }
    }
}

public sealed class ContinuousRtspSubscription : IAsyncDisposable
{
    private readonly Action _dispose;
    private bool _disposed;

    public ContinuousRtspSubscription(
        Guid subscriptionId,
        ChannelReader<ContinuousRtspFrame> frames,
        Action markFrameRead,
        Action dispose)
    {
        SubscriptionId = subscriptionId;
        Frames = frames;
        _markFrameRead = markFrameRead;
        _dispose = dispose;
    }

    public Guid SubscriptionId { get; }

    public ChannelReader<ContinuousRtspFrame> Frames { get; }
    private readonly Action _markFrameRead;

    public void MarkFrameRead() => _markFrameRead();

    public ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return ValueTask.CompletedTask;
        }

        _disposed = true;
        _dispose();
        return ValueTask.CompletedTask;
    }
}
