# Local RTSP Runbook

The primary local path uses `start.sh` to run:

- `mediamtx` as the local RTSP server
- one `ffmpeg` publisher per configured channel
- the `.NET` demo host with RTSP capture enabled
- the frontend dev server

The browser pages request streams by channel ID. The backend resolves that channel to a selected RTSP source. The live demo and tile wall pages use bounded browser sessions, while the React VMS client opens one continuous WebTransport/QUIC stream per active tile.

## Current Channels

| Channel | Stream | RTSP path | Resolution | Default |
|---|---|---|---:|---|
| `channel-001` | `camera-001` | `/live/cctv-lobby-720p` | 1280x720 at 30 fps | enabled |
| `channel-002` | `camera-002` | `/live/cctv-entrance-720p` | 1280x720 at 30 fps | enabled |
| `channel-003` | `camera-003` | `/live/cctv-floor-1080p` | 1920x1080 at 30 fps | enabled |
| `channel-4k` | `camera-4k` | `/live/cctv-parking-4k` | 3840x2160 at 15 fps | opt-in |

The default publishers use generated `testsrc2` video with a CCTV label and timestamp overlay. For manual realistic footage, set `WEBVIDEO_SAMPLE_FOOTAGE=1` or provide local input files. The sample-footage path downloads source recordings, normalizes them into cached 30-second H.264 baseline clips, and then loops those clips through RTSP over TCP with H.264 stream copy.

## Primary Local Path

```bash
./start.sh
```

The launcher downloads missing `mediamtx`, `ffmpeg`, and QUIC runtime dependencies into `.tools/`, starts the local RTSP-over-TCP publishers, starts the backend demo host, starts the frontend, and prints the VMS, live demo, and tile wall URLs.

Useful pages:

- `http://127.0.0.1:4173/vms.html`
- `http://127.0.0.1:4173/live-demo.html?channel=channel-001`
- `http://127.0.0.1:4173/tile-wall.html?channels=channel-001,channel-002,channel-003`
- `http://127.0.0.1:4173/tile-wall.html?channels=channel-001,channel-002,channel-003,channel-4k&frames=1` when `START_4K_RTSP=1`

Useful knobs:

