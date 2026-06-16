# WebVideo

This repository currently contains a contract-first low-latency browser video system prototype.

Included today:

- architecture and topology documents in [docs](./docs/README.md)
- `.NET 10` backend contracts and xUnit specification suites in [backend](./backend/README.md)
- TypeScript frontend contracts plus Vitest and Playwright suites in [frontend](./frontend/README.md)
- a runnable demo host plus browser pages for visible local playback, a multi-channel tile wall, and a React VMS client

Current intent:

- keep service, player, and test harness behavior explicit while the real media path is brought online
- preserve deterministic in-memory coordinators for contract coverage and fallback testing
- make the expected flows, browser transport, WebCodecs decode, WebGPU render, RTSP setup, and high-resolution smoke paths explicit and testable

Current status:

- backend coordinators are implemented as deterministic in-memory services
- backend demo host creates browser sink sessions from client-provided channel IDs, serves bounded demo payloads, and fans out continuous RTSP H.264 access units over WebTransport/QUIC for VMS tiles
- frontend player services read WebTransport, decode H.264 access units with WebCodecs, render through hardware WebGPU when available, and intentionally fall back to Canvas2D instead of slow SwiftShader/software WebGPU
- Playwright validates the contract harness, live demo, tile wall, VMS continuous stream, opt-in 60 second VMS soak, and opt-in 4K smoke against the local RTSP/WebTransport/WebCodecs/render path
- the live demo page asks the backend for a browser stream by client-provided channel id, receives the selected stream sink, and renders visible playback
- the tile wall page opens multiple independent browser-initiated channel sessions on one page, one WebTransport sink per tile
- the VMS client fetches the backend channel catalog, lets the user add/remove camera tiles, shares one long-lived WebTransport/WebCodecs decode session per unique camera channel on the page, mirrors duplicate views into separate WebGPU tile viewports, can request lower-rate source variants when the launcher/test profile enables them, and shows compact per-tile latency/throughput metrics with expandable diagnostics
- when launched through `start.sh`, the backend captures H.264 Annex B access units from local RTSP sources before serving browser session responses
- channel URLs and declared resolution/framerate can be overridden with `WEBVIDEO_CHANNEL_<id>_*` environment variables; this is not yet a dynamic arbitrary-camera registry
- arbitrary camera registration is still predefined-channel based; arbitrary RTSP URL entry and production authentication are future work

Local test helpers:

- `scripts/test-backend.sh`
- `scripts/test-frontend-unit.sh`
- `scripts/test-frontend-e2e.sh`
- `scripts/test-all.sh` runs backend, frontend unit, TypeScript, and Playwright checks; use `SKIP_E2E=1 scripts/test-all.sh` for a faster non-browser pass
- `WEBVIDEO_TEST_PROFILE=hardware-gpu scripts/test-all.sh` runs the central suite with headed system Chrome, Vulkan WebGPU flags, and hardware WebGPU assertions
- `WEBVIDEO_TEST_PROFILE=long scripts/test-all.sh` adds the 60 second three-tile VMS soak; set `WEBVIDEO_E2E_LONG_DURATION_MS` for local shorter/longer runs
- `WEBVIDEO_TEST_PROFILE=hardware-long scripts/test-all.sh` runs the 60 second VMS soak with headed hardware WebGPU assertions
- `WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh` runs the mixed 4K/1080p hardware WebGPU stress diagnostic for 180 seconds
- `WEBVIDEO_TEST_PROFILE=hardware-duplicate-4k60-profile scripts/test-all.sh` runs the duplicate 4K60 VMS profile (`channel-4k-crowd`, duplicate view, plus `channel-15116604`) with real sample footage and hardware WebGPU assertions
- `WEBVIDEO_TEST_PROFILE=hardware-media-worker-profile scripts/test-all.sh` runs the opt-in media-worker comparison path (`?mediaWorker=1`) where WebTransport receive, MoQ parsing, access-unit assembly, and WebCodecs decode happen in a worker before `VideoFrame`s return to the shared WebGPU matrix renderer
- `WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh` adds the opt-in 4K browser smoke
- `WEBVIDEO_TEST_PROFILE=hardware-4k scripts/test-all.sh` combines hardware WebGPU assertions with the 4K smoke
- `WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh` for headed system Chrome with the safer Linux WebGPU preset; set `WEBVIDEO_CHROME_WEBGPU_PRESET=strict-vulkan` only when you need to retry the older aggressive Vulkan/ANGLE path
- `WEBVIDEO_E2E_4K=1 scripts/test-frontend-e2e.sh` for the opt-in 4K browser smoke
- `WEBVIDEO_E2E_4K=1 WEBVIDEO_E2E_4K_STRESS=1 scripts/test-frontend-e2e.sh frontend/tests/e2e/high-resolution-4k.spec.ts` adds the 4K60 crowd stress channel smoke
- `scripts/benchmark-rtsp-source.sh` compares local RTSP source CPU/RAM for `WEBVIDEO_RTSP_BENCH_SERVER=go2rtc` versus `mediamtx`

