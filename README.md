# Luma

A local desktop photo editor with an integrated agent console. The current milestone provides **working photo import, a persistent local library, and automatic RAW lens corrections** in an Electron desktop workspace.

The full product direction, including RAW processing, persistent edits, HDR, and agent-driven editing, is described in [Luma.md](Luma.md).

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

Editing, export, crop, undo/redo, HDR output, and agent execution remain future milestones. Light and color editing controls are disabled; metadata comes from the imported file and missing fields display a dash. The console remains read-only.

## Select and delete photographs

- Click a thumbnail to select it. **Shift-click** selects a range, including photos on other library pages. **Ctrl/Cmd-click** toggles individual photos; Ctrl/Cmd+Shift-click adds a range.
- Paging keeps your selection and preview. The library shows the selection count, including photos on other pages. Preview Previous/Next switches to a single selected photo.
- Press **Delete**, or right-click a thumbnail or the main preview and choose **Delete**. Right-clicking a selected photo keeps the group; right-clicking an unselected photo selects only that photo. Shift+F10 opens the same menu from the keyboard.
- Confirm **Move to Trash** to remove Luma’s internal copies, including originals and cached previews. Source files and SD cards stay untouched. The confirmation defaults to Cancel.
- Deletion runs in the background using the status-bar progress indicator. Cancel stops before the next photo after the current OS Trash operation finishes. Failed photos remain in the library with per-photo errors; there is no permanent-delete fallback.

A deletion journal reconciles interrupted moves on startup. Temporary removal bundles live under `library/removed/`, separately from disposable import staging. Bundles restored using the operating system are preserved there; copy their original files to a source folder and import them again to return them to Luma. In-app Undo and Trash restoration are not implemented.

## Preview controls

- Scroll over the preview to zoom around the pointer. Drag with the left mouse button to move a zoomed image; movement stops at the image edges.
- Use the compact toolbar for zoom steps, percentage presets from 10% to 400%, and **Fit**. Double-click the preview to switch between Fit and 100%.
- With the preview focused, use **+ / −** to zoom, **0** for Fit, **1** for 100%, and **arrow keys** to pan. Hold Shift with an arrow for a larger step.
- A different photo starts in Fit. Import updates and selection changes on the same photo keep its view. Resizing the window or console recalculates Fit and preserves manual zoom where possible.

The large preview always uses Luma's full-resolution rendering. On first opening, a neutral loader appears until it is ready. Later openings can show a blurred, 96-pixel placeholder derived from that exact rendering while the full frame loads. Camera JPEGs remain useful in import review and the gallery, but never appear as a fallback in the large preview. Errors show **Retry**.

Sony ZV-1 and ZV-1A Bayer RAW processing uses native Dawn/WebGPU when a hardware adapter is available. LibRaw unpacks the sensor data; GPU compute passes perform AHD demosaicing, camera white balance, camera-color conversion, brightness, and the SDR display transform. A floating-point linear result provides a foundation for later editing. Unsupported layouts and GPU failures use LibRaw's CPU renderer. Native GPU code runs only in the bundled Node worker; Electron's renderer remains sandboxed.

Full frames are lossless **RGBA8 sRGB** at native decoded dimensions, displayed through a canvas without PNG compression or decoding. These are **8-bit SDR display images**, not editing masters. Future edits must render from originals. At **100%**, one decoded pixel occupies one CSS pixel; Fit never enlarges a small photo. Sony ZV-1/ZV-1A previews automatically apply verified embedded distortion, vignetting, and lateral chromatic-aberration corrections. The **Lens corrections** checkboxes persist independently per photo. Missing tables show a short explanation; existing imports load processing metadata without reimporting. The corrected crop has authoritative native dimensions and can be smaller than the uncorrected image. Import-review and gallery thumbnails retain their quick-preview behavior.

One foreground preview runs at a time, independently of imports. Versioned frames and matching placeholders share the **2 GiB LRU disk cache** under `library/cache/previews/`; uncompressed frames retain fewer photos than the previous PNG cache. SHA-256 checks detect damaged frame data. Active requests and streams are leased against eviction, and changing photos cancels obsolete work. A separate **256 MiB bitmap cache** keeps recently displayed frames ready for fast revisits; active bitmaps are pinned until deselected. A GPU worker stays warm for up to 30 seconds, releases photo textures when deselected, and bounds processing allocations to 1 GiB. Uncorrected CPU workers release their WASM memory after full renders; corrected workers can retain one bounded linear frame for nearby setting changes. Old disposable cache versions rebuild automatically without reimporting originals.

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

Manual editing and the future product MCP interface will share an application API. The current Playwright MCP server is a development tool for testing the UI.

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
| `npm run check`          | Run type checks, lint, formatting checks, and Electron tests                |
| `npm run dev:mcp`        | Launch development Electron with local debugging enabled                    |
| `npm run mcp:ui`         | Start the stdio Playwright MCP server for the running app                   |
| `npm run mcp:test`       | Build and test photo import through MCP using an isolated temporary library |
| `npm run mcp:check`      | Verify the MCP protocol, UI inspection, interaction, and screenshot capture |

For step-by-step module registration, examples, and verification, see [Adding lens corrections and image processors](src/main/processing/README.md). The [RAW processing overview](docs/raw-processing.md) covers pipeline contracts and measured results.

For MCP startup, Codex registration, acceptance checks, and troubleshooting, see [docs/testing.md](docs/testing.md). Contributor instructions are in [AGENTS.md](AGENTS.md).
