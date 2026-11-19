# Android app

`ZdmActivity.kt` hosts `shared/index.html` in a WebView and injects `window.zdmNative.call(method, json)`.
`DownloadService.kt` executes the native bridge contract with OkHttp: HEAD probe, four-worker byte-range scheduler,
2 MiB blocks, resume from `state.json`, pause/resume/cancel, and MD5/SHA-256 verification. Output is written to
`filesDir/downloads/out`.

Build requirements: Android SDK 34, JDK 17 and Gradle 8.9. The build produces `armeabi-v7a` (32-bit), `arm64-v8a`
(64-bit) and universal unsigned release APKs. Desktop `ffmpeg-static` binaries cannot be used here; media remuxing is
not part of this mobile build. See [docs/MOBILE.md](../../docs/MOBILE.md).
