using System.Diagnostics;

namespace WebVideo.Backend.DemoHost;

public sealed record RtspCapturedAccessUnit(byte[] Payload, bool HasVideoSlice, bool IsKeyFrame);

public sealed class RtspH264AccessUnitCapture
{
    private readonly string _ffmpegPath;
    private readonly TimeSpan _timeout;

    public RtspH264AccessUnitCapture(string ffmpegPath, bool isRequired, TimeSpan? timeout = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(ffmpegPath);

        _ffmpegPath = ffmpegPath;
        IsRequired = isRequired;
        _timeout = timeout ?? TimeSpan.FromSeconds(8);
    }

    public bool IsEnabled => true;

    public bool IsRequired { get; }

    public string FfmpegPath => _ffmpegPath;

    public static RtspH264AccessUnitCapture? FromEnvironment()
    {
        var enabled = IsTruthy(Environment.GetEnvironmentVariable("WEBVIDEO_RTSP_CAPTURE"));
        if (!enabled)
        {
            return null;
        }

        var ffmpegPath = Environment.GetEnvironmentVariable("WEBVIDEO_FFMPEG_BIN");
        if (string.IsNullOrWhiteSpace(ffmpegPath))
        {
            ffmpegPath = "ffmpeg";
        }

        var required = IsTruthy(Environment.GetEnvironmentVariable("WEBVIDEO_RTSP_CAPTURE_REQUIRED"));
        return new RtspH264AccessUnitCapture(ffmpegPath, required);
    }

    public async Task<IReadOnlyList<BrowserDemoVideoMessage>> CaptureAsync(
        string streamId,
        string rtspUrl,
        int frameCount,
        long baseTimestampUs,
        long frameDurationUs,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(streamId);
        ArgumentException.ThrowIfNullOrWhiteSpace(rtspUrl);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(frameCount);

        var sourceTimestampUnixTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var annexB = await CaptureAnnexBAsync(rtspUrl, frameCount, cancellationToken);
        var accessUnits = SplitAnnexBAccessUnitsCore(annexB)
            .Where(unit => unit.HasVideoSlice)
            .Take(frameCount)
            .ToArray();

        if (accessUnits.Length < frameCount)
        {
            throw new InvalidOperationException($"Captured {accessUnits.Length} H.264 access units from '{rtspUrl}', expected {frameCount}.");
        }

        return accessUnits
            .Select((unit, index) =>
            {
                var frameTimestampUnixTimeMs = sourceTimestampUnixTimeMs + (long)Math.Round(index * frameDurationUs / 1000.0);
                return new BrowserDemoVideoMessage(
                    StreamId: streamId,
                    SequenceNumber: 101 + index,
                    PresentationTimestampUs: baseTimestampUs + index * frameDurationUs,
                    DecodeTimestampUs: baseTimestampUs + index * frameDurationUs,
                    SourceTimestampUnixTimeMs: frameTimestampUnixTimeMs,
                    ServerTimestampUnixTimeMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    KeyFrame: unit.IsKeyFrame || index == 0,
                    CodecConfigVersion: "rtsp-annexb-v1",
                    Payload: unit.Payload);
            })
            .ToArray();
    }

    public static IReadOnlyList<byte[]> SplitAnnexBAccessUnitsForTesting(byte[] annexB)
        => SplitAnnexBAccessUnits(annexB).Select(unit => unit.Payload).ToArray();

    public static IReadOnlyList<RtspCapturedAccessUnit> SplitAnnexBAccessUnits(byte[] annexB)
        => SplitAnnexBAccessUnitsCore(annexB)
            .Select(unit => new RtspCapturedAccessUnit(unit.Payload, unit.HasVideoSlice, unit.IsKeyFrame))
            .ToArray();

