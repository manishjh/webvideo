# Ingest and Service Topology

## 1. Problem

Current state:

- this repository contains a contract-first `.NET 10` backend prototype
- backend contracts cover ingest, archive, proxy, browser sessions, fanout, metadata, and telemetry
- in-memory coordinator implementations and tests lock expected behavior alongside the local browser media path
- the demo host maps client-provided channel IDs to predefined backend-selected streams, captures local RTSP H.264 access units when enabled, and serves browser sessions over WebTransport/QUIC
- the local browser path now includes bounded live demo playback, a bounded multi-channel tile wall, continuous React VMS playback, default 4K RTSP sources, opt-in long-running VMS soaks, and opt-in 4K/mixed-resolution browser stress profiles
- the current continuous path uses a compact MoQ-shaped object envelope, but is not yet full MOQT/MSF compatible

Target requirement:

- add a browser-oriented path for low-latency live playback and later metadata overlays
- preserve the option to archive and proxy camera streams without unnecessary decode/re-encode
- keep the branch point and timing model explicit enough to test
- graduate from predefined demo channels to arbitrary RTSP camera configuration and continuous stream duration
- make mixed 4K/1080p viewing stable across multi-minute runs before treating it as production-ready

Current decision:

- use `.NET 10` as the v1 backend owner
- prove behavior through contracts, in-memory services, synthetic streams, and browser tests first
- defer alternate implementation languages and service splits to [Future Options](./future-options.md)

## 2. First Principles

### RTSP is control; RTP carries the media

When people say "split RTSP packets", what usually matters is the RTP media payload:

- RTSP sets up the session
- RTP carries H.264/H.265/AAC payloads
- RTCP carries timing and control

Your architecture choice should focus on where RTP is terminated and where the branching happens.

### Avoid decode/re-encode unless absolutely required

If the camera already emits a browser-decodable codec/profile, you should preserve the encoded elementary stream and branch from there.

### One ingest owner is cleaner than two independent consumers

If two services independently pull the same camera stream:

- the camera load doubles
- session behavior may differ between consumers
- timestamps and packet loss can diverge
- operational debugging gets harder

For production, a single ingest owner that fans out internally is usually the better design.

## 3. Recommended V1 Branch Point

The authoritative branch should happen after RTP depacketization and timestamp normalization.

The ingest owner should produce normalized encoded access units that can feed:

- archive writing
- legacy proxy paths where applicable
- live browser fanout
- metadata synchronization
- test sinks and diagnostics

Pros:

- one camera session
- one place for camera quirks, reconnect behavior, packet loss, and clock mapping
- no decode/re-encode when the source codec/profile can be preserved
- a compact contract for fanout and browser egress
- deterministic test boundaries for contracts and synthetic streams

Cons:

- more work in the backend hot path than a raw tee
- the normalizer must handle codec details correctly
- WebTransport egress still needs independent pacing and backpressure

## 4. Is Branching Lossless and Zero-Latency?

Not literally.

You can make it very cheap, but not free.

Reality:

- there is always at least one extra handoff
- there may be extra buffering unless explicitly controlled
- user-space copies add small but real overhead
- scheduler delays can add jitter

On the same machine over loopback or Unix domain sockets, the extra overhead can still be small enough to be operationally irrelevant compared with:

- camera jitter
- encoder behavior
- browser decode/render time

The right target is not "zero overhead". The right target is:

- no extra frame buffering
- no decode/re-encode
- no uncontrolled queue growth
- no timestamp ambiguity

## 5. V1 Service Shape

Use one backend service boundary first:

1. Session/control APIs create live or playback sessions.
2. Ingest owns source connection, reconnect, and source timing.
3. Normalization emits timestamped encoded access units.
4. A per-stream fanout buffer holds a short live window.
5. Browser sessions subscribe to the buffer and maintain independent send queues.
6. Metadata events use the same timeline contract.
7. Telemetry records queue depth, drops, timing, and client state.

This maps directly to the current backend contract areas and keeps the first production path testable.

## 6. Why a Single Backend Is Valid for V1

The real risks are not solved by splitting services early. The real risks are:

- queueing mistakes
- timestamp errors
- too much allocation
- transport implementation quality

If the .NET implementation avoids those, it can be good enough for v1 and much easier to validate.

## 7. Concrete Plan

### Phase A: Decide the branch point

Decide that the authoritative branch happens after RTP depacketization, not by duplicating full RTSP session logic across services.

Output contract:

- stream config
- codec config
- keyframe/delta encoded access units
- PTS/DTS if relevant
- capture/receive timestamps
- loss/discontinuity markers

### Phase B: Prove normalized output

Build a local emitter that:

- connects to one camera or synthetic RTSP source
- depacketizes H.264/H.265 RTP
- reconstructs access units
- emits them to a file or localhost test sink

Success criteria:

- no decode/re-encode
- stable timestamp sequence
- keyframe boundaries preserved

### Phase C: Build browser egress

Build backend browser egress that:

- reads normalized stream units
- repackages to the browser wire protocol
- serves WebTransport
- exposes sender-side metrics
- supports independent per-tile browser sessions for the same page

Success criteria:

- end-to-end browser playback with low queue depth
- continuous arbitrary-duration sessions do not grow queues under steady-state load
- source-to-render latency, server queue depth, backend drops, client drops, sequence gaps, and frame hitches explain failures without relying only on browser e2e video inspection

### Phase D: Add metadata path

- add timed metadata from backend services or analytics producers
- align metadata to the same timeline contract
- render overlays in browser

### Phase E: Re-evaluate ownership

After metrics and production learning:

- keep the single-backend architecture if it is clean enough
- consider future service splits only if the single-backend path becomes the main constraint

## 8. Specific Recommendation

If you want the least-risk serious path:

- do not split by opening two camera sessions
- keep camera ingest in the `.NET 10` backend initially
- branch after depacketization into a normalized encoded stream
- use an in-process fanout buffer and per-client send queues for browser delivery
- measure before introducing new service boundaries
