# Natural rendering and full HDR roadmap

**Status: staged roadmap.** The [experimental Sony RAW HDR milestone](../hdr-processing.md) implements a limited processing, display, tone-mapping and analysis foundation. The broader workflow below remains planned. Each feature brief uses the same eleven sections and includes measurable acceptance criteria. Unresolved algorithms, dependencies, and numerical tolerances require recorded research evidence before implementation is accepted.

The destination is **RAW brackets or HDR files → nondestructive HDR editing → HDR and SDR preview → HDR and SDR export**. A single RAW photograph uses the same foundation without requiring a merge. Natural rendering means believable color, smooth highlights, useful shadow depth, and controlled detail, with explicit creative controls.

## Current capabilities

The [root README](../../README.md) describes the running application. It imports JPEG, PNG, TIFF, and Sony ARW into a persistent managed library. Exposure, contrast, highlights, shadows, whites, blacks, verified Sony RAW white balance, and verified lens corrections share revision-checked history. SDR histograms, clipping overlays, comparison, pixel inspection, and the dedicated editing MCP service exist. Other color controls remain disabled; the console cannot execute commands.

Legacy processing retains RGBA8 sRGB output. The separate experimental HDR path uses Float32 Rec.2020 working data and HDR/SDR output targets. Current support for a container such as JPEG or TIFF does not establish HDR decoding, gain-map support, or HDR export. Sony ZV-1 compressed ARW has a real fixture; additional cameras and recording modes require their own verification. Existing Linux results do not establish Windows/macOS support.

## Workspace feedback backlog

Open tasks from user feedback. Numbers preserve the reported order; the Delete issue still needs reproduction.

- [ ] **1. Bug — Delete key does nothing with a photo selected.** Reproduce and fix the shortcut so it opens the existing deletion confirmation for the selected photos. Preserve text-field and console keyboard behavior, pending range selection, and system Trash handling.
- [ ] **2. Improvement — Zoom and pan in Merge to HDR review.** Support pointer-centered wheel zoom, dragging, Fit, 100%, and scoped keyboard controls consistently with the normal preview. Use the review image's actual dimensions when showing its zoom percentage.
- [ ] **3. Improvement — Collapse merge sources behind the result.** Show the merged photo as the cover of a stack, with an accessible icon and source count to expand or collapse its originals. Keep originals available for individual browsing and editing, and retain the grouping across restarts. Collapsing sources never deletes them.
- [ ] **4. Feasibility — Automatically group a capture sequence.** Investigate reliable camera metadata for photographs taken during one continuous-shutter or BRK sequence. Reuse the expandable stack from item 3; allow manual grouping and ungrouping when sequence identity is missing or ambiguous. Grouping does not automatically merge photos.
- [ ] **5. UI cleanup — Remove Inspect center pixel.** Remove the button from the regular preview toolbar; retain useful pixel inspection through the agent/MCP API.
- [ ] **6. UI cleanup — Remove technical analysis details below the histogram.** Keep the histogram and useful clipping controls visible; retain detailed statistics through the agent/MCP API.
- [ ] **7. UI cleanup — Move Lens corrections lower in the inspector.** Place the section below the main editing controls and collapse it by default. Keep automatic corrections and existing per-photo overrides available.
- [ ] **8. Improvement — Show compact metadata in the preview toolbar.** Use the space freed by item 5 for useful available metadata, such as camera, lens, shutter speed, aperture, and ISO. Keep it readable at 1100 × 700 with the console open, and avoid inventing a single exposure for merged photos.

## Implementation order and dependencies

The briefs describe the complete destination; experimental subsets do not imply completion of every acceptance criterion. The prerequisites below are also repeated in each brief. A display feasibility spike uses synthetic float patterns before a production HDR pipeline exists; final display acceptance follows the processing and tone-mapping foundations. This separation avoids a circular dependency.

