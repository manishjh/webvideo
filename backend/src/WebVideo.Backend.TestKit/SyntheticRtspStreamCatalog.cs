using WebVideo.Backend.Contracts;

namespace WebVideo.Backend.TestKit;

public sealed record ReadinessProbeDefinition(
    string ProbeType,
    string Target,
    string SuccessIndicator);

public sealed record ProcessLaunchDescriptor(
    string Executable,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> EnvironmentVariables,
    string WorkingDirectory,
    ReadinessProbeDefinition ReadinessProbe,
    string Notes);

public sealed record TestStreamReservation(
    int RtspPort,
    int RtpPort,
    int RtcpPort,
    string PublishUrl);

public sealed record SyntheticRtspScenario(
    string ScenarioId,
    string Summary,
    SyntheticRtspStreamDefinition Definition,
    TestStreamReservation Reservation,
    IReadOnlyList<ProcessLaunchDescriptor> LaunchSequence);

/// <summary>
/// Defines runnable local test-stream plans used by backend and browser e2e scaffolding.
/// This is intentionally concrete so tests can lock the expected RTSP smoke setup before
/// the production media pipeline is implemented.
/// </summary>
public static class SyntheticRtspStreamCatalog
{
    public static IReadOnlyList<SyntheticRtspScenario> AllScenarios { get; } =
    [
        CreateScenario("udp-h264-smoke", CameraTransportPreference.ForceUdp, 8554, 5004, 5005),
        CreateScenario("tcp-h264-smoke", CameraTransportPreference.ForceTcp, 8556, 5006, 5007)
    ];

    private static SyntheticRtspScenario CreateScenario(
        string scenarioId,
        CameraTransportPreference publishTransport,
        int rtspPort,
        int rtpPort,
        int rtcpPort)
    {
        var definition = new SyntheticRtspStreamDefinition(
            StreamName: scenarioId,
            Codec: VideoCodecKind.H264,
            Profile: publishTransport == CameraTransportPreference.ForceTcp ? "main" : "baseline",
            Width: 1280,
            Height: 720,
            FrameRate: 30.0,
            KeyFrameInterval: 30,
            TargetBitrateKbps: 4000,
            PublishTransport: publishTransport,
            VideoPattern: "testsrc2",
            EmitMonotonicOverlayTimecode: true);

        var reservation = new TestStreamReservation(
            RtspPort: rtspPort,
            RtpPort: rtpPort,
            RtcpPort: rtcpPort,
            PublishUrl: $"rtsp://127.0.0.1:{rtspPort}/live/{scenarioId}");

        var mediaMtx = new ProcessLaunchDescriptor(
            Executable: "mediamtx",
            Arguments:
            [
                "--log-level", "info",
                "--rtspAddress", $":{rtspPort}",
                "--rtpAddress", $":{rtpPort}",
                "--rtcpAddress", $":{rtcpPort}"
            ],
            EnvironmentVariables: new Dictionary<string, string>
            {
                ["MTX_PROTOCOLS"] = "udp,tcp",
                ["MTX_PATHS"] = "live:"
            },
            WorkingDirectory: ".",
            ReadinessProbe: new ReadinessProbeDefinition("tcp", $"127.0.0.1:{rtspPort}", "listener-ready"),
            Notes: "Start the local RTSP server before publishing the synthetic camera stream.");

        var ffmpeg = new ProcessLaunchDescriptor(
            Executable: "ffmpeg",
            Arguments:
            [
                "-re",
                "-stream_loop", "-1",
                "-f", "lavfi",
                "-i", "testsrc2=size=1280x720:rate=30",
                "-vf", "drawtext=text='%{pts\\:hms}':x=20:y=20:fontsize=28:fontcolor=white",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-tune", "zerolatency",
                "-profile:v", definition.Profile,
                "-g", definition.KeyFrameInterval.ToString(),
                "-keyint_min", definition.KeyFrameInterval.ToString(),
                "-sc_threshold", "0",
                "-b:v", $"{definition.TargetBitrateKbps}k",
                "-pix_fmt", "yuv420p",
                "-rtsp_transport", publishTransport == CameraTransportPreference.ForceTcp ? "tcp" : "udp",
                "-f", "rtsp",
                reservation.PublishUrl
            ],
            EnvironmentVariables: new Dictionary<string, string>(),
            WorkingDirectory: ".",
            ReadinessProbe: new ReadinessProbeDefinition("log", reservation.PublishUrl, "Press [q] to stop"),
            Notes: "Publish a deterministic H.264 test pattern that exercises keyframes and monotonic timestamps.");

        return new SyntheticRtspScenario(
            ScenarioId: scenarioId,
            Summary: $"Synthetic H.264 smoke stream over {publishTransport}.",
            Definition: definition,
            Reservation: reservation,
            LaunchSequence: [mediaMtx, ffmpeg]);
    }
}

