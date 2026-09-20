# Luma

A local desktop photo editor with an integrated agent console. The current milestone provides **photo import, a persistent local library, nondestructive exposure, contrast, highlights, shadows, whites, blacks, and lens edits, shared Undo/Redo, camera-aware RAW white balance, RGB histograms, clipping overlays, Before/After comparison, and pixel inspection** in an Electron desktop workspace.

The full product direction, including RAW processing, persistent edits, HDR, and agent-driven editing, is described in [Luma.md](Luma.md).

The [natural rendering and full HDR roadmap](docs/features/README.md) contains planned implementation briefs, dependencies, and completion criteria for RAW brackets or HDR files → nondestructive HDR editing → HDR/SDR preview → HDR/SDR export. These features are **Planned**; the current preview remains SDR and export is not implemented.

## Start developing

Use Node.js **24 or newer** and npm. Node.js **24 LTS** is the recommended development version, also recorded in `.nvmrc`. Run these commands from the repository root:

```sh
npm ci
npm run dev
```

`npm ci` installs the exact versions in `package-lock.json`. Use `npm install` when intentionally adding or updating dependencies, and include the resulting lockfile changes.

Electron downloads its runtime on first use if it is not already installed. To download it explicitly after `npm ci`, run `npm run setup:electron`. Dependency installation and the first runtime download require network access; subsequent launches and photo imports work offline.

To build and launch the built application:

```sh
npm run build
npm start
```

Development and test launches require a graphical desktop session on Linux. Installers, automated CI, and Windows/macOS verification are deferred to a later milestone.

## Import photographs

1. Click **Import** and choose individual photos or a folder. Folder scans include subfolders by default; change the toggle before choosing a folder to scan only its top level.
2. Review the previews, then deselect any photos you want to exclude. All valid new photos are selected by default. Files with identical contents are marked as already imported or as duplicates within the selection.
3. Click **Import N photos**. The review closes immediately and originals copy in the background. Keep browsing while imported photos appear in the library; your current selection stays in place.
4. The compact status-bar indicator shows transfer progress. Click it for the current filename, fixed photo and byte totals, errors, and **Cancel task**. Clicking Import again during a transfer also opens these details.

One import or deletion runs at a time. Successful results disappear after five seconds; cancelled imports and failures remain until dismissed, including when another import starts. Reloading the window reconnects to the active task. Closing or quitting during a transfer asks whether to keep importing or cancel and quit. Tasks are not resumed after the application exits.

JPEG, PNG, TIFF, and Sony ARW are supported. Sony ZV-1 12-bit compressed RAW is covered by a real camera fixture. Import review uses the RAW's embedded JPEG when available, otherwise LibRaw generates a quick SDR preview. Opening a photo also generates a full-resolution view from the internal original. RAW originals are preserved unchanged. Other camera/recording combinations require separate verification.

The managed library is stored in Electron's user-data directory, under `library/` (normally `~/.config/Luma/library` on Linux). It contains `catalog.sqlite`, `originals/<SHA-256>/` with original files and cached previews, and temporary `staging/` files. Imported photos survive restarts and removal of their source folder. Never edit catalog or managed files while Luma is running.

Cancel stops further work and preserves completed imports. Corrupt files, changed sources, unsupported formats, and write failures are shown individually. Interrupted staging files and unpublished original directories are cleaned at startup. RAW decoder inputs are limited to 512 MB; previews have a 90-second per-file timeout.

Exposure, contrast, highlights, shadows, whites, blacks, and lens corrections share persistent edit history and Undo/Redo. Export, crop, additional light/color adjustments, HDR output, and agent execution remain future milestones; metadata comes from the imported file and missing fields display a dash. The console remains read-only.

## Select and delete photographs

