# Local RTSP Runbook

The primary local path uses `start.sh` to run:

- `go2rtc` as the local RTSP server
- cached MP4 sample clips as go2rtc `ffmpeg:` sources with H.264 stream copy
- the `.NET` demo host with RTSP capture enabled
- the frontend dev server

The previous `mediamtx` plus one `ffmpeg` publisher per configured channel stack is still available with `WEBVIDEO_RTSP_SERVER=mediamtx ./start.sh` for A/B testing. It is no longer the default manual path because it keeps all publishers running whether or not a browser tile is watching them.

The browser pages request streams by channel ID. The backend resolves that channel to a selected RTSP source. The live demo and tile wall pages use bounded browser sessions, while the React VMS client opens one continuous WebTransport/QUIC stream per unique active channel and mirrors duplicate views of the same channel from the shared decoded frame stream.

## Current Channels

| Channel | Stream | RTSP path | Resolution | Default |
|---|---|---|---:|---|
| `channel-4k-crowd` | `camera-4k-crowd` | `/live/cctv-road-crowd-4k60` | 3840x2160 at 60 fps | enabled |
| `channel-13535786` | `camera-13535786` | `/live/download-13535786-4k60` | 3840x2160 at 60 fps | enabled |
| `channel-15116604` | `camera-15116604` | `/live/download-15116604-4k30` | 3840x2160 at 30 fps | enabled |
| `channel-15139494` | `camera-15139494` | `/live/download-15139494-4k60` | 3840x2160 at 60 fps | enabled |
| `channel-15300856` | `camera-15300856` | `/live/download-15300856-4k60` | 3840x2160 at 59.94 fps | enabled |
| `channel-15956743` | `camera-15956743` | `/live/download-15956743-4k60` | 3840x2160 at 59.94 fps | enabled |
| `channel-16147856` | `camera-16147856` | `/live/download-16147856-4k24` | 3840x2160 at 23.98 fps | enabled |

In go2rtc mode, `WEBVIDEO_SAMPLE_FOOTAGE=1` is enabled by default so the launcher can serve cached MP4 clips directly as RTSP sources. The default sample-footage path now expects explicit MP4 files under `.tools/rtsp/footage/` and `.tools/rtsp/footage/downloads/`; it does not repeatedly download or normalize clips on every run. In mediaMTX mode, sample footage remains optional; when it is disabled, the fallback publishers use generated `testsrc2` video.

`start.sh` is the product-like manual path: it publishes one primary RTSP source per channel by default. Lower-resolution/lower-rate source variants are disabled there unless `WEBVIDEO_RTSP_SOURCE_VARIANTS=1` is set. The Playwright/profiling harness uses `test-start.sh`, which enables sample footage but keeps 4K publishers and source variants disabled unless the selected test profile opts in.

## Primary Local Path

```bash
./start.sh
```

The launcher downloads missing `go2rtc`, `ffmpeg`, and QUIC runtime dependencies into `.tools/`, starts the primary local RTSP-over-TCP sources, starts the backend demo host, starts the frontend, and prints the VMS, live demo, and tile wall URLs.

Useful pages:

- `http://127.0.0.1:4173/vms.html`
- `http://127.0.0.1:4173/live-demo.html?channel=channel-4k-crowd`
- `http://127.0.0.1:4173/tile-wall.html?channels=channel-4k-crowd,channel-13535786,channel-15139494`
- `http://127.0.0.1:4173/tile-wall.html?channels=channel-4k-crowd,channel-13535786,channel-15139494,channel-15300856&frames=1` for a bounded 4K stress probe

Useful knobs:

