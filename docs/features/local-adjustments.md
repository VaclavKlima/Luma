# Local adjustments

## Status

**Planned.** Manual brush, linear-gradient, and radial-gradient masks are in scope; automatic subject/sky masking is not. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Apply local light and color corrections nondestructively, using the same HDR-compatible operators and history as global edits.

## User workflow

Create a named mask, paint or position its geometry, refine with add/subtract strokes, and change supported local parameters. Toggle visibility or inspect coverage before committing. Undo can restore both mask geometry and associated adjustments.

## Controls

Offer a mask list with select, rename, enable, duplicate, and delete; brush size/feather/flow; gradient handles and numeric geometry; invert; and a coverage overlay. All geometry has keyboard alternatives, and numeric sliders use `AdjustmentInput`. Define shortcuts scoped to the preview so gallery, text, and console remain independent. Initial local parameters include Exposure and supported tonal/color operators; unavailable ones stay disabled.

## Processing approach

Store masks in stable normalized source coordinates with explicit transforms through orientation, lens geometry, and merge crop. Evaluate feathering and brush coverage in a documented metric independent of current zoom. Research stroke resampling, pressure support, blend semantics, and tile overlap using deterministic reference masks. Define combination rules for add/subtract/invert and the ordered composition of multiple local adjustments.

Blend in an appropriate linear/HDR domain; do not apply local edits to tone-mapped SDR pixels. Define whether local color temperature is a creative relative correction or a physical camera balance; it cannot inherit RAW Kelvin meaning automatically. Generate bounded mask tiles and mipmaps, maintain edge continuity, and include allocations in the processing budget. Geometry edits must not force a new RAW decode.

## API/MCP implications

Design typed operations for mask IDs, bounded stroke arrays, normalized geometry, and local parameter patches. Commit compound mask/parameter changes through one revision-checked service. MCP can enumerate and modify the same masks; never expose arbitrary shader code or mask-file paths.

## Persistence

Version mask coordinates, rasterization, blend rules, and local operator order. Store durable geometry and referenced stroke data with the photo, outside preview caches. History snapshots reference immutable mask content; garbage collection must retain every current/undo/redo reference. Migrate legacy settings with an empty mask list.

## Dependencies

Requires [HDR processing](hdr-processing.md), coordinate contracts, and implemented global operators including [vibrance/saturation](vibrance-saturation.md) for local color intensity. [Tone mapping](tone-mapping.md) follows the local stage. Future geometry changes must preserve mask placement; automatic masking is separate.

## Failure handling

Bound stroke count and tile memory; report complexity limits before accepting an unrenderable edit. Cancel interrupted gestures without orphaning durable mask data. Missing historical mask content is an explicit render error. Resolve concurrent edits through expected revisions, not silent mask replacement.

## Acceptance criteria

- Zero coverage and neutral local settings preserve baseline output; full coverage equals the corresponding global operator at the defined stage.
- Synthetic brush/gradient references verify feather falloff, inversion, add/subtract, overlap, and tile seams within fixed tolerances.
- Masks remain registered after zoom, pan, orientation, lens toggles, and merge crop; test edges at Fit and 100%.
- Multiple masks, Undo/Redo, redo branching, restart, migration, deletion, cancellation, and missing-content recovery retain valid durable references.
- Keyboard-only creation/refinement and UI/MCP equivalence pass; enforce memory bounds and measure interaction latency separately for complex masks.

## References

- [Geometry conventions](../raw-processing.md), [preview geometry](../../src/renderer/src/preview/geometry.ts), and [input design](../input-design.md).
- [HDR processing and allocation policy](hdr-processing.md).
