# Current Renderer

Snapshot date: 2026-06-16

This is the current state of the WebVideo live renderer path, written for external technical review. It describes what we actually run today, what we measured, what decisions are already made, and where the hard bottleneck currently sits.

The short version: the system is a real RTSP/H.264 source -> C# fanout -> WebTransport/QUIC -> WebCodecs -> WebGPU renderer. Transport and WebCodecs decode are healthy in the latest 4K60 single-stream profile. The production blocker is the Chrome/Linux WebGPU import path from decoded `VideoFrame` to `GPUExternalTexture`; the p95 import cost is far above a 60 FPS or 120 FPS budget.

## Current Target

We are building a browser VMS client:

- Client chooses one or more camera channels.
- Browser initiates each stream and supplies the channel id.
- Backend validates the requested channel and selects the RTSP source.
- Backend forwards H.264 access units over WebTransport/QUIC.
- Browser decodes with WebCodecs and renders with WebGPU.
- Metadata/OSD is generated cheaply server-side and drawn inside the WebGPU render pass, not as CSS.
- Queues are bounded; the player prefers dropping stale frames over growing latency.

This path is intended to be low latency and robust under multiple camera tiles. The current sweet spot is useful for lower-rate 1080p/mixed VMS testing. Full-res 4K60 in the current Chrome/Linux WebGPU path is not production-grade yet.

## System Diagram

Plain-text end-to-end path:

```text
  RTSP camera / MP4 loop source
      |
      | H.264 over RTSP
      v
  local RTSP server
      |
      | RTSP pull
      v
  backend RTSP reader
      |
      | H.264 Annex-B access units
      v
  backend fanout
      |
      | bounded per-subscriber queue
      v
  WebTransport endpoint
      |
      | QUIC stream, binary media objects + metadata objects
      v
  browser media worker
      |
      | binary parse -> encoded chunks
      v
  WebCodecs VideoDecoder
      |
      | decoded VideoFrame
      v
  render timing / decoded frame queue
      |
      | latest due frame
      v
  WebGPU renderer
      |
      | importExternalTexture + OSD shader + draw
      v
  OffscreenCanvas / visible canvas
```

The path currently does not decode or re-encode video on the server. The server repackages parsed H.264 access units into the browser transport framing.

## WebTransport Wire Shape

Current continuous mode uses a client-opened WebTransport session with a small control request and a server-opened media stream:

```text
  browser
      |
      | WebTransport CONNECT /live/{channelId}
      v
  backend
      |
      | browser opens request stream and writes one JSON line:
      |   channelId
      |   streamMode: continuous / continuous-binary / continuous-moq
      |   targetLatencyMs
      |   enableMetadata
      |   desiredEgressFrameRate
      |   desiredMaxCodedWidth / desiredMaxCodedHeight
      |   optional chaos-test knobs
      v
  backend validates channel id
      |
      | backend opens unidirectional media stream
      v
  browser reads source/control/video/metadata/end frames
```

Continuous-binary/MoQ media stream shape today:

```text
  JSON source frame
      kind: source
      channelId / streamId / sourceRtspUrl / codec

  repeated video objects
      magic: "MOQL"
      version: 1
      kind: video
      flags: keyframe bit
      publisher priority
      track alias
      group id
      object id
      subgroup id
      sequence number
      presentation timestamp us
      decode timestamp us
      source timestamp unix ms
      server timestamp unix ms
      payload length
      stream id length
      codec config version length
      stream id bytes
      codec config version bytes
      H.264 access-unit payload bytes

  optional JSON metadata frames
      kind: metadata
      stream id
      batch start/end presentation timestamps
      overlay records in normalized video coordinates

  optional JSON end frame
      kind: end
      channelId / streamId / reason
```

This is intentionally closer to a MoQ object model than the old JSON/base64 path, but it is not a complete standards-compliant MoQ stack. The current stream is hybrid: video hot path is binary, while source/metadata/end control frames are line-delimited JSON. The browser parser accepts both in the same stream.

## Backend Modules