- `START_RTSP=0 ./start.sh` skips local RTSP sources.
- `WEBVIDEO_RTSP_SERVER=go2rtc ./start.sh` uses the default go2rtc source stack.
- `WEBVIDEO_RTSP_SERVER=mediamtx ./start.sh` uses the previous mediaMTX plus ffmpeg-publisher stack.
- `START_4K_RTSP=0 ./start.sh` disables the 4K source group in legacy mediaMTX-style paths; the default go2rtc catalog is all 4K clips.
- `START_4K_STRESS_RTSP=0 ./start.sh` is retained for older profiles; the default go2rtc catalog still exposes the retained/downloaded 4K clips.
- `WEBVIDEO_RTSP_SOURCE_VARIANTS=1 ./start.sh` publishes the optional lower-resolution/lower-rate source variants and allows the backend catalog to select them.
- `./test-start.sh` is the automated test/profiling launcher; it defaults `WEBVIDEO_SAMPLE_FOOTAGE=1`, `START_4K_RTSP=0`, `START_4K_STRESS_RTSP=0`, and `WEBVIDEO_RTSP_SOURCE_VARIANTS=0` so ordinary Playwright runs do not spend time preparing 4K stress sources.
- `WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh` verifies the retained road-crowd MP4 plus downloaded clip MP4s are present and loops those files through RTSP.
- `WEBVIDEO_SAMPLE_FOOTAGE_DIR=/path/to/cache WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh` moves the cache.
- `WEBVIDEO_RTSP_COPY_INPUTS=1 ./start.sh` forces local file inputs to publish with `-c:v copy`; use this only when the file already matches the channel's codec, dimensions, and frame-rate expectations.
- `WEBVIDEO_RTSP_COPY_INPUTS=0 ./start.sh` forces publisher-side transcoding/scaling for local file inputs.
- `SETUP_SAMPLE_FOOTAGE_ONLY=1 ./start.sh` downloads or verifies the sample footage cache and exits.
- `SETUP_RTSP_TOOLS_ONLY=1 ./start.sh` downloads or verifies only the RTSP binaries.
- `SETUP_RTSP_TOOLS=0 ./start.sh` requires the selected RTSP server and `ffmpeg` to already be on `PATH` or provided through `GO2RTC_BIN`, `MEDIAMTX_BIN`, and `FFMPEG_BIN`.
- `GO2RTC_BIN=/path/to/go2rtc FFMPEG_BIN=/path/to/ffmpeg ./start.sh` uses explicit go2rtc-mode binaries.
- `MEDIAMTX_BIN=/path/to/mediamtx FFMPEG_BIN=/path/to/ffmpeg WEBVIDEO_RTSP_SERVER=mediamtx ./start.sh` uses explicit mediaMTX-mode binaries.

## Source Stack Benchmark

Use the source-only benchmark when changing local RTSP plumbing:

```bash
WEBVIDEO_RTSP_BENCH_SERVER=go2rtc scripts/benchmark-rtsp-source.sh
WEBVIDEO_RTSP_BENCH_SERVER=mediamtx scripts/benchmark-rtsp-source.sh
```

The benchmark starts only the local RTSP source stack on alternate ports, pulls the selected RTSP streams with copy-mode ffmpeg clients, and reports CPU/RAM for the source stack process tree only. The consumer clients are excluded from the CPU/RAM totals.

Recent local A/B results:

| Scenario | Server | CPU, one-core % | Max RSS |
|---|---|---:|---:|
| one 1080p stream | go2rtc | 4.6% | 40 MB |
| one 1080p stream | mediaMTX + publishers | 23.8% | 102 MB |
| three 1080p streams | go2rtc | 4.8% | 40 MB |
| three 1080p streams | mediaMTX + publishers | 30.8% | 102 MB |
| 3x1080p + 4K + 4K60 | go2rtc | 26.4% | 78 MB |
| 3x1080p + 4K + 4K60 | mediaMTX + publishers | 83.8% | 181 MB |

Local file inputs:

```bash
WEBVIDEO_CCTV_4K_CROWD_INPUT=/path/to/road-crowd.mp4 \
WEBVIDEO_DOWNLOAD_13535786_INPUT=/path/to/clip-13535786.mp4 \
WEBVIDEO_DOWNLOAD_15116604_INPUT=/path/to/clip-15116604.mp4 \
WEBVIDEO_DOWNLOAD_15139494_INPUT=/path/to/clip-15139494.mp4 \
WEBVIDEO_DOWNLOAD_15300856_INPUT=/path/to/clip-15300856.mp4 \
WEBVIDEO_DOWNLOAD_15956743_INPUT=/path/to/clip-15956743.mp4 \
WEBVIDEO_DOWNLOAD_16147856_INPUT=/path/to/clip-16147856.mp4 \
./start.sh
```

