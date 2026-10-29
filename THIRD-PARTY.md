# Third-party components

ZDM is MIT licensed (see [LICENSE](LICENSE)). It bundles or uses the following components, each under its own license.

## FFmpeg (via ffmpeg-static)

ZDM uses `ffmpeg-static` 5.3.0 (GPL-3.0-or-later), which supplies FFmpeg binary release b6.1.1. FFmpeg runs as a separate executable for
local merging and conversion; it is never linked into ZDM.

- Package and binary provenance: https://github.com/eugeneware/ffmpeg-static
- Binary release and build information: https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1
- FFmpeg source and licensing: https://ffmpeg.org/download.html and https://ffmpeg.org/legal.html

The installer includes FFmpeg's GPL text and build provenance under `resources/licenses`. Before any public binary release, the
corresponding source and build material for this exact binary and its linked libraries must be prepared and mirrored with the release
(see [docs/RELEASING.md](docs/RELEASING.md)).

## yt-dlp

Windows builds include `yt-dlp.exe` from the official `yt-dlp/yt-dlp` GitHub release (version pinned in `scripts/fetch-ytdlp.mjs`),
downloaded in CI and verified against the release's `SHA2-256SUMS`. The yt-dlp core is public domain; the Windows executable includes
components under their own licenses, whose notices ship in `resources/tools`. Source: https://github.com/yt-dlp/yt-dlp

## googlevideo

The browser-capture path for YouTube uses `googlevideo` 5.0.1 (MIT), a library for YouTube's UMP/SABR transport.
Source and license: https://github.com/LuanRT/GoogleVideo

## Electron and npm dependencies

Electron, Chromium and other bundled packages keep their upstream license files and notices inside the installed application.
