namespace WebVideo.Backend.DemoHost;

internal sealed class ContinuousRtspAccessUnitStreamParser
{
    private byte[] _buffer = new byte[256 * 1024];
    private int _length;
    private int _scanOffset;
    private int _lastNalStart = -1;
    private int _currentAccessUnitStart = -1;
    private bool _currentHasVideoSlice;
    private bool _currentIsKeyFrame;
    private bool _hasSeenAccessUnitDelimiter;

    public IReadOnlyList<RtspCapturedAccessUnit> Append(ReadOnlySpan<byte> bytes)
    {
        EnsureCapacity(_length + bytes.Length);
        bytes.CopyTo(_buffer.AsSpan(_length));
        _length += bytes.Length;
        return ProcessAvailableNalUnits();
    }

    public IReadOnlyList<RtspCapturedAccessUnit> Flush()
    {
        var units = new List<RtspCapturedAccessUnit>();
        if (_lastNalStart >= 0 && _lastNalStart < _length)
        {
            ProcessNal(_lastNalStart, _length, units);
            _lastNalStart = -1;
        }

        EmitCurrentAccessUnit(_length, units);
        Reset();
        return units;
    }

    private IReadOnlyList<RtspCapturedAccessUnit> ProcessAvailableNalUnits()
    {
        var units = new List<RtspCapturedAccessUnit>();
        while (true)
        {
            var start = FindStartCode(_buffer, _scanOffset, _length);
            if (start < 0)
            {
                break;
            }

            if (_lastNalStart >= 0)
            {
                ProcessNal(_lastNalStart, start, units);
            }

            _lastNalStart = start;
            _scanOffset = start + StartCodeLength(_buffer, start);
        }

        CompactProcessedBytes();
        return units;
    }

    private void ProcessNal(int nalStart, int nalEnd, List<RtspCapturedAccessUnit> units)
    {
        if (nalEnd <= nalStart)
        {
            return;
        }

        var codeLength = StartCodeLength(_buffer, nalStart);
        var header = nalStart + codeLength;
        if (header >= nalEnd)
        {
            return;
        }

        var nalType = _buffer[header] & 0x1F;
        var isAccessUnitDelimiter = nalType == 9;
        var isVideoSlice = nalType is 1 or 5;
        var firstMacroblockInSlice = isVideoSlice
            ? TryReadFirstMacroblockInSlice(_buffer.AsSpan(header + 1, nalEnd - header - 1))
            : null;

        if (isAccessUnitDelimiter)
        {
            _hasSeenAccessUnitDelimiter = true;
            if (_currentAccessUnitStart >= 0 && _currentHasVideoSlice)
            {
                EmitCurrentAccessUnit(nalStart, units);
            }

            _currentAccessUnitStart = nalStart;
            _currentHasVideoSlice = false;
            _currentIsKeyFrame = false;
        }
        else if (_currentAccessUnitStart < 0)
        {
            _currentAccessUnitStart = nalStart;
        }
        else if (!_hasSeenAccessUnitDelimiter && isVideoSlice && _currentHasVideoSlice && firstMacroblockInSlice == 0)
        {
            EmitCurrentAccessUnit(nalStart, units);
            _currentAccessUnitStart = nalStart;
            _currentHasVideoSlice = false;
            _currentIsKeyFrame = false;
        }

        if (isVideoSlice)
        {
            _currentHasVideoSlice = true;
            _currentIsKeyFrame |= nalType == 5;
        }
    }

    private void EmitCurrentAccessUnit(int boundary, List<RtspCapturedAccessUnit> units)
    {
        if (_currentAccessUnitStart < 0 || !_currentHasVideoSlice || boundary <= _currentAccessUnitStart)
        {
            return;
        }

        var payload = new byte[boundary - _currentAccessUnitStart];
        Buffer.BlockCopy(_buffer, _currentAccessUnitStart, payload, 0, payload.Length);
        units.Add(new RtspCapturedAccessUnit(payload, true, _currentIsKeyFrame));
    }

    private void CompactProcessedBytes()
    {
        var keepFrom = _currentAccessUnitStart >= 0
            ? _currentAccessUnitStart
            : _lastNalStart >= 0
                ? _lastNalStart
                : Math.Max(0, _length - 3);
        if (keepFrom <= 0)
        {
            return;
        }

        Buffer.BlockCopy(_buffer, keepFrom, _buffer, 0, _length - keepFrom);
        _length -= keepFrom;
        _scanOffset = Math.Max(0, _scanOffset - keepFrom);
        _lastNalStart = _lastNalStart >= 0 ? _lastNalStart - keepFrom : -1;
        _currentAccessUnitStart = _currentAccessUnitStart >= 0 ? _currentAccessUnitStart - keepFrom : -1;
    }

    private void EnsureCapacity(int requiredLength)
    {
        if (requiredLength <= _buffer.Length)
        {
            return;
        }

        var nextLength = _buffer.Length;
        while (nextLength < requiredLength)
        {
            nextLength *= 2;
        }

        Array.Resize(ref _buffer, nextLength);
    }

    private void Reset()
    {
        _length = 0;
        _scanOffset = 0;
        _lastNalStart = -1;
        _currentAccessUnitStart = -1;
        _currentHasVideoSlice = false;
        _currentIsKeyFrame = false;
        _hasSeenAccessUnitDelimiter = false;
    }

    private static int FindStartCode(byte[] bytes, int offset, int length)
    {
        for (var index = Math.Max(0, offset); index <= length - 3; index++)
        {
            if (bytes[index] == 0 && bytes[index + 1] == 0 && bytes[index + 2] == 1)
            {
                return index;
            }

            if (index <= length - 4
                && bytes[index] == 0
                && bytes[index + 1] == 0
                && bytes[index + 2] == 0
                && bytes[index + 3] == 1)
            {
                return index;
            }
        }

        return -1;
    }

    private static int StartCodeLength(byte[] bytes, int start)
        => bytes[start + 2] == 1 ? 3 : 4;

    private static int? TryReadFirstMacroblockInSlice(ReadOnlySpan<byte> nalPayload)
    {
        Span<byte> rbsp = nalPayload.Length <= 4096 ? stackalloc byte[nalPayload.Length] : new byte[nalPayload.Length];
        var length = 0;

        for (var index = 0; index < nalPayload.Length; index++)
        {
            if (index >= 2 && nalPayload[index] == 0x03 && nalPayload[index - 1] == 0x00 && nalPayload[index - 2] == 0x00)
            {
                continue;
            }

            rbsp[length++] = nalPayload[index];
        }

        var reader = new BitReader(rbsp[..length]);
        return reader.TryReadUnsignedExpGolomb(out var value) ? value : null;
    }

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
                    for (var index = 0; index < leadingZeroBits; index++)
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