`start.sh` loops file inputs indefinitely. Prepared sample footage is stream-copied by default to keep source CPU low. Custom local file inputs are scaled/padded/transcoded by default unless `WEBVIDEO_RTSP_COPY_INPUTS=1` is set.

## Live Diagnostics

The backend exposes continuous fanout diagnostics at:

```text
http://127.0.0.1:8080/api/demo/live/metrics
```

The React VMS page polls the same data at a low rate and shows per-tile backend queue depth and stale-frame drops. Use these with the browser metrics to split latency:

- source-to-render: backend ingest timestamp to rendered frame
- server-to-render: backend WebTransport write timestamp to rendered frame
- receive-to-render: browser receive timestamp to rendered frame
- backend pending frames and drops: whether the server subscriber queue is falling behind

## Channel Overrides

The demo channel catalog can point predefined channels at external RTSP sources. The channel ID is uppercased and hyphens become underscores.

Examples:

```bash
WEBVIDEO_CHANNEL_001_RTSP_URL=rtsp://camera.example.local/live/main \
WEBVIDEO_CHANNEL_001_WIDTH=1920 \
WEBVIDEO_CHANNEL_001_HEIGHT=1080 \
WEBVIDEO_CHANNEL_001_FRAMERATE=30 \
./start.sh
```

```bash
WEBVIDEO_CHANNEL_4K_RTSP_URL=rtsp://camera.example.local/live/4k \
WEBVIDEO_CHANNEL_4K_WIDTH=3840 \
WEBVIDEO_CHANNEL_4K_HEIGHT=2160 \
WEBVIDEO_CHANNEL_4K_FRAMERATE=15 \
./start.sh
```

```bash
WEBVIDEO_CHANNEL_4K_CROWD_RTSP_URL=rtsp://camera.example.local/live/road-crowd \
WEBVIDEO_CHANNEL_4K_CROWD_WIDTH=3840 \
WEBVIDEO_CHANNEL_4K_CROWD_HEIGHT=2160 \
WEBVIDEO_CHANNEL_4K_CROWD_FRAMERATE=60 \
./start.sh
```

Supported override suffixes:

- `_RTSP_URL`
- `_DISPLAY_NAME`
- `_WIDTH`
- `_HEIGHT`
- `_FRAMERATE`
- `_PROFILE`
- `_SUMMARY`

This is still a predefined-channel model. A fully dynamic arbitrary-camera registry is future work.

## WebGPU Validation

For manual hardware WebGPU validation on Linux, open the printed URL with `chrome-webgpu`. That launcher uses a separate Chrome profile and defaults to the safer Vulkan preset:

```text
--enable-unsafe-webgpu
--ignore-gpu-blocklist
--enable-features=Vulkan,VulkanFromANGLE
```

If that preset does not expose a hardware adapter, retry the older aggressive path with `CHROME_WEBGPU_PRESET=strict-vulkan chrome-webgpu ...`. Do not keep `strict-vulkan` as the default if the Chrome window shows compositor or graphics artifacts.

The matching Playwright mode is:

```bash
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=hardware-gpu scripts/test-all.sh
```

Manual VMS validation:

```bash
START_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh
chrome-webgpu http://127.0.0.1:4173/vms.html
```

To test the experimental Chrome video-decode flags alongside the known-good WebGPU Vulkan path:

```bash
CHROME_WEBGPU_PRESET=video-strict-vulkan chrome-webgpu http://127.0.0.1:4173/vms.html
```

Add `channel-4k-crowd`, `channel-13535786`, and `channel-15116604` from the VMS page. For heavier stress, add more downloaded clips such as `channel-15300856` or duplicate `channel-4k-crowd`. You can add the same channel more than once; duplicate views share one WebTransport/WebCodecs decode session for that channel and render into separate tile viewports. For the hardware path, each active tile should report a non-software adapter and a WebGPU canvas path. The default fast path reports `external-texture / worker-offscreen-webgpu-canvas`: a worker owns WebTransport receive, MoQ parsing, WebCodecs decode, and an OffscreenCanvas WebGPU renderer for the tile. Use `?offscreen=0` only for main-thread comparison. Watch source FPS, render FPS, source-to-render p95, frame p95, server drops, client drops, sequence gaps, and hitches. Use the collapsed tile strip for live scanning; expand "stats" only when you need full diagnostics.

