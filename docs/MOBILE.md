# Mobile builds

The desktop app cannot be recompiled for phones: Electron has no Android/iOS target, and the engine relies on Node-only
APIs (`worker_threads`, `node:http2`, raw `fs` handles, native messaging, an ASAR-unpacked FFmpeg and a loopback HTTP
bridge). `mobile/` is therefore a native port with its own UI, bridge and download engine.

## What the shipped mobile builds do

Both native engines implement the same core download path:

- HTTP and HTTPS links only, with credentials rejected.
- `HEAD` probe for file size; four worker slots split the file into 2 MiB byte-range blocks.
- Parallel range requests written into one pre-sized file, with retries and 64 KiB copy buffers.
- Persisted block offsets in `state.json`, so an interrupted transfer resumes after restart.
- Pause, resume, retry and cancel, plus MD5/SHA-256 verification via `checksum: sha256:<hex>` or `md5:<hex>`.
- Safe filenames and collision suffixes; output stays inside the app's own `Downloads` directory.
- Shared mobile UI (`mobile/shared/`) polls `/status` and drives `/downloads` and `/control` through a small bridge.

| Target | Architecture | Build artifact | Installation |
|---|---|---|---|
| Android | `armeabi-v7a` (32-bit) and `arm64-v8a` (64-bit), plus universal APK | Unsigned APK | Sideload; signing required for Play Store |
| iOS | 64-bit only (Apple ended 32-bit support in iOS 11) | Unsigned IPA | Re-sign with an Apple identity before installing |

The bridge contract is in `mobile/protocol/bridge.json`; Android uses an injected `zdmNative` JavaScript interface and
iOS uses a `WKScriptMessageHandler` plus `window.zdmResolve`. Both surface the same Promise API to `mobile/shared/zdm.js`.

## Platform limits (documented, not hidden)

- Browser download takeover and page-video extraction (yt-dlp/`formats`) are desktop-only. The mobile UI accepts direct
  file URLs, not web pages; `formats` returns an explanatory error.
- FFmpeg/HLS/DASH remuxing, `outputFormat` conversion and arbitrary filesystem destinations are not ported.
- Android writes to `filesDir/downloads/out`; iOS writes to the app's Documents directory. Neither platform permits
  writing anywhere the user chooses without a system picker/SAF integration.
- iOS background segmented transfers are constrained by `URLSession` rules; downloads continue only while the app is
  active. A foreground service/WorkManager path is not wired up yet.
- iOS 32-bit builds cannot exist. The legacy Android 32-bit APK remains supported.
- Mobile builds are unsigned; users must trust the source and verify the published SHA-256 sums.

## Building locally

Android (Linux/macOS/Windows):

```sh
# Android SDK 34, JDK 17; Gradle wrapper or system Gradle 8.9
gradle -p mobile/android assembleRelease --no-daemon
# APKs: mobile/android/app/build/outputs/apk/release/
```

iOS (macOS with Xcode):

```sh
brew install xcodegen
cd mobile/ios && xcodegen generate --spec project.yml
xcodebuild -project ZDM.xcodeproj -scheme ZDM -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  -archivePath build/ZDM.xcarchive archive
```

## Releases

`.github/workflows/release-mobile.yml` is a manual `workflow_dispatch`. It builds the three APK variants and one IPA,
renames them to `ZDM-Android-universal.apk`, `ZDM-Android-armeabi-v7a.apk`, `ZDM-Android-arm64-v8a.apk` and
`ZDM-iOS-unsigned.ipa`, writes `SHA256SUMS-android.txt` / `SHA256SUMS-ios.txt`, uploads them as workflow artifacts and
attaches them to the release tag supplied in the dispatch form (creating a pre-release when the tag does not exist).

This is separate from the Electron releases (`release.yml`, `release-unix.yml`, `release-legacy.yml`) and from the GPL
source mirrors required by the bundled FFmpeg binary.
