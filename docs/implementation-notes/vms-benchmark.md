# VMS Benchmark Snapshot

This is a local development snapshot, not a production benchmark.

## 2026-06-15 Frontend Profiling Pass

Chrome CPU-profile capture is now part of the profiling harness. `scripts/profile-vms.sh` defaults `WEBVIDEO_PROFILE_CPU=1`, writes the normal profile JSON plus a sibling page `.cpuprofile`, and includes a compact top-self-time summary in the JSON. The harness also auto-attaches to worker targets before the VMS page creates the media pipeline, starts worker sampling only during the measured window, and writes sibling `.workers.cpuprofiles.json` artifacts when worker targets exist. Failure-mode runs can use `WEBVIDEO_PROFILE_CAPTURE_UNREADY=1` and a shorter `WEBVIDEO_PROFILE_READY_TIMEOUT_MS` so a struggling 4K60 profile is captured instead of discarded by the clean-readiness predicate.

The latest valid production-bundle checks:

| Shape | Result | Notes |
|---|---|---|
| 9 tiles, forced 30 fps, channels `001/002/003` repeated | Passed | Steady-state 29.5-30.8 fps, zero client drops, zero sequence gaps, zero source switches, S2R p95 mostly 42-46 ms, browser task about 31%, server CPU about 25%. |
| Matrix auto-present with throttled-rAF fallback, duplicate crowd plus floor | Passed | Profile `.run/profiles/vms-profile-3streams-1781511251544.json` kept the adaptive recovery shape stable at 1080p24/1080p15, zero VideoFrame copies, zero sequence gaps, no backend drops, matrix presents recovered from the bad rAF-throttled 1/sec behavior to about 23.6/sec steady-state, and crowd S2R p95 was about 41 ms after warm-up. |
| Forced 3x1080p60 raw-capacity run with adaptive disabled | Overload target | Profile `.run/profiles/vms-profile-3streams-1781511349488.json` held 60 fps sources with no source switches, but browser task rose to about 72% steady-state, matrix imports were about 98/sec, draws about 148/sec, render FPS settled around 43-46 fps per tile, decode backlog reached about 30 frames, and S2R p95 reached about 475-534 ms. This proves the current browser-side per-frame API path is the limit before backend or network. |
| Render-on-present matrix compositor, duplicate 1080p60 crowd | Passed | Profile `.run/profiles/vms-profile-2streams-1781514348224.json` kept two duplicate 1080p60 crowd tiles on one shared matrix canvas, with visual hashes changing every sample, zero client drops, zero sequence gaps, steady-state matrix presents about 57/sec, 114 draws/sec, render FPS about 52.4 per tile, and S2R p95 about 129 ms. |
| Full 4K60 duplicate crowd plus 1080p floor, matrix external-texture failure path | Diagnostic pass, not product-grade | Profile `.run/profiles/vms-profile-3streams-1781514376500.json` captured Chrome failing `importExternalTexture` on a 4K `VideoFrame` with "doesn't have back resource". The matrix compositor now disables and hides the stale overlay, visual hashes keep changing through fallback, but browser task is about 87%, crowd render FPS is about 36, S2R p95 is about 774 ms, and drops/gaps appear. Next optimization target: avoid tripping this 4K external-texture failure through source selection, in-session renegotiation, or a safer 4K matrix path. |
| Duplicate 4K60 crowd plus 1080p floor, full caps opened | Improved but not product-grade | Adaptive/source-switch hysteresis reduced steady-state source switches from about 6 to 2 and S2R p95 from about 163 ms to 104 ms when the crowd source settled at `cctv-road-crowd-1080p24`. Full 4K60 still exposes render/API pressure and visible hitches. |
| Post backing-texture compositor sanity, duplicate crowd plus floor | Passed | 20 second production-bundle profile at `.run/profiles/vms-profile-3streams-1781509812621.json`: ready before capture, steady-state duplicate crowd rendered about 24.8 fps at 1080p24, floor rendered about 15.6 fps at 1080p15, zero client drops, zero sequence gaps, zero source switches, S2R p95 35 ms for crowd and 50 ms for floor. |
| `WEBVIDEO_VMS_MATRIX_TEXTURE=copy` on duplicate 4K60 stress | Worse | CPU moved from `importExternalTexture` to `copyExternalImageToTexture`; crowd S2R p95 reached about 440 ms and severe hitches increased. |
| `WEBVIDEO_VMS_MATRIX_FLUSH=raf` on duplicate 4K60 stress | Worse | Browser task fell, but render p95 and source-to-render latency rose; RAF batching is still diagnostic-only. |

