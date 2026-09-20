# Testing Luma

Use focused correctness checks while developing. Full regression and performance measurements belong at milestones; benchmarks also belong in performance work. This workflow remains local to Linux and uses the existing Playwright runner.

## Choose verification

| Command                                       | Coverage                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                               | Type checking, lint, formatting, and fast Node tests; no build, Electron, or RAW decoding                                 |
| `npm run verify -- ui`                        | Fast checks plus workspace layout, shared inputs, keyboard and pointer interaction                                        |
| `npm run verify -- adjustments`               | Fast checks plus math, validation, migration/history, renderer agreement, and editing MCP                                 |
| `npm run verify -- preview`                   | Fast checks plus geometry, loading, cache, cancellation, decoding, and GPU processing                                     |
| `npm run verify -- library`                   | Fast checks plus import, selection, deletion, recovery, and persistence                                                   |
| `npm run verify -- mcp`                       | Fast checks plus editor endpoint, authentication, launcher behavior, and isolated UI MCP protocol                         |
| `npm run verify -- --plan ui preview`         | Print the deduplicated selection without executing or creating artifacts                                                  |
| `npm run check:full`                          | All functional regression tests and isolated MCP protocol verification                                                    |
| `npm run benchmark:adjustments -- highlights` | Only the named adjustment's warmed RAW presentation latency (also accepts exposure, contrast, shadows, whites, or blacks) |
| `npm run benchmark:preview`                   | Complete performance benchmark, including existing regression gates                                                       |

