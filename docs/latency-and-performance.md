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

### Concrete techniques

- Keep transport payloads binary and compact.
- Avoid JSON in hot paths.
- Reuse typed arrays and object pools.
- Avoid crossing worker/main-thread boundaries more than necessary.
- Move parsing and scheduling to a dedicated worker when possible.
- Keep UI framework code out of the media hot path.
- Use hardware WebGPU for the fast path.
- Treat Canvas2D as an intentional compatibility fallback for software-adapter cases.
- Do not treat SwiftShader/software WebGPU as a production rendering path.
- Keep overlay primitives GPU-friendly: instanced boxes, lines, glyph atlases, masks.
- Instrument every queue so latency inflation is visible immediately.

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
