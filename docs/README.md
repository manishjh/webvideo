# Browser Low-Latency Video Architecture

This document set defines an implementation plan for a browser-based live and playback video pipeline with low-latency rendering and graphics overlays.

Documents:

- [Architecture Overview](./architecture-overview.md)
- [Latency and Performance](./latency-and-performance.md)
- [Metadata and Overlay Architecture](./metadata-overlay-architecture.md)
- [Ingest and Service Topology](./ingest-service-topology.md)
- [Scaling and Fanout](./scaling-and-fanout.md)
- [Implementation Plan](./implementation-plan.md)
- [Architecture Diagrams](./architecture-diagrams.md)
- [Current Renderer](./current-renderer.md)
- [Future Options](./future-options.md)
- [Local RTSP Runbook](./implementation-notes/synthetic-rtsp-runbook.md)
- [VMS Benchmark Snapshot](./implementation-notes/vms-benchmark.md)

System goals:

- Source-to-sink latency as low as practical in a browser.
- Shared pipeline for live and playback.
- Clean metadata path for overlays, events, and analytics.
- Explainable and maintainable architecture.
- Efficient use of QUIC, WebTransport, WebCodecs, and WebGPU.

Current validation entry points:

- `./start.sh` for manual product-like local RTSP, WebTransport, WebCodecs, and render validation with primary sources only by default
- `./test-start.sh` for Playwright/profiling startup with sample footage enabled and 4K/source variants opt-in
- `scripts/benchmark-rtsp-source.sh` for source-only go2rtc versus mediaMTX CPU/RAM A/B checks
- `scripts/test-all.sh` for the central automated suite
- `WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh` for headed hardware WebGPU VMS soak coverage
- `WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh` for the current mixed 4K/1080p stress diagnostic
