# Latency and Performance

## 1. Latency Budget

An approximate low-latency budget for a well-tuned path:

| Stage | Target |
|---|---:|
| capture to encoder input | 2-8 ms |
| encode | 4-16 ms |
| server packetization and pacing | 1-4 ms |
| network one-way | 5-40 ms |
| browser receive and reassembly | 1-5 ms |
| decode | 4-12 ms |
| render and present | 4-16 ms |

This implies a practical best-case range around 20-60 ms on a strong local network and more commonly 50-150 ms in real deployments.

## 2. Where Latency Usually Hides

The dominant hidden costs are usually:

- encoder lookahead and B-frames
- oversized transport chunks
- receiver buffering "for smoothness"
- decoding backlog
- rendering one frame later than necessary
- mismatched clocks causing artificial holdback

## 3. Backend Guidance

### Codec choices

Use a codec and profile that browsers decode reliably in hardware where possible.

Common practical choice:

- H.264 baseline/main/high without B-frames for widest compatibility

Secondary options:

- HEVC only if your browser/device matrix supports it
- AV1 only if low-latency hardware decode is acceptable for your targets

For first implementation, choose H.264 with:

- no B-frames
- short GOP
- low-latency encoder tune
- minimal lookahead

### Packetization

Use message units that map closely to decode chunks:

- codec config message
- keyframe chunk
- delta frame chunk

Each chunk should carry:

- stream sequence number
- chunk type
- codec timestamp
- duration if known
- keyframe flag
- dependency info if available
- optional capture and send timestamps

Avoid large bursty writes. Pace encoded chunks according to capture/encode time and network conditions.

### QUIC/WebTransport strategy

Recommended:

- reliable ordered stream for encoded video
- reliable ordered stream for timed metadata
- datagrams only for data that can be dropped safely

Do not force all signaling, media, and metadata into one stream if you care about keeping metadata responsive under load.

Current local implementation note: the demo uses WebTransport over QUIC, but each media session currently rides a single reliable ordered bidirectional stream with a compact MoQ-shaped object envelope. That validates browser QUIC/WebTransport connectivity, but it does not yet use the full latency advantages of QUIC such as independent unidirectional media streams, stream priorities, or datagram delivery for droppable delta data. Treat the current wire behavior as QUIC transport with TCP-like ordering semantics until the media object mapping is upgraded.

### Congestion control and pacing

Your application-level pacing matters even on top of QUIC.

Requirements:

- smooth burst shaping
- frame-aware pacing
- bounded send queue
- late-frame drop policy for live

## 4. Frontend Guidance

### Reader design

Use dedicated async readers per stream. Keep parse logic incremental. Avoid building large intermediate arrays.

Suggested stages:

1. byte reader
2. frame/chunk parser
3. decode submitter
4. presentation scheduler
5. renderer

Each stage should expose queue depth and processing time metrics.

### Decoder usage

Configure `VideoDecoder` once per stream configuration change.

Rules:

- feed chunks immediately when dependencies are satisfied
- do not queue far ahead
- cap decode backlog tightly
- close `VideoFrame`s immediately after rendering

Recommended starting limits:

- encoded chunk queue: 2-6 frames
- decoded frame queue: 1-3 frames

### Worker placement

Workers help when JavaScript orchestration competes with UI and compositor work. They do not automatically make decode faster, and they must not move production playback onto a software decoder.

Good worker candidates:

- WebTransport reads
- compact object envelope parsing
- access-unit assembly
- dependency/keyframe/drop decisions
- metrics aggregation
- decode submission, if `VideoDecoder` still uses hardware decode in that worker/browser profile

Risky worker candidates:

- decode plus main-thread rendering when every decoded `VideoFrame` has to bounce across threads before WebGPU can consume it
- per-tile render workers that each own separate GPU/device/canvas state and duplicate compositor work
- software WASM video decode for 4K/60 unless it is only a fallback or diagnostic path

Current local behavior: the stable VMS path uses main-thread WebTransport parsing, main-thread WebCodecs submission, and a shared WebGPU matrix compositor. Two worker experiments are available:

- `?decodeWorker=1` moves only WebCodecs decode submission/output handoff to a worker.
- `?mediaWorker=1` moves WebTransport connect/read, compact object parsing, access-unit assembly, keyframe/drop policy, and WebCodecs decode into a worker, then transfers decoded `VideoFrame` objects back to the main thread for the shared WebGPU matrix compositor.

Both worker paths are opt-in benchmarking tools, not defaults. The 2026-06-15 local profiles showed that `?mediaWorker=1` reduced browser task time in dense-wall runs, but did not beat the default path on source-to-render latency across all tiles. The strict production rule remains: promote a worker path only after it is better on latency, smoothness, drops, and task load for the target profile.

### Render path

Primary hardware path:

- import `VideoFrame` into GPU path directly where browser support allows
- composite video plane plus overlay primitives in a single render pass
- avoid CPU canvas compositing

Render architecture:

- one full-screen quad for video
- one or more overlay passes or instanced draws for boxes, lines, text anchors, masks
- optional final color/tone conversion pass only if required

Fallback policy:

- require hardware WebGPU for the production fast path
- detect and reject SwiftShader/software WebGPU adapters for live video
- use the explicit Canvas2D renderer when Chrome only exposes a software adapter
- expose the active render path and GPU adapter in the VMS UI and Playwright diagnostics

The Canvas2D path is a compatibility fallback, not the performance target. In local testing, Chrome's Linux SwiftShader WebGPU path was slower and more jitter-prone than the Canvas2D fallback.

### Scheduling

Do not blindly render on every `requestAnimationFrame` using "latest frame wins" unless you accept timestamp drift.

Instead:

- maintain a monotonic media presentation clock
- pick the frame whose PTS is due
- drop frames already too late
- apply metadata valid for the chosen presentation timestamp

For live, favor bounded latency over perfect completeness.

## 5. Metadata Performance Model

Metadata must be cheap to decode and cheap to render.

Recommended:

- binary wire format
- compact typed events
- event batches per frame or per short time window
- preallocated overlay buffers

Avoid:

- large JSON payloads at frame rate
- CPU-heavy per-frame text layout for dynamic overlays
- rebuilding GPU buffers from scratch for every primitive

## 6. How to Get Close to Native Performance

### What "close to native" means here

In a browser, close to native means:

- hardware decode if available
- GPU compositing
- minimal copying
- minimal JS object churn
- no extra buffering beyond what the pipeline needs

### Copy ownership policy

The target media path is:

1. RTSP/RTP H.264 access units are normalized in the backend without decode/re-encode.
2. The backend writes one compact binary media object per access unit to WebTransport/QUIC.
3. The browser incrementally parses the binary object envelope without cloning payload bytes.
4. WebCodecs owns the encoded chunk after `EncodedVideoChunk` submission.
5. Hardware decode produces a `VideoFrame`.
6. WebGPU imports that `VideoFrame` as an external texture and composites directly to the WebGPU canvas.

Some ownership handoffs cannot be eliminated with the current browser and .NET API shapes:

- the RTSP reader must cross from the source process/socket into backend-owned memory
- Kestrel/MsQuic must own or copy bytes while QUIC/TLS packets are built and retransmitted
- WebTransport exposes browser-owned `Uint8Array` chunks to JavaScript
- `EncodedVideoChunk`/`VideoDecoder` may internally retain or copy encoded bytes because JavaScript must be free to release its buffers after `decode`
- the browser/driver may do GPU-internal layout or color-space copies while importing/presenting a `VideoFrame`

Those boundaries are not acceptable excuses for application-level waste. The codebase should treat these as unacceptable in the production fast path:

- JSON or base64 video payloads
- concatenating the full pending transport buffer every read
- cloning frame payloads between parser and decoder
- CPU readback from WebGPU except for explicit diagnostics
- `VideoFrame` to Canvas2D or CPU pixel conversion when hardware WebGPU is available
- unbounded encoded, decoded, transport, or render queues
- per-frame allocations for stable GPU resources such as render targets, overlay buffers, samplers, and pipelines

Render-path labels are part of the production diagnostics. Direct single-canvas playback and the shared VMS matrix normally report `external-texture / webgpu-canvas` on the hardware path. The VMS matrix retains the latest WebCodecs `VideoFrame` per visible tile, imports dirty frames as `GPUExternalTexture` resources, redraws only dirty tile regions into a persistent WebGPU backing texture during normal frame-arrival flushes, and copies that backing texture to the matrix canvas. Resize, layout, and tile-removal events still force a clear plus full retained-tile redraw. This avoids the intermediate per-frame `VideoFrame` -> `GPUTexture` copy and avoids re-importing/redrawing unchanged tiles on every other tile's frame arrival. The older retained texture copy path is still available with `?matrixTexture=copy` and reports `videoframe-copy / webgpu-canvas`.

### Concrete techniques

- Keep transport payloads binary and compact.
- Avoid JSON in hot paths.
- Reuse typed arrays and object pools.
- Avoid crossing worker/main-thread boundaries more than necessary.
- Move parsing and scheduling to a dedicated worker when possible.
- Keep UI framework code out of the media hot path. The current React VMS app now consumes the reusable `video-pipe` viewport instead of directly wiring transport, decode, and renderer classes; React owns tile lifecycle and diagnostics, while the pipe owns per-frame work.
- Use hardware WebGPU for the fast path.
- Treat Canvas2D as an intentional compatibility fallback for software-adapter cases.
- Do not treat SwiftShader/software WebGPU as a production rendering path.
- Keep overlay primitives GPU-friendly: instanced boxes, lines, glyph atlases, masks.
- Instrument every queue so latency inflation is visible immediately.

### Current Refactor Boundary

The frontend pipe is intentionally an internal module before it becomes a published package:

- app input: channel descriptors, tile IDs, matrix canvas ID, auth/certificate settings, and runtime options
- pipe ownership: WebTransport URL construction, streaming reads, incremental chunk assembly, WebCodecs decode, live frame shedding, duplicate-tile frame ownership, WebGPU/Canvas renderer selection, and metrics snapshots
- app ownership: channel catalog fetch, tile add/close/duplicate behavior, layout, expanded diagnostics, and backend metrics polling

