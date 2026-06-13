# Backend Scaffold

This folder contains the contract-first `.NET 10` backend scaffold.

Structure:

- `src/WebVideo.Backend.Contracts`: planned backend service contracts and flow/spec catalogs
- `src/WebVideo.Backend.TestKit`: synthetic RTSP smoke-stream plans for tests
- `src/WebVideo.Backend.DemoHost`: runnable ASP.NET host that serves synthetic browser stream payloads
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
