# RAW processing and lens corrections

Luma registers repository modules for RAW decoding, verified camera capabilities, and lens correction. Runtime plugin installation and Lensfun database shipping are deferred.

For implementation steps, registration examples, versioning, and contributor checks, see [Adding lens corrections and image processors](../src/main/processing/README.md).

## Module contracts

- `src/main/processing/contracts.ts` defines `RawDecoder`, `RawSession`, `CameraProfile`, `LensCorrectionProvider`, and `LinearFrame`.
- `processing/formats.ts` contains lightweight decoder declarations used by both native pickers and import scanning. `processing/decoders.ts` registers worker implementations. Add an implementation and its declaration together; keep extension lists in the declaration.
- `processing/cameras.ts` registers camera modules. Sony ZV-1 and ZV-1A share `cameras/sony-zv1.ts`. Camera names and verified CFA requirements belong here, not in GPU algorithms or the viewer. LibRaw decoder support does not imply verified GPU support. Other layouts use CPU processing; unsupported compression needs a decoder update or another decoder.
- `processing/metadata.ts` registers lens providers. A provider resolves numeric metadata into radial tables and independent unavailable reasons. `tests/lens-correction.spec.ts` registers a test-only second camera and calibrated provider without changing orchestration or the viewer.

LibRaw and native Dawn stay in the bundled Node worker. Main imports only lightweight declarations and pure processing utilities. The renderer receives photo IDs, settings, status, and validated display frames; it has no filesystem or native-resource access.

### Coordinates, color, and ownership

`RawSource` contains owned, unpacked sensor samples, active dimensions, stored row width, active left/top margins, CFA order, black levels, white balance, camera matrix, and LibRaw flip. The Bayer reader handles storage margins before demosaicing. Camera profiles declare active-sensor coordinates and final decoder orientation.

A `LinearFrame` is an owned, interleaved RGBA `Float32Array`: unrotated active-sensor camera RGB, white-balanced, normalized to 0–1 sensor units, with padding alpha. It has no camera-to-sRGB matrix, display curve, or lens correction. The CPU adapter requests linear 16-bit camera output from LibRaw, then normalizes the memory-image API's oriented storage back to sensor coordinates. GPU AHD writes the corresponding camera RGB into a worker-owned `rgba32float` texture. The CPU and GPU retain at most one photo's intermediate; these SDR intermediates are not HDR editing masters.

Corrections run in this order:

1. Decode and demosaic into linear camera RGB.
2. Evaluate vignetting gain in source sensor coordinates.
3. Combine distortion and lateral chromatic aberration into one inverse radial mapping. CPU and GPU use Catmull–Rom bicubic interpolation with the same edge extension. The GPU applies gain to each source tap before interpolation, which avoids another full-sized texture.
4. Apply the camera matrix, histogram-based brightness, and SDR sRGB display curve.
5. Apply final orientation and write RGBA8 plus its exact 96-pixel placeholder.

The original uncorrected path remains available when all corrections are off. A centered crop excludes unmapped borders and preserves the original aspect ratio to integer-pixel rounding. The crop uses native pixel spacing and never resizes back to the original dimensions. Decoded/cropped dimensions are authoritative for 100% and Fit. On the checked-in fixture, all corrections yield 5422 × 3622 versus 5496 × 3672 uncorrected.

The shared 4096-entry radial lookup contains red/green/blue coordinate scales and vignetting gain. It is independent of camera metadata syntax. Radius is normalized by the active image half-diagonal, measured from the center of pixel centers. The crop checks each edge pixel and each channel; providers must supply monotonic radial mappings. Taps at a valid border extend the outermost pixel.

### Sony embedded tables

Read ExifTool with `-G1 -n`. Prefer `SubIFD:DistortionCorrParams`, `SubIFD:VignettingCorrParams`, and `SubIFD:ChromaticAberrationCorrParams`; use the corresponding `SR2SubIFD` tags when absent. Do not use `Sony:DistortionCorrParams`, which describes a different maker-note field and is all zero in the fixture.

Each table has its own count prefix, followed by signed coefficients and optional zero padding. Chromatic aberration counts both channels, with red followed by blue. The fixture contains 11 distortion samples, 16 vignetting samples, and 22 chromatic-aberration coefficients (11 per channel). A missing or malformed table disables only that correction. Numeric fields are stored separately from formatted inspector strings.

For a table of N samples, sample radii are `(i + 0.5) / (N - 1)`. Distortion scale is `1 + value / 16384`; red/blue scales are `1 + value / 2097152`. Vignetting gain is `2 ** (2 ** (value / 8192 - 1) - 0.5)`. Values outside the supported ranges, malformed counts, nonfinite values, nonzero padding, and non-monotonic geometry are rejected. Each provider version and its parsed numerical result contribute to correction identity.