```text
  BrowserDemoStreamCatalog
      defines channels, stream ids, source urls, resolution, fps, caps

  BrowserDemoWebTransportEndpoint
      accepts browser WebTransport sessions
      reads browser open request
      validates route channel id against requested channel id
      selects the backend source for that channel
      emits continuous video objects and metadata objects
      records egress timing diagnostics

  ContinuousRtspStreamFanout
      owns one live RTSP reader per source
      keeps shared source reading independent from client count
      publishes frames to bounded subscriber channels
      drops stale queued frames instead of growing latency
      exposes source cadence, pending queue, drop, and subscriber metrics

  ContinuousRtspAccessUnitStreamParser
      parses H.264 Annex-B bytes into access units
      identifies keyframes and timestamps
      avoids server-side decode

  BrowserDemoContinuousEgressDiagnostics
      records media-object egress timing
      tracks dequeue age, write cost, payload size, gaps, and skips
```

Primary backend files:

- `backend/src/WebVideo.Backend.DemoHost/BrowserDemoWebTransportEndpoint.cs`
- `backend/src/WebVideo.Backend.DemoHost/ContinuousRtspStreamFanout.cs`
- `backend/src/WebVideo.Backend.DemoHost/ContinuousRtspAccessUnitStreamParser.cs`
- `backend/src/WebVideo.Backend.DemoHost/BrowserDemoContinuousEgressDiagnostics.cs`
- `backend/src/WebVideo.Backend.DemoHost/BrowserDemoStreamCatalog.cs`

Backend decisions already taken:

- The browser is the stream initiator.
- The browser provides the channel id.
- The backend validates that the route channel id and open-request channel id match.
- The backend chooses the source from the channel id and requested caps.
- The backend does not transcode in the hot path.
- The backend does not run analytics for current OSD; metadata is cheap synthetic state.
- Per-subscriber queues are bounded to avoid latency buildup.
- Stale frames can be dropped before transport write.
- Video objects carry presentation timestamps, decode timestamps, source timestamps, server timestamps, keyframe flags, and MoQ-shaped group/object identity.

## Frontend Modules

```text
  VmsApp
      React app shell
      owns tile lifecycle, duplicate tiles, close/reopen, and OSD toggles
      passes channel/tile state into the video-pipe layer

  VideoPipeViewport
      groups visible tiles by channel
      creates one player controller per channel group
      connects render targets to either per-tile offscreen or matrix renderers

  VideoPipePlayerController
      owns player lifecycle from app perspective
      starts/stops the worker media pipeline
      collects worker metrics and status for the UI

  workerMediaPipelineClient
      chooses worker vs main-thread pipeline from runtime options
      transfers OffscreenCanvas or matrix MessagePort where needed
      starts mediaPipelineWorker

  mediaPipelineWorker
      owns WebTransport receive loop
      parses binary frames
      assembles EncodedVideoChunk inputs
      owns WebCodecs VideoDecoder
      owns decoded frame queue and render pacing
      owns worker-side WebGPU render target when available

  contracts/services
      WebTransportIngestClient
      EncodedChunkAssembler
      VideoDecodeCoordinator
      main-thread WebGPU renderers and fallbacks

  offscreenMatrixViewportWorker
      owns shared matrix WebGPU device/canvas for the tile wall experiment
      tracks matrix import/draw/present timing

  renderTimingBuffer
      holds decoded frames and decides when a frame is due
      bounds backlog and favors latest useful frames
```

Primary frontend files:

- `frontend/src/vms/VmsApp.tsx`
- `frontend/src/video-pipe/VideoPipeViewport.tsx`
- `frontend/src/video-pipe/playerController.ts`
- `frontend/src/video-pipe/workerMediaPipelineClient.ts`
- `frontend/src/video-pipe/mediaPipelineWorker.ts`
- `frontend/src/video-pipe/renderTimingBuffer.ts`
- `frontend/src/video-pipe/offscreenMatrixRenderer.ts`
- `frontend/src/video-pipe/offscreenMatrixViewportWorker.ts`
- `frontend/src/contracts/services.ts`

Frontend decisions already taken:

- The hot path is worker-first.
- WebCodecs is configured with `hardwareAcceleration: "prefer-hardware"` and `optimizeForLatency: true`.
- AVC is passed as Annex-B where appropriate.
- Transport payloads are binary, not JSON/base64.
- The default texture upload path is `GPUExternalTexture` from decoded `VideoFrame`.
- OSD is drawn in WGSL/WebGPU, not HTML/CSS overlay.
- Frame queues are bounded.
- Stale decoded frames are dropped instead of waiting behind old frames.
- Adaptive render pressure exists, but the latest 4K60 bottleneck is not solved by lowering target FPS alone.