| Stage | Brief                                                  | Required foundation and deliverable                                                                                                          |
| ----- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | [HDR display](hdr-display.md)                          | First prove or rule out the Electron presentation path on actual HDR hardware; record platform limitations.                                  |
| 1     | [HDR processing](hdr-processing.md)                    | Use feasibility findings to define a versioned float master, color/brightness contracts, bounded scheduling, and legacy compatibility.       |
| 2     | [Bounded Sony HDR/noise merge](../merge-processing.md) | Existing experimental Sony HDR pipeline; permanent masters, shared review and tasks before broader camera-profile work.                      |
| 2     | [Camera color profiles](camera-color-profiles.md)      | Processing contract; verified characterization and neutral rendering for supported cameras.                                                  |
| 2     | [Tone mapping](tone-mapping.md)                        | Processing and characterized color inputs; separate controlled SDR and HDR display transforms. Complete production display integration here. |
| 3     | [HDR analysis](hdr-analysis.md)                        | Processing, tone mapping, and display target descriptors; distinguish scene, display, and source clipping.                                   |
| 3     | [White balance picker](white-balance-picker.md)        | Processing, camera profiles, and existing white-balance/history service.                                                                     |
| 3     | [Vibrance and saturation](vibrance-saturation.md)      | Processing, camera profiles, and tone mapping.                                                                                               |
| 3     | [Tone curves](tone-curves.md)                          | Processing and tone mapping; coordinate semantics must cover HDR values.                                                                     |
| 3     | [Color mixer](color-mixer.md)                          | Processing, tone mapping, and the color model validated for vibrance/saturation.                                                             |
| 3     | [Noise reduction](noise-reduction.md)                  | Processing and camera/noise characterization; synthetic merge-like inputs suffice before merge integration.                                  |
| 3     | [Sharpening](sharpening.md)                            | Processing, tone mapping, and noise-reduction stage contract; output branch completed with export.                                           |
| 3     | [Local adjustments](local-adjustments.md)              | Processing and global operators; reuse color controls where offered and gate other local operations until supported.                         |
| 4     | [HDR merge](hdr-merge.md)                              | Processing, camera profiles, tone mapping, and existing library/task services; integrate analysis and detail processing.                     |
| 5     | [HDR file support](hdr-file-support.md)                | Processing and tone mapping; validate format adapters independently of display hardware.                                                     |
| 5     | [Export](export.md)                                    | Processing, tone mapping, file-format decisions, output sharpening, and completed edit operators; validate merged and imported assets.       |
| 5     | Final platform verification                            | Re-run display, analysis, file interoperability, export, and complete workflow acceptance on Linux, Windows, and macOS.                      |

Format and licensing research may begin early. These stages order production integration, not every experiment. No user-facing control becomes available merely because its brief exists. General crop/straighten, automatic masks, terminal execution, and cloud features remain outside these briefs; merge's valid-area crop is included.

## Shared implementation requirements

- Preserve originals byte-for-byte. Use the shared application edit service, expected revisions, and photo-wide Undo/Redo for every persisted adjustment. Numeric sliders use [AdjustmentInput conventions](../input-design.md); specialized editors provide equivalent keyboard and cancellation behavior.
- Extend settings and catalog schemas transactionally, including every history snapshot, redo branch, cursor, and timestamps. Current settings v5/catalog schema 8 are the starting point, not reserved future version numbers. Legacy render behavior remains versioned; offer an explicit undoable processing upgrade instead of silently changing existing photographs.
- Keep camera aliases and characterization in providers, native processing in separate workers, and filesystem access in main. Preserve the sandbox, context isolation, typed bridge, photo/session IDs, and MCP parity. Proposed operations in briefs are contracts to design, not existing APIs. No generic command runner or arbitrary filesystem bridge is introduced.
- Version all pixel-affecting algorithms and include source identity, parameters, profiles, master format, and output transform in appropriate cache keys. Distinguish content identity from edit revision. Validate dimensions, layout, byte counts, hashes, color descriptors, and finite float samples before presentation.
- Keep durable originals and merged masters outside disposable caches. Preserve the 2 GiB preview LRU, leases, one foreground request, cancellation, and current allocation bounds unless an explicit measured redesign replaces them. HDR needs tiling or bounded degradation, not unbounded full-image copies. Preview work stays outside the import/deletion task lock.
- Keep quick review/gallery previews separate. Never show a camera JPEG in the large preview. A placeholder must match the frame's revision and rendering identity, including its output target. HDR fallback uses a controlled SDR rendition of the same edits, with an accurate mode indicator.
- Preserve native decoded dimensions, CSS-pixel zoom, normalized pan, stale-result rejection, retry behavior, and pointer-capture cleanup. Verify 1100 × 700 with the console open, independent scrolling, keyboard access, and non-color status cues.

