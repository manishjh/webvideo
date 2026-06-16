using Xunit;

namespace WebVideo.Backend.DemoHost.Tests;

public sealed class LocalRtspLauncherTests
{
    [Fact]
    public void Start_script_defaults_to_go2rtc_and_keeps_mediamtx_fallback()
    {
        var startScript = File.ReadAllText(FindRepoFile("start.sh"));

        Assert.Contains("WEBVIDEO_RTSP_SERVER=\"${WEBVIDEO_RTSP_SERVER:-go2rtc}\"", startScript, StringComparison.Ordinal);
        Assert.Contains("ensure_go2rtc", startScript, StringComparison.Ordinal);
        Assert.Contains("ensure_mediamtx", startScript, StringComparison.Ordinal);
        Assert.Contains("\"$WEBVIDEO_RTSP_SERVER\" == \"mediamtx\"", startScript, StringComparison.Ordinal);
    }

    [Fact]
    public void Rtsp_source_benchmark_reports_cpu_and_memory()
    {
        var benchmarkScript = File.ReadAllText(FindRepoFile("scripts/benchmark-rtsp-source.sh"));

        Assert.Contains("cpuPercentOneCore", benchmarkScript, StringComparison.Ordinal);
        Assert.Contains("rssMaxBytes", benchmarkScript, StringComparison.Ordinal);
        Assert.Contains("rtsp-server.pid", benchmarkScript, StringComparison.Ordinal);
        Assert.Contains("rtsp-publishers.pids", benchmarkScript, StringComparison.Ordinal);
    }

    private static string FindRepoFile(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            directory = directory.Parent;
        }

        throw new FileNotFoundException($"Could not find repository file '{relativePath}'.", relativePath);
    }
}
