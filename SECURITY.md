# Security

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository. If it is unavailable, open a minimal issue asking for a private
channel. Do not publish exploit details.

Never post signed media URLs, cookies, authorization headers, native-messaging payloads, browser profile files or the contents of
`~/.zdm` in a public issue.

## Design rules

- The local bridge between the extension and the app is authenticated and bound to loopback only.
- The native messaging host forwards only validated, size-limited JSON. Format selectors and output formats are allow-listed; file names
  are sanitised; page JavaScript has no handoff endpoint.
- Request credentials (cookies, authorization) are held only in the extension/app process, are excluded from history and UI snapshots,
  and are stripped on cross-origin redirects. When a site truly needs them, yt-dlp and ffmpeg receive them as command-line arguments:
  neither tool has a portable header-file channel, so a user who can inspect another process on the same machine may be able to see
  them. ZDM never logs credentials, and a dedicated OS account removes that local observer. Do not run ZDM on a shared machine with
  untrusted local users if this matters.
- Download blocks are written only after every byte was received (see [docs/PERFORMANCE.md](docs/PERFORMANCE.md)).
- No DRM bypass, no credential harvesting, no page-controlled file paths.

## Supported versions

Only the latest release is maintained. There is no automatic updater yet.
