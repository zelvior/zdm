# Legacy build: Windows 7 / 8 / 8.1 and 32-bit

The `legacy/` track builds ZDM installers for **Windows 7 SP1, 8, 8.1, 10 and 11, 32-bit and 64-bit**.
The standard build (Electron 44, `npm run dist`) is separate and unchanged.

| | Standard build | Legacy build |
|---|---|---|
| Windows | 10 / 11, x64 | 7 SP1 / 8 / 8.1 / 10 / 11, ia32 and x64 |
| Runtime | Electron 44 | Electron 22 (Chromium 108, Node 16) |
| Installers | `ZDM-Setup.exe` | `ZDM-32bit.exe`, `ZDM-64bit.exe` |
| YouTube browser capture (SABR) | yes | no (reported as unavailable; direct files, HLS, DASH and page extraction still work) |

Windows 7 needs updates **KB4474419** and **KB4490628** before modern installers run.

## Build

```powershell
cd legacy
npm install              # set npm_config_arch=ia32 first for the 32-bit installer
npm run stage            # copies shared sources and applies the legacy substitutions
npm run verify           # fails on syntax or APIs that Node 16 / Chromium 108 lack
npm run dist:ia32        # or dist:x64
```

`legacy/stage` and `legacy/release` are generated and git-ignored.

## Browser extension on old browsers

The legacy build ships `manifest.legacy.json` (installed as `manifest.json`). Chrome 109, the last Chrome on Windows 7, cannot declare
`"world": "MAIN"` scripts, so `background.js` registers them dynamically. Use Chrome/Edge 102+ or Firefox ESR 115.

## Known limits (verify on real machines)

- CI cannot run Windows 7. Test on a Windows 7 SP1 machine and on a 32-bit VM.
- Browser integration builds its native launcher with the .NET Framework `csc.exe`. If none exists, ZDM falls back to a `.cmd` launcher and
  shows the reason if that fails too.
- The bundled FFmpeg must run on the target OS. If it does not run on Windows 7, replace `ffmpeg.exe` with a Windows-7-compatible static build.
- Current `yt-dlp` no longer supports Windows 7, so page-video extraction may not work there.
- `ffmpeg-static` has no 32-bit Windows binary. The ia32 build runs `legacy/fetch-ffmpeg.mjs`, which downloads one, checks it is a 32-bit
  executable and runs `ffmpeg -version`. If the default links break, set the repository variable `FFMPEG_IA32_URL` to a direct link to a
  32-bit `ffmpeg.exe`, `.gz` or `.zip`.

## Releasing

The `release-legacy.yml` workflow builds both architectures and publishes a GitHub release. See [RELEASING.md](RELEASING.md).
