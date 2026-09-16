# Preview runtime and distribution

The image worker is built as `out/main/preview-worker.js` and started with `child_process.fork` using a pinned Node 24.20.0 binary from the matching optional `node-{platform}-{arch}` package. Supported package targets are Linux, macOS, and Windows on x64 and arm64. Windows package names use `win`. This avoids Electron's [Linux GLib symbol conflict with sharp](https://sharp.pixelplumbing.com/install/#electron-and-linux).

`npm ci` must include optional dependencies for the target platform. The runtime packages contain their binaries directly and do not need a second download at application launch. No installed system Node runtime is used by the photo worker. Keep `package-lock.json` committed; installing native dependencies for a different target requires that target's npm platform/architecture settings.

## Full-resolution display rendering

Import review keeps its fast JPEG path. A separate instance of the bundled worker renders the active photo at full decoded dimensions: RAW uses LibRaw with half-size disabled, AHD demosaicing, camera white balance, explicit sRGB primaries/gamma, and 8-bit output; raster originals use sharp orientation and ICC conversion. Both produce true-color sRGB PNG with lossless compression level 3 and no resize. The full worker does not extract embedded JPEGs or start ExifTool. It exits after each render so retained WASM memory is released.

The main process owns a versioned, 2 GiB LRU cache under `library/cache/previews/`, publishes entries atomically, and streams assets through the secured photo protocol. Request tokens cancel superseded work without affecting imports. The active image and open streams pin cache entries; temporary excess is removed after their release. Cache versions and interrupted writes are cleaned at startup. RAW inputs retain the 512 MB limit and full renders have a 90-second timeout. Failures preserve quick viewing and offer explicit regeneration.

These PNGs are disposable SDR display assets, not high-bit-depth editing intermediates. Future editing must decode originals and version its rendering policy. The Sony fixture's decoded visible image is 5496 × 3672, slightly smaller than its metadata dimensions.

## Packaging contract

This repository currently builds an unpacked development application, not installers. When adding a packager:

- Ship `out/` and all production and matching optional dependencies, including `sharp`, `@img/*`, `exiftool-vendored`, `exiftool-vendored.pl` or `exiftool-vendored.exe`, `@colorhythm/libraw-wasm`, `typed-cstruct`, and the matching `node-*` runtime.
- Keep the worker and its dependency tree outside ASAR. A plain Node child cannot load Electron's ASAR filesystem. Preserve relative package layout and executable permissions.
- The LibRaw package resolves its adjacent `dist/libraw.wasm`; retain its generated module and WASM file together. Preserve ExifTool's vendored executable/Perl files and sharp's native libvips libraries.
- Run import and RAW fallback tests against the packaged artifact on every supported platform before claiming distributable support.

## Third-party notices

Retain each shipped package's complete license/notice files. The npm dependencies include them; do not prune them from distributables.

| Component           | License / notice source                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| sharp               | Apache-2.0; its `LICENSE` and native `@img` notices cover libvips and bundled codecs                                    |
| ExifTool wrapper    | MIT; `exiftool-vendored/LICENSE`                                                                                        |
| ExifTool executable | Perl licensing; retain vendored package licenses and documentation                                                      |
| LibRaw WASM wrapper | MIT; retain the package's license files                                                                                 |
| LibRaw              | CDDL-1.0 or LGPL-2.1; retain `LibRaw/COPYRIGHT`, `LibRaw/LICENSE.CDDL`, and `LibRaw/LICENSE.LGPL` from the WASM package |
| typed-cstruct       | MIT; retain its package license                                                                                         |
| Node.js             | MIT and bundled third-party notices in the runtime package's `LICENSE`                                                  |

Test photographs are never part of the application bundle. Their provenance is in [fixture documentation](../tests/fixtures/README.md).
