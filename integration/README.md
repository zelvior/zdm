# Browser integration

ZDM connects to the browser extension through Chrome's **native messaging**.

- **Pairing:** the extension has a fixed ID (see [../docs/BROWSER-DISTRIBUTION.md](../docs/BROWSER-DISTRIBUTION.md)). When ZDM starts it registers
  its native host for Chrome, Edge and Firefox, re-checks every 15 seconds and repairs a missing registry entry, manifest, launcher or ID.
- **Flow:** the browser starts the launcher: on Windows `native-host.exe` (built from `NativeHostLauncher.cs`, with a `native-host.cmd` fallback),
  on macOS and Linux `native-host.sh`. On Windows the browser finds it through a registry key; on macOS and Linux ZDM writes the native
  messaging manifest into the browser's own folder (for example `~/.config/google-chrome/NativeMessagingHosts/`). It runs
  `native-host.cjs`, which forwards bounded, validated JSON to the authenticated loopback bridge and starts ZDM if it is closed.
- **Privacy:** cookies, authorization, user agent and referrer stay in extension memory; only context observed for the selected URL and tab
  is passed on. Credentials are excluded from history and stripped on cross-origin redirects.
- **Scripts:** `register-native-host.ps1` registers manually (development); `package-extension.ps1` builds the store ZIP.

Supported: HTTP(S) files of any type, byte-range resume, HLS, DASH, separate audio/video assembly, web-page video extraction, MP4 remuxing
and audio extraction. Not supported: DRM-protected streams, arbitrary POST downloads, proxy inheritance. `blob:` URLs cannot be downloaded
themselves; their observed network playlists may be.

Taking over browser downloads is on by default and only cancels the browser's copy after ZDM accepts it.
