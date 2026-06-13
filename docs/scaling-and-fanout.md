# Scaling and Fanout

## 1. Core Reality

With browser delivery over WebTransport/QUIC, you no longer get the old multicast shape where the camera effectively fans out directly to viewers.

For browser clients:

- delivery is effectively unicast
- each client has its own transport state
- each client consumes server egress bandwidth
- each client may require slightly different pacing because network conditions differ

That means the problem is not "how do we avoid proxying". The problem is:

- how do we proxy once from the camera
- while avoiding repeated work inside the server tier

## 2. What Work Must Be Shared

The work that should happen once per stream:

- RTSP session management
- RTP receive and depacketization
- codec config extraction
- timestamp normalization
- archive writing
- access-unit reconstruction

The work that is inherently per client:

- QUIC connection state
- congestion control
- encryption
- pacing
- retransmission behavior
- browser session lifecycle

This is the key scaling model. You can share the stream normalization work, but you cannot share the final WebTransport session itself.

## 3. Recommended Full-C# V1 Topology

If you start full C#, use this shape:

1. One ingest owner per camera stream.
2. Ingest produces normalized encoded access units.
3. Those access units go into an in-memory fanout buffer per stream.
4. Multiple browser sessions subscribe to that buffer.
5. Each browser session has its own small send queue and pacing state.

This avoids:

- one RTSP session per viewer
- one depacketizer per viewer
- one archive writer per viewer

It still requires:

- one QUIC/WebTransport session per viewer

## 4. Fanout Buffer Design

Use a per-stream ring buffer of recent access units.

Each entry should carry:

- stream ID
- sequence number
- keyframe flag
- PTS
- optional DTS
- receive timestamp
- encoded payload reference
- discontinuity/loss markers

The ring buffer should:

- keep only a short live window
- allow zero or near-zero extra copies inside the process
- let a new viewer join at the next keyframe
- expose backpressure and drop metrics

Do not create one full copy of every frame per client.

Instead:

- store one encoded payload per access unit
- let client sessions hold references until sent

## 5. Service Placement Strategy

### Best latency shape

- ingest, fanout buffer, and browser egress in the same process or pod

Pros:

- minimal internal handoff latency
- no extra node hop
- simplest timing behavior

Cons:

- scaling egress separately from ingest is harder

### Best operational shape

- ingest and normalization as one service
- browser egress as a separate deployable service
- keep them on the same node when possible

Pros:

- independent scaling
- cleaner ownership boundaries

Cons:

- one more network hop
- slightly more jitter

### Large-scale shape

- one ingest owner per stream
- one relay/egress group per hot stream
- clients routed to the same egress shard by `stream_id`
- only split a stream across multiple egress pods when one pod is near capacity

This avoids duplicating inter-service fanout unnecessarily.

## 6. Latency of Internal Binary Handoff

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

These are not guarantees. They are practical planning ranges.

The main point:

- same-pod or same-node binary handoff is usually not the dominant latency term
- cross-node fanout starts to matter more

Compared with:

- camera jitter
- encode behavior
- browser decode
- browser render scheduling

the local backend-to-egress handoff is often a second-order concern if designed correctly.

## 7. What Actually Drives Server Load

For no-transcode delivery, server load is usually driven by:

- aggregate egress bitrate
- number of QUIC sessions
- encryption overhead
- pacing timers
- retransmission volume under loss
- memory held by per-client queues

A simple sizing model is:

`total_egress ~= encoded_bitrate_per_stream * viewer_count`

Example:

- 4 Mbps stream
- 1,000 viewers

Raw payload egress is about:

- 4 Gbps before protocol overhead

That is why scaling decisions must center on egress, not just ingest.

## 8. Routing Strategy

For live streaming, route viewers by `stream_id`, not randomly.

Why:

- viewers of the same stream can share the same normalized source buffer
- joining viewers can attach at the next keyframe
- metrics and backpressure remain stream-local

Recommended policy:

- sticky routing by `stream_id`
- capacity threshold per egress shard
- spill over to a second shard only when necessary

## 9. What to Build First

### Phase 1

- full C# ingest and browser egress
- in-process per-stream ring buffer
- one-node benchmark

Measure:

- viewers per node
- bitrate per node
- CPU per 100 viewers
- memory per 100 viewers
- p50/p95/p99 added latency from ingest to browser send

### Phase 2

- split browser egress into a separate local process only if measurements show the in-process path is the bottleneck
- measure whether the split improves session density, deployment isolation, or tail latency enough to justify the extra boundary

### Phase 3

- add stream-aware routing and horizontal egress scale in Kubernetes
- keep each stream single-owner on ingest

## 10. Recommendation

Do not design around one media worker per client or duplicate the stream to many workers immediately.

Start with:

- one authoritative ingest per stream
- one shared normalized live buffer per stream
- many client sessions hanging off that buffer

Only split egress when measurements show:

- QUIC/session density is the bottleneck
- or GC/allocation jitter is affecting tail latency

If you introduce a separate egress service, keep the handoff:

- binary
- local
- after depacketization
- same node if possible

That should add around sub-millisecond to low-single-digit milliseconds, not tens of milliseconds, if the topology is disciplined.
