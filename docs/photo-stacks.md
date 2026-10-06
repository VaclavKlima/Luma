# Photo stacks and capture sequences

Stacks are flat, persistent groups in the managed library. Each photograph belongs to at most one stack. A new stack starts collapsed; its cover remains an ordinary selectable and editable photograph. The separate expand button reports the member count. Derived photographs also report their immutable recipe source count, which can differ from the stack's membership.

Expanded members appear immediately below the cover with a grouping marker. The cover stays first, followed by older results and originals ordered by precise capture time, with import time as each missing date's fallback. A stack can cross a library page; the first member on the following page identifies its cover. Pages contain 60 visible photo rows. The library heading reports stored photographs, while page controls and Previous/Next follow visible rows.

Use **Actions** or a photo's context menu:

- **Group selected photos** accepts two or more ungrouped photographs of any supported format. The active selected photograph becomes the initial cover.
- **Select stack** explicitly selects every member, including members hidden by collapse or pagination.
- **Set as cover**, **Remove from stack**, and **Ungroup stack** organize photographs without changing originals, processing identities, edits, or merge recipes.
- **Group capture sequences…** starts the metadata scan described below.

Expansion and collapse preserve the active preview, selected IDs, and range anchor. The gallery names selected photographs hidden in collapsed stacks. A hidden active photograph or range anchor uses its cover's visible position for navigation and range boundaries. Clicking a collapsed cover selects only that cover. Delete confirms and moves only explicitly selected managed bundles to system Trash.

Successful merge publication unions the complete memberships of its sources' stacks, retains unused originals and older results, makes the new result the cover, and collapses the stack. Catalog version 11 backfills surviving stored merge relationships once. Overlapping relationships form a single stack with the newest result as cover; subsequent restarts respect manual changes.

Successful deletion and interrupted-removal recovery repair memberships inside the catalog transaction. Removing a cover promotes the newest surviving result, otherwise the first ordered member. Fewer than two surviving members dissolve the stack. Failed Trash calls leave memberships intact, and cancellation waits for the current OS move. Recoverable and OS-restored bundles retain the existing removal-journal behavior.

## Verified automatic grouping

The enabled profile is **Sony ZV-1A ARW continuous capture v1**. It is based on the supplied twelve originals `DSC03246.ARW`–`DSC03257.ARW`. The nine shutter-varied single shots `DSC03258.ARW`–`DSC03266.ARW` provide negative evidence. These private inputs remain in ignored local fixtures and are not licensed for redistribution.

Versioned capture records preserve model/make, available body serial, file format, original date/time, fractional digits, any recorded timezone offset, release/drive fields, and sequence counters. The bundled worker reads ExifTool's raw JSON, preserving fractions such as `006`; capture inspection does not open a RAW decoder or rebuild previews. Missing offsets remain unknown and are not inferred from the computer's timezone.

The current profile requires all of the following:

- `Make = SONY`, `Model = ZV-1A`, and ARW format.
- `ReleaseMode = 2`, `ReleaseMode2 = 1`, `ReleaseMode3 = 1`, and `SequenceLength = 0`. The verified files do not contain `DriveMode`; additional combinations need camera evidence.
- Agreement between `SequenceNumber`, `SequenceImageNumber`, and `SequenceFileNumber` on every member.
- A contiguous sequence starting at frame 1, at least two frames, strictly increasing precise timestamps, and no adjacent gap greater than one second.

Counter resets start independent sequences. Missing frames, conflicting counters or modes, simultaneous ambiguous captures, absent precise timestamps, additional cameras, and BRK modes do not qualify. Unknown continuous timing prevents automatic detection for that camera's cached metadata because an overlap cannot be ruled out. Manual grouping remains available. Candidate Sony fields are documented in [ExifTool's Sony reference](https://exiftool.sourceforge.net/TagNames/Sony.html); the reference alone does not verify capture boundaries.

Successful imports reconcile committed capture metadata across batches. An untouched automatic stack can extend when its full cached sequence becomes unambiguous, retaining its cover and expansion state. Manual grouping, cover/membership changes, removal, and ungrouping protect those choices from later scans. Existing libraries can use **Group capture sequences…** to inspect managed originals. The background task has fixed totals, per-photo errors, cancellation, and the same library-operation serialization as import, deletion, and merge publication. Cancellation can retain completed metadata inspection, but publishes no partial grouping; a later scan reuses that cache.

There is no time-only grouping, nested stack, automatic quality ranking, or automatic merging. **BRK and additional cameras remain unverified** and need independent real-sequence boundary tests before enabling their profiles.

## Storage and API

Catalog version 11 separates `stacks`, `stack_members`, `capture_metadata`, `stack_overrides`, and the gallery revision from photo edits and `derived_assets`. Member IDs are unique. Cover, ordering, origin, expansion, and stack revision survive restarts. Flat `listPhotos`, navigation, and range enumeration remain available alongside the stack-aware gallery projection.

Preload and the editing MCP server share the main-process service. Stack operations take IDs and expected revisions. Manual grouping uses the gallery revision returned by `listStacks`; cover, expansion, removal, and ungrouping use the summary's stack revision. Members are paginated. MCP exposes `luma_list_stacks`, `luma_get_photo_stack`, `luma_get_stack_members`, `luma_group_photos`, `luma_ungroup_stack`, `luma_remove_from_stack`, `luma_set_stack_cover`, `luma_set_stack_expanded`, `luma_list_gallery`, `luma_locate_gallery_photo`, `luma_get_gallery_range`, and `luma_group_capture_sequences`. No renderer filesystem access is added.

## Focused verification

Registered targets are `stack-model` and `capture-sequence` (Node), `stack-library` and `capture-metadata` (service), and `stack-ui` (Electron). The real capture test uses `LUMA_CAPTURE_FIXTURES`, defaulting to ignored `artifacts/fixtures/sony-2026-10-04`; absent private inputs are an explicit skip, not camera acceptance. Keep the existing real Sony ZV-1 embedded-preview and decoder-fallback targets selected when import processing changes.

```sh
npm run verify -- --target stack-model --target capture-sequence --target stack-library --target capture-metadata --target stack-ui
```

Affected import, deletion, merge publication, migration, and MCP regressions remain explicit selections. Comprehensive suites and benchmarks remain separate checkpoints. Automated libraries and Trash adapters are isolated from the user library.
