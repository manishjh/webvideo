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
- preserve or normalize encoded media without decode/re-encode where possible
- encode to a browser-decodable codec when required
- packetize elementary stream access units or chunked segments
- transmit over WebTransport/QUIC
- transmit metadata on a synchronized path
- expose session control for live and playback
- maintain observability metrics

Current baseline:

- `.NET 10` backend contracts define ingest, archive, proxy, browser session, fanout, metadata, and telemetry behavior.
- deterministic in-memory backend coordinators lock the service lifecycle and expected flow semantics before the full media implementation.
- the demo host serves synthetic browser stream payloads over HTTP so the frontend can exercise visible playback while WebTransport/WebCodecs work is still pending.

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
6. Schedule decoded frames against the media clock.
7. Select metadata for the presented timestamp.
8. Composite video and overlays.
9. Emit timing and queue metrics.
