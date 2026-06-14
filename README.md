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
- the VMS client fetches the backend channel catalog, lets the user add/remove camera tiles, opens one long-lived WebTransport stream per tile, and shows per-tile latency/throughput metrics
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
- `WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long scripts/test-all.sh` runs the mixed 4K/1080p/720p hardware WebGPU stress diagnostic for 180 seconds
- `WEBVIDEO_TEST_PROFILE=4k scripts/test-all.sh` adds the opt-in 4K browser smoke
- `WEBVIDEO_TEST_PROFILE=hardware-4k scripts/test-all.sh` combines hardware WebGPU assertions with the 4K smoke
- `WEBVIDEO_PLAYWRIGHT_CHROME_WEBGPU=1 scripts/test-frontend-e2e.sh` for headed system Chrome with Linux Vulkan WebGPU flags
- `WEBVIDEO_E2E_4K=1 START_4K_RTSP=1 scripts/test-frontend-e2e.sh` for the opt-in 4K browser smoke

Local demo launcher:

- `./start.sh`
- opens the VMS client at `http://127.0.0.1:4173/vms.html`
- opens the browser demo at `http://127.0.0.1:4173/live-demo.html?channel=channel-001`
- also prints a tile wall URL at `http://127.0.0.1:4173/tile-wall.html?channels=channel-001,channel-002,channel-003`
- downloads missing `mediamtx` and `ffmpeg` binaries into `.tools/rtsp/`, starts local RTSP-over-TCP publishers for two 720p channels and one 1080p channel, enables backend RTSP capture/fanout, and cleans everything up on exit; use `START_RTSP=0 ./start.sh` to skip it
- use `START_4K_RTSP=1 ./start.sh` to add the 4K RTSP publisher and `channel-4k`
- use `WEBVIDEO_SAMPLE_FOOTAGE=1 ./start.sh` to download real surveillance sample recordings, normalize them into cached 30-second H.264 clips, and loop them with H.264 stream copy instead of generated test patterns
- real local files can be supplied directly with `WEBVIDEO_CCTV_LOBBY_INPUT`, `WEBVIDEO_CCTV_ENTRANCE_INPUT`, `WEBVIDEO_CCTV_FLOOR_INPUT`, and `WEBVIDEO_CCTV_4K_INPUT`
- live fanout diagnostics are available at `http://127.0.0.1:8080/api/demo/live/metrics`, and the VMS page shows backend queue/drop counters per tile
- the VMS page also shows source FPS, render FPS, client drops, skipped sequence frames, frame hitches, and frame-interval p95 so visible stutter is not hidden behind transport-only counters
- for manual hardware WebGPU validation, open the demo with `chrome-webgpu`; that launcher uses a separate Chrome profile and enables `Vulkan,VulkanFromANGLE,DefaultANGLEVulkan`