The correction order follows the [Lensfun modifier documentation](https://lensfun.github.io/manual/latest/structlfModifier.html). Sony coefficient interpretation was cross-checked against the upstream [darktable implementation](https://github.com/darktable-org/darktable/blob/master/src/iop/lens.cc) and [RawTherapee implementation](https://github.com/Beep6581/RawTherapee/blob/dev/rtengine/lensmetadata.cc). Luma's TypeScript and WGSL correction implementation is independently written; no Lensfun database or upstream lens module is bundled. Existing AHD attribution remains in `third_party/libraw`.

## Catalog, requests, and cache

Schema version 3 adds a `processing` table containing numeric metadata, independent settings, and a monotonically increasing settings revision. Imports publish the photo and processing row in one SQLite transaction. Existing photos lazily read metadata from their managed originals using a serialized metadata worker. No source files or reimport are needed. Bump `PROCESSING_METADATA_VERSION` when extraction or provider interpretation changes; older metadata is then reloaded lazily while preserving settings and their revision. Deleting a photo also removes its processing row through a catalog trigger.

`getLensSettings(photoId)` and `updateLensSettings(photoId, kind, enabled)` are narrow typed bridge operations. Updates validate the ID, setting name, boolean, and supported correction. Main serializes writes and emits `lensChanged`. The renderer updates controls immediately, reconciles confirmed state, cancels obsolete requests, and checks revisions before presenting pixels. Same-photo updates preserve normalized zoom/pan and stop pointer capture.

Preview cache v3 keys variants by original hash, module versions, correction-data identity, settings, and crop policy. Revisions identify requests, while identical settings can reuse an older pixel variant with the current revision. All variants and their matching placeholders share the existing 2 GiB LRU budget and stream leases. Regeneration invalidates the selected variant; deletion invalidates every variant. Originals remain byte-for-byte unchanged.

GPU buffers are released after demosaicing before allocating the corrected texture. GPU allocations remain subject to the existing 1 GiB estimate and device limits; CPU retained float data is limited to 384 MiB. Changing supported corrections can reuse the active linear frame; cancelling work can terminate the worker. Changing photos, deletion, worker release, shutdown, and the 30-second idle timeout release retained resources. CPU workers may remain warm for corrected frames. Preview work stays outside the import/deletion task lock.

## Contributor verification

Run `npm run check`, `npm run benchmark:preview`, and `npm run mcp:test`. The real camera fixture's provenance and license remain in [tests/fixtures/README.md](../tests/fixtures/README.md); do not add private photographs to fixtures. Embedded JPEGs may be inspected for framing, never used as corrected preview pixels or color references.

Coverage includes uncorrected LibRaw regression, independent/malformed/unequal Sony tables, linear CPU output, synthetic grids, falloff and displaced channels, centered crops and portrait orientation, full-resolution CPU/GPU agreement, linear reuse, exact placeholders, settings revisions, cache variants/restart/removal, lazy catalog migration, rapid UI updates, native zoom, and the minimum console layout. Existing tests cover real embedded and decoder-fallback imports, cancellation, stale work, hardware loss, stream leases, and shutdown.

The benchmark reports correction time separately and compares CPU/PNG, CPU/RGBA, GPU/RGBA, corrected CPU/RGBA, and corrected GPU/RGBA through actual Electron presentation. Save a pre-change `benchmark.json` outside `test-results`, then set `LUMA_PREVIEW_BASELINE=/absolute/path/benchmark.json` for the post-change run. This adds the required 15% uncorrected CPU/GPU regression gate. The corrected GPU must remain faster than corrected CPU. Run benchmark samples without other GPU tests in parallel.

### Local results — September 15, 2026

Linux/Radeon RX 7900 XTX, bundled Node 24, checked-in Sony ZV-1 fixture; four measurements per path with independent workers. Times include generation, streamed loading, integrity validation, and actual Electron canvas presentation.

| Path                 | Before this change | After this change |
| -------------------- | -----------------: | ----------------: |
| Uncorrected CPU/RGBA |            2664 ms |           2701 ms |
| Uncorrected GPU/RGBA |             695 ms |            707 ms |
| Corrected CPU/RGBA   |                  — |           5297 ms |
| Corrected GPU/RGBA   |                  — |            747 ms |

The first-display regression gate passed: CPU +1.4%, GPU +1.7%. Corrected GPU was 7.1× faster than corrected CPU. Corrected GPU added approximately 40 ms to first display compared with uncorrected GPU. Cached GPU presentation was 34.7 ms versus 33.4 ms for the legacy PNG path in the same run, passing the existing 15% relative cached-presentation gate. Animation-frame waits depend on compositor refresh timing, so cached wall times should be compared within the same run.

The full-resolution corrected CPU/GPU comparison had mean absolute difference 0.00321 on the 0–255 scale; 0.00965% of RGBA components differed by more than two levels. These are fixture results, not guarantees for every photograph. The correction-stage diagnostics include resampling and downstream color work; the CPU stage also includes its final display conversion.

Verification passed: `npm run check` (67 tests; opt-in benchmark skipped there and run separately), six final focused Electron preview tests, two final RAW regressions, the extended benchmark with the saved baseline gate, `npm run mcp:test`, and `npm run mcp:check`. Direct `luma_ui` MCP inspection also verified the isolated development window and compact console layout. Generated evidence is under `artifacts/verification/` and `artifacts/mcp/`, outside version control. The test harness reloads its existing Electron window for MCP persistence checks because the MCP navigation tool intentionally blocks file-URL navigation.

Import-review and gallery thumbnails remain quick previews. General editing, HDR, manual profile selection, longitudinal chromatic-aberration correction, and native terminal execution are separate milestones. Windows/macOS hardware and packaging require independent verification.
