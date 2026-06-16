# Implementation Plan

## 1. Suggested Repository Structure

Current repository structure:

```text
backend/
  src/
    WebVideo.Backend.Contracts/
    WebVideo.Backend.TestKit/
    WebVideo.Backend.DemoHost/
  tests/
    WebVideo.Backend.Contracts.Tests/
    WebVideo.Backend.Specifications.Tests/
    WebVideo.Backend.DemoHost.Tests/
frontend/
  src/
    contracts/
    testing/
    vms/
  tests/
    unit/
    contracts/
    e2e/
docs/
scripts/
```

Current baseline:

- `.NET 10` backend contracts and deterministic in-memory coordinators
- ASP.NET demo host for RTSP-backed browser stream payloads and local WebTransport/QUIC
- TypeScript browser contracts plus WebTransport, WebCodecs, scheduler, hardware WebGPU render services, and Canvas2D fallback for software-adapter cases
- Vitest and Playwright suites for contract, live demo, tile wall, VMS continuous playback, opt-in 60 second soak, opt-in mixed 4K/1080p soak, and opt-in 4K browser-flow coverage; local 4K RTSP sources are served by default through `start.sh`, while Playwright/profiling uses `test-start.sh` to enable sample footage with 4K/source variants opt-in
- future service splits are documented separately in [Future Options](./future-options.md)

## 2. Phase Plan

### Phase 0: Contract scaffold and visible demo

Goal:

- lock service and player shapes before production media I/O

Tasks:

- define backend contracts for ingest, archive, proxy, browser sessions, fanout, metadata, and telemetry
- implement deterministic in-memory backend coordinators
- define TypeScript browser contracts for transport, decode, schedule, render, and telemetry
- implement deterministic in-memory player services
- serve synthetic stream payloads from the demo host
- route client-provided channel IDs to backend-selected streams and browser sink/session records
- capture real H.264 Annex B access units from the local RTSP source when `start.sh` enables RTSP capture
- render a visible browser demo page and contract harness
- render a visible multi-channel tile wall with one client-initiated channel session per tile
- render a React VMS client with long-lived WebTransport streams, add/remove channel tiles, and per-tile health metrics
- expose default local 4K RTSP channels plus opt-in high-resolution browser smoke tests

Exit criteria:

- backend tests pass
- frontend unit and contract tests pass
- Playwright validates the contract harness, live demo, tile wall, VMS continuous playback, and opt-in long-running VMS soak
- opt-in 4K Playwright validates one 3840x2160 browser session when `WEBVIDEO_E2E_4K=1`

### Phase 1: Define protocol and timing model

Goal:

- freeze the first transport/message model

Tasks:

- define video chunk message schema
- define metadata message schema
- define startup/session config handshake
- define timestamp domains and mapping rules
- define error and resync behavior

Exit criteria:

- protocol document and reference parser on both backend and frontend

### Phase 2: Build browser transport prototype

Goal:

- confirm WebTransport -> WebCodecs -> WebGPU works on target browsers/devices; the local Playwright harness currently verifies this loop against `test-start.sh`

Tasks:

- send RTSP-captured H.264 access units from backend-selected channel sessions
- frontend WebTransport read, reassembly, and WebCodecs decode
- independent browser-initiated sessions for multiple channel tiles on one page
- measure receive, decode, render, and visible presentation timing
- hardware WebGPU validation with Linux Vulkan/ANGLE flags, WebGPU external textures from WebCodecs `VideoFrame`, and WebGPU canvas presentation
- software WebGPU adapter detection that avoids slow SwiftShader rendering and uses Canvas2D fallback instead
- default 4K source path and opt-in 4K browser smoke path
- per-tile VMS diagnostics for render FPS, source FPS, latency summaries, backend queue/drop counters, client drops, skipped sequence frames, frame hitches, and frame interval p95
- opt-in mixed-resolution VMS soak for `channel-4k`, `channel-003`, and `channel-001`

Exit criteria:

- stable low-latency local playback
- baseline metrics visible in browser
- default headless Playwright passes
- `WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh` passes for the 60 second hardware VMS soak
- `WEBVIDEO_E2E_4K=1 scripts/test-frontend-e2e.sh` passes for the high-resolution smoke
- `WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh` passes on a Vulkan-capable Chrome install

### Phase 3: Build live camera path

Goal:

- harden the continuous live camera session path and move from predefined demo channels to operator-configurable cameras

Tasks:

- RTSP source ingest
- RTP depacketization into normalized encoded access units
- no-transcode archive/proxy compatibility where possible
- paced WebTransport send
- frontend continuous read, reassembly, and decode
- minimal scheduler with late-frame dropping
- dynamic channel registry or camera configuration API for arbitrary RTSP sources
- continuous session lifecycle, backpressure, reconnect, and keyframe recovery
- hot-path optimization for mixed 4K/1080p viewing, including main-thread work reduction, decode/render backpressure control, and explicit live frame shedding

Exit criteria:

- arbitrary-duration live stream reaches latency target on development network
- queue depth, drops, sequence gaps, frame hitches, and latency metrics are visible and tied to failure reasons
- mixed 4K/1080p playback stays within agreed FPS, hitch, and source-to-render budgets for a multi-minute run

