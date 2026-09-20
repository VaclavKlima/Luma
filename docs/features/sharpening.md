# Detail and output sharpening

## Status

**Planned.** Detail sharpening and output sharpening are separate future stages. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Improve perceived detail without objectionable halos, amplified noise, or clipped HDR highlights, and tailor final sharpening to export dimensions.

## User workflow

Adjust detail sharpening at 100% after noise reduction. Inspect reduced previews with a clear scale indication. At export, choose output sharpening for the actual resized output and review its proof independently of the master edit.

## Controls

Provide Amount, Radius in source pixels, and validated threshold/detail protection using `AdjustmentInput`; Amount 0 bypasses. Output sharpening belongs in export options with Off as a valid choice. Final ranges, units, and protection semantics require algorithm evidence. Avoid making Fit look sharper by silently increasing the saved amount.

## Processing approach

Research bounded unsharp/deconvolution candidates using edges, texture, noise, and bright HDR impulses. Specify luminance versus channel processing, stage order, edge extension, negative-value policy, alpha treatment, and halo suppression. Define detail sharpening after the selected denoising stage and before final output preparation. Output sharpening uses final resized dimensions; research its placement relative to output tone/gamut mapping and encoding, then version it.

Reference calculations and measurements must quantify overshoot/undershoot, edge spread, texture retention, and noise amplification. A radius is never interpreted in CSS pixels or changed by device pixel ratio. Full-resolution computation or a validated approximation must underpin Fit; proof at 100% uses actual output pixels. Tile overlap must cover the filter support.

## API/MCP implications

Persist detail parameters via ordinary revision-checked edits. Include output parameters in typed export/proof requests and frozen job descriptors. Report source/output dimensions and the operator version so MCP can distinguish detail edits from export-only processing.

## Persistence

Migrate photo history with detail sharpening disabled. Save output sharpening in export presets/job manifests, not photo history unless a future explicit design calls for that. Include source scale, radius, algorithm version, and export resize policy in the appropriate cache identity. Legacy edits remain unchanged.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and the [noise-reduction](noise-reduction.md) stage contract. Detail sharpening can ship before export; output sharpening acceptance is completed with [export](export.md).

## Failure handling

Validate radius and allocation bounds before committing settings. On unsupported GPU operations, use the bounded reference CPU path. Export must report an unsupported sharpening mode rather than silently omitting it. Stale proof jobs cannot replace the active photo preview.

## Acceptance criteria

- Amount 0 is identical to baseline; flat fields remain unchanged and alpha is preserved.
- Edge/impulse fixtures meet predeclared overshoot, halo-width, and noise-amplification thresholds across SDR and 16×-white samples.
- Verify native 100%, Fit, multiple device pixel ratios, and two export sizes; radius behavior follows source or output pixels as specified.
- Tiled and reference output agree within fixed tolerances without seams; test CPU/GPU fallback, bounded memory, and cancellation.
- Detail history/restart, export preset round trips, UI/MCP parity, and preview/export proof agreement pass with real noisy and merged fixtures.

## References

- [Native-pixel preview contract](../../README.md#preview-controls), [input design](../input-design.md), and [noise reduction](noise-reduction.md).
- [Export output preparation](export.md).
