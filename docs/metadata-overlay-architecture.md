# Metadata and Overlay Architecture

## 1. Goals

The metadata system should support:

- timed overlays
- analytics output
- track annotations
- user interaction layers
- debugging and observability overlays

It must remain synchronized with video while staying independent enough to evolve without breaking the video pipeline.

## 2. Recommended Metadata Model

Define three classes of metadata:

### A. Timed frame-associated metadata

Examples:

- bounding boxes
- keypoints
- segmentation masks
- OCR hits
- object IDs

Characteristics:

- attached to a frame PTS or a short validity interval
- usually high frequency
- must render in sync with video

### B. Timed stream events

Examples:

- ad markers
- scoreboard changes
- scene changes
- chapter transitions
- alerts

Characteristics:

- lower frequency
- tied to timeline, not necessarily one frame

### C. Ephemeral interaction/telemetry

Examples:

- cursor position
- hover target
- live operator cues
- non-critical diagnostics

Characteristics:

- can be dropped
- should not block video

## 3. Transport Recommendation

### Video stream

- reliable ordered WebTransport unidirectional stream

### Metadata stream

- reliable ordered WebTransport unidirectional stream
- batch metadata events in compact binary records

### Optional datagram path

- only for ephemeral metadata that is safe to lose

This gives the cleanest long-term architecture.

## 4. Wire Protocol Shape

Use a versioned binary envelope.

Top-level message fields:

- protocol version
- message type
- stream/session ID
- sequence number
- send timestamp
- payload length

Metadata message payload fields:

- timeline domain ID
- event batch start PTS
- event count
- event records

Event record fields:

- event type
- target track ID
- start PTS
- end PTS or duration
- spatial coordinate space
- confidence
- payload reference or inline payload

## 5. Coordinate Systems

Overlays are wrong unless coordinate semantics are strict.

Support explicit coordinate spaces:

- normalized video space `[0..1]`
- coded pixel space
- display pixel space
- world/scene space if relevant

Recommended default:

- normalized video space for most overlays

This keeps overlays stable across resolution changes, cropping, and display scaling.

## 6. Rendering Model

Split overlay rendering into layers:

1. video base layer
2. geometric primitives layer
3. text/icon layer
4. post effects/debug layer
5. interaction layer

Each layer consumes metadata projected to the chosen presentation timestamp.

## 7. Metadata Timing Rules

For each presentation timestamp `T`:

1. select metadata whose validity window contains `T`
2. interpolate data if the event type allows interpolation
3. drop expired ephemeral events
4. use last-known state only for event types explicitly marked stateful

Do not allow implicit "sticky" overlays unless the schema says so.

## 8. Suggested Schema Families

Keep the schema small and typed.

Core event types:

- `box2d`
- `polyline2d`
- `keypoints2d`
- `mask_ref`
- `label`
- `state_change`
- `chapter`
- `alert`
- `telemetry_hint`

Text rendering should reference:

- string table IDs
- style IDs
- glyph atlas entries

Avoid raw repeated strings in per-frame metadata.

## 9. GPU Strategy for Overlays

### Geometry

Represent common overlays as instance data:

- rectangles
- lines
- points
- textured quads

### Text

Use a glyph atlas and batched quads. Do not perform expensive text shaping every frame in the hot path unless the use case absolutely requires it.

### Masks

For segmentation-style overlays:

- send compressed mask references or compact tiles
- decode/upload asynchronously
- render with a dedicated blend pipeline

## 10. Maintainability Rules

To keep the metadata system explainable:

- version every message family
- define strict semantics for timing and expiry
- keep the event taxonomy small at first
- separate transport schema from render schema
- provide a browser debug overlay that shows active metadata and timing offsets

## 11. Minimal Viable Metadata Set

Start with:

- frame timestamp
- box overlays
- labels
- stream events
- overlay style IDs

Defer:

- masks
- dense pose/keypoint systems
- rich text
- collaborative interaction layers

