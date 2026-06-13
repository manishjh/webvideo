# Frontend Scaffold

This folder contains the contract-first browser player scaffold.

Structure:

- `src/contracts`: planned TypeScript contracts for transport, decode, schedule, render, and telemetry
- `src/testing`: concrete browser pages for the contract harness and live demo renderer
- `tests/unit`: service surface and placeholder tests with Vitest
- `tests/contracts`: flow/spec/e2e manifest coverage tests with Vitest
- `tests/e2e`: Playwright validation for the contract harness page

Expected commands once Node.js is available:

```bash
npm install
npx playwright install
scripts/test-frontend-unit.sh
scripts/test-frontend-e2e.sh
```

The player services are implemented as deterministic in-memory browser pipeline components. The current suites lock:

- public browser-facing method signatures
- transport/decode/scheduler/renderer/telemetry behavior
- an integrated in-memory player flow
- frontend flow coverage
- browser behavior coverage
- documented end-to-end scenarios
- a Playwright harness that renders the current manifests and runs a simulated browser player flow
- a backend-fed live demo page that renders visible playback in the browser
