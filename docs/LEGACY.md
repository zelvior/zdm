# Legacy builds: older systems and 32-bit

The `legacy/` track builds ZDM for systems the standard build (Electron 44, `npm run dist`, `dist:mac`, `dist:linux`) no longer runs on.
It uses older Electron versions, which is why it exists as a separate, slightly reduced build.

| System | Standard build | Legacy build |
|---|---|---|
| Windows | 10 / 11, x64 | 7 SP1 / 8 / 8.1 / 10 / 11, ia32 and x64 (`ZDM-32bit.exe`, `ZDM-64bit.exe`) |
| macOS | current macOS, Apple Silicon and Intel (`ZDM-mac-arm64.dmg`, `ZDM-mac-x64.dmg`) | **10.13 High Sierra and newer, Intel** (`ZDM-legacy-mac-x64.dmg`; also runs on Apple Silicon through Rosetta) |
| Linux, 64-bit | x64 and ARM64: `.AppImage`, `.deb`, `.rpm` (`ZDM-linux-*`) | x64: `.AppImage`, `.deb` (`ZDM-legacy-linux-x64`) for older distributions |
| Linux, 32-bit | not available | **experimental**: `.AppImage`, `.deb` (`ZDM-legacy-linux-ia32`) |
| Runtime | Electron 44 | Electron 22 (Chromium 108, Node 16); 32-bit Linux: Electron 17.4.11 (Chromium 98, Node 16.13) |
| YouTube browser capture (SABR) | yes | no (reported as unavailable; direct files, HLS, DASH and page extraction still work) |

## What "32-bit macOS" can and cannot mean

**There is no 32-bit macOS build, and one cannot be made.** Electron has never shipped a 32-bit macOS runtime, and Apple removed 32-bit
application support in macOS 10.15. Every Mac that can run Electron at all runs it as a 64-bit app, so the macOS legacy build is the
64-bit Intel build for the **oldest macOS Electron supports with a still-usable Chromium: 10.13**. Electron removed 10.13 and 10.14 in
version 27 and macOS 10.15 in version 33, which is why the standard build cannot cover them. macOS 10.12 and older would need an Electron
release that has been out of support for years, so they are not supported.

## What "legacy Linux" can and cannot mean

- **32-bit Linux is experimental.** Electron stopped supporting 32-bit Linux after version 17 (Electron 18 no longer runs on it), so this
  one build uses Electron 17.4.11, which is no longer maintained and has known browser-engine security issues. It only loads ZDM's own
  local pages, but treat it as a best-effort option for old hardware and do not use it to browse the web. It has not been run on real
  32-bit hardware by the project.
- yt-dlp has no standalone 32-bit Linux program. The 32-bit build bundles yt-dlp's portable script, which needs **Python 3 installed**.
  Without Python, direct downloads still work but extracting a video from a web page does not.
- The legacy x64 build uses Electron 22 (Chromium 108). It runs on older distributions than the standard build, but the exact oldest
  release has not been measured: test on your oldest target distribution.
- Linux on 32-bit ARM (armv7) is not built.

Windows 7 needs updates **KB4474419** and **KB4490628** before modern installers run.

## Build (Windows)

```powershell
cd legacy
npm install              # set npm_config_arch=ia32 first for the 32-bit installer
npm run stage            # copies shared sources and applies the legacy substitutions
npm run verify           # fails on syntax or APIs that Node 16 / Chromium 108 lack
npm run dist:ia32        # or dist:x64
```

`legacy/stage` and `legacy/release` are generated and git-ignored.

## Build (macOS and Linux)

Run these on the matching operating system. Fetch yt-dlp into the repository's `vendor/` folder first
(`node scripts/fetch-ytdlp.mjs vendor <target>`), then:

```sh
cd legacy
npm_config_arch=x64 npm install                 # macOS and 64-bit Linux
npm run stage && npm run verify
npm run dist:mac                                # fetch target: mac          -> release/ZDM-legacy-mac-x64.dmg/.zip
npm run dist:linux:x64                          # fetch target: linux-x64    -> release/ZDM-legacy-linux-*.AppImage/.deb
```

32-bit Linux skips Electron 22's downloader and installs ffmpeg for the right architecture by hand:

```sh
cd legacy
npm install --ignore-scripts
npm_config_arch=ia32 npm_config_platform=linux node node_modules/ffmpeg-static/install.js
file node_modules/ffmpeg-static/ffmpeg          # must say "ELF 32-bit"
npm run stage && npm run verify
npm run dist:linux:ia32                         # fetch target: linux-ia32   -> release/ZDM-legacy-linux-*.AppImage/.deb
```

The `release-unix.yml` workflow does all of this for you.

## Browser extension on old browsers

The legacy build ships `manifest.legacy.json` (installed as `manifest.json`). Chrome 109, the last Chrome on Windows 7, cannot declare
`"world": "MAIN"` scripts, so `background.js` registers them dynamically. Use Chrome/Edge 102+ or Firefox ESR 115.

## Known limits (verify on real machines)

- CI cannot run Windows 7, old macOS or 32-bit Linux. Test on a Windows 7 SP1 machine, a Mac on macOS 10.13 to 11, and a 32-bit Linux VM.
- macOS builds are only ad-hoc signed, not notarized. Users approve the first start (see INSTALL.md).
- yt-dlp no longer publishes a build for macOS older than 10.15 (the last yt-dlp version that supported macOS 10.14 and earlier was
  2025.08.11). The legacy macOS app bundles the standard `yt-dlp_macos`, so **page-video extraction works on macOS 10.15 to 11 and is
  unavailable on macOS 10.13 and 10.14**. Direct downloads, HLS and DASH work everywhere the app runs. Pinning `YTDLP_VERSION=2025.08.11`
  would give 10.13/10.14 an extractor, but one that is over a year old and no longer matches current sites.
- Browser integration builds its native launcher with the .NET Framework `csc.exe`. If none exists, ZDM falls back to a `.cmd` launcher and
  shows the reason if that fails too.
- The bundled FFmpeg must run on the target OS. If it does not run on Windows 7, replace `ffmpeg.exe` with a Windows-7-compatible static build.
- Current `yt-dlp` no longer supports Windows 7, so page-video extraction may not work there.
- `ffmpeg-static` has no 32-bit Windows binary. The ia32 build runs `legacy/fetch-ffmpeg.mjs`, which downloads one, checks it is a 32-bit
  executable and runs `ffmpeg -version`. If the default links break, set the repository variable `FFMPEG_IA32_URL` to a direct link to a
  32-bit `ffmpeg.exe`, `.gz` or `.zip`.

## Releasing

`release-legacy.yml` builds the Windows installers and publishes a GitHub release; `release-unix.yml` adds the macOS and Linux builds (modern and
legacy) to the same release. See [RELEASING.md](RELEASING.md).
