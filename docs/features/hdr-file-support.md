# HDR file interoperability

## Status

**Planned.** Current JPEG/PNG/TIFF import does not establish HDR interpretation. No candidate below is promised as supported until its exact format variant passes acceptance. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Import HDR files without losing their brightness range or color meaning, preserve originals, and define an evidence-based compatibility matrix for import and export.

## User workflow

Choose files through the normal import review, see detected HDR type and limitations, then edit their reconstructed float content. When only an SDR rendition can be decoded, label that limitation explicitly before acceptance and preserve the untouched original for future support.

## Controls

Show container/encoding, primaries/profile, transfer function, bit depth, and gain-map availability when known. Ambiguous metadata requires an explicit supported interpretation choice or rejection, not a filename-based HDR assumption. Advanced interpretation choices use named profiles/encodings, with preview and undoable re-interpretation after import.

## Processing approach

Register lightweight format declarations with worker decoder implementations. Decode transfer functions into the master adapter while retaining whether the source is scene- or display-referred. Validate ICC and container color metadata together, including conflicting/missing metadata, orientation, alpha, bit depth, and brightness references. PQ absolute luminance and HLG's reference/display assumptions need distinct explicit adapters and normative conformance vectors; select libraries only after these are demonstrated.

Ultra HDR's documented JPEG representation combines an SDR primary image, a secondary gain map, and interpretation metadata. Its reconstruction depends on gain parameters and display capacity; malformed metadata calls for SDR fallback. Luma's importer must retain the reconstruction metadata and derive an editable HDR rendition independently of the current monitor, while preserving the primary SDR rendition for compatibility testing. [Ultra HDR specification](https://developer.android.com/media/platform/hdr-image-format).

Research the specification's single/per-channel gains, offsets, gamma, headroom limits, metadata defaults, gain-map resampling, and orientation with reference files and independent decoders. Do not apply those rules indiscriminately to every vendor gain-map container. Luma must label a valid primary-only fallback as SDR and never call it preserved HDR. A processed SDR rendition of an imported base image is subject to the normal large-preview contract; RAW embedded camera JPEGs remain prohibited there.

The matrix below is a research queue. For each enabled row, record exact container/profile/transfer variants, codec version/license, architecture support, decoder/encoder availability, independent reader, metadata policy, and fixture evidence. Pin normative specifications and conformance vectors in the format decision record; extension or bit depth alone is insufficient evidence.

| Candidate                          | Import research                                                    | Export research                                    | Compatibility/fallback gate                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| JPEG Ultra HDR gain map            | Primary/map discovery, reconstruction, ICC/XMP validation          | SDR base plus regenerated map/metadata             | Independent HDR reconstruction and ordinary SDR reader appearance; invalid-map fallback.   |
| AVIF with PQ or HLG                | Supported bit depths, color metadata, transfer/reference handling  | HDR encoder and correct color/brightness signaling | Independent reader on each claimed platform; no assumed SDR compatibility.                 |
| HEIF/HEIC HDR or gain-map variants | Codec/container and vendor-specific auxiliary-image semantics      | Encoder availability, licensing, exact variant     | Test each variant separately; unsupported codec/map is explicit.                           |
| JPEG XL HDR                        | Float/high-depth interpretation and color metadata                 | HDR encoding and metadata round trip               | Reader availability and packaging verified per platform.                                   |
| OpenEXR                            | Scene-linear channels, chromaticities, alpha and supported layouts | Float interchange and metadata preservation        | Limit supported channels/layouts explicitly; preview through controlled output transforms. |
| Floating-point TIFF                | Sample format, profiles, range and brightness convention           | Explicit float interchange variant                 | Reject ambiguous interpretation; distinguish existing integer SDR TIFF support.            |
| Radiance HDR/RGBE                  | Dynamic range, primaries/exposure conventions and metadata limits  | Optional interchange writer                        | Document precision/color/alpha limitations and verify independently.                       |

Initial release research must choose at least one interoperable HDR import/export path plus the SDR path. Unsupported candidates remain marked Planned or rejected with reasons; full support does not mean every HDR format is implemented.

## API/MCP implications

Expose typed format capabilities and detected source interpretation through library/import APIs. Unsupported reasons name the encoding or metadata issue. Source-interpretation changes require expected revisions; import requests keep session IDs and main-owned picker access. Export consumes the same format capability registry.

## Persistence

Preserve original bytes, content hash, color/transfer/gain metadata, selected interpretation, and decoder version. Rebuild disposable masters from originals using the saved interpretation. Migrate current SDR assets without reclassifying them from extensions. Changed decoder semantics require explicit rendering compatibility and history handling.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), and existing import/provider declarations. Research can begin in stage 1; final import integration is stage 5. [Export](export.md) depends on these decisions; display hardware is not needed for numerical decoder conformance.

## Failure handling

Bound decompressed dimensions, auxiliary images, metadata, time, and memory. Reject malformed or unsupported inputs per file without aborting other accepted imports. Primary-only fallback must be labeled SDR; corrupt primaries fail. Preserve source files, cancellation behavior, and interrupted-import recovery.

## Acceptance criteria

- Every advertised matrix variant has licensed real files and independent reference vectors covering dark values, above-white values, saturated colors, orientation, alpha where supported, and metadata.
- Compare decoded linear values and color/brightness descriptors against an independent implementation within fixed codec-specific tolerances.
- Gain-map fixtures include varying headroom, per-channel parameters, reduced-resolution maps, absent optional fields, invalid required fields, and unsupported variants; verify HDR and SDR outcomes separately.
- Import, duplicate detection, cancellation, restart, interpretation history, cache rebuild, CPU fallback, and malformed-file limits pass without changing originals.
- Export/reimport and an independent viewer validate each enabled writer; publish Linux/Windows/macOS codec/reader results and unsupported reasons, separate from display capability.

## References

- [Ultra HDR specification](https://developer.android.com/media/platform/hdr-image-format), reviewed September 20, 2026; research must record the version/variant actually implemented.
- [Format declarations](../../src/main/processing/formats.ts), [decoder registration](../../src/main/processing/decoders.ts), and [runtime packaging/licenses](../runtime-dependencies.md).