Local demo launcher:

- `./start.sh`
- opens the VMS client at `http://127.0.0.1:4173/vms.html`
- opens the browser demo at `http://127.0.0.1:4173/live-demo.html?channel=channel-4k-crowd`
- also prints tile wall URLs using `channel-4k-crowd` plus downloaded clip channels such as `channel-13535786` and `channel-15139494`
- downloads missing `go2rtc` and `ffmpeg` binaries into `.tools/rtsp/`, serves cached MP4 sample clips as local RTSP-over-TCP streams for one retained 4K60 road-crowd channel plus downloaded 4K clips, enables backend RTSP capture/fanout, and cleans everything up on exit; use `START_RTSP=0 ./start.sh` to skip RTSP entirely
- `WEBVIDEO_RTSP_SERVER=mediamtx ./start.sh` restores the previous mediaMTX plus ffmpeg-publisher source stack for A/B testing
- 4K publishing is enabled by default; use `START_4K_RTSP=0 ./start.sh` to disable both 4K publishers, or `START_4K_STRESS_RTSP=0 ./start.sh` to disable only the extra 4K60 stress publisher
- `start.sh` is the product-like manual path and publishes only the primary source for each channel by default; use `WEBVIDEO_RTSP_SOURCE_VARIANTS=1 ./start.sh` to also publish the lower-resolution/lower-rate source variants
- `./test-start.sh` starts a lighter Playwright stack with sample footage enabled and 4K/source variants disabled unless the test profile opts in with `START_4K_RTSP=1`, `START_4K_STRESS_RTSP=1`, or `WEBVIDEO_RTSP_SOURCE_VARIANTS=1`
- go2rtc mode enables `WEBVIDEO_SAMPLE_FOOTAGE=1` by default so MP4 clips can be served with H.264 stream copy; mediaMTX mode still supports generated test patterns when sample footage is disabled
- real local files can be supplied directly with `WEBVIDEO_CCTV_4K_CROWD_INPUT` and the downloaded clip overrides `WEBVIDEO_DOWNLOAD_13535786_INPUT`, `WEBVIDEO_DOWNLOAD_15116604_INPUT`, `WEBVIDEO_DOWNLOAD_15139494_INPUT`, `WEBVIDEO_DOWNLOAD_15300856_INPUT`, `WEBVIDEO_DOWNLOAD_15956743_INPUT`, and `WEBVIDEO_DOWNLOAD_16147856_INPUT`
- live fanout diagnostics are available at `http://127.0.0.1:8080/api/demo/live/metrics`, and the VMS page shows backend queue/drop counters per tile
- the VMS page also shows source FPS, render FPS, client drops, skipped sequence frames, frame hitches, and frame-interval p95 so visible stutter is not hidden behind transport-only counters
- for manual hardware WebGPU validation, open the demo with `chrome-webgpu`; that launcher uses a separate Chrome profile and defaults to the safer `Vulkan,VulkanFromANGLE` preset. Use `CHROME_WEBGPU_PRESET=strict-vulkan chrome-webgpu ...` only if the safe preset does not expose hardware WebGPU.
