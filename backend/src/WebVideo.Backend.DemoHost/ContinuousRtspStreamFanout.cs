using System.Collections.Concurrent;
using System.Buffers;
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
    long LastFrameIntervalMs,
    long MaxFrameIntervalMs,
    long LastFrameAgeMs,
    long RecentFrameIntervalP95Ms,
    long RecentFrameIntervalMaxMs,
    long RecentFrameHitches,
    long RecentSevereFrameHitches,
    long LastKeyFrameIntervalMs,
    long ReaderRestartCount,
    long ReaderErrorCount,
    double IngressFps,
    double PublishedFps,
    double SubscriberReadFps,
    double RecentIngressFps,
    double RecentPublishedFps,
    double RecentSubscriberReadFps,
    IReadOnlyList<ContinuousRtspSubscriberMetrics> Subscribers);

public sealed record ContinuousRtspSubscriberMetrics(
    Guid SubscriptionId,
    long FramesWritten,
    long FramesRead,
    long FramesDropped,
    int PendingFrames,
    double RecentReadFps);

public sealed class ContinuousRtspStreamFanout : IAsyncDisposable
{
    public const string DefaultRtspTransport = "tcp";

    private readonly string _ffmpegPath;
    private readonly string _rtspTransport;
    private readonly ContinuousRtspFrameSourceFactory? _sourceFactory;
    private readonly TimeSpan _startupTimeout;
    private readonly ConcurrentDictionary<string, StreamWorker> _workers = new(StringComparer.Ordinal);