If normal Chrome reports `canvas2d-fallback` with a disabled software adapter, that is expected protection against the slow SwiftShader WebGPU path. Use `chrome-webgpu` for hardware WebGPU validation on the local Linux setup.

The default VMS decode path is the media-worker pipeline. It keeps WebTransport receive, MoQ object parsing, access-unit assembly, WebCodecs decode, and WebGPU OffscreenCanvas tile rendering away from the main React thread. The older worker-decoder-only comparison path can still be opened manually with:

```text
http://127.0.0.1:4173/vms.html?decodeWorker=1
```

This path is useful for structural comparison, but the product-like default is the media-worker/offscreen renderer.

For manual recoverability checks, the VMS page accepts chaos query parameters that are forwarded to the backend WebTransport stream:

```text
http://127.0.0.1:4173/vms.html?chaosDisconnectAfterFrames=12
http://127.0.0.1:4173/vms.html?chaosFrameDelayMs=6&chaosDropEveryNFrames=37
```

The first path forces repeated server-side stream ends and should reconnect without losing the last retained frame. The second injects mild egress delay and dropped encoded frames; the tile should record sequence gaps or client drops, recover at the next usable key frame, and continue rendering.

## Tests

Default automated coverage:

```bash
scripts/test-backend.sh
scripts/test-frontend-unit.sh
scripts/test-frontend-e2e.sh
scripts/test-all.sh
```

The default Playwright run starts local RTSP sources through `test-start.sh`, verifies WebTransport byte receipt, decodes with WebCodecs, renders visible frames, and avoids slow SwiftShader/software WebGPU adapters. Hardware profiles require WebGPU canvas presentation and accept either the direct `external-texture` path or the forced copy fallback path. The suite checks:

- the contract harness
- the live demo
- a three-channel tile wall with independent channel sessions
- the React VMS client, including channel selection, three simultaneous long-lived WebTransport streams, duplicate-view session sharing, MoQ-shaped object diagnostics, latency budgets, close/reopen, continued playback, source renegotiation/recovery, WebTransport disconnect recovery, delayed/dropped-frame chaos recovery, and per-tile metrics

The VMS soak profiles are opt-in because they keep the browser open longer than the default e2e pass:

```bash
WEBVIDEO_E2E_LONG=1 scripts/test-frontend-e2e.sh tests/e2e/vms-long-run.spec.ts
WEBVIDEO_TEST_PROFILE=long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-duplicate-4k60-profile scripts/test-all.sh
```

For targeted 4K60 profiling, `scripts/profile-vms.sh` accepts these useful knobs:

```bash
WEBVIDEO_CHROME_WEBGPU_PRESET=video-strict-vulkan ./scripts/profile-vms.sh
WEBVIDEO_VMS_MATRIX_RETAIN=swapchain ./scripts/profile-vms.sh
WEBVIDEO_VMS_MATRIX_RETAIN=backing ./scripts/profile-vms.sh
WEBVIDEO_VMS_PREDECODE_ADMISSION=1 ./scripts/profile-vms.sh
```

`matrixRetain=auto` is the default: one-slot/full-redraw matrix passes render directly to the swapchain, while partial multi-tile updates use the retained backing texture. `WEBVIDEO_VMS_PREDECODE_ADMISSION=1` is diagnostic-only and drops only AVC non-reference frames before decode when render/import service time is over budget.

That test samples three simultaneous VMS tiles across the 30-second sample-footage loop boundary, asserts continued frame/message progress, render FPS, source-to-render and receive-to-render budgets, fresh backend fanout metrics, bounded subscriber queues, and hardware WebGPU fast-path diagnostics when `WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1`.

The worker decoder browser path is intentionally opt-in while it is being hardened:

```bash
WEBVIDEO_E2E_WORKER_DECODE=1 \
WEBVIDEO_PLAYWRIGHT_START_SERVER=0 \
scripts/test-frontend-e2e.sh frontend/tests/e2e/vms-client.spec.ts
```

For non-gating profiling, use the VMS profile script. It starts the `test-start.sh` stack, opens the configured stream sets, verifies selected RTSP source names when `WEBVIDEO_PROFILE_EXPECT_RTSP_SOURCES` is set, samples browser and backend counters every second, prints both full-run and warm-up-discarded steady-state summaries, and writes full JSON timelines under `.run/profiles/`.

```bash
scripts/profile-vms.sh

WEBVIDEO_PROFILE_STREAM_SETS=channel-4k-crowd,channel-15116604,channel-16147856 \
WEBVIDEO_PROFILE_DURATION_MS=60000 \
scripts/profile-vms.sh

WEBVIDEO_VMS_MATRIX_TEXTURE=copy \
WEBVIDEO_PROFILE_STREAM_SETS=channel-4k-crowd,channel-4k-crowd,channel-15116604 \
scripts/profile-vms.sh
```

The profile captures backend process CPU/memory, RTSP fanout counters, WebTransport egress dequeue/write timings, Chrome main-thread performance metrics, long-task counts, WebTransport receive cadence, WebCodecs decode p95, WebGPU render p95, RAF cadence, queue depth, drops, and source-to-render / receive-to-render latency.

For targeted mixed-resolution diagnosis without running the whole central suite:

```bash
WEBVIDEO_E2E_LONG=1 \
WEBVIDEO_E2E_LONG_CHANNELS=channel-4k-crowd,channel-15116604,channel-16147856 \
WEBVIDEO_E2E_LONG_DURATION_MS=180000 \
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1 \
scripts/test-frontend-e2e.sh tests/e2e/vms-long-run.spec.ts
```

The VMS tile metrics distinguish backend subscriber drops, client-side dependency drops, skipped sequence frames, frame hitches, severe hitches, and frame interval p95. Use those counters when a stream looks visually choppy even if the older backend-only `Drops` value is flat.

To run Playwright against a `start.sh` stack that is already running:

```bash
WEBVIDEO_PLAYWRIGHT_START_SERVER=0 \
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1 \
scripts/test-frontend-e2e.sh tests/e2e/vms-client.spec.ts
```

The 4K smoke is opt-in because it is heavier:

```bash
WEBVIDEO_E2E_4K=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-4k scripts/test-all.sh
```

That test verifies a 4K browser session receives RTSP-backed WebTransport data, decodes through WebCodecs, renders through WebGPU, uses a 3840x2160 canvas, and can render as a tile beside another browser-initiated channel.

The 4K60 crowd stress smoke is separately opt-in:

```bash
WEBVIDEO_E2E_4K=1 WEBVIDEO_E2E_4K_STRESS=1 \
scripts/test-frontend-e2e.sh tests/e2e/high-resolution-4k.spec.ts
```

That stress smoke verifies `channel-4k-crowd` declares 3840x2160 at 60 fps, receives RTSP-backed WebTransport data, decodes through WebCodecs, and renders a frame in the browser.

For a fast non-browser pass, use:

```bash
SKIP_E2E=1 scripts/test-all.sh
```

## Current Limit

The live demo and tile wall pages still serve bounded sessions where the browser can pass `?frames=N`. The VMS page uses continuous WebTransport streams with a compact MoQ-shaped object envelope, bounded backend subscriber queues, frontend keyframe recovery, duplicate-view decode sharing, and low-rate queue/drop diagnostics. The channel catalog is still predefined; arbitrary RTSP URL entry, production auth, and full MOQT/MSF interoperability remain future work.

## Lower-Level Synthetic Plans

The backend test kit still contains older raw RTSP launch plans:

- [backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs](/home/mj/myapps/webvideo/backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs:1)
- [backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs](/home/mj/myapps/webvideo/backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs:1)

Those are retained for specification coverage. The browser e2e path now uses the `start.sh` channel publishers described above.