    private async Task<byte[]> CaptureAnnexBAsync(
        string rtspUrl,
        int frameCount,
        CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(_timeout);

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
            "-loglevel", "warning",
            "-rtsp_transport", "tcp",
            "-i", rtspUrl,
            "-map", "0:v:0",
            "-an",
            "-c:v", "copy",
            "-bsf:v", "h264_metadata=aud=insert",
            "-frames:v", frameCount.ToString(System.Globalization.CultureInfo.InvariantCulture),
            "-f", "h264",
            "pipe:1"
        })
        {
            processStart.ArgumentList.Add(argument);
        }

        using var process = Process.Start(processStart)
            ?? throw new InvalidOperationException($"Failed to start ffmpeg at '{_ffmpegPath}'.");

        await using var output = new MemoryStream();
        var outputTask = process.StandardOutput.BaseStream.CopyToAsync(output, timeout.Token);
        var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);

        try
        {
            await process.WaitForExitAsync(timeout.Token);
            await outputTask;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new TimeoutException($"Timed out capturing RTSP stream '{rtspUrl}' after {_timeout.TotalSeconds:0.#} seconds.");
        }

        var stderr = await errorTask;
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"ffmpeg exited with code {process.ExitCode} while reading '{rtspUrl}'. {stderr}".Trim());
        }

        return output.ToArray();
    }

    private static IReadOnlyList<CapturedAccessUnit> SplitAnnexBAccessUnitsCore(byte[] annexB)
    {
        var nals = ParseNalUnits(annexB);
        var units = new List<CapturedAccessUnit>();
        var current = new List<NalUnit>();
        var currentHasVideoSlice = false;
        var currentIsKeyFrame = false;
        var hasAccessUnitDelimiters = nals.Any(nal => nal.NalType == 9);

        foreach (var nal in nals)
        {
            if (hasAccessUnitDelimiters && nal.NalType == 9 && currentHasVideoSlice)
            {
                AddCurrentUnit(units, current, currentHasVideoSlice, currentIsKeyFrame);
                current = [];
                currentHasVideoSlice = false;
                currentIsKeyFrame = false;
            }
            else if (!hasAccessUnitDelimiters && nal.IsVideoSlice && currentHasVideoSlice && nal.FirstMacroblockInSlice == 0)
            {
                AddCurrentUnit(units, current, currentHasVideoSlice, currentIsKeyFrame);
                current = [];
                currentHasVideoSlice = false;
                currentIsKeyFrame = false;
            }

            current.Add(nal);

            if (nal.IsVideoSlice)
            {
                currentHasVideoSlice = true;
                currentIsKeyFrame |= nal.NalType == 5;
            }
        }

        AddCurrentUnit(units, current, currentHasVideoSlice, currentIsKeyFrame);
        return units;
    }

    private static void AddCurrentUnit(
        List<CapturedAccessUnit> units,
        IReadOnlyList<NalUnit> current,
        bool hasVideoSlice,
        bool isKeyFrame)
    {
        if (current.Count == 0)
        {
            return;
        }

        var length = current.Sum(nal => nal.End - nal.Start);
        var payload = new byte[length];
        var offset = 0;
        foreach (var nal in current)
        {
            var nalLength = nal.End - nal.Start;
            Buffer.BlockCopy(nal.Source, nal.Start, payload, offset, nalLength);
            offset += nalLength;
        }

        units.Add(new CapturedAccessUnit(payload, hasVideoSlice, isKeyFrame));
    }

    private static IReadOnlyList<NalUnit> ParseNalUnits(byte[] annexB)
    {
        var units = new List<NalUnit>();
        var start = FindStartCode(annexB, 0);
        while (start >= 0)
        {
            var codeLength = StartCodeLength(annexB, start);
            var header = start + codeLength;
            var next = FindStartCode(annexB, header);
            var end = next >= 0 ? next : annexB.Length;

            if (header < end)
            {
                var nalType = annexB[header] & 0x1F;
                var firstMacroblock = IsVideoSliceType(nalType)
                    ? TryReadFirstMacroblockInSlice(annexB.AsSpan(header + 1, end - header - 1))
                    : null;

                units.Add(new NalUnit(
                    annexB,
                    start,
                    end,
                    nalType,
                    IsVideoSliceType(nalType),
                    firstMacroblock));
            }

            start = next;
        }

        return units;
    }

    private static int FindStartCode(byte[] bytes, int offset)
    {
        for (var i = Math.Max(0, offset); i <= bytes.Length - 3; i++)
        {
            if (bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 1)
            {
                return i;
            }

            if (i <= bytes.Length - 4 && bytes[i] == 0 && bytes[i + 1] == 0 && bytes[i + 2] == 0 && bytes[i + 3] == 1)
            {
                return i;
            }
        }

        return -1;
    }

    private static int StartCodeLength(byte[] bytes, int start)
        => bytes[start + 2] == 1 ? 3 : 4;

    private static bool IsVideoSliceType(int nalType)
        => nalType is 1 or 5;

    private static int? TryReadFirstMacroblockInSlice(ReadOnlySpan<byte> nalPayload)
    {
        Span<byte> rbsp = nalPayload.Length <= 4096 ? stackalloc byte[nalPayload.Length] : new byte[nalPayload.Length];
        var length = 0;

        for (var i = 0; i < nalPayload.Length; i++)
        {
            if (i >= 2 && nalPayload[i] == 0x03 && nalPayload[i - 1] == 0x00 && nalPayload[i - 2] == 0x00)
            {
                continue;
            }

            rbsp[length++] = nalPayload[i];
        }

        var reader = new BitReader(rbsp[..length]);
        return reader.TryReadUnsignedExpGolomb(out var value) ? value : null;
    }

    private static bool IsTruthy(string? value)
        => string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
           || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
           || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best effort during timeout cleanup.
        }
    }

    private sealed record CapturedAccessUnit(byte[] Payload, bool HasVideoSlice, bool IsKeyFrame);

    private sealed record NalUnit(
        byte[] Source,
        int Start,
        int End,
        int NalType,
        bool IsVideoSlice,
        int? FirstMacroblockInSlice);

    private ref struct BitReader
    {
        private readonly ReadOnlySpan<byte> _bytes;
        private int _bitOffset;

        public BitReader(ReadOnlySpan<byte> bytes)
        {
            _bytes = bytes;
            _bitOffset = 0;
        }

        public bool TryReadUnsignedExpGolomb(out int value)
        {
            value = 0;
            var leadingZeroBits = 0;

            while (TryReadBit(out var bit))
            {
                if (bit)
                {
                    var suffix = 0;
                    for (var i = 0; i < leadingZeroBits; i++)
                    {
                        if (!TryReadBit(out var suffixBit))
                        {
                            return false;
                        }

                        suffix = (suffix << 1) | (suffixBit ? 1 : 0);
                    }

                    value = ((1 << leadingZeroBits) - 1) + suffix;
                    return true;
                }

                leadingZeroBits++;
                if (leadingZeroBits > 30)
                {
                    return false;
                }
            }

            return false;
        }

        private bool TryReadBit(out bool bit)
        {
            bit = false;
            if (_bitOffset >= _bytes.Length * 8)
            {
                return false;
            }

            var byteIndex = _bitOffset / 8;
            var bitIndex = 7 - (_bitOffset % 8);
            bit = ((_bytes[byteIndex] >> bitIndex) & 1) == 1;
            _bitOffset++;
            return true;
        }
    }
}