- `START_RTSP=0 ./start.sh` skips local RTSP sources.
- `START_4K_RTSP=1 ./start.sh` adds the 4K publisher and `channel-4k`.
- `WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh` downloads surveillance sample recordings from [C-MOR](https://www.c-mor.com/video-surveillance-demo/sample-recordings-of-the-video-surveillance-system-c-mor) into `.tools/rtsp/footage/`, normalizes them to 30-second H.264 clips, and loops them through RTSP.
- `START_4K_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh` also downloads a 1080p sample source and normalizes it once into a 3840x2160 15 fps H.264 clip before RTSP publishing.
- `WEBVIDEO_RTSP_COPY_INPUTS=1 ./start.sh` forces local file inputs to publish with `-c:v copy`; use this only when the file already matches the channel's codec, dimensions, and frame-rate expectations.
- `WEBVIDEO_RTSP_COPY_INPUTS=0 ./start.sh` forces publisher-side transcoding/scaling for local file inputs.
- `SETUP_SAMPLE_FOOTAGE_ONLY=1 ./start.sh` downloads or verifies the sample footage cache and exits.
- `SETUP_RTSP_TOOLS_ONLY=1 ./start.sh` downloads or verifies only the RTSP binaries.
- `SETUP_RTSP_TOOLS=0 ./start.sh` requires `mediamtx` and `ffmpeg` to already be on `PATH` or provided through `MEDIAMTX_BIN` and `FFMPEG_BIN`.
- `MEDIAMTX_BIN=/path/to/mediamtx FFMPEG_BIN=/path/to/ffmpeg ./start.sh` uses explicit binaries.

Local file inputs:

```bash
WEBVIDEO_CCTV_LOBBY_INPUT=/path/to/lobby.mp4 \
WEBVIDEO_CCTV_ENTRANCE_INPUT=/path/to/entrance.mp4 \
WEBVIDEO_CCTV_FLOOR_INPUT=/path/to/floor.mp4 \
START_4K_RTSP=1 WEBVIDEO_CCTV_4K_INPUT=/path/to/parking.mp4 \
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
START_4K_RTSP=1 ./start.sh
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

For manual hardware WebGPU validation on Linux, open the printed URL with `chrome-webgpu`. That launcher uses a separate Chrome profile and enables:

```text
--enable-unsafe-webgpu
--ignore-gpu-blocklist
--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan
```

The matching Playwright mode is:

```bash
WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=hardware-gpu scripts/test-all.sh
```

Manual VMS validation:

```bash
START_RTSP=1 START_4K_RTSP=1 WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh
chrome-webgpu http://127.0.0.1:4173/vms.html
```

Add `channel-4k`, `channel-003`, and `channel-001` from the VMS page. For the hardware path, each active tile should report a non-software adapter and a render path such as `external-texture` / `webgpu-canvas`. Watch source FPS, render FPS, source-to-render p95, frame p95, server drops, client drops, sequence gaps, and hitches.

If normal Chrome reports `canvas2d-fallback` with a disabled software adapter, that is expected protection against the slow SwiftShader WebGPU path. Use `chrome-webgpu` for hardware WebGPU validation on the local Linux setup.

## Tests

Default automated coverage:

```bash
scripts/test-backend.sh
scripts/test-frontend-unit.sh
scripts/test-frontend-e2e.sh
scripts/test-all.sh
```

The default Playwright run starts local RTSP sources through `start.sh`, verifies WebTransport byte receipt, decodes with WebCodecs, renders visible frames, and avoids slow SwiftShader/software WebGPU adapters. Hardware profiles additionally require the WebGPU `external-texture` / `webgpu-canvas` path. The suite checks:

- the contract harness
- the live demo
- a three-channel tile wall with independent channel sessions
- the React VMS client, including channel selection, three simultaneous long-lived WebTransport streams, MoQ-shaped object diagnostics, latency budgets, close/reopen, continued playback, and per-tile metrics

The VMS soak profiles are opt-in because they keep the browser open longer than the default e2e pass:

```bash
WEBVIDEO_E2E_LONG=1 scripts/test-frontend-e2e.sh tests/e2e/vms-long-run.spec.ts
WEBVIDEO_TEST_PROFILE=long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh
```

That test samples three simultaneous VMS tiles across the 30-second sample-footage loop boundary, asserts continued frame/message progress, render FPS, source-to-render and receive-to-render budgets, fresh backend fanout metrics, bounded subscriber queues, and hardware WebGPU fast-path diagnostics when `WEBVIDEO_REQUIRE_HARDWARE_WEBGPU=1`.

For targeted mixed-resolution diagnosis without running the whole central suite:

```bash
START_4K_RTSP=1 WEBVIDEO_E2E_LONG=1 \
WEBVIDEO_E2E_LONG_CHANNELS=channel-4k,channel-003,channel-001 \
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
WEBVIDEO_E2E_4K=1 START_4K_RTSP=1 scripts/test-frontend-e2e.sh
WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh
WEBVIDEO_TEST_PROFILE=hardware-4k scripts/test-all.sh
```

That test verifies a `channel-4k` browser session receives RTSP-backed WebTransport data, decodes through WebCodecs, renders through WebGPU, uses a 3840x2160 canvas, and can render as a tile beside another browser-initiated channel.

For a fast non-browser pass, use:

```bash
SKIP_E2E=1 scripts/test-all.sh
```

## Current Limit

The live demo and tile wall pages still serve bounded sessions where the browser can pass `?frames=N`. The VMS page uses continuous WebTransport streams with a compact MoQ-shaped object envelope, bounded backend subscriber queues, frontend keyframe recovery, and low-rate queue/drop diagnostics. The channel catalog is still predefined; arbitrary RTSP URL entry, production auth, and full MOQT/MSF interoperability remain future work.

## Lower-Level Synthetic Plans

The backend test kit still contains older raw RTSP launch plans:

- [backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs](/home/mj/myapps/webvideo/backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs:1)
- [backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs](/home/mj/myapps/webvideo/backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs:1)

Those are retained for specification coverage. The browser e2e path now uses the `start.sh` channel publishers described above.
