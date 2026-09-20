# SDR and HDR export

## Status

**Planned.** Individual and batch export are not implemented. [Shared requirements](README.md#shared-implementation-requirements) apply.

## Goal

Export controlled SDR and HDR renditions from original-derived or durable merged masters, with accurate color metadata and the same edit semantics as preview.

## User workflow

1. Select one or multiple photographs, await pending range selection, and freeze IDs and committed edit revisions.
2. Choose destination through a main-owned native picker, rendition/format, output profile, size, quality, metadata policy, and optional output sharpening.
3. Review filename conflicts and unavailable combinations; preview the chosen output target where supported.
4. Start a background task, continue editing, inspect fixed totals/phase progress, cancel, and review per-file results. Later edits do not silently alter the frozen job.

## Controls

Provide named SDR/HDR presets backed by explicit settings: format, bit depth, primaries/profile, transfer function, reference/peak brightness when applicable, gain-map policy, dimensions, quality, output sharpening, filename template, and metadata/privacy options. Only validated combinations are selectable. Choose Skip, Rename, or explicitly authorized Replace for existing files; preserve the original until a replacement is fully written.

## Processing approach

Render frozen settings from originals or the durable merged master at requested dimensions. Use the same ordered edit operators and versioned tone/gamut transforms as preview. Specify orientation, alpha, resizing filter, bit-depth quantization/dithering, and sharpening order. Never export the cached RGBA8 preview as the HDR source.

SDR output uses an explicit output profile and controlled highlight compression; retain a baseline sRGB option. HDR output uses an enabled format from the compatibility matrix with correct transfer/primaries/brightness metadata. Gain-map output requires a deliberate SDR base and HDR rendition derived from the same edits; regenerate their relationship after editing or resizing rather than copying an obsolete source map. Keep source metadata separate from calculated output metadata and never invent a single shutter/ISO for a merge.

Research encoders, licenses, codec/quality settings, gamut intent, quantization, and independent reader compatibility before enabling presets. Freeze pixel, color, and brightness error tolerances per output variant. Metadata defaults must explicitly address EXIF, orientation normalization, ICC/container signaling, copyright, GPS removal, thumbnails, and merge provenance; avoid copying stale dimensions or leaking internal paths.

## API/MCP implications

Design typed export/proof/start/cancel/status operations with photo IDs, expected revisions, destination grants, and validated options. Main issues an opaque destination handle through an authorized picker/application workflow; renderer and MCP do not gain arbitrary filesystem operations. Editing MCP and UI use identical job validation. Capability responses distinguish encoder availability from current display HDR support: HDR export can work while preview uses SDR.

## Persistence

Save versioned presets and an immutable job manifest containing source/master identity, settings snapshot, rendering/profile/codec versions, destination grant, output options, and naming decisions. Leases protect required assets until each export finishes; coordinate with deletion without blocking foreground preview. Revalidate destinations and permissions after restart. Initial scope records interrupted jobs for review rather than promising automatic resumption.

Write each output to a task-owned temporary file in the destination filesystem, validate it, then publish atomically where supported. Research and document platform-specific durability/rename behavior. Cleanup touches only task-owned partial files. Completed files remain after cancellation; write failures never remove pre-existing destination files or managed originals. Export does not create photo-history entries.

## Dependencies

Requires [HDR processing](hdr-processing.md), [tone mapping](tone-mapping.md), selected [HDR file formats](hdr-file-support.md), and [output sharpening](sharpening.md). Complete operator integration for curves, color, local adjustments, and denoising before accepting their export parity. Validate both [merged assets](hdr-merge.md) and imported HDR. True HDR preview is a separate hardware gate, not a prerequisite for writing valid files.

## Failure handling

Report per-file missing assets, unsupported versions, encoder failures, disk-full, revoked permissions, and collisions. A changed revision before job acceptance causes a conflict; after acceptance the frozen snapshot remains authoritative. Cancellation stops queued work and safely concludes publication in flight. Closing/quitting during export follows the task-registry confirmation and cleanup policy. Retain cancelled/error results until dismissed.

## Acceptance criteria

- Export one photo and a mixed batch of single RAW, merged, and HDR-import assets to the selected SDR and HDR formats; independent readers verify dimensions, orientation, profiles, transfer/brightness metadata, and alpha policy.
- Export/reimport retains distinguishable values above reference white for HDR within frozen codec tolerances; SDR matches the controlled rendition without mislabeled HDR claims.
- Gain-map output matches both its intended SDR base in an ordinary reader and reconstructed HDR at multiple headrooms in an independent implementation.
- Compare output proof with export pixels after identical transforms, resize, and sharpening. Validate every implemented edit operator, frozen revisions, and legacy processing versions.
- Inject disk-full, encoder crash, cancellation, deletion races, collisions, and restart at write/publication boundaries; preserve originals, existing files, completed results, and clean ownership of partial files.
- Metadata/privacy choices, batch progress totals, keyboard access, UI/MCP parity, and bounded worker memory pass. Document reader/codec results on Linux, Windows, and macOS and retain separate HDR performance evidence.

## References

- [Current tasks/library boundary](../../src/shared/contracts.ts), [editing MCP verification](../testing.md#dedicated-editing-mcp-server), and [runtime dependencies](../runtime-dependencies.md).
- [Format compatibility research](hdr-file-support.md) and [full HDR completion checklist](README.md#full-hdr-completion-checklist).
