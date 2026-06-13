# Future Options

This file holds implementation options that are not part of the current v1 baseline.

The current baseline is:

- `.NET 10` backend contracts, coordinators, demo host, and future ingest/egress work
- TypeScript browser contracts and player services
- one authoritative ingest owner per stream
- branch after RTP depacketization into normalized encoded access units
- in-process fanout first, with service splits driven by measurement

## 1. Rust Backend or Sidecar Options

Rust may be useful later for transport, packetization, pacing, timestamping, session control, or media hot-path ownership.

Possible repository shape for a Rust backend and TypeScript frontend:

```text
backend/
  crates/
    transport/
    media_pipeline/
    metadata_protocol/
    session_control/
    observability/
frontend/
  src/
    transport/
    protocol/
    decoder/
    scheduler/
    renderer/
    overlays/
    metrics/
    ui/
docs/
```

If C# remains the control plane and API layer, the split would be:

- keep transport/media hot path in Rust
- expose control and orchestration services in C#

## 2. Splitting the Original Stream to Rust

There are several meanings of "split".

### Option A: Two independent RTSP sessions to the camera

- C# opens one RTSP session
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

- requires an inter-process protocol
- exact transparent forwarding is trickier for RTSP-over-TCP interleaving
- creates two RTP stacks to keep correct

Recommendation:

- workable if Rust owns depacketization and web delivery while C# keeps camera/session ownership

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

- best mixed-language architecture if C# remains the ingest owner

### Option D: Rust owns ingest; C# consumes normalized media/events from Rust

- Rust handles RTSP, RTP, pacing, and web transport
- C# handles control plane, APIs, archive indexing, and business logic

Pros:

- keeps the hot media path in one systems-language service
- avoids duplicate packet handling stacks
- simplest performance story long term

Cons:

- larger migration
- archive path must integrate with Rust output
- changes the current ownership model

Recommendation:

- strongest long-term architecture if low-latency streaming becomes the core product capability

## 3. Mixed-Language Interop Guidance

If you do mixed C# and Rust, do not start with FFI unless there is a narrow, stable boundary.

Avoid as the default:

- direct C ABI integration
- embedding Rust into the .NET service process for the whole media pipeline

Reason:

- harder deployment
- harder crash isolation
- more painful memory ownership boundaries
- more complex debugging

Prefer:

- separate process on the same host
- binary protocol over Unix domain socket or loopback TCP
- explicit session, stream, and timing contracts

This gives most of the performance benefit with much less integration risk.

## 4. Rust Egress as a Scaling Optimization

Rust fanout/QUIC handlers may help when:

- concurrent viewers become large
- QUIC/session handling becomes a hot path
- GC or allocation behavior in the egress layer becomes noisy
- tighter control over pacing and memory layout is needed

Rust does not remove the per-client bandwidth cost. It can reduce:

- per-client CPU cost
- per-client memory overhead
- jitter introduced by the egress runtime

That means Rust is useful as an egress optimization layer, not as a way to recover multicast.

## 5. Best Mixed-Language Scaling Topology

If Rust egress is added later, the best shape is usually:

1. C# owns ingest, archive, and stream normalization.
2. C# publishes normalized access units to one or more local egress workers.
3. Rust workers own WebTransport/QUIC client sessions.
4. Clients are assigned to egress workers by stream ID and capacity.

The branch point remains after depacketization.

## 6. Placement Options

### Best latency shape

- C# ingest and Rust egress in the same pod
- communicate over Unix domain socket or shared-memory-style buffer

Pros:

- minimal handoff latency
- no extra node hop
- simplest timing behavior

Cons:

- scaling egress separately from ingest is harder

### Best operational shape

- C# ingest as one service
- Rust egress as a separate deployable service
- keep them on the same node when possible

Pros:

- independent scaling
- cleaner ownership boundaries

Cons:

- one more network hop
- slightly more jitter

## 7. Latency of C# to Rust Binary Handoff

Assuming:

- simple binary framing
- no JSON
- no disk
- no service mesh
- healthy nodes

Typical added latency should be roughly:

| Handoff path | Expected added latency |
|---|---:|
| same process | effectively negligible |
| same pod via Unix socket / shared-memory-style IPC | ~0.05 to 0.5 ms |
| same node via loopback TCP | ~0.1 to 1 ms |
| different pods on same node | ~0.2 to 1.5 ms |
| cross-node in cluster | ~0.5 to 5 ms |

These are planning ranges, not guarantees.

The local C# to Rust handoff is often a second-order concern compared with camera jitter, encode behavior, browser decode, and browser render scheduling if designed correctly.

## 8. Suggested Evaluation Path

Only introduce Rust egress when measurements show:

- C# QUIC/session density is the bottleneck
- GC/allocation jitter is affecting tail latency
- the browser egress layer needs tighter pacing or memory layout control

If Rust egress is introduced, keep the handoff:

- binary
- local
- after depacketization
- same node if possible

If the browser path becomes the primary product path, a later migration could move ingest, low-latency transport, and media normalization to Rust while keeping C# as the control, business, and archive orchestration plane.
