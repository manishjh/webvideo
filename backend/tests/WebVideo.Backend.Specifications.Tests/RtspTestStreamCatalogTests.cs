using WebVideo.Backend.Contracts;
using WebVideo.Backend.TestKit;
using Xunit;

namespace WebVideo.Backend.Specifications.Tests;

public sealed class RtspTestStreamCatalogTests
{
    [Fact]
    public void Synthetic_rtsp_catalog_exposes_udp_and_tcp_smoke_scenarios()
    {
        var scenarioIds = SyntheticRtspStreamCatalog.AllScenarios
            .Select(scenario => scenario.ScenarioId)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(["tcp-h264-smoke", "udp-h264-smoke"], scenarioIds);
    }

    [Fact]
    public void Every_scenario_has_a_definition_reservation_and_launch_sequence()
    {
        foreach (var scenario in SyntheticRtspStreamCatalog.AllScenarios)
        {
            Assert.Equal(VideoCodecKind.H264, scenario.Definition.Codec);
            Assert.True(scenario.Definition.Width > 0);
            Assert.True(scenario.Definition.Height > 0);
            Assert.True(scenario.Definition.FrameRate > 0);
            Assert.True(scenario.Definition.KeyFrameInterval > 0);
            Assert.True(scenario.Definition.EmitMonotonicOverlayTimecode);

            Assert.True(scenario.Reservation.RtspPort > 0);
            Assert.True(scenario.Reservation.RtpPort > 0);
            Assert.True(scenario.Reservation.RtcpPort > 0);
            Assert.StartsWith("rtsp://127.0.0.1:", scenario.Reservation.PublishUrl, StringComparison.Ordinal);

            Assert.Equal(2, scenario.LaunchSequence.Count);
        }
    }

    [Fact]
    public void Mediamtx_launch_step_opens_all_required_rtsp_listener_ports()
    {
        foreach (var scenario in SyntheticRtspStreamCatalog.AllScenarios)
        {
            var mediaMtx = scenario.LaunchSequence[0];

            Assert.Equal("mediamtx", mediaMtx.Executable);
            Assert.Contains("--rtspAddress", mediaMtx.Arguments);
            Assert.Contains("--rtpAddress", mediaMtx.Arguments);
            Assert.Contains("--rtcpAddress", mediaMtx.Arguments);
            Assert.Equal("udp,tcp", mediaMtx.EnvironmentVariables["MTX_PROTOCOLS"]);
            Assert.Equal("tcp", mediaMtx.ReadinessProbe.ProbeType);
        }
    }

    [Fact]
    public void Ffmpeg_launch_step_publishes_a_deterministic_h264_test_pattern()
    {
        foreach (var scenario in SyntheticRtspStreamCatalog.AllScenarios)
        {
            var ffmpeg = scenario.LaunchSequence[1];
            var joinedArguments = string.Join(' ', ffmpeg.Arguments);

            Assert.Equal("ffmpeg", ffmpeg.Executable);
            Assert.Contains("-f lavfi", joinedArguments, StringComparison.Ordinal);
            Assert.Contains("testsrc2=size=1280x720:rate=30", joinedArguments, StringComparison.Ordinal);
            Assert.Contains("-c:v libx264", joinedArguments, StringComparison.Ordinal);
            Assert.Contains("-tune zerolatency", joinedArguments, StringComparison.Ordinal);
            Assert.Contains($"-profile:v {scenario.Definition.Profile}", joinedArguments, StringComparison.Ordinal);
            Assert.Contains($"-g {scenario.Definition.KeyFrameInterval}", joinedArguments, StringComparison.Ordinal);
            Assert.Contains(scenario.Reservation.PublishUrl, joinedArguments, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void Transport_specific_scenarios_select_matching_rtsp_transport_arguments()
    {
        var udpScenario = SyntheticRtspStreamCatalog.AllScenarios.Single(scenario => scenario.ScenarioId == "udp-h264-smoke");
        var tcpScenario = SyntheticRtspStreamCatalog.AllScenarios.Single(scenario => scenario.ScenarioId == "tcp-h264-smoke");

        Assert.Contains("udp", udpScenario.LaunchSequence[1].Arguments);
        Assert.Contains("tcp", tcpScenario.LaunchSequence[1].Arguments);
        Assert.Equal(CameraTransportPreference.ForceUdp, udpScenario.Definition.PublishTransport);
        Assert.Equal(CameraTransportPreference.ForceTcp, tcpScenario.Definition.PublishTransport);
    }
}