## Evidence and acceptance policy

Each brief inherits these gates. Algorithm research must produce a decision record naming candidates, licenses, versions, supported inputs, numerical reference results, and rejected alternatives. Where a tolerance is still open, record the metric, fixed threshold, fixtures, and hardware before implementation approval; an unfilled tolerance is a release blocker. Use independent references, not self-comparison alone.

Future implementations select [verification scopes](../testing.md) explicitly. Preserve the real Sony fixture through embedded and decoder-fallback import paths, existing CPU/GPU and cache/persistence regressions, the 15% uncorrected preview regression gates, and warmed interaction p95 ≤33 ms on the established reference hardware. Measure HDR decoding, merging, memory, computation, and actual Electron presentation separately; publish input dimensions, bracket count, hardware, and cold/warm results. Do not weaken SDR gates to accommodate HDR cost.

Keep licensed real bracket sequences with translations, rotations, parallax, moving people, foliage, and water, plus independently generated ramps, charts, malformed files, and known exposure ratios. Test persistence, concurrency, interrupted writes, cancellation, deletion, MCP parity, and accessible UI. Use isolated profiles, library fixtures, and Trash adapters. Hardware display measurements and independent export round trips are mandatory; screenshots alone cannot establish HDR luminance. Evidence belongs under ignored `artifacts/verification/`, with fixture attribution in `tests/fixtures`.

This documentation delivery only checks Markdown formatting, relative links, section/feature coverage, dependency consistency, and agreement with current repository contracts. Application tests and benchmarks are unnecessary for this delivery.

## Full HDR completion checklist

- [ ] Single RAW, real RAW brackets, and each supported HDR import preserve highlight range throughout nondestructive editing and restart.
- [ ] All editing controls in this roadmap work across the documented HDR range, share UI/MCP history, and preserve legacy edits.
- [ ] Merges handle alignment and subject motion separately, retain durable masters and reproducible provenance, and report impossible cases.
- [ ] True HDR presentation is measured on supported hardware; brightness headroom, monitor changes, context loss, and SDR fallback are verified.
- [ ] The same edits produce a controlled SDR rendition with explicit gamut and highlight handling.
- [ ] SDR and HDR individual/batch exports preserve intended appearance and metadata through independent round trips; gain-map outputs have a verified SDR base where supported.
- [ ] Statistics distinguish retained HDR values, target clipping, gamut limits, and known sensor saturation without inventing missing measurements.
- [ ] Linux, Windows, and macOS compatibility records identify tested OS/runtime/GPU/driver/display combinations and explicitly mark unsupported or unverified configurations. Unsupported platforms must show the limitation and usable SDR behavior; an all-platform HDR claim requires measured HDR success on all three.
- [ ] Memory, preview regression, interaction performance, persistence, migration, failure recovery, accessibility, and MCP acceptance gates pass with retained evidence.

## References

- [Product direction](../../Luma.md), [RAW contracts](../raw-processing.md), and [provider contribution guide](../../src/main/processing/README.md).
- [HDR display feasibility source](https://developer.chrome.com/blog/new-in-webgpu-129) and [Ultra HDR format specification](https://developer.android.com/media/platform/hdr-image-format); their implications and required experiments are scoped in the display and file briefs.
