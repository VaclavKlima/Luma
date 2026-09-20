# Color mixer

## Status

**Planned.** Individual color-range controls are not implemented. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Adjust hue, saturation, and luminance of selected color ranges while preserving smooth transitions, useful shadow detail, and HDR headroom.

## User workflow

Select a named color range, adjust its Hue/Saturation/Luminance controls, and inspect affected regions in the normal preview and comparison. Multiple range adjustments remain a single ordered part of the photo's edit pipeline.

## Controls

Start with named red, orange, yellow, green, aqua, blue, purple, and magenta ranges. Use `AdjustmentInput` with neutral zero for each dimension. Define hue units, control ranges, and actual range boundaries in the research record; UI colors supplement text labels. An optional affected-area overlay is transient and must also be keyboard accessible.

## Processing approach

Use the HDR color model validated for global color intensity. Specify circular hue weights, overlap normalization, and neutral/low-chroma protection. Weights should derive from the input hue to the mixer stage so changing one range cannot unpredictably cascade into another. Resolve all ranges in one documented operator, with circular interpolation at the red wrap boundary.

Research how range luminance changes affect chroma and how to preserve hue near black and extreme highlights. Define precedence relative to global vibrance/saturation, curves, and local color adjustments in the versioned graph. Preserve values above white and alpha; leave final gamut compression to the output stage. Record smoothness and selectivity metrics before freezing the model.

## API/MCP implications

Accept validated patches keyed by stable range IDs and dimension, with expected revision. Return range definitions and units as capabilities. Combined patches commit atomically through the existing service. Neither range selection nor overlay visibility creates a photo edit.

## Persistence

Add zero-valued ranges to every historical settings snapshot transactionally. Persist range-definition and operator versions so later boundary tuning does not alter old edits. Include all range values in downstream frame identities; preserve upstream data reuse.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and the validated model from [vibrance/saturation](vibrance-saturation.md). Local mixer support, if offered later, also uses [local adjustments](local-adjustments.md).

## Failure handling

Reject unknown ranges, invalid dimensions, and nonfinite values. Unsupported processing versions remain clearly unavailable. GPU loss uses the same bounded CPU operator; failures never rewrite confirmed settings or original pixels.

## Acceptance criteria

- All-zero mixer output is identical to the preceding pipeline; changing one range follows its documented influence weights on a synthetic hue wheel.
- Dense hue sweeps cross 0°/360° and every range boundary without discontinuities above the fixed research tolerance.
- Near-neutral colors remain stable; exercise dark, saturated, and 16×-white samples, preserving finite values and alpha.
- Compare RGB/hue/luminance errors against the independent reference with fixed tolerances; test overlapping extreme settings and CPU/GPU agreement.
- Shared history, migrations, restart, stale revisions, keyboard use, and equivalent UI/MCP edits pass.

## References

- [Vibrance/saturation color model research](vibrance-saturation.md), [input conventions](../input-design.md), and [shared edits](../../src/shared/edits.ts).