That boundary is meant to make future optimization work local. For example, moving parser/decode scheduling to a worker should touch `video-pipe` without rewriting the VMS UI.

### Limits you cannot remove

- browser process scheduling
- implementation differences across Chrome/Edge/Safari/Firefox variants
- restricted control over decoder internals
- platform-specific zero-copy behavior

That means the design should be robust to slightly different runtime behavior rather than assuming one ideal browser path.

## 7. Operational Metrics

Collect at minimum:

- capture timestamp
- encode start/end
- send enqueue/dequeue
- network RTT
- receive timestamp
- parse completion
- decode submit time
- decode output time
- render submit time
- present time
- queue depths at each stage
- dropped frame counts by reason
- source FPS and render FPS
- frame interval p95/p99
- frame hitch and severe hitch counts
- skipped sequence ranges and skipped frame counts
- backend subscriber stale-frame drops
- client dependency drops
- active render path and GPU adapter details
- metadata delay and expiry counts

For the local VMS pipeline, `scripts/profile-vms.sh` is the non-gating profiling entrypoint. It runs the real `start.sh` RTSP + WebTransport + WebCodecs + WebGPU path, samples the duplicate 4K60 stress shape by default, reports duplicate tile IDs independently, includes a warm-up-discarded `steadyState` summary, and writes JSON timelines to `.run/profiles/`. Set `WEBVIDEO_PROFILE_CPU=1` to also emit Chrome page `.cpuprofile` artifacts with top self-time summaries. When worker media paths are enabled, the harness auto-attaches to worker targets and writes `.workers.cpuprofiles.json` artifacts so page-thread improvements cannot hide worker CPU regressions. Set `WEBVIDEO_PROFILE_CAPTURE_UNREADY=1` when profiling a failure-mode run that may not reach the normal clean-readiness predicate.

The current local hardware profiles show the important split:

- 1-tile high-FPS baseline (`channel-4k-crowd`) selects `cctv-road-crowd-1080p60`; after warm-up it rendered about 59 fps with zero client drops, zero sequence gaps, zero backend drops, zero severe hitches, browser task around 22%, server CPU around 22%, source-to-render p95 around 37 ms, and render p95 around 3.4 ms.
- 9-tile forced 30 fps wall (`channel-001`, `channel-002`, `channel-003` repeated three times) remains the current sweet-spot proof: after warm-up it rendered about 29.5-30.8 fps per tile with zero client drops, zero sequence gaps, zero source switches, browser task around 31%, server CPU around 25%, and source-to-render p95 around 42-46 ms.
- 3-tile 4K60 stress shape (`channel-4k-crowd`, duplicate `channel-4k-crowd`, `channel-003`) is still not product-grade at full 4K60. After adding slower adaptive recovery/source-switch hysteresis, the short failure-mode profile improved from about six steady-state source switches, five severe hitches, and 163 ms S2R p95 to about two source switches, two severe hitches, and 104 ms S2R p95 when the crowd stream settled on the 1080p24 recovery variant. It can still climb back to 4K60 and expose render/API pressure, so this remains a stress target rather than a claimed capacity.
- Duplicate views share one WebTransport/WebCodecs session per channel. The matrix compositor ref-counts retained `VideoFrame` objects so duplicate views can redraw the same decoded frame through external textures without cloning or copying it into separate retained source textures; duplicate external-texture imports are cached within a matrix flush. Normal frame-arrival flushes update only dirty tile regions in the matrix backing texture, so unchanged duplicates do not force repeated imports or draws.
- Startup can still show transient hitches while Chrome/WebGPU/WebCodecs warm up, so profile summaries must inspect both full-run and warm-up-discarded `steadyState`.
- `matrixFlush=raf` remains a diagnostic switch, not the default. In the current frame-arrival render loop it can feed back into adaptive pressure after stress removal; the proven default is the microtask compositor flush.

That points the next optimization at page/session-level transport multiplexing, a real source-control path for non-destructive variant switching, tighter worker handoff policy, reducing startup warm-up hitches, adding deeper compositor diagnostics, and comparing external-texture versus forced-copy behavior across longer and denser stream shapes. Workerizing transport/MoQ parse and decode orchestration is now measurable with `?mediaWorker=1`, but it is not yet the default fast path.

## 8. Failure and Degradation Policies

### Live

- drop late metadata events after validity window
- drop stale decoded frames if presentation deadline passed
- count skipped sequence ranges separately from explicit dependency drops
- prefer dropping stale live frames over preserving old frames and inflating source-to-render latency
- request/keyframe recovery on decode corruption
- reduce overlay complexity under GPU pressure

The current local mixed 4K/1080p/720p run is a diagnostic stress path. It proves the hardware WebGPU path can be selected, but it also exposes browser-side hitches, skipped sequence ranges, and backend stale-frame drops under load. Do not treat that profile as product-grade until its multi-minute FPS, hitch, and source-to-render budgets are stable.

### Playback

- increase buffer depth before dropping
- allow more accurate sync recovery
- favor completeness over minimal latency