## Browser Worker Hot Path

```text
  mediaPipelineWorker
      |
      | 1. connect WebTransport
      v
  WebTransportIngestClient
      |
      | 2. read binary media objects
      v
  EncodedChunkAssembler
      |
      | 3. emit EncodedVideoChunk metadata
      v
  VideoDecodeCoordinator
      |
      | 4. VideoDecoder.decode()
      v
  VideoDecoder output callback
      |
      | 5. push VideoFrame to LiveDecodedFrameQueue
      v
  LiveRenderTimingController
      |
      | 6. choose latest due frame
      v
  OffscreenWebGpuVideoRenderer or MatrixPortRendererClient
      |
      | 7. importExternalTexture(VideoFrame)
      | 8. update uniforms and OSD state
      | 9. encode draw commands
      | 10. queue.submit()
      v
  canvas presentation
```

Important ownership rule:

```text
  Encoded bytes can be copied/transferred cheaply enough today.
  Decoded VideoFrame ownership is stricter.
  A VideoFrame transferred to one worker/port cannot safely be reused by another.
  This is why duplicate tiles currently need careful sharing decisions.
```

## Render Path Variants

Current renderer options:

```text
  per-tile offscreen worker path
      media worker owns OffscreenCanvas
      media worker decodes and renders directly
      best isolation from main thread
      latest 4K60 profile used this path

  offscreen matrix worker path
      one worker owns one shared WebGPU canvas for the tile wall
      can use direct swapchain drawing for one dirty slot
      can use retained backing texture for partial multi-tile redraw
      useful architecture for multi-tile batching
      still blocked by VideoFrame -> GPUExternalTexture import cost

  main-thread matrix fallback
      keeps compatibility for browsers/options that fail worker rendering
      not the target performance path

  bitmap/copy experiment
      createImageBitmap/copy-style path
      measured worse for 4K60
      not a viable default
```

Text diagram of current GPU-side work for one frame:

```text
  decoded VideoFrame
      |
      | Chrome/WebGPU importExternalTexture
      | current p95: 45.4 ms in latest NVIDIA 4K60 run
      v
  GPUExternalTexture
      |
      | one textured quad sample
      | OSD shader branches/text/box work
      v
  render pass
      |
      | encode + submit
      | current p95 encode/submit: roughly 0.4 ms + 0.2 ms
      v
  canvas
```

The shader/draw part is not currently the wall. The import step is.

## OSD And Metadata

Current metadata path:

```text
  BrowserDemoWebTransportEndpoint
      |
      | cheap metadata object:
      | source resolution
      | source/server timing
      | normalized random/debug box/text
      v
  WebTransport binary metadata message
      |
      v
  mediaPipelineWorker
      |
      | update overlay state
      v
  WebGPU render pass
      |
      | draw OSD in shader over video
      v
  canvas
```

Metadata decisions:

- Metadata is server-generated today.
- It is synthetic/cheap; there is no server-side detection or analytics compute.
- OSD toggle is per tile at the app layer.
- OSD rendering is in WebGPU so it sits on the video image, not in a DOM layer.
- OSD timing is measured for drift against video/source timing.
- The OSD uniform update p95 is about 0.2 ms in the latest 4K60 run, so OSD is not the current bottleneck.

## Latest 4K60 Profile

Profile file:

```text
.run/profiles/vms-profile-1streams-1781600813963.json
```

Scenario:

```text
  channel: channel-4k-crowd
  source: rtsp://127.0.0.1:8554/live/cctv-road-crowd-4k60
  source format: 3840x2160, H.264, 60 FPS
  browser GPU adapter: nvidia turing
  decode pipeline: media-worker
  presentation: worker-offscreen-webgpu-canvas
  upload source: external-texture
  duration: 12 seconds
  steady-state window: after 3 second warmup
```

Steady-state headline:

```text
  backend read fps:      60.08
  egress sent fps:       60.08
  browser received fps:  59.61
  browser rendered fps:  13.97
  client drops:          290
  backend drops:         0
  sequence gaps:         0
  protocol ends:         0
  decode backlog max:    8 frames
  render queue max:      0 frames
```

Interpretation:

