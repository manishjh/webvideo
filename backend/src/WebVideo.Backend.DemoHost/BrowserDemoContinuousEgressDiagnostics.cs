namespace WebVideo.Backend.DemoHost;

internal sealed class BrowserDemoMoqObjectTimeline
{
    private long _currentGroupId;
    private long _currentObjectId = -1;

    public BrowserDemoMoqObjectIdentity Advance(ContinuousRtspFrame frame)
    {
        if (frame.KeyFrame)
        {
            _currentGroupId = frame.SourceTimestampUnixTimeMs;
            _currentObjectId = 0;
        }
        else
        {
            _currentObjectId += 1;
        }

        return new BrowserDemoMoqObjectIdentity(_currentGroupId, _currentObjectId);
    }
}

internal readonly record struct BrowserDemoMoqObjectIdentity(long GroupId, long ObjectId);

internal sealed record BrowserDemoContinuousEgressMetrics(
    string ChannelId,
    string StreamId,
    long StreamsOpened,
    long FramesDequeued,
    long FramesSent,
    long FramesSkippedBeforeKeyFrame,
    long FramesSkippedStale,
    long SequenceGapEvents,
    long SequenceGapFrames,
    long WriteErrors,
    long BytesSent,
    long LastSentUnixTimeMs,
    double RecentSentFps,
    BrowserDemoTimingSummary DequeueAgeMs,
    BrowserDemoTimingSummary WriteMs,
    BrowserDemoTimingSummary PayloadBytes);

internal sealed record BrowserDemoTimingSummary(
    long Count,
    double Average,
    double P50,
    double P95,
    double P99,
    double Max,
    double Latest);

internal sealed class BrowserDemoContinuousEgressProfiler
{
    private const int SampleCapacity = 512;
    private readonly object _gate = new();
    private readonly string _channelId;
    private readonly string _streamId;
    private readonly double[] _dequeueAgeMs = new double[SampleCapacity];
    private readonly double[] _writeMs = new double[SampleCapacity];
    private readonly double[] _payloadBytes = new double[SampleCapacity];
    private readonly long[] _sentFrameUnixTimeMs = new long[SampleCapacity];
    private long _streamsOpened;
    private long _framesDequeued;
    private long _framesSent;
    private long _framesSkippedBeforeKeyFrame;
    private long _framesSkippedStale;
    private long _sequenceGapEvents;
    private long _sequenceGapFrames;
    private long _writeErrors;
    private long _bytesSent;
    private long _lastSentUnixTimeMs;
    private int _sampleIndex;

    public BrowserDemoContinuousEgressProfiler(string channelId, string streamId)
    {
        _channelId = channelId;
        _streamId = streamId;
    }

    public void RecordStreamOpened()
        => Interlocked.Increment(ref _streamsOpened);

    public void RecordFrameDequeued(long ageMs)
    {
        Interlocked.Increment(ref _framesDequeued);
        lock (_gate)
        {
            _dequeueAgeMs[_sampleIndex % SampleCapacity] = Math.Max(0, ageMs);
        }
    }

    public void RecordFrameSent(double writeMs, long bytesSent)
    {
        var sentAtUnixTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Interlocked.Increment(ref _framesSent);
        Interlocked.Add(ref _bytesSent, Math.Max(0, bytesSent));
        Interlocked.Exchange(ref _lastSentUnixTimeMs, sentAtUnixTimeMs);

        lock (_gate)
        {
            var index = _sampleIndex % SampleCapacity;
            _writeMs[index] = Math.Max(0, writeMs);
            _payloadBytes[index] = Math.Max(0, bytesSent);
            _sentFrameUnixTimeMs[index] = sentAtUnixTimeMs;
            _sampleIndex += 1;
        }
    }

    public void RecordPreKeyFrameSkipped()
        => Interlocked.Increment(ref _framesSkippedBeforeKeyFrame);

    public void RecordStaleFrameSkipped()
        => Interlocked.Increment(ref _framesSkippedStale);

    public void RecordSequenceGap(long skippedFrames)
    {
        Interlocked.Increment(ref _sequenceGapEvents);
        Interlocked.Add(ref _sequenceGapFrames, Math.Max(0, skippedFrames));
    }

    public void RecordWriteError()
        => Interlocked.Increment(ref _writeErrors);

    public BrowserDemoContinuousEgressMetrics GetMetrics()
    {
        double[] dequeueAge;
        double[] write;
        double[] payloadBytes;
        long[] sentFrameTimes;
        lock (_gate)
        {
            var sampleCount = Math.Min(_sampleIndex, SampleCapacity);
            dequeueAge = ReadRing(_dequeueAgeMs, sampleCount);
            write = ReadRing(_writeMs, sampleCount);
            payloadBytes = ReadRing(_payloadBytes, sampleCount);
            sentFrameTimes = ReadRing(_sentFrameUnixTimeMs, sampleCount);
        }

        return new BrowserDemoContinuousEgressMetrics(
            ChannelId: _channelId,
            StreamId: _streamId,
            StreamsOpened: Interlocked.Read(ref _streamsOpened),
            FramesDequeued: Interlocked.Read(ref _framesDequeued),
            FramesSent: Interlocked.Read(ref _framesSent),
            FramesSkippedBeforeKeyFrame: Interlocked.Read(ref _framesSkippedBeforeKeyFrame),
            FramesSkippedStale: Interlocked.Read(ref _framesSkippedStale),
            SequenceGapEvents: Interlocked.Read(ref _sequenceGapEvents),
            SequenceGapFrames: Interlocked.Read(ref _sequenceGapFrames),
            WriteErrors: Interlocked.Read(ref _writeErrors),
            BytesSent: Interlocked.Read(ref _bytesSent),
            LastSentUnixTimeMs: Interlocked.Read(ref _lastSentUnixTimeMs),
            RecentSentFps: ComputeRecentFps(sentFrameTimes, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            DequeueAgeMs: Summarize(dequeueAge),
            WriteMs: Summarize(write),
            PayloadBytes: Summarize(payloadBytes));
    }

    private static T[] ReadRing<T>(T[] samples, int sampleCount)
    {
        if (sampleCount <= 0)
        {
            return [];
        }

        var target = new T[sampleCount];
        Array.Copy(samples, target, sampleCount);
        return target;
    }

    private static BrowserDemoTimingSummary Summarize(double[] samples)
    {
        if (samples.Length == 0)
        {
            return new BrowserDemoTimingSummary(0, 0, 0, 0, 0, 0, 0);
        }

        var sorted = samples.Order().ToArray();
        var total = 0.0;
        for (var index = 0; index < samples.Length; index += 1)
        {
            total += samples[index];
        }

        return new BrowserDemoTimingSummary(
            Count: samples.Length,
            Average: total / samples.Length,
            P50: Percentile(sorted, 0.50),
            P95: Percentile(sorted, 0.95),
            P99: Percentile(sorted, 0.99),
            Max: sorted[^1],
            Latest: samples[^1]);
    }

    private static double Percentile(double[] sortedSamples, double fraction)
    {
        if (sortedSamples.Length == 0)
        {
            return 0;
        }

        var index = Math.Clamp((int)Math.Ceiling(sortedSamples.Length * fraction) - 1, 0, sortedSamples.Length - 1);
        return sortedSamples[index];
    }

    private static double ComputeRecentFps(long[] samples, long nowUnixTimeMs)
    {
        const long WindowMs = 3000;
        var count = 0;
        var min = long.MaxValue;
        var max = 0L;

        for (var index = 0; index < samples.Length; index += 1)
        {
            var timestamp = samples[index];
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
}
