# Synthetic RTSP Runbook

The repository currently defines two synthetic RTSP smoke scenarios in:

- [backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs](/home/mj/myapps/webvideo/backend/src/WebVideo.Backend.TestKit/SyntheticRtspStreamCatalog.cs:1)

Scenarios:

- `udp-h264-smoke`
- `tcp-h264-smoke`

These scenarios are meant to be the first live test sources for backend ingest and browser e2e work.

## Required tools

- `mediamtx`
- `ffmpeg`

## UDP smoke stream

Start the RTSP server:

```bash
mediamtx --log-level info --rtspAddress :8554 --rtpAddress :5004 --rtcpAddress :5005
```

In another terminal, publish the synthetic source:

```bash
ffmpeg -re -stream_loop -1 -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -vf "drawtext=text='%{pts\\:hms}':x=20:y=20:fontsize=28:fontcolor=white" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v baseline \
  -g 30 -keyint_min 30 -sc_threshold 0 -b:v 4000k -pix_fmt yuv420p \
  -rtsp_transport udp -f rtsp rtsp://127.0.0.1:8554/live/udp-h264-smoke
```

## TCP smoke stream

Start the RTSP server:

```bash
mediamtx --log-level info --rtspAddress :8556 --rtpAddress :5006 --rtcpAddress :5007
```

In another terminal, publish the synthetic source:

```bash
ffmpeg -re -stream_loop -1 -f lavfi -i testsrc2=size=1280x720:rate=30 \
  -vf "drawtext=text='%{pts\\:hms}':x=20:y=20:fontsize=28:fontcolor=white" \
  -c:v libx264 -preset veryfast -tune zerolatency -profile:v main \
  -g 30 -keyint_min 30 -sc_threshold 0 -b:v 4000k -pix_fmt yuv420p \
  -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8556/live/tcp-h264-smoke
```

## Intended use

- backend ingest smoke test
- browser transport/decode/render smoke test
- metadata overlay alignment test
- reconnect and discontinuity test

These commands are documented from the current test catalog and should stay aligned with:

- xUnit tests in [backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs](/home/mj/myapps/webvideo/backend/tests/WebVideo.Backend.Specifications.Tests/RtspTestStreamCatalogTests.cs:1)
- Playwright/browser scenario references in [frontend/tests/e2e/contract-harness.spec.ts](/home/mj/myapps/webvideo/frontend/tests/e2e/contract-harness.spec.ts:1)

