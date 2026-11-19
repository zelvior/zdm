# Mobile builds

The desktop app cannot be recompiled for phones: Electron has no Android/iOS target, and the engine relies on Node-only
APIs (`worker_threads`, `node:http2`, raw `fs` handles, native messaging, an ASAR-unpacked FFmpeg and a loopback HTTP
bridge). `mobile/` is therefore a native port that reuses the **full desktop renderer** and implements the same
`window.downloader` API on top of a native bridge (`renderer/mobile-bridge.js`).

## What the shipped mobile builds do

Both native engines implement the desktop bridge surface:

- `snapshot` / `status` with the same download fields the renderer expects: status, size, speed, per-connection
  progress, category, description, creation/schedule times, output path and error text.
- `add` / `downloads` with one or many links, mirrors, custom filename, category, note, schedule time, checksum,
  page-extraction flag, output format and queue-only mode.
- `control` / `action` for pause, resume, retry, cancel, remove, open, reveal, start and stop.
- **Background activity:** Android runs a `dataSync` foreground service with a live progress notification; iOS holds a
  `UIApplication` background task during a transfer and posts a local notification when a file completes.
- `settings` for concurrency, connections per file, speed limit, hash verification, notifications, clipboard watching
  and all other renderer settings. Settings are persisted in `state.json`.
- `clipboard` (Android `ClipboardManager`, iOS `UIPasteboard`) and `chooseDirectory` (the app's own output folder).
- `formats` and `review` for page media discovery: YouTube `ytInitialPlayerResponse` direct formats, `og:video`,
  `<source>` and JSON-LD `contentUrl` / `.mp4` links on other pages.
- `integration`, `browserSetup`, `registerBrowser`, `registerCustom`, `removeCustom`, `openProgress`, `about` and the
  progress-window methods return mobile-appropriate responses so every desktop screen still works.

The transfer engine keeps the desktop split-download behaviour: HTTP(S) `HEAD` probing, mirror failover, byte-range
blocks sized from the connections setting (minimum 2 MiB), retries, pause/resume/cancel, persisted block offsets, speed
reporting and MD5/SHA-256 verification. The `connections` setting accepts **1–64** (default 16), the same ceiling as the
desktop app; Android uses a dedicated 64-thread block pool so 64 ranges really run in parallel, and iOS dispatches up to
64 block tasks through `DispatchQueue.global`. Four download slots are scheduled independently. A generation counter
prevents a cancelled worker from finalising a file after a restart.

| Target | Architecture | Build artifact | Installation |
|---|---|---|---|
| Android | `armeabi-v7a` (32-bit) and `arm64-v8a` (64-bit), plus universal APK | Signed APK | Install directly; Play Store still needs its own signing key |
| iOS | 64-bit only (Apple ended 32-bit support in iOS 11) | Unsigned IPA | Re-sign with an Apple identity before installing |

## Platform boundaries

A small number of desktop capabilities depend on operating-system facilities that mobile platforms do not offer:

- **Browser native messaging** cannot exist on Android/iOS; the integration screen explains this and the share sheet /
  clipboard replace it. The renderer and its browser-connection UI are still present.
- **YouTube cipher-protected formats** need yt-dlp's JavaScript runtime. The native extractor uses direct
  `streamingData` URLs; if a video offers only ciphered formats, paste the resolved media link instead.
- **FFmpeg remux/transcode** (MKV/WebM/FLAC targets and HLS/DASH key handling) needs a mobile FFmpeg build and is not
  bundled. Direct media downloads and the formats the browser already exposes work.
- **Arbitrary filesystem paths** are replaced by the app's own Downloads/Documents folder; neither OS allows writing
  anywhere without a system picker/SAF integration.
- **iOS 32-bit builds cannot exist** (Apple ended support in iOS 11), so only 64-bit iOS is shipped.
- **iOS background segmented transfers** are constrained by the OS: a background task keeps the app alive briefly after
  the screen locks, but a long transfer still needs the app in the foreground. Android's foreground service has no such
  restriction.
- The iOS build sets `NSAllowsArbitraryLoads` so `http://` links work outside the WKWebView; prefer HTTPS and remove
  this exception before a strict App Store submission.
- Android APKs are signed with `mobile/android/zdm-release.p12`, a public sideload key committed to this repository.
  The key provides no publisher authenticity; verify the published SHA-256 sums. If an older build used a different key,
  uninstall it before installing this one. The iOS IPA remains unsigned and must be re-signed outside CI.

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
aligns, signs and renames them to `ZDM-Android-universal.apk`, `ZDM-Android-armeabi-v7a.apk`, `ZDM-Android-arm64-v8a.apk` and
`ZDM-iOS-unsigned.ipa`, writes `SHA256SUMS-android.txt` / `SHA256SUMS-ios.txt`, uploads them as workflow artifacts and
attaches them to the release tag supplied in the dispatch form (creating a pre-release when the tag does not exist).

This is separate from the Electron releases (`release.yml`, `release-unix.yml`, `release-legacy.yml`) and from the GPL
source mirrors required by the bundled FFmpeg binary.
