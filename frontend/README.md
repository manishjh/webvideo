# Frontend

This folder contains the contract-first browser player and local test harness.

Structure:

- `src/contracts`: planned TypeScript contracts for transport, decode, schedule, render, and telemetry
- `src/testing`: concrete browser pages for the contract harness and live demo renderer
- `src/vms`: React VMS client, tile session controller, and performance metric aggregation
- `tests/unit`: service surface and pipeline tests with Vitest
- `tests/contracts`: flow/spec/e2e manifest coverage tests with Vitest
- `tests/e2e`: Playwright validation for the contract harness, live demo, tile wall, VMS client, and high-resolution smoke paths

Expected commands once Node.js is available:

```bash
npm install
npx playwright install
scripts/test-frontend-unit.sh
scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=hardware-gpu scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh
WEBVIDEO_E2E_4K=1 START_4K_RTSP=1 scripts/test-frontend-e2e.sh
```

The player services keep deterministic paths for contract coverage and now exercise the real browser media path in Playwright. The current suites lock:

- public browser-facing method signatures
- WebTransport/decode/scheduler/renderer/telemetry behavior
- an integrated in-memory player flow
- frontend flow coverage
- browser behavior coverage
- documented end-to-end scenarios
- a default headless Playwright harness that renders manifests, receives WebTransport bytes, decodes through WebCodecs, and verifies visible browser rendering while avoiding slow software WebGPU adapters
- an opt-in headed Chrome WebGPU harness with `WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1` that uses the Linux Vulkan/ANGLE flags and verifies hardware `VideoFrame` external-texture rendering to the WebGPU canvas
- a backend-fed live demo page that requests a channel session, records the QUIC/WebTransport URL, shows whether RTSP capture was verified, and renders visible playback in the browser
- a tile wall page that opens separate client-initiated channel sessions per tile and verifies independent WebTransport byte flow, WebCodecs decode, and WebGPU render state
- a React VMS client that fetches channels from the backend, lets the user add/remove camera tiles, opens three long-lived WebTransport H.264 streams using a MoQ-shaped object envelope for continuous viewing, verifies MoQ object diagnostics and latency budgets, and exposes per-tile source-to-render/server-to-render/receive-to-render/decode/render plus backend queue/drop metrics
- an opt-in 60 second VMS soak with `WEBVIDEO_E2E_LONG=1` or `WEBVIDEO_TEST_PROFILE=hardware-long` that verifies three simultaneous live tiles keep advancing, stay within latency/FPS budgets, and keep backend queues bounded
- an opt-in mixed-resolution VMS stress diagnostic with `WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long` that runs `channel-4k`, `channel-003`, and `channel-001` together for 180 seconds and exposes sequence gaps, client drops, and frame hitches under 4K load
- an opt-in 4K Playwright smoke with `WEBVIDEO_E2E_4K=1 START_4K_RTSP=1` that verifies a 3840x2160 browser session can receive, decode, and render at least one RTSP-backed frame, including as a tile beside another browser-initiated channel

The headed Chrome path uses:

```text
--enable-unsafe-webgpu
--ignore-gpu-blocklist
--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
```
