# White balance picker

## Status

**Planned.** Temperature, Tint, and As Shot already exist for verified Sony RAW; the picker does not. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Set white balance from a neutral area without sampling tone-mapped screen pixels or confusing clipped highlights with neutral material.

## User workflow

Activate the picker, move its sample area over the photo, inspect sample validity, and apply a valid neutral measurement. Temperature and Tint update together in one history entry. Escape leaves confirmed settings unchanged; As Shot restores original gains through the existing service.

## Controls

Provide a keyboard-focusable picker toggle, sample-size control, and readable validity feedback. Support keyboard positioning or numeric normalized coordinates and an explicit Apply action. Keep the existing Temperature/Tint input ranges and gestures unless the provider contract is deliberately extended. Picker interactions must release capture on cancel, photo change, or loss of focus.

## Processing approach

Sample a robust neighborhood from linear, pre-creative-adjustment data, with the inverse geometry mapping needed for orientation, crop, zoom, and lens corrections. Use source saturation/black-level information where available. Exclude transparent, invalid, clipped, and near-black samples; reject a region with insufficient valid coverage rather than inventing a neutral estimate.

Research robust median/trimmed estimation and the inversion into the current white-balance provider's Kelvin/Tint model. Record minimum luminance, valid-pixel fraction, channel-saturation thresholds, and residual neutral error before implementation approval. Do not clamp an unrepresentable illuminant silently into the UI range. Color profiles and as-shot gains must be applied exactly once. Mixed lighting may have no single global solution; report sample uncertainty. Merged and imported HDR assets require declared white-balance capability and source semantics, not guessed camera metadata.

## API/MCP implications

Design a read-only sample proposal operation taking photo ID, expected revision, normalized position, and bounded sample area. Return validity, provider identity, estimated settings, sample counts, and residual error. Applying the proposal uses the existing revision-checked edit service; sample coordinates never grant filesystem access. MCP and UI share the same estimator.

## Persistence

Persist resulting Custom white balance using shared history. Picker position and hover feedback are transient. Sampling provenance may accompany the edit for explanation, but playback uses saved settings/provider version rather than resampling. If the current settings type suffices, no new independent adjustment or history stack is needed.

## Dependencies

Requires [HDR processing](hdr-processing.md), [camera color profiles](camera-color-profiles.md), and existing white-balance/history services. Support for merged/HDR imports follows their capability adapters; initial availability can remain limited to verified RAW.

## Failure handling

Give distinct reasons for clipping, darkness, mixed samples, unsupported input, and out-of-model estimates. A stale revision or changed photo discards the proposal. No failed sample changes settings. Retain manual Temperature/Tint and As Shot where currently supported.

## Acceptance criteria

- Known neutral patches under at least two measured illuminants recover neutrality within a fixed residual tolerance selected during research.
- Tests reject clipped channels, black, transparency, tiny valid regions, and unsupported camera profiles without adding history.
- Cropped, rotated, panned, Fit, and 100% samples identify the same source area within the documented pixel-boundary rule.
- One accepted sample creates one combined edit; Undo/Redo, restart, concurrent MCP edits, Escape, and As Shot pass.
- Keyboard-only use works at 1100 × 700 with the console open, and sampling does not alter originals or display mode.

## References

- [White-balance model](../../src/shared/white-balance.ts), [edit service contracts](../../src/shared/edits.ts), and [input design](../input-design.md).
- [Current white-balance processing](../raw-processing.md#white-balance-statistics-and-comparison).
