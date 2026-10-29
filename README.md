# ZDM

**ZDM** is a fast download manager for **Windows, macOS and Linux**, made by **Zelvior**. It splits big files into blocks, downloads them over many
connections at once, takes over your browser's downloads, and can pull the video out of almost any web page.

Black-and-white interface. No ads, no accounts, no telemetry.

## What it does

| | |
|---|---|
| **Fast transfers** | Up to 64 parallel connections per file, HTTP/1.1 and HTTP/2 (ALPN) with multiplexing, one pre-sized file written directly in place, resume after pause, crash or restart |
| **Built for huge files** | Block size grows with the file: 2–4 MB for small files, up to 64 MB for files over 128 GiB. A 500 GB download needs about 8,000 requests instead of about 125,000 |
| **Adaptive** | Fast connections get larger blocks, slow ones are dropped and replaced, faster mirrors receive more blocks, idle connections duplicate the last stragglers |
| **Polite to servers** | HTTP 429 / 503 halve that server's connections, honour `Retry-After`, move to one multiplexed HTTP/2 session, then recover slowly |
| **Integrity** | SHA-256 and MD5 are computed in a worker thread while downloading. Enter a checksum and a mismatch discards the file |
| **Any file** | Every file type, categorised (Video, Audio, Images, Archives, Documents, Programs, Other). Missing extensions are filled in from Content-Type |
| **Any video page** | `yt-dlp` and `ffmpeg` find and merge the best streams: choose quality (up to 4K, 1080p, 720p, 480p, audio only) and container (MP4, MKV, WebM, MP3, M4A, FLAC, WAV). HLS and DASH (`.mpd`) manifests are supported |
| **Browser takeover** | The Chrome / Edge / Firefox extension sends every browser download to ZDM. If ZDM is not running, the browser keeps the download |
| **Clipboard links** | Copy a download or video link and ZDM offers to add it |
| **Live indicators** | Download details show the protocol (HTTP/2 or HTTP/1.1), range blocks, multiplexing, connections in use, throttling, hashing and checksum status |

DRM-protected streams (Widevine, PlayReady, FairPlay) are refused. ZDM does not and will not bypass DRM.

## Install

| System | Download from the Releases page |
|---|---|
| **Windows 10/11, 64-bit** | `ZDM-Setup.exe` |
| **Windows 7 / 8 / 8.1, or 32-bit Windows** | `ZDM-32bit.exe` / `ZDM-64bit.exe` |
| **macOS** (Apple Silicon / Intel) | `ZDM-mac-arm64.dmg` / `ZDM-mac-x64.dmg` |
| **Older macOS** (10.13 and newer, Intel) | `ZDM-legacy-mac-x64.dmg` |
| **Linux** 64-bit (Intel/AMD, ARM64) | `ZDM-linux-*.AppImage`, `.deb` or `.rpm` |
| **Older Linux**, and 32-bit Linux (experimental) | `ZDM-legacy-linux-*` |

The installers and apps are unsigned: Windows SmartScreen and macOS Gatekeeper will warn the first time. Verify the SHA-256 file on the
release page before running. Closing the window keeps ZDM in the system tray (switchable in Options). Details per system:
[docs/INSTALL.md](docs/INSTALL.md) and [docs/LEGACY.md](docs/LEGACY.md) (what "legacy" can and cannot cover).

Full walkthrough, including the browser extension: [docs/INSTALL.md](docs/INSTALL.md).

## Use it

- **Add URL:** paste one or many links. Under *Advanced* you can add mirrors, a checksum, or tick *This address is a web page* to extract its video.
- **From the browser:** click a download link, or use the extension's *Download this page's video* button.
- **Pause, resume, queue, schedule:** from the toolbar. Speed limit, connection count, memory budget and the rest are in **Options**.

## Build from source

```sh
npm ci
npm test
npm start                 # run the app
npm run dist              # Windows: NSIS installer -> release/ZDM-Setup.exe
npm run dist:mac -- --arm64   # macOS (or --x64): .dmg and .zip -> release/
npm run dist:linux -- --x64   # Linux (or --arm64): .AppImage, .deb, .rpm -> release/
```

Requires Node.js 22. Build each package on its own operating system (Windows installer on Windows, `.dmg` on macOS, Linux packages on
Linux); before `dist:mac`/`dist:linux` fetch yt-dlp with `node scripts/fetch-ytdlp.mjs vendor mac` (or `linux-x64`, `linux-arm64`).
The 32-bit and older-system track lives in [`legacy/`](legacy/).
Release steps: [docs/RELEASING.md](docs/RELEASING.md). Performance design: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Project layout

| Folder | Contents |
|---|---|
| `core/` | Download engine: scheduler, block buffers, write queue, HTTP/1.1 + HTTP/2 transport, DNS cache, hashing, HLS, yt-dlp / ffmpeg extraction |
| `desktop/` | Electron main process, tray, About window, clipboard monitor, browser registration |
| `renderer/` | The user interface |
| `extension/` | Browser extension (Chrome, Edge, Firefox) |
| `integration/` | Native messaging host that links the extension to the app |
| `legacy/` | Build track for Windows 7 / 8 / 32-bit |
| `tests/` | Engine tests (extension and integration tests sit beside their code) |

## License

Apache License 2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD-PARTY.md](THIRD-PARTY.md).