- Click a thumbnail to select it. **Shift-click** selects a range, including photos on other library pages. **Ctrl/Cmd-click** toggles individual photos; Ctrl/Cmd+Shift-click adds a range.
- Paging keeps your selection and preview. The library shows the selection count, including photos on other pages. Preview Previous/Next switches to a single selected photo.
- Press **Delete**, or right-click a thumbnail or the main preview and choose **Delete**. Right-clicking a selected photo keeps the group; right-clicking an unselected photo selects only that photo. Shift+F10 opens the same menu from the keyboard.
- Confirm **Move to Trash** to remove Luma’s internal copies, including originals and cached previews. Source files and SD cards stay untouched. The confirmation defaults to Cancel.
- Deletion runs in the background using the status-bar progress indicator. Cancel stops before the next photo after the current OS Trash operation finishes. Failed photos remain in the library with per-photo errors; there is no permanent-delete fallback.

A deletion journal reconciles interrupted moves on startup. Temporary removal bundles live under `library/removed/`, separately from disposable import staging. Bundles restored using the operating system are preserved there; copy their original files to a source folder and import them again to return them to Luma. In-app Undo and Trash restoration are not implemented.

## Preview controls

- Scroll over the preview to zoom around the pointer. Drag with the left mouse button to move a zoomed image; movement stops at the image edges.
- Use the compact toolbar for zoom steps, percentage presets from 10% to 3200%, and **Fit**. Double-click the preview to switch between Fit and 100%.
- With the preview focused, use **+ / −** to zoom, **0** for Fit, **1** for 100%, and **arrow keys** to pan. Hold Shift with an arrow for a larger step.
- A different photo starts in Fit. Import updates and selection changes on the same photo keep its view. Resizing the window or console recalculates Fit and preserves manual zoom where possible.

The large preview always uses Luma's full-resolution rendering. On first opening, a neutral loader appears until it is ready. Later openings can show a blurred, 96-pixel placeholder derived from that exact rendering while the full frame loads. Camera JPEGs remain useful in import review and the gallery, but never appear as a fallback in the large preview. Errors show **Retry**.

Sony ZV-1 and ZV-1A Bayer RAW processing uses native Dawn/WebGPU when a hardware adapter is available. LibRaw unpacks the sensor data; GPU compute passes perform AHD demosaicing, camera white balance, camera-color conversion, brightness, and the SDR display transform. A floating-point linear result supports continuous exposure, contrast, highlights, shadows, whites, and blacks adjustment. Unsupported layouts and GPU failures use LibRaw's CPU renderer. Native GPU code runs only in the bundled Node worker; Electron's renderer remains sandboxed.

Full frames are lossless **RGBA8 sRGB** at native decoded dimensions, displayed through a canvas without PNG compression or decoding. These are **8-bit SDR display images**, not editing masters. Exposure uses floating-point pixels derived from originals before display clipping. At **100%**, one decoded pixel occupies one CSS pixel; Fit never enlarges a small photo. Sony ZV-1/ZV-1A previews automatically apply verified embedded distortion, vignetting, and lateral chromatic-aberration corrections. The **Lens corrections** checkboxes persist independently per photo. Missing tables show a short explanation; existing imports load processing metadata without reimporting. The corrected crop has authoritative native dimensions and can be smaller than the uncorrected image. Import-review and gallery thumbnails retain their quick-preview behavior.

One foreground preview runs at a time, independently of imports. Versioned frames, matching placeholders, and prepared float assets share the **2 GiB LRU disk cache** under `library/cache/previews/`; uncompressed frames retain fewer photos than the previous PNG cache. SHA-256 checks detect damaged frame data. Active requests and streams are leased against eviction, and changing photos cancels obsolete work. A separate **256 MiB bitmap cache** keeps recently displayed frames ready for fast revisits; active bitmaps are pinned until deselected. A GPU worker stays warm for up to 30 seconds, releases photo textures when deselected, and bounds processing allocations to 1 GiB. Workers can retain bounded upstream linear data for nearby exposure, contrast, highlights, shadows, whites, blacks, and lens changes and release their process memory after the idle timeout. Old disposable cache versions rebuild automatically without reimporting originals.

