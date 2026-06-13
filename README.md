# WebVideo

This repository currently contains a contract-first scaffold for a low-latency browser video system.

Included today:

- architecture and topology documents in [docs](./docs/README.md)
- `.NET 10` backend contracts and xUnit specification suites in [backend](./backend/README.md)
- TypeScript frontend contracts plus Vitest and Playwright suites in [frontend](./frontend/README.md)
- a runnable demo host plus browser page for visible local playback

Current intent:

- lock the service, player, and test harness shapes before the full RTSP/WebTransport/WebCodecs/WebGPU implementation starts
- implement deterministic in-memory coordinators first so the behavior can be exercised under test
- make the expected flows, behaviors, and RTSP smoke setup explicit and testable

Current status:

- backend coordinators are implemented as deterministic in-memory services
- backend demo host serves synthetic browser stream payloads over HTTP
- frontend player services are implemented as deterministic in-memory services
- Playwright validates a real simulated browser flow rendered by the contract harness page
- the live demo page fetches from the backend and renders a visible synthetic stream

Local test helpers:

- `scripts/test-backend.sh`
- `scripts/test-frontend-unit.sh`
- `scripts/test-frontend-e2e.sh`

Local demo launcher:

- `./start.sh`
