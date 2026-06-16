# Frontend

This folder contains the contract-first browser player and local test harness.

Structure:

- `src/contracts`: planned TypeScript contracts for transport, decode, schedule, render, and telemetry
- `src/video-pipe`: reusable live player module for WebTransport receive, WebCodecs decode, shared WebGPU viewport rendering, frame shedding, and metrics
- `src/testing`: concrete browser pages for the contract harness and live demo renderer
- `src/vms`: React VMS client shell, channel/tile lifecycle, tile presentation, and diagnostics UI
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
WEBVIDEO_TEST_PROFILE=hardware-duplicate-4k60-profile scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-media-worker-profile scripts/test-all.sh
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh
WEBVIDEO_E2E_4K=1 scripts/test-frontend-e2e.sh
WEBVIDEO_E2E_4K=1 WEBVIDEO_E2E_4K_STRESS=1 scripts/test-frontend-e2e.sh tests/e2e/high-resolution-4k.spec.ts
```

The player services keep deterministic paths for contract coverage and now exercise the real browser media path in Playwright. The current suites lock:

- public browser-facing method signatures
- WebTransport/decode/scheduler/renderer/telemetry behavior
- an integrated in-memory player flow
- frontend flow coverage
- browser behavior coverage
- documented end-to-end scenarios
- a default headless Playwright harness that renders manifests, receives WebTransport bytes, decodes through WebCodecs, and verifies visible browser rendering while avoiding slow software WebGPU adapters
- an opt-in headed Chrome WebGPU harness with `WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1` that uses the safer Linux Vulkan/ANGLE preset and verifies hardware `VideoFrame` external-texture rendering to the WebGPU canvas
- a backend-fed live demo page that requests a channel session, records the QUIC/WebTransport URL, shows whether RTSP capture was verified, and renders visible playback in the browser
- a tile wall page that opens separate client-initiated channel sessions per tile and verifies independent WebTransport byte flow, WebCodecs decode, and WebGPU render state
- a React VMS client that fetches channels from the backend, lets the user add/remove camera tiles, opens long-lived WebTransport H.264 streams using a MoQ-shaped object envelope for continuous viewing, shares one transport/decode session for duplicate views of the same camera, verifies MoQ object diagnostics, source renegotiation/recovery, WebTransport chaos recovery, and latency budgets, and exposes compact per-tile source-to-render/render-FPS/drop metrics with expandable diagnostics
- a reusable `VideoPipeViewport` adapter that lets application code supply channel groups and tile canvas IDs while the pipe owns the session controller, duplicate-tile renderer fanout, shared matrix canvas, WebCodecs decode, and WebGPU render path
- an opt-in 60 second VMS soak with `WEBVIDEO_E2E_LONG=1` or `WEBVIDEO_TEST_PROFILE=hardware-long` that verifies three simultaneous live tiles keep advancing, stay within latency/FPS budgets, and keep backend queues bounded
- an opt-in mixed-resolution VMS stress diagnostic with `WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long` that runs `channel-4k-crowd`, `channel-15116604`, and `channel-16147856` together and exposes sequence gaps, client drops, and frame hitches under 4K load
- a duplicate-view 4K60 VMS profile with `scripts/profile-vms.sh` or `WEBVIDEO_TEST_PROFILE=hardware-duplicate-4k60-profile` that opens `channel-4k-crowd` twice plus `channel-15116604`, requires hardware WebGPU, reports duplicate tile IDs independently, includes a warm-up-discarded `steadyState` summary, and can emit Chrome CPU profiles with `WEBVIDEO_PROFILE_CPU=1`
- VMS profile visual hashing: `tests/e2e/vms-profile.spec.ts` now samples the actual visible matrix/tile canvas image each profile interval and reports `visualHashChanges` / `visualUniqueHashes`, so a frozen visible frame fails stable profiles even if transport/decode/render counters keep advancing. Use `WEBVIDEO_PROFILE_VISUAL_HASHES=0` only for pure CPU micro-profiling.
- an opt-in media-worker VMS profile with `WEBVIDEO_TEST_PROFILE=hardware-media-worker-profile` or `WEBVIDEO_VMS_MEDIA_WORKER=1 scripts/profile-vms.sh`; this moves WebTransport receive, MoQ object parsing, access-unit assembly, and WebCodecs decode into a worker before transferring `VideoFrame`s back to the shared WebGPU matrix renderer. It is a benchmark comparison path, not the default fast path.
- an opt-in 4K Playwright smoke with `WEBVIDEO_E2E_4K=1` that verifies a 3840x2160 browser session can receive, decode, and render at least one RTSP-backed frame, including as a tile beside another browser-initiated channel; the launcher publishes 4K streams by default
- an opt-in 4K60 crowd stress smoke with `WEBVIDEO_E2E_4K_STRESS=1` that verifies `channel-4k-crowd` declares 3840x2160 at 60 fps and renders an RTSP-backed frame

Playwright startup uses `../test-start.sh`, which enables sample footage but keeps 4K publishers and source variants off unless a profile opts in. Manual `../start.sh` stays closer to a product run and publishes only primary sources unless `WEBVIDEO_RTSP_SOURCE_VARIANTS=1` is set.

The headed Chrome path uses:

```text
--enable-unsafe-webgpu
--ignore-gpu-blocklist
--enable-features=Vulkan,VulkanFromANGLE
```

Use `WEBVIDEO_CHROME_WEBGPU_PRESET=strict-vulkan` only as a diagnostic retry for the older `DefaultANGLEVulkan` path; it can cause compositor artifacts on some Linux graphics stacks.

VMS profiling knobs:

```text
WEBVIDEO_VMS_MATRIX_PRESENT=auto|immediate|raf
WEBVIDEO_VMS_MATRIX_TEXTURE=auto|external|copy
WEBVIDEO_VMS_MATRIX_FLUSH=microtask|timer|raf
WEBVIDEO_VMS_ADAPTIVE_RENDER=0|1
```

`matrixPresent=auto` is the normal multi-tile path. It coalesces visible matrix presents, keeps a timer fallback for throttled `requestAnimationFrame`, and reports matrix flush/present/draw/import/bind-group counters in `scripts/profile-vms.sh` artifacts.

If Chrome/driver rejects a matrix `VideoFrame` import, the player disables and hides the shared matrix canvas before falling back to per-tile rendering. This prevents a stale matrix frame from covering live fallback video; the fallback reason is exposed as `matrixFallbackReason` in VMS diagnostics and profile artifacts.