```text
  The server is delivering the stream.
  QUIC/WebTransport receive rate is close to source rate.
  WebCodecs decode p95 is low.
  The browser cannot render imported decoded 4K frames fast enough.
```

## Latency And Cost Table

Numbers below are from the steady-state section of `.run/profiles/vms-profile-1streams-1781600813963.json` unless otherwise noted.

| Stage | Module | Work | Average | p95 / max | Notes |
| --- | --- | --- | ---: | ---: | --- |
| Source cadence at backend | `ContinuousRtspStreamFanout` | Incoming RTSP/H.264 frame interval | not measured as average latency | p95 27 ms, recent max 49 ms | Cadence/jitter, not added buffering. |
| Backend fanout queue | `ContinuousRtspStreamFanout` | Per-subscriber bounded queue | pending 0 frames | backend drops 0 | Not currently the 4K60 wall. |
| Egress queue age | `BrowserDemoWebTransportEndpoint` diagnostics | Time from fanout read to egress write | 0.13 ms | p95 1.0 ms, max 6 ms | Excellent; no latency buildup here. |
| QUIC stream write | WebTransport endpoint | Binary object write to QUIC stream | 0.93 ms | p95 3.26 ms, max 9.78 ms | Acceptable for current single-stream run. |
| Payload size | WebTransport endpoint | H.264 access unit/object size | 60.8 KB | p95 136.1 KB, max 443.6 KB | Bigger frames make burst handling important. |
| Browser receive cadence | `WebTransportIngestClient` | Inter-arrival interval in worker | not measured as average latency | p95 33 ms | Receive rate still tracks 60 FPS overall. |
| Decode | `VideoDecodeCoordinator` / WebCodecs | Encoded chunk -> decoded `VideoFrame` | not measured in profile | p95 1.3 ms | Hardware decode appears healthy. |
| Frame import | WebGPU renderer | `importExternalTexture(VideoFrame)` | not measured in profile | p95 45.4 ms | Dominant bottleneck. Over 60 FPS budget by about 28.7 ms. |
| Bind group | WebGPU renderer | Bind imported frame/resources | not measured in profile | p95 0.2 ms | Cheap. |
| OSD/uniform update | WebGPU renderer | Overlay uniforms/text/box state | not measured in profile | p95 0.2 ms | Cheap. OSD is not the current wall. |
| Command encode | WebGPU renderer | Encode draw pass | not measured in profile | p95 0.4 ms | Cheap. |
| Queue submit | WebGPU renderer | Submit commands | not measured in profile | p95 0.2 ms | Cheap. |
| Total render call | WebGPU renderer | Import + bind + uniform + encode + submit | not measured in profile | p95 45.8 ms | Almost entirely import cost. |
| Source to render | Full pipeline | Source/server timestamp to rendered frame | p50 105 ms | p95 191 ms | End-to-end visible latency for latest steady run. |
| Receive to render | Browser pipeline | Worker receive timestamp to rendered frame | p50 96 ms | p95 186 ms | Most of visible latency is client-side after receive. |

System process costs from the same run:

| Process role | Command | Average CPU | Max CPU | Average RSS | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| Backend app | `dotnet` | 7.04% | 7.2% | 119.18 MB | C# endpoint/fanout cost for one 4K60 stream. |
| Backend RTSP reader | `ffmpeg` stream copy | 19.18% | 20.9% | 21.35 MB | Current reader path is still a cost center. |
| RTSP publisher | `ffmpeg` loop/copy | 6.68% | 7.5% | 16.59 MB | Local test-source cost, not production camera cost. |
| Frontend static server | `node` | 0.20% | 0.2% | 87.93 MB | Not relevant to hot path. |

Browser main-thread metrics:

```text
  browser task percent: 7.62%
  long task count:      0
  JS heap used:         6.49 MB
```

This supports the current conclusion that the main thread is not the single-stream 4K60 wall after moving transport/decode/render to workers.

## Frame Budget Status

The current service budget comparison for the latest run:

```text
  120 FPS budget:  8.33 ms
  100 FPS budget: 10.00 ms
  60 FPS budget:  16.67 ms

  render p95:      45.8 ms
  import p95:      45.4 ms
```

Headroom:

```text
  render p95 vs 120 FPS: -37.5 ms
  render p95 vs 100 FPS: -35.8 ms
  render p95 vs 60 FPS:  -29.1 ms

  import p95 vs 120 FPS: -37.1 ms
  import p95 vs 100 FPS: -35.4 ms
  import p95 vs 60 FPS:  -28.7 ms
```

For this path to be production-grade at native 4K60, the decoded-frame-to-GPU import path must become much cheaper or be avoided.

## Experiments Already Tried

### Per-tile offscreen worker, NVIDIA strict Vulkan

Latest profile:

```text
.run/profiles/vms-profile-1streams-1781600813963.json
```

Result:

```text
  rendered fps:     13.97
  received fps:     59.61
  decode p95:       1.3 ms
  render p95:       45.8 ms
  import p95:       45.4 ms
  adapter:          nvidia turing
```

Decision:

```text
  Good isolation from main thread.
  Does not solve 4K60 because importExternalTexture dominates.
```

### Matrix direct swapchain path

Profile:

```text
.run/profiles/vms-profile-1streams-1781599859939.json
```

Result:

```text
  rendered fps:     13.61
  received fps:     61.46
  render p95:       57.6 ms
  import p95:       57.0 ms
  presentation:     worker-offscreen-matrix-canvas
  matrix path:      swapchain
  copies:           0 videoFrameCopies
```

Decision:

```text
  Removing the retained backing copy did not fix 4K60.
  The import wall remains before the actual draw/present work.
```

### Intel low-power / QuickSync-oriented WebGPU profile

Profile:

```text
.run/profiles/vms-profile-1streams-1781600243887.json
```

Result:

```text
  rendered fps:     17.37
  received fps:     68.36
  decode p95:       1.2 ms
  render p95:       51.3 ms
  import p95:       49.6 ms
  adapter:          intel gen-9
```

Decision:

```text
  Intel was not a clear win for this WebGPU import path.
  Decode looked fine; render import still dominated.
```

### Bitmap/copy fallback

Result:

```text
  readiness failed in the 4K60 stress path
  visible render rate was roughly 1-2 FPS in the failure run
  source-to-render latency climbed into seconds
```

Decision:

```text
  Not a viable performance path.
  Keeping it only as a diagnostic/fallback experiment.
```

### Safe predecode admission

Profile:

```text
.run/profiles/vms-profile-1streams-1781600576904.json
```

Result:

```text
  rendered fps:     12.29
  received fps:     62.51
  decode p95:       1.2 ms
  render p95:       43.9 ms
  import p95:       43.5 ms
  sequence gaps:    0
  protocol ends:    0
```

Decision:

```text
  The classifier did not improve the current 4K60 crowd clip.
  It remains opt-in, not a default.
```

## Current Bottleneck Diagnosis

The latest 4K60 profile says:

```text
  backend read fps ~= 60
  egress sent fps ~= 60
  browser receive fps ~= 60
  WebCodecs decode p95 ~= 1.3 ms
  WebGPU importExternalTexture p95 ~= 45.4 ms
  WebGPU bind/uniform/encode/submit p95 combined ~= 1.0 ms
```

Therefore:

```text
  transport is not the current single-stream bottleneck
  server fanout is not the current single-stream bottleneck
  WebCodecs decode is not the current single-stream bottleneck
  OSD shader/uniform work is not the current single-stream bottleneck
  the decoded VideoFrame -> WebGPU external texture import path is the wall
```

This does not mean the backend is finished for 100-200 camera scale. The RTSP reader and RTP-to-MoQ/WebTransport bridge still need server-side efficiency work. It only means that the latest single 4K60 browser playback failure is client render-import dominated.

## Copy And Ownership Boundaries

Current practical copy/ownership picture:

```text
  server RTSP reader
      reads H.264 bytes from source process/socket
      no decode
      no pixel copy

  backend fanout
      stores access-unit byte payload for subscribers
      bounded queue prevents unbounded copies/backlog

  WebTransport write
      writes binary payload to QUIC stream
      still involves normal managed/native network buffers

  browser worker
      parses binary framing
      creates EncodedVideoChunk input for WebCodecs

  WebCodecs
      decodes compressed H.264 to browser-owned VideoFrame
      likely hardware accelerated in successful runs

  WebGPU
      imports VideoFrame as GPUExternalTexture
      this is the expensive step in Chrome/Linux today
      actual draw is cheap once import succeeds
```

