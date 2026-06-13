# Ingest and Service Topology

## 1. Problem

Current state:

- a `.NET 10` service talks to cameras over RTSP
- it archives into a custom container format
- it can proxy RTSP through to thick clients such as VLC without decode/re-encode

New requirement:

- add a browser-oriented path for low-latency live playback and later metadata overlays

Key decision:

- keep everything in C#
- add a Rust sidecar/service for the web path
- or move ingest/hot media path to Rust and keep C# for control and archiving orchestration

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

## 3. Can You Split the Original Stream to Rust?

Yes, but there are different meanings of "split".

### Option A: Two independent RTSP sessions to the camera

- C# opens RTSP session
- Rust opens another RTSP session

Pros:

- no interop between C# and Rust
- simplest implementation to prototype

Cons:

- doubles camera sessions and bandwidth from camera
- not all cameras handle multiple subscribers well
- packet loss, jitter, and timestamps can differ across the two sessions
- operationally messy

Recommendation:

- acceptable only for quick prototyping or lab validation

### Option B: C# receives RTP and packet-copies to Rust

- C# remains the ingest owner
- after RTSP setup, C# forwards received RTP/RTCP packets to Rust over localhost

Pros:

- one camera session
- Rust sees near-original packet flow
- preserves existing C# archive/proxy ownership

Cons:

- you still have inter-process protocol design
- exact transparent forwarding is trickier for RTSP-over-TCP interleaving
- you now have two RTP stacks to keep correct

Recommendation:

- workable if you want Rust to own depacketization and web delivery while C# keeps camera/session ownership

### Option C: C# terminates RTSP/RTP, then sends normalized encoded access units to Rust

- C# owns camera connection and RTP reassembly
- C# extracts NAL units / access units and timing
- C# sends a compact internal binary stream to Rust

Pros:

- far simpler contract than raw packet mirroring
- isolates RTSP camera quirks inside one service
- easier to support UDP and interleaved TCP consistently
- better fit for downstream WebTransport packaging

Cons:

- more work in C# hot path than a raw tee
- Rust no longer sees literal original packets

Recommendation:

- this is the best mixed-language architecture if you keep C# as the ingest owner

### Option D: Rust owns ingest; C# consumes normalized media/events from Rust

- Rust handles RTSP, RTP, pacing, web transport
- C# handles control plane, APIs, archive indexing, business logic

Pros:

- keeps the entire hot media path in one systems-language service
- avoids duplicate packet handling stacks
- simplest performance story long term

Cons:

- larger migration
- archive path must integrate with Rust output
- changes the current ownership model

Recommendation:

- strongest long-term architecture if low-latency streaming is a core product capability

## 4. Is Packet-Copying Lossless and Zero-Latency?

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

## 5. Interop Guidance

If you do mixed C# and Rust, do not start with FFI unless you have a very narrow, stable boundary.

### Avoid as the default

- direct C ABI integration
- embedding Rust into the .NET service process for the whole media pipeline

Reason:

- harder deployment
- harder crash isolation
- more painful memory ownership boundaries
- more complex debugging

### Prefer

- separate process on the same host
- binary protocol over Unix domain socket or loopback TCP
- explicit session, stream, and timing contracts

This gives most of the performance benefit with much less integration risk.

## 6. Option Comparison

| Option | Latency | Complexity | Operational Risk | Long-Term Quality |
|---|---:|---:|---:|---:|
| all C# | medium to good | low to medium | low | medium |
| C# ingest + raw RTP tee to Rust | good | medium to high | medium | medium |
| C# ingest + normalized access units to Rust | very good | medium | low to medium | high |
| Rust ingest + C# control plane | best | high initially | medium | best |

## 7. Recommended Course

### Short-term recommendation

Keep `.NET 10` as the system owner for now, but do not mirror the full RTSP problem into the browser path.

Recommended shape:

1. C# remains the single RTSP/RTP ingest owner.
2. C# continues archive writing and legacy RTSP/VLC support.
3. C# depacketizes RTP into timestamped encoded access units.
4. C# sends those access units plus timing metadata to a local Rust service.
5. Rust handles WebTransport packaging, pacing, metadata multiplexing, and browser delivery.

Why this is the best first production step:

- no double pull from the camera
- no decode/re-encode
- no FFI
- camera/RTSP quirks stay in one place
- Rust owns the web hot path where low-level transport control matters most
- C# keeps your existing business/control/archive architecture intact

### Long-term recommendation

If the browser path becomes the primary product path, plan a future migration toward:

- Rust owning ingest, low-latency transport, and media normalization
- C# owning control plane, session APIs, archive coordination, and product/business logic

That gives the cleanest architecture once requirements stabilize.

## 8. Why "All C#" May Still Be Valid

Do not reject the all-C# option too quickly.

If your team is strongest in C# and:

- the existing RTSP path is already robust
- you can implement depacketization and WebTransport cleanly
- profiling shows the hot path is acceptable

then an all-C# first version is a rational choice.

The real risks are not the language by itself. The real risks are:

- queueing mistakes
- timestamp errors
- too much allocation
- transport implementation quality

If the .NET implementation can avoid those, it may be good enough for v1.

## 9. Concrete Plan

### Phase A: Decide the branch point

Decide that the authoritative branch happens after RTP depacketization, not by duplicating full RTSP session logic across services.

Output contract:

- stream config
- codec config
- keyframe/delta encoded access units
- PTS/DTS if relevant
- capture/receive timestamps
- loss/discontinuity markers

### Phase B: Prove C# normalized output

Build a local emitter in C# that:

- connects to one camera
- depacketizes H.264/H.265 RTP
- reconstructs access units
- emits them to a file or localhost test sink

Success criteria:

- no decode/re-encode
- stable timestamp sequence
- keyframe boundaries preserved

### Phase C: Build Rust web egress

Build a Rust service that:

- ingests the normalized stream from C#
- repackages to browser wire protocol
- serves WebTransport
- exposes sender-side metrics

Success criteria:

- end-to-end browser playback with low queue depth

### Phase D: Add metadata path

- add timed metadata from C# or analytics producers
- align metadata to the same timeline contract
- render overlays in browser

### Phase E: Re-evaluate ownership

After metrics and production learning:

- keep split architecture if it is clean enough
- or move ingest fully to Rust if the C# hot path becomes the main constraint

## 10. Specific Recommendation

If you want the least-risk serious path:

- do not split by opening two camera sessions
- do not start with FFI
- keep camera ingest in C# initially
- branch after depacketization into a normalized encoded stream
- send that stream to a Rust sidecar for web delivery

If you want the simplest engineering path:

- prototype end-to-end entirely in C#
- only introduce Rust if profiling shows the hot path or QUIC/WebTransport layer needs tighter control

If you want the best long-term media architecture:

- move the full ingest and web media pipeline to Rust
- keep C# as the control/business/archive orchestration plane

