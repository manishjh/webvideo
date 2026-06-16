using System.Text.Json;
using WebVideo.Backend.DemoHost;

var arguments = Args.Parse(args);
if (arguments.Help)
{
    Args.PrintHelp();
    return 0;
}

var options = new RtpMoqBridgeBenchmarkOptions(
    CameraCount: arguments.GetInt("cameras", "WEBVIDEO_RTP_MOQ_CAMERAS", 200),
    FramesPerSecond: arguments.GetInt("fps", "WEBVIDEO_RTP_MOQ_FPS", 30),
    DurationSeconds: arguments.GetInt("duration", "WEBVIDEO_RTP_MOQ_DURATION_SECONDS", 10),
    PayloadBytes: arguments.GetInt("payload-bytes", "WEBVIDEO_RTP_MOQ_PAYLOAD_BYTES", 1200),
    ChannelCapacity: arguments.GetInt("channel-capacity", "WEBVIDEO_RTP_MOQ_CHANNEL_CAPACITY", 16384),
    WorkerCount: arguments.GetInt("workers", "WEBVIDEO_RTP_MOQ_WORKERS", Math.Max(1, Environment.ProcessorCount)));

var result = await RtpMoqBridgeBenchmark.RunAsync(options, CancellationToken.None);
var json = JsonSerializer.Serialize(result, new JsonSerializerOptions
{
    WriteIndented = true
});

var outputPath = arguments.GetString("output", "WEBVIDEO_RTP_MOQ_OUTPUT", null);
if (!string.IsNullOrWhiteSpace(outputPath))
{
    var directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
    if (!string.IsNullOrWhiteSpace(directory))
    {
        Directory.CreateDirectory(directory);
    }

    await File.WriteAllTextAsync(outputPath, json);
}

Console.WriteLine(json);
return result.DroppedPackets == 0 && result.ParseErrors == 0 ? 0 : 1;

internal sealed class Args
{
    private readonly Dictionary<string, string> _values;

    private Args(Dictionary<string, string> values, bool help)
    {
        _values = values;
        Help = help;
    }

    public bool Help { get; }

    public static Args Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < args.Length; index += 1)
        {
            var arg = args[index];
            if (arg is "-h" or "--help")
            {
                return new Args(values, help: true);
            }

            if (!arg.StartsWith("--", StringComparison.Ordinal))
            {
                throw new ArgumentException($"Unexpected argument '{arg}'.");
            }

            var name = arg[2..];
            if (string.IsNullOrWhiteSpace(name))
            {
                throw new ArgumentException("Option name cannot be empty.");
            }

            if (index + 1 >= args.Length)
            {
                throw new ArgumentException($"Missing value for option '{arg}'.");
            }

            values[name] = args[++index];
        }

        return new Args(values, help: false);
    }

    public int GetInt(string name, string environmentVariable, int defaultValue)
    {
        var value = GetString(name, environmentVariable, null);
        if (string.IsNullOrWhiteSpace(value))
        {
            return defaultValue;
        }

        if (!int.TryParse(value, out var parsed))
        {
            throw new ArgumentException($"'{name}' must be an integer. Value: '{value}'.");
        }

        return parsed;
    }

    public string? GetString(string name, string environmentVariable, string? defaultValue)
    {
        if (_values.TryGetValue(name, out var value))
        {
            return value;
        }

        return Environment.GetEnvironmentVariable(environmentVariable) ?? defaultValue;
    }

    public static void PrintHelp()
    {
        Console.WriteLine("""
            Usage:
              dotnet run --project backend/tools/WebVideo.Backend.RtpMoqBench -- [options]

            Options:
              --cameras <n>            Camera stream count. Default: 200
              --fps <n>                Frames per second per camera. Default: 30
              --duration <seconds>     Synthetic duration to generate. Default: 10
              --payload-bytes <n>      RTP payload bytes per packet. Default: 1200
              --channel-capacity <n>   Shared bounded channel capacity. Default: 16384
              --workers <n>            Worker count. Default: Environment.ProcessorCount
              --output <path>          Optional JSON result path.
            """);
    }
}