    public ContinuousRtspStreamFanout(string ffmpegPath, TimeSpan? startupTimeout = null, string? rtspTransport = null)
        : this(ffmpegPath, NormalizeRtspTransport(rtspTransport), sourceFactory: null, startupTimeout)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffmpegPath);
    }

    internal ContinuousRtspStreamFanout(ContinuousRtspFrameSourceFactory sourceFactory, TimeSpan? startupTimeout = null)
        : this("test-source", DefaultRtspTransport, sourceFactory, startupTimeout)
    {
        ArgumentNullException.ThrowIfNull(sourceFactory);
    }

    private ContinuousRtspStreamFanout(
        string ffmpegPath,
        string rtspTransport,
        ContinuousRtspFrameSourceFactory? sourceFactory,
        TimeSpan? startupTimeout)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffmpegPath);

        _ffmpegPath = ffmpegPath;
        _rtspTransport = rtspTransport;
        _sourceFactory = sourceFactory;
        _startupTimeout = startupTimeout ?? TimeSpan.FromSeconds(8);
    }

    public async Task<ContinuousRtspSubscription> SubscribeAsync(
        string streamId,
        string rtspUrl,
        double frameRate,
        int? targetLatencyMs,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(streamId);
        ArgumentException.ThrowIfNullOrWhiteSpace(rtspUrl);

        var workerKey = $"{streamId}\n{rtspUrl}";
        var worker = _workers.GetOrAdd(
            workerKey,
            _ => new StreamWorker(_ffmpegPath, _rtspTransport, _sourceFactory, streamId, rtspUrl, frameRate, _startupTimeout));
        return await worker.SubscribeAsync(targetLatencyMs, cancellationToken);
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

    public static string NormalizeRtspTransport(string? rtspTransport)
    {
        if (string.IsNullOrWhiteSpace(rtspTransport))
        {
            return DefaultRtspTransport;
        }

        var normalized = rtspTransport.Trim().ToLowerInvariant();
        return normalized switch
        {
            "udp" => "udp",
            "tcp" => "tcp",
            _ => throw new ArgumentException("RTSP transport must be 'udp' or 'tcp'.", nameof(rtspTransport))
        };
    }

    internal static IReadOnlyList<string> CreateFfmpegArgumentsForTesting(string rtspTransport, string rtspUrl)
        => StreamWorker.CreateFfmpegArguments(rtspTransport, rtspUrl);

    private sealed class StreamWorker : IAsyncDisposable
    {
        private const int MaxSubscriberQueue = 12;
        private const int RecentSampleCapacity = 4096;
        private readonly object _gate = new();
        private readonly string _ffmpegPath;
        private readonly string _rtspTransport;
        private readonly ContinuousRtspFrameSourceFactory? _sourceFactory;
        private readonly string _streamId;
        private readonly string _rtspUrl;
        private readonly double _frameRate;
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
        private long _lastFrameIntervalMs;
        private long _maxFrameIntervalMs;
        private long _lastKeyFrameIntervalMs;
        private long _readerRestartCount;
        private long _readerErrorCount;
        private long _startedUnixTimeMs;
        private readonly long[] _recentFrameUnixTimeMs = new long[RecentSampleCapacity];

        public StreamWorker(
            string ffmpegPath,
            string rtspTransport,
            ContinuousRtspFrameSourceFactory? sourceFactory,
            string streamId,
            string rtspUrl,
            double frameRate,
            TimeSpan startupTimeout)
        {
            _ffmpegPath = ffmpegPath;
            _rtspTransport = rtspTransport;
            _sourceFactory = sourceFactory;
            _streamId = streamId;
            _rtspUrl = rtspUrl;
            _frameRate = frameRate;
            _frameDurationUs = (long)Math.Round(1_000_000.0 / frameRate);
            _startupTimeout = startupTimeout;
        }

        public Task<ContinuousRtspSubscription> SubscribeAsync(int? targetLatencyMs, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var id = Guid.NewGuid();
            var maxQueue = ComputeSubscriberQueueDepth(targetLatencyMs);
            var channel = Channel.CreateBounded<ContinuousRtspFrame>(new BoundedChannelOptions(maxQueue)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });
            var subscriber = new SubscriberState(id, channel, maxQueue);

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
            var nowUnixTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var elapsedSeconds = Math.Max(
                (nowUnixTimeMs - Interlocked.Read(ref _startedUnixTimeMs)) / 1000.0,
                0.001);
            var framesRead = Interlocked.Read(ref _framesRead);
            var framesPublished = Interlocked.Read(ref _framesPublished);
            var subscriberFramesRead = subscriberMetrics.Sum(metrics => metrics.FramesRead);
            var recentFrameFps = ComputeRecentFps(_recentFrameUnixTimeMs, nowUnixTimeMs);
            var recentFrameCadence = ComputeRecentFrameCadence(_recentFrameUnixTimeMs, nowUnixTimeMs, _frameRate);
            var lastFrameUnixTimeMs = Interlocked.Read(ref _lastFrameUnixTimeMs);

            return new ContinuousRtspFanoutMetrics(
                StreamId: _streamId,
                RtspUrl: _rtspUrl,
                ReaderRunning: readerTask is { IsCompleted: false },
                ProcessRunning: IsProcessRunning(process),
                SubscriberCount: subscriberMetrics.Length,
                FramesRead: framesRead,
                KeyFramesRead: Interlocked.Read(ref _keyFramesRead),
                BytesRead: Interlocked.Read(ref _bytesRead),
                FramesPublished: framesPublished,
                SubscriberFramesWritten: Interlocked.Read(ref _subscriberFramesWritten),
                SubscriberFramesDropped: Interlocked.Read(ref _subscriberFramesDropped),
                LastFrameUnixTimeMs: lastFrameUnixTimeMs,
                LastKeyFrameUnixTimeMs: Interlocked.Read(ref _lastKeyFrameUnixTimeMs),
                LastFrameIntervalMs: Interlocked.Read(ref _lastFrameIntervalMs),
                MaxFrameIntervalMs: Interlocked.Read(ref _maxFrameIntervalMs),
                LastFrameAgeMs: lastFrameUnixTimeMs > 0 ? Math.Max(0, nowUnixTimeMs - lastFrameUnixTimeMs) : 0,
                RecentFrameIntervalP95Ms: recentFrameCadence.P95Ms,
                RecentFrameIntervalMaxMs: recentFrameCadence.MaxMs,
                RecentFrameHitches: recentFrameCadence.Hitches,
                RecentSevereFrameHitches: recentFrameCadence.SevereHitches,
                LastKeyFrameIntervalMs: Interlocked.Read(ref _lastKeyFrameIntervalMs),
                ReaderRestartCount: Interlocked.Read(ref _readerRestartCount),
                ReaderErrorCount: Interlocked.Read(ref _readerErrorCount),
                IngressFps: framesRead / elapsedSeconds,
                PublishedFps: framesPublished / elapsedSeconds,
                SubscriberReadFps: subscriberFramesRead / elapsedSeconds,
                RecentIngressFps: recentFrameFps,
                RecentPublishedFps: recentFrameFps,
                RecentSubscriberReadFps: subscriberMetrics.Sum(metrics => metrics.RecentReadFps),
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
            Interlocked.Exchange(ref _startedUnixTimeMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
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
                    Interlocked.Increment(ref _readerErrorCount);
                    Interlocked.Increment(ref _readerRestartCount);
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

            foreach (var argument in CreateFfmpegArguments(_rtspTransport, _rtspUrl))
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

        internal static string[] CreateFfmpegArguments(string rtspTransport, string rtspUrl)
            =>
            [
                "-hide_banner",
                "-loglevel", "error",
                "-rtsp_transport", rtspTransport,
                "-i", rtspUrl,
                "-map", "0:v:0",
                "-an",
                "-c:v", "copy",
                "-bsf:v", RtspH264AccessUnitCapture.WebCodecsSafeH264AnnexBBitstreamFilter,
                "-f", "h264",
                "pipe:1"
            ];

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
            var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
            var parser = new ContinuousRtspAccessUnitStreamParser();
            var hasSeenBytes = false;
            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    var bytesRead = await source.ReadAsync(buffer, cancellationToken);
                    if (bytesRead == 0)
                    {
                        foreach (var unit in parser.Flush())
                        {
                            Publish(unit);
                        }

                        return;
                    }
                    Interlocked.Add(ref _bytesRead, bytesRead);

                    if (!hasSeenBytes)
                    {
                        startupToken.ThrowIfCancellationRequested();
                        hasSeenBytes = true;
                    }

                    foreach (var unit in parser.Append(buffer.AsSpan(0, bytesRead)))
                    {
                        Publish(unit);
                    }
                }
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        private void Publish(RtspCapturedAccessUnit unit)
        {
            var sequence = Interlocked.Increment(ref _sequence);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            Interlocked.Exchange(ref _recentFrameUnixTimeMs[(int)(sequence % _recentFrameUnixTimeMs.Length)], now);
            Interlocked.Increment(ref _framesRead);
            var previousFrameUnixTimeMs = Interlocked.Exchange(ref _lastFrameUnixTimeMs, now);
            if (previousFrameUnixTimeMs > 0)
            {
                var intervalMs = Math.Max(0, now - previousFrameUnixTimeMs);
                Interlocked.Exchange(ref _lastFrameIntervalMs, intervalMs);
                UpdateMax(ref _maxFrameIntervalMs, intervalMs);
            }

            if (unit.IsKeyFrame)
            {
                Interlocked.Increment(ref _keyFramesRead);
                var previousKeyFrameUnixTimeMs = Interlocked.Exchange(ref _lastKeyFrameUnixTimeMs, now);
                if (previousKeyFrameUnixTimeMs > 0)
                {
                    Interlocked.Exchange(ref _lastKeyFrameIntervalMs, Math.Max(0, now - previousKeyFrameUnixTimeMs));
                }
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
                    var writeResult = subscriber.TryWrite(frame);
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

        private static void UpdateMax(ref long target, long candidate)
        {
            while (true)
            {
                var current = Interlocked.Read(ref target);
                if (candidate <= current)
                {
                    return;
                }

                if (Interlocked.CompareExchange(ref target, candidate, current) == current)
                {
                    return;
                }
            }
        }

        private static double ComputeRecentFps(long[] samples, long nowUnixTimeMs)
        {
            const long WindowMs = 3000;
            var count = 0;
            var min = long.MaxValue;
            var max = 0L;

            for (var index = 0; index < samples.Length; index++)
            {
                var timestamp = Interlocked.Read(ref samples[index]);
                if (timestamp <= 0 || nowUnixTimeMs - timestamp > WindowMs)
                {
                    continue;
                }

                count += 1;
                min = Math.Min(min, timestamp);
                max = Math.Max(max, timestamp);
            }

            if (count < 2 || max <= min)
            {
                return 0;
            }

            return (count - 1) / ((max - min) / 1000.0);
        }

        private static RecentFrameCadence ComputeRecentFrameCadence(
            long[] samples,
            long nowUnixTimeMs,
            double frameRate)
        {
            const long WindowMs = 60_000;
            var timestamps = new List<long>(samples.Length);

            for (var index = 0; index < samples.Length; index++)
            {
                var timestamp = Interlocked.Read(ref samples[index]);
                if (timestamp <= 0 || nowUnixTimeMs - timestamp > WindowMs)
                {
                    continue;
                }

                timestamps.Add(timestamp);
            }

            if (timestamps.Count < 2)
            {
                return default;
            }

            timestamps.Sort();
            var intervals = new long[timestamps.Count - 1];
            for (var index = 1; index < timestamps.Count; index++)
            {
                intervals[index - 1] = Math.Max(0, timestamps[index] - timestamps[index - 1]);
            }

            Array.Sort(intervals);

            var expectedFrameIntervalMs = 1000.0 / Math.Max(frameRate, 1);
            var hitchThresholdMs = Math.Max(expectedFrameIntervalMs * 2.25, 45);
            var severeHitchThresholdMs = Math.Max(expectedFrameIntervalMs * 4, 120);
            long hitches = 0;
            long severeHitches = 0;
            for (var index = 0; index < intervals.Length; index++)
            {
                var interval = intervals[index];
                if (interval > hitchThresholdMs)
                {
                    hitches++;
                }

                if (interval > severeHitchThresholdMs)
                {
                    severeHitches++;
                }
            }

            return new RecentFrameCadence(
                P95Ms: Percentile(intervals, 0.95),
                MaxMs: intervals[^1],
                Hitches: hitches,
                SevereHitches: severeHitches);
        }

        private static long Percentile(long[] sortedSamples, double fraction)
        {
            if (sortedSamples.Length == 0)
            {
                return 0;
            }

            var index = Math.Clamp(
                (int)Math.Ceiling(sortedSamples.Length * fraction) - 1,
                0,
                sortedSamples.Length - 1);
            return sortedSamples[index];
        }

        private readonly record struct RecentFrameCadence(
            long P95Ms,
            long MaxMs,
            long Hitches,
            long SevereHitches);

        private int ComputeSubscriberQueueDepth(int? targetLatencyMs)
        {
            if (targetLatencyMs is null or <= 0)
            {
                return MaxSubscriberQueue;
            }

            var framesInBudget = (int)Math.Ceiling(targetLatencyMs.Value * _frameRate / 1000.0);
            var burstCushionFrames = Math.Max(framesInBudget * 3, (int)Math.Ceiling(_frameRate * 0.75));
            return Math.Clamp(burstCushionFrames, 4, MaxSubscriberQueue);
        }

        private sealed class SubscriberState
        {
            public SubscriberState(Guid id, Channel<ContinuousRtspFrame> channel, int maxQueue)
            {
                Id = id;
                Channel = channel;
                MaxQueue = maxQueue;
            }

            public Guid Id { get; }

            public Channel<ContinuousRtspFrame> Channel { get; }

            public int MaxQueue { get; }

            private long _framesWritten;
            private long _framesRead;
            private long _framesDropped;
            private int _pendingFrames;
            private readonly long[] _recentReadUnixTimeMs = new long[RecentSampleCapacity];

            public (bool Written, bool DroppedOldest) TryWrite(ContinuousRtspFrame frame)
            {
                var pendingBeforeWrite = Volatile.Read(ref _pendingFrames);
                var willDropOldest = pendingBeforeWrite >= MaxQueue;
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
                var framesRead = Interlocked.Increment(ref _framesRead);
                Interlocked.Exchange(
                    ref _recentReadUnixTimeMs[(int)(framesRead % _recentReadUnixTimeMs.Length)],
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                DecrementPendingFrame();
            }

            public ContinuousRtspSubscriberMetrics GetMetrics()
                => new(
                    SubscriptionId: Id,
                    FramesWritten: Interlocked.Read(ref _framesWritten),
                    FramesRead: Interlocked.Read(ref _framesRead),
                    FramesDropped: Interlocked.Read(ref _framesDropped),
                    PendingFrames: Math.Max(0, Volatile.Read(ref _pendingFrames)),
                    RecentReadFps: ComputeRecentFps(_recentReadUnixTimeMs, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));

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
