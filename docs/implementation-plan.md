# Implementation Plan

## 1. Suggested Repository Structure

For a Rust backend and TypeScript frontend:

```text
backend/
  crates/
    transport/
    media_pipeline/
    metadata_protocol/
    session_control/
    observability/
frontend/
  src/
    transport/
    protocol/
    decoder/
    scheduler/
    renderer/
    overlays/
    metrics/
    ui/
docs/
```

If C# is preferred for control plane and APIs:

- keep transport/media hot path in Rust
- expose control and orchestration services in C#

## 2. Phase Plan

### Phase 0: Prove browser path

Goal:

- confirm WebTransport -> WebCodecs -> WebGPU works on target browsers/devices

Tasks:

- send synthetic encoded video chunks from backend
- decode and render a test stream
- measure receive, decode, and present timing
- validate GPU compositing path

Exit criteria:

- stable playback of low-latency stream
- baseline metrics visible in browser

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

### Phase 2: Build live path

Goal:

- first live end-to-end pipeline

Tasks:

- source ingest
- low-latency encode
- paced QUIC/WebTransport send
- frontend reassembly and decode
- minimal scheduler with late-frame dropping
- WebGPU video presentation

Exit criteria:

- live stream reaches latency target on development network

### Phase 3: Add metadata overlays

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

### Phase 4: Add playback

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

### Phase 5: Hardening

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

1. Source frames enter encoder.
2. Encoder emits keyframes and delta frames.
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

1. browser prototype with synthetic chunks
2. protocol freeze
3. live end-to-end
4. metrics and debug overlay
5. metadata overlays
6. playback
7. optimization and hardening

## 7. Deliverables

- protocol spec
- reference Rust sender
- TypeScript browser receiver
- WebGPU renderer
- overlay renderer
- observability dashboard
- browser compatibility report

