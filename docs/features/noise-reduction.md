# Noise reduction

## Status

**Planned.** Luminance and chroma noise reduction are not implemented. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Reduce distracting noise while preserving real texture, fine edges, and HDR shadow detail in single RAW and merged photographs.

## User workflow

Inspect the photo at 100%, adjust luminance and chroma reduction, compare texture and edges, then assess the result at Fit. A merged image may have spatially varying noise and must not inherit a single source ISO as its noise model.

## Controls

Use separate Luminance and Chroma strength inputs, proposed 0…100 with 0 bypass. Add detail/edge protection only when its behavior has been validated. Provide scale-aware feedback when a reduced preview cannot show final detail. No automatic strength change should silently rewrite existing edits.

## Processing approach

Research bounded, tileable classical methods before committing to a library or learned model. Compare denoising in sensor, linear working, and suitable luminance/chroma domains; document placement relative to demosaic, merge, local edits, and sharpening. Use known-noise synthetic inputs and paired low/high-noise captures to measure texture loss, edge spread, chroma error, and residual noise power.

Noise estimates should use validated camera/ISO information where available and measured image statistics otherwise, with confidence recorded. For merges, account for exposure weighting, rejected samples, and deghosted reference regions. Imported HDR needs a distinct estimation path when no sensor data exists. Preserve above-white values, legitimate chroma, negative-channel policy, and alpha. Tiled processing requires defined overlap and no visible seams.

Research must freeze the algorithm, dependency/license, support range, reference metrics and thresholds, and bounded CPU/GPU behavior. Do not promise recovery of detail absent from the input or add generated detail without a separate feature decision.

## API/MCP implications

Extend edit patches with validated strengths and operator version. Capabilities report supported input domains and whether an automatic estimate is available. Any estimated strength proposal commits through the same revision-checked edit service as manual controls.

## Persistence

Migrate history with bypass defaults. Persist strengths, selected model/version, and any accepted automatic parameters so restart does not silently re-estimate a different result. Distinguish prepared denoising caches from immutable masters and version their identities by stage and source.

## Dependencies

Requires [HDR processing](hdr-processing.md) and [camera characterization](camera-color-profiles.md). Define merge-like noise fixtures before [HDR merge](hdr-merge.md), then verify real merged inputs during integration. [Sharpening](sharpening.md) consumes denoised output at its documented stage.

## Failure handling

Missing calibration disables only the calibrated estimator, with a supported manual path if available. Excessive allocations fail safely or use bounded CPU processing. A render failure must not silently bypass a saved nonzero denoising setting in export.

## Acceptance criteria

- Zero strength reproduces the input; synthetic and paired real captures meet fixed noise-reduction and texture-retention thresholds recorded before algorithm approval.
- Verify dark textures, skin, stars, saturated highlights, and fine repeating detail at native scale; quantify edge broadening and chroma bleeding.
- Merged fixtures include regions sourced from one frame and multiple frames; demonstrate no denoising seam across deghost boundaries.
- Compare CPU/GPU and tiled/untiled references within foundation tolerances; test alpha, extreme HDR values, memory bounds, and cancellation.
- History, restart, migration, combined local edits, UI/MCP parity, and full-resolution export equivalence pass; report processing cost separately.

## References

- [RAW processing stages](../raw-processing.md), [camera characterization](camera-color-profiles.md), and [HDR merge provenance](hdr-merge.md).
- [Verification and fixture isolation](../testing.md).
