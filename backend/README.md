# Backend

This folder contains the contract-first `.NET 10` backend prototype.

Structure:

- `src/WebVideo.Backend.Contracts`: planned backend service contracts and flow/spec catalogs
- `src/WebVideo.Backend.TestKit`: synthetic RTSP smoke-stream plans for tests
- `src/WebVideo.Backend.DemoHost`: runnable ASP.NET host that serves browser stream payloads and local WebTransport
- `tests/WebVideo.Backend.Contracts.Tests`: API surface and placeholder tests
- `tests/WebVideo.Backend.Specifications.Tests`: coverage/specification tests
- `tests/WebVideo.Backend.DemoHost.Tests`: runnable demo host payload tests

Expected commands once the .NET SDK is available:

```bash
scripts/test-backend.sh
```

The backend coordinators are implemented as deterministic in-memory services. The tests lock:

- public method signatures
- ingest/archive/proxy/browser session lifecycle behavior
- fanout ring buffer behavior
- metadata window behavior
- telemetry snapshot behavior
- required architecture flows
- required backend behavior coverage
- synthetic RTSP stream launch plans
- demo stream payloads consumable by the browser page
- client-provided channel IDs that route to backend-selected streams and create browser sink/session records
- WebTransport frame serialization and the local browser channel endpoint
- optional FFmpeg-backed RTSP H.264 capture enabled by `start.sh`
- continuous RTSP H.264 fanout for VMS WebTransport streams using a MoQ-shaped video object envelope
- go2rtc-backed local RTSP source serving by default, with mediaMTX plus ffmpeg publishers retained as a fallback launcher mode
- live fanout diagnostics for per-stream process state, bytes, frames, queue depth, and stale-frame drops
- declared 720p, 1080p, and opt-in 4K channel shapes for local browser stress testing
- environment overrides for predefined demo channel RTSP URLs, display names, dimensions, frame rates, profile names, and summaries

The demo host supports two browser paths: bounded sessions for the live demo/tile wall compatibility pages, and continuous per-channel WebTransport streams for the React VMS client. Backend live diagnostics cover server-side fanout state; browser-side sequence gaps, dependency drops, frame hitches, render FPS, and GPU path are reported by the VMS client. The continuous path is MoQ-shaped but not yet full MOQT/MSF wire-compatible. Dynamic arbitrary-camera registration is still future work; today the catalog is predefined with environment overrides.
