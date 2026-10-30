# Start here

ZDM is a download manager for Windows, macOS and Linux by Zelvior. This page is the map of the code.

## How a download flows

1. **Entry points:** the Add URL dialog (`renderer/`), the clipboard monitor (`desktop/clipboard-links.cjs`), or the browser extension
   (`extension/`) through the native host (`integration/native-host.cjs`) and the authenticated local bridge (`core/bridge.mjs`).
2. **`core/engine.mjs`** probes the URL (`core/http.mjs`) and picks a path:
   - range-capable file of 4 MB or more: block download, `core/scheduler.mjs` + `core/chunk.mjs` + `core/write-queue.mjs`, hashed by `core/hasher.mjs`;
   - smaller or non-range file: part-file download;
   - HLS (`core/hls.mjs`), DASH and other streams (`core/extract.mjs`, ffmpeg), web pages (yt-dlp), YouTube capture (`core/sabr.mjs`).
3. Finished files are assembled or moved into place (`assemble` in the engine), categorised (`core/filetypes.mjs`) and reported to the UI.

## Where things live

| Area | Files |
|---|---|
| Scheduling, adaptive sizing, throttling | `core/scheduler.mjs`, `core/ranges.mjs` |
| Block memory safety | `core/block-buffer.mjs`, `core/write-queue.mjs` |
| Worker threads | `core/pool.mjs`, `core/chunk-worker.mjs`, `core/hash-worker.mjs` |
| Transport (HTTP/1.1, HTTP/2, DNS) | `core/http.mjs`, `core/dns.mjs` |
| Browser pairing | `desktop/browser-registration.cjs`, `integration/`, `extension/background.js` |
| Interface and theme | `renderer/index.html`, `renderer/app.js`, `renderer/styles.css` |

## Working on it

```powershell
npm ci
npm test
```

Engine tests start local HTTP servers and compare file hashes. Add a test next to the behaviour you change. Keep the interface
black and white, flat and square. See [../CONTRIBUTING.md](../CONTRIBUTING.md) for the pull-request rules.
