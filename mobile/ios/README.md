# iOS app

`ZdmViewController.swift` hosts `shared/index.html` in a WKWebView, receives `zdmNative` script messages and resolves
them through `window.zdmResolve`. `DownloadService.swift` implements the native bridge with `URLSession` byte ranges,
2 MiB blocks, persisted offsets, pause/resume/cancel and CryptoKit checksum verification. Files are saved under the
app's Documents directory.

iOS is 64-bit only. Browser takeover, page extraction, FFmpeg remuxing and background segmented transfers remain
desktop features. Build on macOS with Xcode and `xcodegen generate --spec project.yml`; the IPA produced in CI is
unsigned and must be re-signed before installation. See [docs/MOBILE.md](../../docs/MOBILE.md).