Multiple scopes form a union: `npm run verify -- ui library`. The explicit mapping lives in [verification-plan.ts](../scripts/verification-plan.ts); it never reads the dirty working tree. Each spec belongs to one [Playwright project](https://playwright.dev/docs/test-projects): `node`, `service`, `electron`, `raw-gpu`, or `benchmark`. The runner gives Node tests two workers and runs other groups serially, with one worker each. Benchmarks run alone. Mixed files are split so lightweight checks cannot accidentally include real RAW decoding.

1. Select the affected scope and implement the change.
2. Run that verification command when ready.
3. On failure, inspect the relevant log excerpt and rerun the failing test first, for example `npx playwright test --project=electron tests/adjustment-wiring.spec.ts -g Contrast`. Reuse the build unless application code changed. For detailed diagnostics, prefix that rerun with `LUMA_TEST_TRACE=1`.
4. Stop when the relevant checks pass. Repeat broader coverage only if the fix affects it. Full suites, benchmarks, GPU smoke checks, and manual MCP inspection are not automatic additions.

Every command prints counts, duration, selected scope, and artifact paths. Successful logs and accessibility snapshots stay in artifacts. The runner builds once when required and shares that build with MCP. It does not cache test results. `npm run test:e2e` is the compatibility command for all functional projects without static checks or the separate UI MCP script.

Aim for fast checks under 15 seconds and typical focused verification around 30–90 seconds on the development machine; measure results rather than treating these as guarantees. RAW-heavy scopes can take longer. All automated Electron launches use harness-created temporary profiles, verify Electron's actual user-data path before interacting, and remove profiles after cleanup. Manual inspection is reserved for visual changes or unresolved UI problems.

### Local refactor measurements

September 18, 2026, on the development Linux machine (Node 26.7 test runner, bundled Node 24.20 preview runtime):

| Command                                       | Result                                                   | Elapsed |
| --------------------------------------------- | -------------------------------------------------------- | ------- |
| `npm run check`                               | 23 tests plus type, lint, and formatting checks passed   | 3.2 s   |
| `npm run verify -- ui`                        | 40 tests and all static checks passed                    | 49.0 s  |
| `npm run check:full`                          | 104 tests plus isolated UI MCP passed; no skips          | 299.0 s |
| `npm run benchmark:adjustments -- highlights` | Exactly one benchmark passed                             | 8.2 s   |
| `npm run benchmark:preview`                   | All four benchmarks passed with the saved baseline gates | 77.5 s  |

The complete benchmark used `artifacts/verification/highlights/benchmark.json` as its baseline. Uncorrected CPU/GPU medians changed by +1.4%/+7.5%, inside the 15% limits. Exposure, contrast, highlights, shadows, whites, and blacks each measured about 7.1 ms p95. These are local measurements, not cross-platform guarantees. The CLI's dry-run selection was also verified with Node 24.20.

Acceptance checks cover exact spec assignment, scope unions, invalid inputs, dry runs without artifacts, shared builds, nonzero command and test-stage propagation, retained logs, unique artifact directories, occupied-port rejection, profile isolation/removal, and child-process cleanup. Disabling routine traces exposed two existing test timing assumptions: workspace bounds now wait for xterm's asynchronous fit, and photo-switch gestures wait for the control to finish saving and display the draft. Both retained their assertions and passed focused reruns and the complete suite.

Generated evidence remains under `artifacts/verification/`: the successful fast run is `2026-09-18T16-17-22.152Z-check-VJP8FD`, UI run `2026-09-18T16-25-21.971Z-check-RuxluE`, milestone run `2026-09-18T16-17-43.201Z-check-1DE8ND`, named benchmark `2026-09-18T16-23-14.330Z-benchmark-2poipj`, and complete benchmark `2026-09-18T16-23-41.163Z-benchmark-PS2B5y`. Later commands preserved earlier reports, and routine/benchmark runs produced no trace archives.

## Automated Electron coverage

Electron downloads its runtime on first use if needed. Run `npm run setup:electron` after `npm ci` to complete this download explicitly before an offline test run.

The tests use [Playwright's Electron API](https://playwright.dev/docs/api/class-electron) to launch the built application, inspect the desktop window and preload bridge, and close their Electron process. They run sequentially without retries and need a desktop display or a provisioned virtual display. No separate browser download is needed. Each test runs with its browser context offline; test user data is isolated from normal launches and removed after cleanup.

The suite checks empty startup, the isolated bridge, source selection, recursive folders, review/deselection, duplicate detection, exact original copies, persistence after restart and source removal, real Sony ZV-1 ARW import, keyboard access, and layout at 1280 × 800 and 1920 × 1080 (including the minimum 1100 × 700 console layout). Background-import tests slow the real copy stream after review and cover immediate dialog closure, byte progress, browsing during copying, renderer reload, cancellation, retained errors, success dismissal, quit choices, reduced motion, and the compact loader at 1100 × 700. The test harness supplies native confirmation responses; the real quit and cleanup paths run. Library tests also cover fixed task totals, paginated error retention after staging disposal, selection navigation after page shifts, failed writes, changed/missing sources, interrupted staging recovery, orientation, corrupt files, and the real RAW decoder fallback.

Slow-copy instrumentation runs through Playwright’s main-process debugger and is absent from the application API. Photo-action tests cover modifier selection, ranges across pages, keyboard and context menus, modal focus, deletion through the background task UI, failures, cancellation, and quit handling. Deletion-service tests cover byte preservation, v1 schema migration, and recovery before/after a Trash move. Automated deletion uses an injected move into each test profile’s `test-trash/` directory, never the user’s normal Trash.

Native picker return values are supplied using Playwright's Electron main-process API. The renderer, preload, scanner, preview process, filesystem copies, and database remain real. Native OS picker interaction itself requires a manual check. No test-only filesystem access is exposed by the production preload bridge.

Each invocation creates a unique directory under `artifacts/verification/`. It contains `result.json`, stage logs, and per-project `summary.json`, `results/`, and `report/` directories. Failures retain `failure.png` and Electron diagnostics. Tracing is disabled normally and always disabled for benchmarks; `LUMA_TEST_TRACE=1` records `electron-N.zip` traces for diagnostic failures. Open a report with `npx playwright show-report <run>/<project>/report`. Later runs never erase earlier artifacts; remove obsolete runs explicitly when no longer needed. All artifacts are ignored by Git.

The real Electron Trash API was also checked separately on the Linux home filesystem with a uniquely named disposable bundle; contents were verified and the fixture restored and cleaned up. The host's `/tmp` uses tmpfs, where that native Trash check failed. The failure leaves the library photo intact; see Electron's [tmpfs Trash issue](https://github.com/electron/electron/issues/28045).

Preview tests cover pointer-centered wheel zoom, native image sizing, bounded drag and capture cleanup, Ctrl-wheel without page zoom, keyboard controls, context menus and deletion, photo switching, resize behavior, small/portrait images, and the compact toolbar with the console at 1100 × 700. Geometry tests check fit, zoom limits, pointer anchoring, pan bounds, and wheel delta normalization. Test gates delay full-frame requests and invalidate frame metadata to verify neutral loading, disabled controls, errors, and retry states.

Full-resolution checks decode the real Sony RAW to 5496 × 3672 pixels and compare the CPU RGBA output against LibRaw. GPU checks compare AHD output to that CPU reference and exercise synthetic neutral bars, black levels, highlights, stripe boundaries, all flip orientations, and device loss. A simulated GPU failure verifies CPU fallback and a matching placeholder. Raster checks cover orientation, profiles, native dimensions, and alpha. Cache tests cover restart, LRU, stream leases, version cleanup, interrupted writes, cancellation, removal, and shutdown. Electron tests verify neutral first loading, matching blurred placeholders, native canvas dimensions, rapid navigation, imports during loading, and repair of corrupted RGBA frames. GPU tests skip only when no hardware adapter is available; this is reported separately from a hardware pass.

Lens-correction module contracts, schema migration, independent-table coverage, and the extended correction benchmark are documented in [RAW processing](raw-processing.md). Lens UI tests cover default availability, rapid independent changes, cached variants, native zoom, restart persistence, and the minimum console layout. MCP additionally imports the real Sony RAW, changes distortion, reloads the renderer to verify persistence, captures the correction controls, and deletes the photo through isolated Trash.

Run `npm run gpu:check` for a native compute/readback smoke check. Run `npm run benchmark:preview` for four measurements each of CPU/PNG, CPU/RGBA fallback, and GPU/RGBA using the same Sony fixture, bundled Node worker, streamed files, and real Electron canvas presentation. The benchmark requires a hardware GPU, includes integrity checking and two animation frames, aligns presentation starts to a frame boundary, samples eight cached revisits per rendered frame, reports generation/presentation separately, and fails if first display is slower or cached presentation regresses by more than 15%. It is opt-in rather than a timing-sensitive ordinary test. Reports go to the unique benchmark run directory under `artifacts/verification/`; later checks preserve them. Set `LUMA_PREVIEW_DIAGNOSTICS=1` to log per-frame backend and stage timings; `LUMA_PREVIEW_BACKEND=cpu` forces fallback. The local Sony fixture benchmark on Radeon RX 7900 XTX measured median first presentation at 3449 ms for CPU/PNG and 749 ms for GPU/RGBA; warm presentation was 12 ms and 8 ms respectively. Four samples include cold GPU initialization once. These are fixture measurements, not a guarantee for other cameras or hardware. The renderer bitmap cache is bounded to 256 MiB and has LRU/lease/identity tests. The tested renderer remains SDR. Windows/macOS hardware and packaging are not covered by the local Linux run.

### Additional camera samples

The GPU eligibility regression covers the **ZV-1A** model name as well as ZV-1. Ten local ZV-1A ARWs were separately compared against LibRaw at full resolution, including portrait orientation and different white balances. All passed the same pixel tolerances as the checked-in ZV-1 fixture. These local photographs are not repository fixtures. On the same Radeon RX 7900 XTX, a ZV-1A sample measured 2586 ms median for CPU/RGBA fallback versus 717 ms for GPU/RGBA, including worker generation, streamed loading, integrity validation, and Electron canvas presentation. Cached GPU presentation measured 14 ms across 32 revisits. These isolated measurements exclude React selection handling and are not a guarantee for every photograph.

To repeat comparisons using local files, set `LUMA_RAW_TEST_FILES` to a JSON array of absolute paths and run `npx playwright test tests/gpu-preview.spec.ts`. To benchmark one of those files through the bundled worker and Electron presentation, set `LUMA_RAW_BENCHMARK_FILE` to its absolute path and run `npm run benchmark:preview`. Both commands read source files and write only isolated test output; the benchmark does not touch the existing library. Comparison images and reports appear in that invocation’s `artifacts/verification/` directory.

## Test through MCP

For repeatable import testing, run:

```sh
npm run mcp:test
```

This builds and launches an isolated Electron instance with a temporary library and an ephemeral loopback debugging port, then uses actual MCP tools to import fixtures, verify a neutral loading state, wait for full resolution, then zoom and drag the native-resolution canvas, reset Fit, detect duplicates, select multiple photos, confirm deletion into isolated test Trash, open the console, and capture screenshots. The full-resolution zoomed preview is saved as `<run>/mcp/preview-zoom.png`. It closes its processes and removes the temporary library afterwards. It does not modify your normal library.

For an isolated development inspection, pass Electron's profile argument through the launcher:

```sh
npm run dev:mcp -- -- --user-data-dir=/absolute/temporary/profile
```

The first `--` belongs to npm; the second forwards the profile argument to Electron through electron-vite. Do not rely on `ELECTRON_CLI_ARGS`: the electron-vite CLI replaces that environment variable while parsing arguments.

For intentional manual inspection of the isolated development window:

1. Start the application and keep it running:

   ```sh
   npm run dev:mcp -- -- --user-data-dir=/absolute/temporary/profile
   ```

2. In another terminal, verify the actual MCP connection:

   ```sh
   npm run mcp:check
   ```

The check starts the locally installed MCP server over stdio, initializes the protocol, discovers tools, and uses those tools to inspect the app, select a photo (or open the empty-library import dialog), open the console, and capture a screenshot. A successful check establishes that the server can operate the renderer even if the current Codex session has not loaded its tools yet.

`dev:mcp` exposes Electron's Chrome DevTools Protocol endpoint at `http://127.0.0.1:9222`. The local, version-pinned Playwright MCP server connects to that endpoint using `npm run mcp:ui`. This follows [Playwright MCP's support for Electron over CDP](https://playwright.dev/mcp/configuration/browser-extension). Neither a browser extension nor a separately installed Chrome is needed for this connection.

Ordinary `npm run dev` and production launches do not enable the debug endpoint. Stop the `dev:mcp` process when finished. Run one Luma debugging instance at a time because the port is fixed.

If the renderer development server's port 5173 is occupied, use `LUMA_DEV_PORT=5174 npm run dev:mcp`. This changes only the Vite port; the MCP debugging endpoint remains bound to `127.0.0.1:9222`.

### Register the server in Codex

Merge [mcp-config.example.toml](mcp-config.example.toml) into the trusted project's `.codex/config.toml` and replace `cwd` with the absolute checkout path. In this workspace the path is `/var/home/KolegaDragan/Development/Luma`. Preserve any existing settings. The project configuration directory may require a separately permitted write in managed environments.

The `luma_ui` server runs `npm run --silent mcp:ui` from that directory. Codex supports project-scoped MCP configuration for trusted projects, including an explicit working directory. See the [official Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Restart or reload the Codex client's MCP connection after registration. A server added during a conversation may not appear in that conversation's tool catalog until the client reconnects. Use the client's MCP settings or `/mcp` where available to confirm that `luma_ui` is connected.

Once connected, ask the agent to inspect the Luma window, select an imported photograph, open the console, and take a screenshot. Use fresh accessibility snapshots to identify controls before interacting with them. The MCP connection can inspect rendered controls, screenshots, and renderer console messages; native operating-system dialogs are outside this renderer connection and need separate verification.

Do not use MCP `browser_resize` or Playwright `page.setViewportSize()` for Electron layout checks. They emulate the web viewport without resizing the native window, which can leave flickering empty areas outside the content. In direct MCP inspection, evaluate `window.resizeTo(1100, 700)` and wait for `innerWidth` and `innerHeight` to settle; verify that the OS frame also changed. Automated tests use Electron's `BrowserWindow.setContentSize(1100, 700)`. If viewport emulation was already enabled, restart the isolated development window before native resizing.

### Troubleshooting

| Symptom                                        | Check                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP cannot connect to port 9222                | Start `npm run dev:mcp`, wait for the window, and confirm no other application owns port 9222.                                                    |
| Server starts but no tools appear in Codex     | Verify the trusted project's configuration, its absolute `cwd`, and reload the client's MCP connection.                                           |
| `mcp:ui` waits without displaying an interface | This is a stdio server intended for an MCP client. Use `mcp:check` to exercise it from a terminal.                                                |
| Electron cannot open a window                  | Run from a graphical Linux session and check the reported missing display or system library. A browser-only run does not verify Electron startup. |
| First launch cannot download Electron          | Allow the required network access, then run `npm run setup:electron`. Keep the committed dependency versions.                                     |

## Platform and milestone limits

This milestone targets local Linux verification. Windows/macOS execution, manual native-picker interaction, distribution installers, and CI remain separate checks. Additional adjustments, HDR output, and native terminal execution are not implemented. Exposure, contrast, highlights, shadows, whites, blacks, shared history, and the dedicated editing MCP API are covered below.

The RAW fixture is a Sony ZV-1 12-bit compressed ARW. See [fixture provenance](../tests/fixtures/README.md). The fallback test disables embedded extraction through dependency injection while running the real LibRaw decoder. Native decoding must run with the bundled Node process, because Electron's Linux GLib exports conflict with sharp; see [runtime dependencies](runtime-dependencies.md).

Report automated checks and MCP protocol checks separately from direct Codex tool invocation. A passed MCP script does not establish that a particular Codex conversation has loaded the registered server.

## Dedicated editing MCP server

Start Luma normally with `npm start` or `npm run dev`. Run `npm run --silent mcp:editor` as a stdio MCP server; this interface does not need CDP or `dev:mcp`. It uses the installed [MCP SDK stdio transport](https://ts.sdk.modelcontextprotocol.io/server#stdio).

The server offers `luma_list_photos`, `luma_get_edits`, `luma_update_edits`, `luma_get_edit_history`, `luma_undo_edit`, `luma_redo_edit`, and `luma_get_photo_statistics`. Use photo IDs from the list operation, then read the current revision before committing a patch or navigating history. An exposure patch looks like `{ "exposureEv": 1.25 }`; contrast accepts integers from −100 to +100, for example `{ "contrast": 35 }`. Shadows, Whites, Blacks, and Highlights accept integers from −100 to +100, for example `{ "highlights": -60 }`. A combined `{ "exposureEv": 1.25, "contrast": 35, "highlights": -60, "shadows": 65, "whites": -35, "blacks": 20, "lens": { "distortion": false } }` patch makes one history entry. Lens patches use `{ "lens": { "distortion": false } }`. Revision conflicts require another read. Each update creates one entry in the same history used by the UI.

The application listens on an ephemeral port bound only to `127.0.0.1`. A random authentication token and port are published atomically at `<profile>/editor/connection.json`, with directory mode 0700 and file mode 0600 on Unix, and removed during shutdown. Requests with browser origins, incorrect hosts, missing authentication, or unknown operations are rejected. Only the application opens SQLite. The stdio server reads the connection file again per request, so it reconnects after a normal application restart.

For an isolated profile, launch Electron with `--user-data-dir=/absolute/test/profile` and set `LUMA_PROFILE=/absolute/test/profile` in the MCP server environment. The default profile follows Electron's Luma configuration directory. Register a server named `luma_editor` using command `npm`, arguments `["run", "--silent", "mcp:editor"]`, and this repository as its working directory. Set `LUMA_PROFILE` when using a nondefault profile. Keep `luma_ui` registered separately for development renderer inspection.

Run `npm run mcp:editor:test` to exercise the real stdio protocol against an isolated Electron profile, including shared UI Undo/Redo, conflicts, authentication, file permissions, and restart. `npm run verify -- adjustments`, `npm run verify -- mcp`, and `npm run check:full` include the editing protocol tests. Run `npm run benchmark:preview` separately from other GPU workloads; `exposure-latency.json`, `contrast-latency.json`, and `highlights-latency.json`, `shadows-latency.json`, `whites-latency.json`, and `blacks-latency.json` report warmed RAW slider presentation, targeting p95 ≤33 ms on the verified Radeon setup. Set `LUMA_PREVIEW_BASELINE` to a saved pre-change benchmark JSON to enforce the 15% uncorrected regression gate.

Adjustment coverage is shared where behavior is shared: `adjustment-input-decimal.spec.ts` and `adjustment-input-integer.spec.ts` exercise shared input gestures, cancellation, control switching, conflicts, shutdown, and minimum layout; `adjustment-wiring.spec.ts` checks each adjustment's connection to history and the preview. Curve and validation tests stay in `contrast.spec.ts`, `highlights.spec.ts`, `tonal-adjustments.spec.ts`, and `edits.spec.ts`. Curve sweeps report the first failing sample instead of thousands of separate assertions.

Transactional legacy migration, rollback, redo, and revision coverage remains distinct in `contrast-migration.spec.ts`, `highlights-migration.spec.ts`, `tonal-migration.spec.ts`, and `edit-history.spec.ts`. Shared parameterized engine and renderer tests use small synthetic/raster cases and separate representative Sony RAW cases, preserving CPU/native/WebGL agreement, neutral output, combined edits, alpha, texture reuse, and stale fallback coalescing. Lens corrections, original-byte preservation, cancellation, deletion recovery, and real embedded/decoder-fallback compatibility retain their own tests. Editing MCP still checks combined patches, draft replacement, invalid values, and revision conflicts.

## White balance and analysis verification

Run `npm run verify -- ui adjustments preview mcp` for the deduplicated feature scope, then the Sony import and embedded-preview-failure specs in `import-raw.spec.ts` and `library-raw.spec.ts`. New coverage includes `white-balance.spec.ts`, `white-balance-migration.spec.ts`, `white-balance-raw.spec.ts`, `white-balance-ui.spec.ts`, `statistics.spec.ts`, comparison interaction and statistics scheduling/cancellation in the existing preview service suite.

`luma_get_photo_statistics` takes `{ "photoId": "<id>", "expectedRevision": 4 }`. Its `rgb` arrays contain exact integer counts, excluding alpha-zero pixels; the UI histogram is sampled. A stale revision returns a conflict. A new foreground preview can interrupt background statistics, in which case request them again after presentation settles. The MCP timeout accommodates full RAW generation. Combined editing patches may include `{ "whiteBalance": { "mode": "custom", "kelvin": 8000, "tint": 25 }, "highlights": -50 }`; `{ "whiteBalance": { "mode": "as-shot" } }` resets both controls in one history entry.

Capture `npm run benchmark:preview` before implementation, then set `LUMA_PREVIEW_BASELINE` to its `benchmark.json` for the post-change run. The 15% uncorrected-preview gate is unchanged. `npm run benchmark:adjustments -- temperature` measures warmed white-balance gestures with the histogram and both clipping overlays enabled, retaining the 33 ms p95 target. Keep evidence under ignored `artifacts/verification/` and report the actual hardware and platform limitations.
