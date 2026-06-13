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
  tests/
    unit/
    contracts/
    e2e/
docs/
scripts/
```

Current baseline:

- `.NET 10` backend contracts and deterministic in-memory coordinators
- ASP.NET demo host for synthetic browser stream payloads
- TypeScript browser contracts and deterministic player services
- Vitest and Playwright suites for contract and browser-flow coverage
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
- render a visible browser demo page and contract harness

Exit criteria:

- backend tests pass
- frontend unit and contract tests pass
- Playwright validates the contract harness and live demo

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

- confirm WebTransport -> WebCodecs -> WebGPU works on target browsers/devices

Tasks:

- send synthetic encoded video chunks from backend
- frontend reassembly and decode
- measure receive, decode, and present timing
- WebGPU video presentation

Exit criteria:

- stable low-latency synthetic playback
- baseline metrics visible in browser

### Phase 3: Build live camera path

Goal:

- first live end-to-end pipeline

Tasks:

- RTSP source ingest
- RTP depacketization into normalized encoded access units
- no-transcode archive/proxy compatibility where possible
- paced WebTransport send
- frontend reassembly and decode
- minimal scheduler with late-frame dropping

Exit criteria:

- live stream reaches latency target on development network
- queue depth and drop metrics are visible

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

1. Client requests live or playback session over HTTPS.
2. Server returns:
   - auth/session token
   - WebTransport endpoint
   - stream IDs or logical channel descriptors
   - codec config
   - timeline epoch and timebase
3. Client opens WebTransport.
4. Client starts video and metadata readers.

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
- overlay renderer
- observability dashboard
- browser compatibility report
