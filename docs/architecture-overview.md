# Architecture Overview

## 1. Problem Statement

Build a browser video stack with:

- Live streaming over QUIC.
- Browser ingest via WebTransport.
- Decode via WebCodecs.
- Render via WebGPU.
- Overlay/graphics path for metadata-driven artifacts.
- Support for both live and playback.
- Minimal source-to-sink latency.

The system should be efficient, observable, and simple enough to reason about under production load.

## 2. Design Principles

### Minimize copies and queues

Every extra buffer, conversion, or reorder step increases latency and jitter. The pipeline should keep frame ownership clear and avoid "just in case" queues.

### Separate media timing from UI timing

Video decode, metadata timing, and presentation scheduling should not depend on the browser UI event loop more than necessary.

### Prefer explicit time domains

Each media frame and metadata event must carry timestamps that can be mapped across:

- capture clock
- encoder clock
- transport send time
- receive time
- decode time
- presentation time

### Make live and playback share the same core abstractions

Playback should reuse the same packet/frame/metadata model as live, while allowing deeper buffering and seek support.

### Degrade predictably

When the system is overloaded, it must choose a deterministic fallback strategy:

- drop late metadata
- drop non-reference frames only if codec/packaging allows it
- reduce overlay complexity
- reduce render resolution
- reduce frame rate before growing latency indefinitely

## 3. High-Level Architecture

### Backend

Responsibilities:

- ingest source video
- encode to a browser-decodable codec
- packetize elementary stream access units or chunked segments
- transmit over WebTransport/QUIC
- transmit metadata on a synchronized path
- expose session control for live and playback
- maintain observability metrics

Recommended language split:

- Rust for transport, packetization, pacing, timestamping, and session control
- Rust or C# for control plane, API, orchestration, asset management, and playback indexing

### Frontend

Responsibilities:

- establish WebTransport session
- receive media and metadata
- depacketize into encoded chunks
- feed WebCodecs `VideoDecoder`
- maintain a frame scheduler
- render decoded frames and overlays via WebGPU
- expose stats and debugging tools

Recommended language split:

- TypeScript for all browser logic
- WGSL shaders for compositing, color conversion if needed, and overlay rendering

## 4. Media Path Options

There are two viable payload strategies on top of WebTransport:

### Option A: Send encoded access units directly

The backend sends codec configuration plus encoded frames with timestamps and dependency flags.

Pros:

- lowest conceptual overhead
- avoids full container parsing in browser
- tighter control over latency

Cons:

- you own packetization, reassembly, and timestamp correctness
- more custom protocol work
- playback storage and seek indexing need explicit design

### Option B: Send small fragmented container units

The backend sends low-latency fragmented MP4 or another compact container form over WebTransport.

Pros:

- easier alignment with playback storage
- clearer sample metadata model

Cons:

- more packaging overhead
- browser-side demux/parsing complexity
- risk of hidden buffering if packaging is too coarse

For minimum latency and maximum control, Option A is the better default.

## 5. Metadata Path Options

### Option 1: Multiplex metadata into the same logical media stream

Each unit on the stream is a typed message:

- codec config
- video chunk
- metadata batch
- sync marker
- control event

Pros:

- simpler ordering model
- transport-level relative order is preserved

Cons:

- metadata can be delayed behind media bursts
- harder to prioritize metadata independently

### Option 2: Separate WebTransport stream for metadata

Use:

- one unidirectional stream for video
- one unidirectional stream for metadata
- optional datagrams for ultra-ephemeral hints

Pros:

- cleaner separation
- independent backpressure and prioritization
- easier evolution of metadata protocol

Cons:

- requires explicit time synchronization and correlation

Recommended default:

- reliable ordered stream for video
- reliable ordered stream for timed metadata
- optional datagrams for non-critical hints such as cursor, transient detections, or telemetry

## 6. Live vs Playback

### Live mode

Optimize for:

- minimal encoder lookahead
- tight transport pacing
- shallow client buffers
- aggressive late-frame dropping

### Playback mode

Optimize for:

- seek support
- indexed storage
- adaptive buffering
- deterministic presentation

Shared abstraction:

- session
- track
- timestamp mapping
- chunk
- metadata event
- renderer

## 7. Recommended Baseline Architecture

### Control plane

- HTTPS endpoint creates a playback or live session
- returns auth token, stream IDs, codec config, and timing epoch

### Data plane

- WebTransport connection per session
- one unidirectional stream for video chunks
- one unidirectional stream for timed metadata
- optional datagrams for non-essential low-value hints

### Browser pipeline

1. Open WebTransport session.
2. Read startup config and timing epoch.
3. Start media stream reader and metadata stream reader.
4. Reassemble encoded video chunks.
5. Push chunks to `VideoDecoder`.
6. Put decoded `VideoFrame`s into a very small presentation queue.
7. Render video and overlay layers in WebGPU.
8. Present based on a monotonic presentation clock.

## 8. Key Challenges

### Browser APIs are low-level but not fully real-time

WebTransport, WebCodecs, and WebGPU are efficient, but the browser still controls scheduling, memory pressure, and process isolation. You can approach native behavior, but not fully own the machine.

### Timestamp discipline is hard

Small errors in timestamp generation, drift correction, or queue policy create visible jitter quickly.

### Backpressure can appear in multiple layers

Potential bottlenecks include:

- encoder output bursts
- QUIC congestion control
- browser stream reader cadence
- decoder saturation
- GPU upload/render stalls

### Color formats and zero-copy are constrained

You do not always get a perfect zero-copy path from decoder to GPU. Behavior varies by browser, platform, and decoded pixel format.

### Metadata alignment needs strict semantics

Overlays become visibly wrong if metadata semantics are vague. You need clear rules for event validity windows, interpolation, expiry, and confidence.

## 9. Success Criteria

- Live glass-to-glass latency target: as low as practical, ideally within roughly 50-150 ms depending on network, encode settings, and browser/device behavior
- Stable frame pacing with bounded jitter
- Metadata overlays visually aligned with video
- Clear observability on every queue and timing stage
- Shared architecture for live and playback

