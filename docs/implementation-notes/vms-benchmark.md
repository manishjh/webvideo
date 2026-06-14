# VMS Benchmark Snapshot

This is a local development snapshot, not a production benchmark.

Run shape:

- date: 2026-06-14
- source mode: `WEBVIDEO_SAMPLE_FOOTAGE=1`
- source files: cached 30-second H.264 baseline surveillance clips in `.tools/rtsp/footage/`
- client: `http://127.0.0.1:4173/vms.html`
- active tiles: `channel-001`, `channel-002`, `channel-003`
- browser path: RTSP-over-TCP publish -> continuous backend fanout -> WebTransport/QUIC MoQ-shaped video objects -> WebCodecs Annex B decode -> WebGPU external texture render
- source publishing: prepared sample MP4s are looped with `ffmpeg -c:v copy`
- live queue: six encoded frames per subscriber, with stale frames dropped instead of buffering seconds of old video
- sample window: approximately 20 seconds with two simultaneous 720p tiles plus one 1080p tile

| Channel | Frames | Dropped | FPS | Bytes | Messages | Source-to-render p95 | Server-to-render p95 | Receive-to-render p95 | Decode p95 | Render p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `channel-001` | 537 | 0 | 29.39 | 9,438,506 | 538 | 41 ms | 41 ms | 40 ms | 0.4 ms | 1.2 ms |
| `channel-002` | 444 | 0 | 26.32 | 9,012,083 | 445 | 42 ms | 42 ms | 41 ms | 0.5 ms | 1.3 ms |
| `channel-003` | 431 | 12 | 27.12 | 14,773,422 | 445 | 48 ms | 48 ms | 46 ms | 1.0 ms | 1.8 ms |

## Mixed 4K Stress Snapshot

This stress run is intentionally heavier than the current tuned baseline.

Run shape:

- date: 2026-06-14
- source mode: `START_4K_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1`
- active tiles: `channel-4k`, `channel-003`, `channel-001`
- browser: headed Chrome launched with the Linux Vulkan/ANGLE WebGPU flags
- GPU path: `external-texture` / `webgpu-canvas`
- GPU adapter: NVIDIA Turing
- duration: 180 seconds
- source rates: 4K at 15 fps by design, 1080p/720p at 30 fps

Final sample from the 180 second run:

| Channel | Frames | Messages | Render FPS | Client drops | Backend drops | Sequence gap frames | Hitches | Severe hitches | Source-to-render p95 | Receive-to-render p95 | Decode p95 | Render p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `channel-4k` | 2,578 | 2,663 | 13.08 | 77 | 290 | 1,363 | 441 | 45 | 1,543 ms | 215 ms | 102 ms | 19 ms |
| `channel-003` | 3,749 | 3,979 | 12.93 | 217 | 1,760 | 3,790 | 1,192 | 536 | 8,364 ms | 482 ms | 117 ms | 10 ms |
| `channel-001` | 3,747 | 3,899 | 13.16 | 143 | 1,769 | 3,721 | 1,192 | 551 | 10,716 ms | 436 ms | 115 ms | 4 ms |

Mid-run behavior also showed all three tiles dipping to roughly 10-11 fps around the 45 second mark, with source-to-render p95 in the 3-6.5 second range. The important finding is that the hardware GPU path was correct, but the mixed-resolution path still developed browser-side scheduling and backpressure issues over time.

Backend process sample after the browser run:

| Process | Shape | CPU | RSS |
|---|---|---:|---:|
| `mediamtx` | local RTSP server | 7.4% | 46 MB |
| `ffmpeg` publishers | three prepared-file stream-copy publishers | 1.0-1.3% each | 16-18 MB each |
| `.NET` demo host | WebTransport endpoint plus continuous fanout | 17.0% | 130 MB |
| `ffmpeg` readers | three backend RTSP copy readers | 1.7-2.6% each | 18-20 MB each |

Backend fanout counters at sample time:

| Stream | Frames read | Subscriber drops | Pending frames |
|---|---:|---:|---:|
| `camera-001` | 538 | 0 | 0 |
| `camera-002` | 478 | 8 | 0 |
| `camera-003` | 448 | 1 | 0 |

Interpretation:

- The VMS browser path is now a long-lived WebTransport stream per tile, not repeated bounded batches.
- Chrome decoded the H.264 Annex B stream through WebCodecs and rendered `VideoFrame` objects through WebGPU.
- The VMS continuous stream no longer sends video frames as JSON/base64; it sends a compact MoQ-shaped object envelope with track alias, group id, object id, subgroup id, priority, timing, and raw H.264 payload.
- The previous high S2R behavior was mostly client hot-path overhead: per-frame React updates and per-frame WebGPU readback/synchronization. Those are now throttled/diagnostic-only.
- Source-side FFmpeg encode is removed for prepared sample footage. MediaMTX still needs publishers, but those publishers now stream-copy instead of encoding.
- Backend queue depth was zero at the sample point. The small drop counts are intentional stale-frame drops from the six-frame live queue and are preferable to seconds of latency.
- RTSP publishing must use TCP locally; UDP publication caused RTP packet loss and keyframe-only recovery.
- The older single `Dropped` counter did not explain visible stutter well enough. The VMS UI now separates backend stale-frame drops, client dependency drops, skipped sequence ranges, frame hitches, severe hitches, source FPS, render FPS, and frame interval p95.
- The next performance milestone is reducing main-thread media work, improving explicit live frame shedding, tightening decode/backpressure policy, full MOQT/MSF interoperability, and replacing the backend whole-buffer Annex B parser with an incremental pooled parser.
