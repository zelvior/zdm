# Releasing ZDM

Public source and public binaries are separate steps. Do not publish a download just because a local package command succeeded.

## Checklist

1. `npm ci && npm test` on Windows, Linux and macOS (the **Tests** workflow runs all three).
2. Review the diff for private data and proprietary material.
3. Verify third-party notices ([../THIRD-PARTY.md](../THIRD-PARTY.md)). Prepare and mirror the corresponding source for the bundled GPL
   FFmpeg binary and its linked libraries next to the release assets, and record hashes. Review yt-dlp's bundled components too.
4. Build the installers (below) and test one on a clean Windows machine without Node.js: install, launch, connect the extension, take over
   a browser download, download a video, update over the old version, uninstall.
5. Publish as a **pre-release** until clean-machine checks and known limits are documented.
6. Never attach research files, browser profiles, diagnostics containing media URLs, or user data.

## Standard installer

Run the **Build Windows release candidate** workflow (`release.yml`). It downloads and checksum-verifies `yt-dlp.exe`
(`scripts/fetch-ytdlp.mjs`), builds `ZDM-Setup.exe` and `SHA256SUMS.txt`, and uploads them as workflow artifacts. Publish them yourself.

## Legacy installers and GitHub release

Run **release-legacy.yml** from the Actions tab. Inputs:

| Input | Meaning |
|---|---|
| `tag` | New tag such as `0.2.0` or `v0.2.0` (a missing `v` is added). Empty: `v<package version>-r<run number>` |
| `title` | Release title. Empty: `ZDM <tag>` |
| `notes` | Your release notes, placed above the auto-generated commit list |
| `prerelease` | Mark the release as a pre-release |
| `overwrite` | Replace the files of an **existing** release with the same tag. Off by default: an existing tag fails instead of being overwritten |

The workflow builds `ZDM-32bit.exe` and `ZDM-64bit.exe`, writes `SHA256SUMS.txt` and creates the release. Pushing a `v*` tag runs it too.

## macOS and Linux apps

Run **release-unix.yml** after `release-legacy.yml`, with the **same tag**, to attach these files to the Windows release (a new tag creates a
release that holds only these files):

- modern: `ZDM-mac-arm64.dmg/.zip`, `ZDM-mac-x64.dmg/.zip`, `ZDM-linux-*.AppImage/.deb/.rpm` for x64 and arm64
- legacy: `ZDM-legacy-mac-x64.dmg/.zip`, `ZDM-legacy-linux-*.AppImage/.deb` for x64 and 32-bit

It writes `SHA256SUMS-macos-linux.txt` (separate from the Windows `SHA256SUMS.txt`). Before announcing a platform, install it on a real
machine: macOS first-start approval, drag to Applications, connect Chrome, take over a download; Linux `.deb` on Ubuntu LTS, `.rpm` on
Fedora, the AppImage on a distribution with restricted user namespaces (Ubuntu 24.04), tray icon on GNOME and KDE.

macOS builds are ad-hoc signed only. Notarization needs an Apple Developer ID (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`) and removing `identity: null` in `electron-builder.unix.cjs`; it is not set up.

Code signing and browser-store publication are not configured; do not advertise them.