The desired ideal path is:

```text
  compressed bytes
      -> hardware decoder
      -> GPU-resident decoded frame
      -> WebGPU sample without costly cross-subsystem copy/import
      -> one draw per visible tile
```

Our code asks for the ideal browser-level API shape, but Chrome/Linux currently appears to charge heavily at the `importExternalTexture(VideoFrame)` boundary for 4K frames.

## Known Risks

```text
  1. 4K60 native-size WebGPU rendering is not solved.
  2. Multiple 4K streams multiply the same import wall.
  3. Duplicate tile sharing is constrained by VideoFrame ownership/transfer rules.
  4. Local ffmpeg reader/publisher costs can hide future server scale costs.
  5. Browser/GPU-driver behavior changes materially with Chrome flags and profiles.
  6. Metrics for per-stage averages are incomplete on the frontend; p95 is good, but averages per render substage should also be recorded.
  7. The current path has no audio.
  8. B-frame-heavy streams need correct timestamp/reorder handling; WebCodecs can handle decode order, but our transport/timing layer must preserve enough timing information.
```

## External Review Questions

These are the highest-value questions for another expert/team:

```text
  1. On Chrome/Linux, what is the best current path for low-cost VideoFrame -> WebGPU sampling at 4K60?

  2. Is importExternalTexture expected to be this expensive for 3840x2160 H.264 VideoFrames on NVIDIA/Intel Linux, or are our Chrome flags/ANGLE/Vulkan/VAAPI choices wrong?

  3. Can we force the decoder and WebGPU device onto the same physical adapter and memory path more reliably?

  4. Is there a practical zero-copy or lower-copy path from WebCodecs to WebGPU that avoids this import cost?

  5. Should the production renderer use native video compositor for the base video and reserve WebGPU for OSD/analytics overlays?

  6. If WebGPU remains the base-video renderer, should we batch multiple tiles in one shared offscreen matrix device, or isolate one worker/canvas per tile?

  7. For B-frame-heavy streams, what exact timestamp/reorder metadata should be carried over the wire to keep WebCodecs and low-latency pacing correct?

  8. Would WebTransport multiplexing reduce browser/network overhead enough to matter after the render-import wall is fixed?

  9. For server scale, should the bridge forward RTP payloads over QUIC with minimal repacketization, or continue to form media objects around H.264 access units?

  10. Which browser/OS/GPU combinations have proven production-grade WebCodecs + WebGPU 4K60 interop today?
```

## How To Reproduce Current Manual Path

Start the local stack:

```bash
./start.sh
```

Open the VMS client with the WebGPU Chrome launcher:

```bash
chrome-webgpu http://127.0.0.1:4173/vms.html
```

For the strict NVIDIA/Vulkan experiment:

```bash
CHROME_WEBGPU_PRESET=video-strict-vulkan chrome-webgpu http://127.0.0.1:4173/vms.html
```

Profile the VMS path:

```bash
WEBVIDEO_CHROME_WEBGPU_PRESET=video-strict-vulkan \
WEBVIDEO_VMS_OFFSCREEN=1 \
./scripts/profile-vms.sh
```

Run the broader automated suite:

```bash
./scripts/test-all.sh
```

Run headed hardware WebGPU soak coverage:

```bash
WEBVIDEO_TEST_PROFILE=hardware-long ./scripts/test-all.sh
```

Run mixed 4K/1080p hardware stress diagnostics:

```bash
WEBVIDEO_TEST_PROFILE=hardware-mixed-4k-long ./scripts/test-all.sh
```

## Current Conclusion

The architecture is directionally correct for a low-latency browser VMS: client-initiated channel selection, bounded backend fanout, binary WebTransport, worker-owned WebCodecs, worker/offscreen WebGPU, and shader-based OSD.

The current implementation is not yet production-grade for native 4K60 WebGPU playback. The latest evidence points to the browser/GPU interop boundary, specifically `importExternalTexture(VideoFrame)`, not to the server, QUIC, decode, OSD, bind groups, command encoding, or queue submission.

The next serious renderer investigation should focus on proving or disproving this exact boundary with browser/GPU-specific traces, Chrome media/GPU diagnostics, and a minimal external-texture benchmark that removes our transport, WebCodecs setup, OSD, and app code from the equation.