Use `npm run gpu:check` to verify a real hardware computation and `npm run benchmark:preview` to compare CPU/RGBA fallback and the former CPU/PNG path against GPU/RGBA presentation in isolated Electron. `LUMA_PREVIEW_BACKEND=cpu` forces the CPU renderer for troubleshooting; `LUMA_PREVIEW_DIAGNOSTICS=1` logs backend and stage timings. Neither setting changes originals. Linux/Radeon is tested locally; Windows/macOS backend verification and installers remain outstanding. Native `webgpu` files must remain external to the JS bundle and be unpacked alongside the bundled Node runtime in future installers.

## Preview runtime

Preview generation runs in a separate process using a pinned, bundled Node 24 runtime. This avoids a [known Electron/GLib conflict on Linux](https://sharp.pixelplumbing.com/install/#electron-and-linux) that crashes sharp's native decoder inside Electron. No system Node executable, ExifTool installation, or online processing service is required by the running app. npm installs the optional runtime binary for the target OS and CPU; keep optional dependencies enabled.

The production build keeps processing dependencies external in `node_modules`. An installable distributable is a later milestone; packaging requirements and licenses are documented in [runtime dependencies](docs/runtime-dependencies.md).

## Stack and boundaries

| Layer        | Technology and responsibility                                        |
| ------------ | -------------------------------------------------------------------- |
| Desktop      | Electron; native window controls and application lifecycle           |
| Build        | electron-vite; separate main, preload, and renderer builds           |
| Interface    | React and TypeScript; CSS Modules, CSS variables, and Lucide icons   |
| Console      | xterm.js with the fit addon; read-only presentation                  |
| Verification | Playwright Electron tests and a locally pinned Playwright MCP server |

`src/main` owns privileged desktop operations. `src/preload` exposes typed library and import operations, with shared contracts in `src/shared`. Background-task snapshots and the reusable `TaskProgress` component support both measured progress and operations with unknown totals. `src/renderer` contains the library and import UI. The renderer is sandboxed, uses context isolation, and has no Node integration.

Manual exposure/contrast/highlights/shadows/whites/blacks/lens editing and the dedicated editing MCP server share the application API and history. The Playwright MCP server remains a separate development tool for testing the UI.

## Commands

| Command                  | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `npm run setup:electron` | Download the Electron runtime explicitly before the first launch            |
| `npm run dev`            | Launch Electron with live renderer updates                                  |
| `npm run build`          | Build main, preload, and renderer for production                            |
| `npm start`              | Launch the previously built application                                     |
| `npm run typecheck`      | Check TypeScript without rewriting source                                   |
| `npm run lint`           | Check lint rules                                                            |
| `npm run format:check`   | Check source and documentation formatting                                   |
| `npm run test:e2e`       | Run the real Electron smoke and interaction tests                           |
| `npm run check`          | Run type checks, lint, formatting checks, and fast Node tests               |
| `npm run dev:mcp`        | Launch development Electron with local debugging enabled                    |
| `npm run mcp:ui`         | Start the stdio Playwright MCP server for the running app                   |
| `npm run mcp:test`       | Build and test photo import through MCP using an isolated temporary library |
| `npm run mcp:check`      | Verify the MCP protocol, UI inspection, interaction, and screenshot capture |

Use `npm run verify -- <scope>` for focused verification (`ui`, `adjustments`, `preview`, `library`, or `mcp`); combine scopes or preview them with `npm run verify -- --plan ui preview`. Run `npm run check:full` at milestone completion. Run benchmarks at milestones or during performance work; `npm run benchmark:adjustments -- highlights` measures just one adjustment. Every invocation preserves logs and reports in a separate ignored artifact directory. See the [verification workflow](docs/testing.md#choose-verification) for failure reruns and diagnostic tracing.

For step-by-step module registration, examples, and verification, see [Adding lens corrections and image processors](src/main/processing/README.md). The [RAW processing overview](docs/raw-processing.md) covers pipeline contracts and measured results.

For MCP startup, Codex registration, acceptance checks, and troubleshooting, see [docs/testing.md](docs/testing.md). Contributor instructions are in [AGENTS.md](AGENTS.md).

## Light adjustments and history

Use the Exposure slider or numeric value for −5 to +5 EV in 0.01 EV steps. Contrast uses the same slider and numeric value, from −100 to +100 in integer steps; 0 is neutral. It applies a smooth luminance curve after exposure, around fixed linear middle gray (0.18). Highlights uses integer steps from −100 to +100 after contrast: negative values compress bright tones and reveal retained detail above display white; positive values brighten them. Values at or below linear middle gray are unchanged. Shadows lifts or deepens dark detail while preserving pure black. Whites adjusts bright tones and the white endpoint; Blacks lifts or clips the black endpoint. These three controls also use integer steps from −100 to +100 with 0 as neutral, and run after Highlights in that order. Enter `0` to reset an adjustment. A drag or repeated arrow-key gesture commits one history entry on release; Escape cancels it. Photo changes and normal shutdown flush unfinished gestures. Exposure, contrast, highlights, shadows, whites, blacks, and independent lens toggles share the toolbar Undo/Redo buttons above the photograph and Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, or Ctrl+Y shortcuts. Text fields and the read-only console keep their own keyboard behavior. A new edit after Undo discards the redo branch. Edits persist across restarts and leave originals unchanged.

The preview uses WebGL2 presentation with Canvas2D fallback, smooth reduction, nearest-pixel magnification, and a subtle pixel grid from 800%. Interactive float textures prepare after the first full-resolution frame. Exposure, contrast, highlights, shadows, whites, and blacks changes preserve zoom and pan. Gallery and import-review thumbnails keep their quick-preview behavior.

Agents can use the dedicated `npm run --silent mcp:editor` stdio server with a normally running application. It shares the application's edit service and history and requires expected revisions to prevent overwriting concurrent edits. See [editing MCP setup and tests](docs/testing.md#dedicated-editing-mcp-server). The console itself still does not execute commands.

## Histogram, comparison, and RAW white balance

The collapsible histogram at the top of the inspector describes the displayed SDR sRGB image, using 256 bins per channel and a deterministic sample of up to 65,536 working pixels. Its shared linear frequency scale does not change with zoom or pan. Hover the plot or focus it and use arrow keys to read a bin. Percentages and clipping counts in this panel are approximate.

Shadow clipping means all display channels reach 0; highlight clipping means any display channel reaches 255. Hover a clipping indicator to preview its overlay, or click to toggle it. Blue marks shadows and red marks highlights. These SDR endpoints do not establish loss of RAW sensor data. Focus the preview and press **J** to toggle both overlays.

Use **Before** or `\` for the neutral image, and the comparison button or **Y** for a vertical split. Drag the divider or focus it and use arrow keys, Home, or End. Before retains the current lens corrections and framing, with neutral light controls and As Shot white balance. Split overlays and its histogram describe After. Comparison, split position, and overlays are transient and reset on a different photo; starting an edit in full Before returns to After.

For verified Sony ZV-1/ZV-1A RAW profiles, Color offers Temperature (2000–25000 K, 50 K steps), Tint (−100…+100, positive toward magenta), and **As Shot**. As Shot preserves the original gains exactly; its Kelvin and Tint readouts are estimates. Editing either value selects Custom. As Shot restores both in one undoable edit. Raster images and unsupported cameras keep normal viewing with these controls unavailable. Automatic balance, eyedropper, other presets, HDR and additional cameras remain future work.

MCP `luma_get_photo_statistics` accepts `photoId` and `expectedRevision` and returns exact committed RGB bins, visible-pixel and clipping counts, revision, rendering identity and SDR sRGB information. White balance patches are atomic, for example `{ "whiteBalance": { "mode": "custom", "kelvin": 6500, "tint": 20 }, "exposureEv": 0.5 }`, or `{ "whiteBalance": { "mode": "as-shot" } }`. All edits share history.