The dominant frontend CPU-profile signatures under stress are browser-native WebGPU calls (`importExternalTexture`, `copyExternalImageToTexture` when forced, `createBindGroup`, `getCurrentTexture`, `queue.submit`) plus smaller transport parse and matrix flush costs. The matrix compositor now keeps a persistent WebGPU backing texture, stages the latest frames on arrival, redraws dirty tile regions only on the visible present tick, and uses `matrixPresent=auto` to coalesce canvas presents. Auto mode prefers `requestAnimationFrame` but has a short timer fallback because profiling showed rAF can be throttled to roughly 1 Hz in some Playwright/headed/occlusion paths. Matrix profile JSON now reports flushes, visible presents, draws, external imports, bind groups, VideoFrame copy counts, and visible-frame hash changes, which makes present starvation, stale overlays, and per-frame API pressure visible. The next serious optimization work should focus on reducing external-texture/import and bind-group pressure, preventing 4K `VideoFrame` back-resource import failures, in-session source-control protocol work, shader/pipeline changes that batch more tile draws per bind group, and eventual page/session-level WebTransport multiplexing.

WASM is not a current fast-path answer for H.264 here. When hardware WebCodecs is active, replacing decode with WASM would move decode back onto CPU and lose the browser's hardware path. WASM may still be useful later for deterministic protocol parsing or bitstream utilities if JavaScript parsing becomes hot, but the current raw 3x1080p60 profile is dominated by browser-native WebGPU/WebCodecs lifecycle calls, not JavaScript parser code.

## Latest External-Texture Matrix Snapshot

Run shape:

- date: 2026-06-15
- source mode: `WEBVIDEO_SAMPLE_FOOTAGE=1`
- frontend mode: production build from `start.sh`
- browser: headed Google Chrome with `Vulkan,VulkanFromANGLE,DefaultANGLEVulkan`
- GPU adapter: NVIDIA Turing
- browser path: RTSP-over-TCP publish -> continuous backend fanout -> WebTransport/QUIC MoQ-shaped video objects -> WebCodecs Annex B decode -> retained WebCodecs `VideoFrame` objects -> WebGPU external textures -> one shared matrix canvas
- VMS matrix GPU path: `external-texture` / `webgpu-canvas`

30 second profile, single high-FPS source:

| Tile | Selected source | Source FPS | Render FPS | Client drops | Sequence gaps | Severe hitches | Source-to-render p95 | Receive-to-render p95 | Render p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `channel-4k-crowd` | `cctv-road-crowd-1080p60` | 60 | 59.0 | 0 | 0 | 0 | 37 ms | 33 ms | 3.4 ms |

30 second profile, duplicate 4K60 stress shape after VMS source renegotiation:

| Tile | Selected source | Source FPS | Render FPS | Client drops | Sequence gaps | Severe hitches | Source-to-render p95 | Receive-to-render p95 | Render p95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `channel-4k-crowd` | `cctv-road-crowd-1080p24` | 24 | 23.6 | 0 | 0 | 0 | 36 ms | 32 ms | 3.9 ms |
| `channel-4k-crowd-2` | `cctv-road-crowd-1080p24` | 24 | 23.6 | 0 | 0 | 0 | 36 ms | 32 ms | 3.9 ms |
| `channel-003` | `cctv-floor-1080p` | 30 | 29.3 | 0 | 0 | 0 | 48 ms | 37 ms | 3.8 ms |

30 second forced-copy comparison for the same duplicate 4K60 stress shape:

| Matrix path | Crowd render p95 | Floor render p95 | Crowd source-to-render p95 | Floor source-to-render p95 | Browser task |
|---|---:|---:|---:|---:|---:|
| `external-texture` | 4.0 ms | 3.8 ms | 39 ms | 45 ms | ~25.6% |
| `videoframe-copy` via `WEBVIDEO_VMS_MATRIX_TEXTURE=copy` | 5.6 ms | 3.9 ms | 41 ms | 42 ms | ~26.3% |

30 second media-worker comparison for the same duplicate 4K60 stress shape:

| Decode/transport path | Crowd render p95 | Floor render p95 | Crowd source-to-render p95 | Floor source-to-render p95 | Browser task | Server CPU | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| default main-thread media path | 3.9 ms | 3.8 ms | 36 ms | 48 ms | 26.0% | 29.3% | default |
| `?mediaWorker=1` | 3.9 ms | 3.8 ms | 53 ms | 48 ms | 22.6% | 30.3% | keep opt-in; lower browser task, worse duplicate-crowd latency |

30 second profile, 9-tile dense wall:

| Path | Selected source policy | Render FPS | Client drops | Sequence gaps | Severe hitches | Source-to-render p95 | Browser task | Server CPU |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| default main-thread media path | dense wall asks for 15 fps low-resolution variants and all tiles use the 15 fps dense render cap | ~14.7-15.3 per tile | 0 | 0 | 0 | mostly 35-41 ms | 27.5% | 20.7% |
| `?mediaWorker=1` | same dense source policy | ~14.6-15.3 per tile | 0 | 0 | 0 | mostly 69-80 ms | 24.5% | 20.2% |

