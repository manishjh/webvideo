using WebVideo.Backend.Contracts;
using Xunit;

namespace WebVideo.Backend.Specifications.Tests;

public sealed class SpecificationCoverageTests
{
    [Fact]
    public void Flow_catalog_covers_expected_backend_flow_ids()
    {
        string[] expected =
        [
            "archive-write-path",
            "browser-fanout-and-egress",
            "camera-live-ingest",
            "legacy-rtsp-proxy",
            "metadata-publication",
            "observability-and-recovery",
            "synthetic-rtsp-test-stream"
        ];

        Assert.Equal(expected, BackendSpecificationCatalog.RequiredFlowIds);
    }

    [Fact]
    public void Every_flow_contains_steps_with_metrics_and_method_bindings()
    {
        foreach (var flow in BackendSpecificationCatalog.Flows)
        {
            Assert.NotEmpty(flow.Steps);

            foreach (var step in flow.Steps)
            {
                Assert.True(step.Sequence > 0, $"Flow '{flow.FlowId}' has a non-positive step number.");
                Assert.False(string.IsNullOrWhiteSpace(step.Title));
                Assert.False(string.IsNullOrWhiteSpace(step.Owner));
                Assert.False(string.IsNullOrWhiteSpace(step.Description));
                Assert.NotEmpty(step.Methods);
                Assert.NotEmpty(step.RequiredMetrics);
            }
        }
    }

    [Fact]
    public void Every_contract_method_reference_resolves_to_a_real_public_method()
    {
        var assembly = typeof(CameraStreamIngestCoordinator).Assembly;

        foreach (var flow in BackendSpecificationCatalog.Flows)
        {
            foreach (var step in flow.Steps)
            {
                foreach (var method in step.Methods)
                {
                    Assert.True(
                        BackendSpecificationCatalog.MethodExists(assembly, method),
                        $"Method reference '{method.TypeName}.{method.MethodName}' could not be resolved.");
                }
            }
        }
    }

    [Fact]
    public void Specification_catalog_covers_all_required_backend_behaviors()
    {
        string[] expected =
        [
            "archive-persists-normalized-access-units",
            "browser-fanout-reuses-shared-live-buffer",
            "browser-session-lifecycle-is-explicit",
            "camera-rtsp-ingest-starts-once-per-stream",
            "metadata-remains-timeline-aligned",
            "synthetic-rtsp-source-is-runnable",
            "telemetry-covers-all-critical-stages"
        ];

        var actual = BackendSpecificationCatalog.Specifications
            .Select(specification => specification.SpecificationId)
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void Every_specification_maps_to_real_flows_and_declares_outcomes()
    {
        var flowIdSet = BackendSpecificationCatalog.RequiredFlowIds.ToHashSet(StringComparer.Ordinal);

        foreach (var specification in BackendSpecificationCatalog.Specifications)
        {
            Assert.False(string.IsNullOrWhiteSpace(specification.Summary));
            Assert.NotEmpty(specification.RequiredOutcomes);
            Assert.NotEmpty(specification.RequiredMethods);
            Assert.NotEmpty(specification.CoveredFlowIds);

            foreach (var flowId in specification.CoveredFlowIds)
            {
                Assert.Contains(flowId, flowIdSet);
            }
        }
    }
}