### Phase 4: Add metadata overlays

Goal:

- synchronized overlays with bounded overhead

Tasks:

- metadata stream reader
- metadata timeline store
- per-frame metadata selection
- primitive overlay rendering
- debug timing overlay

Exit criteria:

- overlays remain visually aligned under jitter and moderate loss

### Phase 5: Add playback

Goal:

- reuse core path for on-demand playback

Tasks:

- indexed chunk storage
- session seek API
- playback buffering policy
- timeline scrubbing
- metadata replay by timeline

Exit criteria:

- seekable playback with same render/overlay architecture

### Phase 6: Hardening

Goal:

- production readiness

Tasks:

- network recovery logic
- keyframe recovery
- memory profiling
- browser matrix validation
- observability dashboards
- feature flags for fallback paths

Exit criteria:

- repeatable performance profile and known degradation behavior

## 3. Detailed End-to-End Flow

### Session startup

1. Client requests a live or playback session over HTTPS with a browser-provided channel ID.
2. Server resolves the channel ID to the backend stream and creates a browser sink/session.
3. Server returns:
   - auth/session token
   - WebTransport endpoint
   - selected stream ID and logical channel descriptor
   - codec config
   - timeline epoch and timebase
4. Client opens WebTransport when available, or the deterministic local fallback during scaffolded testing.
5. Client starts video and metadata readers.

### Live video path

1. Source frames enter encoder or normalized ingest path.
2. Encoder or depacketizer emits keyframes and delta frames.
3. Backend wraps encoded frame into chunk message.
4. Backend timestamps and paces send.
5. Browser receives bytes and parses chunk messages.
6. Browser submits `EncodedVideoChunk`s to `VideoDecoder`.
7. `VideoDecoder` outputs `VideoFrame`s.
8. Scheduler selects frame for current presentation deadline.
9. Renderer composites video plus active overlays.
10. Frame is presented; used `VideoFrame` is closed immediately.

### Metadata path

1. Backend emits timed metadata events.
2. Metadata is sent on dedicated stream.
3. Browser stores events in timeline window keyed by PTS.
4. Scheduler asks metadata store for events active at video PTS.
5. Renderer draws corresponding overlays.

## 4. Critical Technical Decisions

### Decision: one or two streams

Recommendation:

- two reliable streams by default

Reason:

- clearer isolation
- simpler prioritization
- easier schema evolution

### Decision: worker model

Recommendation:

- transport parsing and scheduling in a worker if browser APIs allow required objects
- keep main thread thin

Reason:

- reduces UI interference
- lowers GC pressure in render path

Current status:

- VMS transport parsing, decode submission, scheduling, and render orchestration still run largely on the main browser thread.
- An experimental Dedicated Worker decoder path is available with `?decodeWorker=1`; default playback stays on the stable main-thread WebCodecs path until the opt-in browser test proves the worker `VideoFrame` handoff renders reliably.
- Worker movement must not imply software decode. The target remains WebCodecs hardware decode and WebGPU hardware render; workers are only for CPU-side orchestration that otherwise competes with React/layout/input/compositor scheduling.
- The 180 second mixed 4K/1080p stress run shows visible hitches, skipped sequence ranges, backend stale-frame drops, and source-to-render spikes even on the hardware WebGPU path.
- Moving WebTransport read/parsing and live scheduling away from React/main-thread work is the safer near-term optimization target. Worker decode and worker WebGPU/OffscreenCanvas remain follow-up candidates after measurement.

### Decision: metadata format

Recommendation:

- binary protocol, versioned

Reason:

- JSON becomes expensive quickly at frame cadence

### Decision: live latency policy

Recommendation:

- bounded queue sizes with explicit dropping

Reason:

- uncontrolled queues always convert transient load into persistent latency

## 5. Risk Register

### Browser support risk

Mitigation:

- define supported browser/device matrix early
- test hardware decode path explicitly

### Zero-copy assumption risk

Mitigation:

- treat zero-copy as an optimization, not a requirement
- benchmark fallback texture upload path
- disable software WebGPU adapters for live video; SwiftShader can be much slower than Canvas2D fallback

### Mixed-resolution overload risk

Mitigation:

- keep the `hardware-mixed-4k-long` profile as a diagnostic stress path
- expose client drops, sequence gaps, frame hitches, and backend stale-frame drops in the VMS UI
- optimize scheduling and queue policy before treating `4K + 1080p` as a product-grade target

### Timestamp drift risk

Mitigation:

- build clock mapping and drift metrics from day one

### Metadata complexity risk

Mitigation:

- start with a very small schema and primitive set

### Playback format divergence risk

Mitigation:

- keep live chunk model compatible with stored playback units

## 6. Recommended Milestone Order

1. contract scaffold and visible synthetic demo
2. protocol and timing freeze
3. browser transport prototype
4. live end-to-end
5. metrics and debug overlay
6. metadata overlays
7. playback
8. optimization and hardening

## 7. Deliverables

- protocol spec
- `.NET 10` backend contracts and coordinators
- backend demo host and synthetic stream catalog
- TypeScript browser contracts and receiver
- WebGPU renderer
- Canvas2D fallback policy for software WebGPU adapters
- overlay renderer
- observability dashboard
- browser compatibility report