The media-worker result is deliberately not promoted to default. It shows useful main-thread relief under dense-wall load, but the production bar is strict: the default only changes when the candidate is better on latency, smoothness, drops, and CPU/task load for the target profile.

The matrix compositor still matters because a WebGPU canvas current texture cannot be treated as persistent storage across separate presents. The compositor now retains the latest `VideoFrame` per visible tile, ref-counts shared frames for duplicate views, imports frames as `GPUExternalTexture` resources, redraws dirty tile regions into a persistent WebGPU backing texture, and copies that backing texture to the matrix canvas each flush. Full clears/redraws are reserved for resize/layout/tile-removal cases. `?matrixTexture=copy` keeps the older retained `GPUTexture` copy path available for fallback and profiling. Source selection is controlled by client-provided caps and adaptive pressure; a source change currently restarts the channel's media session because the backend's selected-source stream is write-only after the open request. A production in-session source switch needs a control path so the backend can switch variants without tearing down the active transport/decode pipeline.

Run shape:

- date: 2026-06-14
- source mode: `WEBVIDEO_SAMPLE_FOOTAGE=1`
- source files: cached 30-second H.264 baseline surveillance clips in `.tools/rtsp/footage/`
- client: `http://127.0.0.1:4173/vms.html`
- active tiles: `channel-001`, `channel-002`, `channel-003`
- browser path: RTSP-over-TCP publish -> continuous backend fanout -> WebTransport/QUIC MoQ-shaped video objects -> WebCodecs Annex B decode -> WebGPU external texture render
- source publishing: prepared sample MP4s are looped with `ffmpeg -c:v copy`
- live queue: six encoded frames per subscriber, with stale frames dropped instead of buffering seconds of old video
- sample window: approximately 20 seconds with three simultaneous 1080p tiles

| Channel | Frames | Dropped | FPS | Bytes | Messages | Source-to-render p95 | Server-to-render p95 | Receive-to-render p95 | Decode p95 | Render p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `channel-001` | 537 | 0 | 29.39 | 9,438,506 | 538 | 41 ms | 41 ms | 40 ms | 0.4 ms | 1.2 ms |
| `channel-002` | 444 | 0 | 26.32 | 9,012,083 | 445 | 42 ms | 42 ms | 41 ms | 0.5 ms | 1.3 ms |
| `channel-003` | 431 | 12 | 27.12 | 14,773,422 | 445 | 48 ms | 48 ms | 46 ms | 1.0 ms | 1.8 ms |

## Mixed 4K Stress Snapshot

This stress run is intentionally heavier than the current tuned baseline.

Run shape:

- date: 2026-06-14
- source mode: `WEBVIDEO_SAMPLE_FOOTAGE=1` with default 4K publishers
- active tiles: `channel-4k`, `channel-003`, `channel-001`
- browser: headed Chrome launched with the Linux Vulkan/ANGLE WebGPU flags
- GPU path: `external-texture` / `webgpu-canvas`
- GPU adapter: NVIDIA Turing
- duration: 180 seconds
- source rates: 4K at 15 fps by design, 1080p at 30 fps

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
- The current frontend ownership boundary is `frontend/src/video-pipe`: reusable transport/decode/render/metrics code lives there, while the VMS app only supplies channel groups, tile IDs, layout, and diagnostics presentation.
- Chrome decoded the H.264 Annex B stream through WebCodecs and rendered `VideoFrame` objects through WebGPU.
- The VMS continuous stream no longer sends video frames as JSON/base64; it sends a compact MoQ-shaped object envelope with track alias, group id, object id, subgroup id, priority, timing, and raw H.264 payload.
- The previous high S2R behavior was mostly client hot-path overhead: per-frame React updates and per-frame WebGPU readback/synchronization. Those are now throttled/diagnostic-only.
- Source-side FFmpeg encode is removed for prepared sample footage. MediaMTX still needs publishers, but those publishers now stream-copy instead of encoding.
- Backend queue depth was zero at the sample point. The small drop counts are intentional stale-frame drops from the six-frame live queue and are preferable to seconds of latency.
- RTSP publishing must use TCP locally; UDP publication caused RTP packet loss and keyframe-only recovery.
- The older single `Dropped` counter did not explain visible stutter well enough. The VMS UI now separates backend stale-frame drops, client dependency drops, skipped sequence ranges, frame hitches, severe hitches, source FPS, render FPS, and frame interval p95.
- The next performance milestone is reducing main-thread media work without abandoning hardware decode/render. The opt-in media-worker coordinator now proves worker-owned WebTransport parsing and WebCodecs decode can render through the shared matrix, but the benchmark does not yet justify making it default. Next work should focus on page-level multiplexed WebTransport/MOQT, tighter worker handoff policy, explicit live frame shedding, decode/backpressure tuning, and replacing the backend whole-buffer Annex B parser with an incremental pooled parser.
