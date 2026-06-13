using WebVideo.Backend.DemoHost;
using Xunit;

namespace WebVideo.Backend.DemoHost.Tests;

public sealed class BrowserDemoStreamCatalogTests
{
    [Fact]
    public void ListStreams_exposes_expected_demo_catalog()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var streams = catalog.ListStreams();

        Assert.Collection(
            streams,
            first =>
            {
                Assert.Equal("camera-001", first.StreamId);
                Assert.Equal("udp-h264-smoke", first.ScenarioId);
            },
            second =>
            {
                Assert.Equal("camera-002", second.StreamId);
                Assert.Equal("tcp-h264-smoke", second.ScenarioId);
            });
    }

    [Fact]
    public void CreateStream_returns_a_renderable_browser_payload()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var response = catalog.CreateStream("camera-001");

        Assert.Equal("camera-001", response.StreamId);
        Assert.Equal("Synthetic Camera 001", response.DisplayName);
        Assert.Equal("udp-h264-smoke", response.ScenarioId);
        Assert.Equal("avc1", response.Codec.Codec);
        Assert.Equal(1280, response.Codec.CodedWidth);
        Assert.Equal(720, response.Codec.CodedHeight);
        Assert.Equal(8, response.VideoMessages.Count);
        Assert.Equal(8, response.MetadataMessages.Count);
        Assert.Equal(101, response.VideoMessages[0].SequenceNumber);
        Assert.True(response.VideoMessages[0].KeyFrame);
        Assert.Equal("ball", response.MetadataMessages[0].Records[0].Tags["label"]);
        Assert.Equal("player", response.MetadataMessages[1].Records[0].Tags["label"]);
    }

    [Fact]
    public void CreateStream_throws_for_unknown_stream_id()
    {
        var catalog = new BrowserDemoStreamCatalog();

        var exception = Assert.Throws<KeyNotFoundException>(() => catalog.CreateStream("camera-999"));

        Assert.Contains("camera-999", exception.Message, StringComparison.Ordinal);
    }
}
