using System.Net;
using Microsoft.AspNetCore.Server.Kestrel.Core;
using WebVideo.Backend.DemoHost;

AppContext.SetSwitch("Microsoft.AspNetCore.Server.Kestrel.Experimental.WebTransportAndH3Datagrams", true);

var builder = WebApplication.CreateBuilder(args);
if (!IsTruthy(Environment.GetEnvironmentVariable("WEBVIDEO_BACKEND_VERBOSE_HTTP_LOGS")))
{
    builder.Logging.AddFilter("Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Warning);
    builder.Logging.AddFilter("Microsoft.AspNetCore.Routing.EndpointMiddleware", LogLevel.Warning);
    builder.Logging.AddFilter("Microsoft.AspNetCore.Http.Result", LogLevel.Warning);
}

var backendPort = GetInt32EnvironmentVariable("BACKEND_PORT", 8080);
var frontendPort = GetInt32EnvironmentVariable("FRONTEND_PORT", 4173);
var rtspPort = GetInt32EnvironmentVariable("RTSP_PORT", 8554);
var webTransportPort = GetInt32EnvironmentVariable("WEBVIDEO_WEBTRANSPORT_PORT", 9443);
var webTransportEnabled = !IsFalse(Environment.GetEnvironmentVariable("WEBVIDEO_ENABLE_WEBTRANSPORT"));
var webTransportCertificatePath = Environment.GetEnvironmentVariable("WEBVIDEO_DEV_CERT_PATH");
if (string.IsNullOrWhiteSpace(webTransportCertificatePath))
{
    webTransportCertificatePath = Path.Combine(Environment.CurrentDirectory, ".run", "webtransport-devcert.pfx");
}

var webTransportCertificatePassword = Environment.GetEnvironmentVariable("WEBVIDEO_DEV_CERT_PASSWORD");
if (string.IsNullOrWhiteSpace(webTransportCertificatePassword))
{
    webTransportCertificatePassword = "webvideo-dev";
}

var webTransportCertificate = webTransportEnabled
    ? LocalDevelopmentCertificate.LoadOrCreate(webTransportCertificatePath, webTransportCertificatePassword)
    : null;
var webTransportCertificateHashBase64 = webTransportCertificate is null
    ? ""
    : LocalDevelopmentCertificate.CreateSha256HashBase64(webTransportCertificate);

builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Loopback, backendPort, listenOptions =>
    {
        listenOptions.Protocols = HttpProtocols.Http1AndHttp2;
    });

    if (webTransportEnabled)
    {
        options.Listen(IPAddress.Loopback, webTransportPort, listenOptions =>
        {
            listenOptions.Protocols = HttpProtocols.Http3;
            listenOptions.UseHttps(webTransportCertificate!);
        });
    }
});

builder.Services.AddSingleton(_ => new BrowserDemoStreamCatalog(RtspH264AccessUnitCapture.FromEnvironment(), webTransportPort, rtspPort));
builder.Services.AddSingleton(_ =>
{
    var ffmpegPath = Environment.GetEnvironmentVariable("WEBVIDEO_FFMPEG_BIN");
    if (string.IsNullOrWhiteSpace(ffmpegPath))
    {
        ffmpegPath = "ffmpeg";
    }

    var rtspTransport = Environment.GetEnvironmentVariable("WEBVIDEO_BACKEND_RTSP_TRANSPORT");
    return new ContinuousRtspStreamFanout(ffmpegPath, rtspTransport: rtspTransport);
});
builder.Services.AddCors(options =>
{
    var frontendOrigin = $"http://127.0.0.1:{frontendPort}";
    var localhostFrontendOrigin = $"http://localhost:{frontendPort}";
    options.AddPolicy(
        "local-dev",
        policy => policy
            .WithOrigins(frontendOrigin, localhostFrontendOrigin)
            .AllowAnyHeader()
            .AllowAnyMethod());
});

var app = builder.Build();

app.UseCors("local-dev");

app.MapGet(
    "/healthz",
    () => Results.Ok(new
    {
        status = "ok",
        service = "webvideo-demo-host",
        utcNow = DateTimeOffset.UtcNow
    }));

app.MapGet(
    "/api/demo/streams",
    (BrowserDemoStreamCatalog catalog) => Results.Ok(catalog.ListStreams()));

app.MapGet(
    "/api/demo/channels",
    (BrowserDemoStreamCatalog catalog) => Results.Ok(catalog.ListChannels()));

app.MapGet(
    "/api/demo/live/metrics",
    (ContinuousRtspStreamFanout liveFanout) => Results.Ok(liveFanout.GetMetrics()));

app.MapGet(
    "/api/demo/live/egress-metrics",
    () => Results.Ok(BrowserDemoWebTransportEndpoint.GetEgressMetrics()));

app.MapGet(
    "/api/demo/live/process-metrics",
    () =>
    {
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        return Results.Ok(new
        {
            processId = Environment.ProcessId,
            totalProcessorTimeMs = process.TotalProcessorTime.TotalMilliseconds,
            workingSetBytes = process.WorkingSet64,
            privateMemoryBytes = process.PrivateMemorySize64,
            gcHeapBytes = GC.GetTotalMemory(forceFullCollection: false),
            threadCount = process.Threads.Count,
            utcNow = DateTimeOffset.UtcNow
        });
    });

app.MapGet(
    "/api/demo/webtransport/certificate-hash",
    () => Results.Ok(new
    {
        algorithm = "sha-256",
        valueBase64 = webTransportCertificateHashBase64
    }));

app.MapPost(
    "/api/demo/channels/{channelId}/sessions",
    async (string channelId, BrowserDemoSessionOpenRequest request, BrowserDemoStreamCatalog catalog, CancellationToken cancellationToken) =>
    {
        try
        {
            var response = await catalog.OpenChannelSessionAsync(channelId, request, cancellationToken: cancellationToken);
            return Results.Ok(response);
        }
        catch (KeyNotFoundException exception)
        {
            return Results.NotFound(new
            {
                error = exception.Message,
                channelId
            });
        }
        catch (Exception exception) when (exception is InvalidOperationException or TimeoutException)
        {
            return Results.Problem(
                title: "Browser stream source unavailable",
                detail: exception.Message,
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    });

app.MapMethods(
    "/live/{channelId}",
    [HttpMethods.Connect],
    BrowserDemoWebTransportEndpoint.HandleAsync);

app.MapGet(
    "/api/demo/streams/{streamId}",
    (string streamId, BrowserDemoStreamCatalog catalog) =>
    {
        try
        {
            return Results.Ok(catalog.CreateStream(streamId));
        }
        catch (KeyNotFoundException exception)
        {
            return Results.NotFound(new
            {
                error = exception.Message,
                streamId
            });
        }
    });

app.Run();

static int GetInt32EnvironmentVariable(string name, int fallback)
{
    var value = Environment.GetEnvironmentVariable(name);
    return int.TryParse(value, out var parsed) ? parsed : fallback;
}

static bool IsFalse(string? value)
    => string.Equals(value, "0", StringComparison.OrdinalIgnoreCase)
        || string.Equals(value, "false", StringComparison.OrdinalIgnoreCase);

static bool IsTruthy(string? value)
    => string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
        || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
        || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase)
        || string.Equals(value, "on", StringComparison.OrdinalIgnoreCase);

public partial class Program;
