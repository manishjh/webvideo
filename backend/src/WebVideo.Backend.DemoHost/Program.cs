using WebVideo.Backend.DemoHost;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<BrowserDemoStreamCatalog>();
builder.Services.AddCors(options =>
{
    options.AddPolicy(
        "local-dev",
        policy => policy
            .WithOrigins("http://127.0.0.1:4173", "http://localhost:4173")
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

public partial class Program;
