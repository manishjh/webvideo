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
- [Synthetic RTSP Runbook](./implementation-notes/synthetic-rtsp-runbook.md)

System goals:

- Source-to-sink latency as low as practical in a browser.
- Shared pipeline for live and playback.
- Clean metadata path for overlays, events, and analytics.
- Explainable and maintainable architecture.
- Efficient use of QUIC, WebTransport, WebCodecs, and WebGPU.
