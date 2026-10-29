# Contributing to ZDM

ZDM is maintained by **Zelvior**. Bug reports, fixes, tests and documentation corrections are welcome.

## Before you start

- Open an issue for anything bigger than a small fix, and wait for agreement on scope.
- Keep changes focused: one concern per pull request.
- Only test what you can actually run. State which Windows versions and browsers you tested.

## Set up

```powershell
npm ci
npm test
npm start
```

Node.js 22 is required. `npm test` runs the engine, extension and native-host tests. Tests that need a real `ffmpeg` or
`googlevideo` need the production dependencies installed (`npm ci`).

## Pull requests

- `npm test` must pass.
- Add or update a test for every behaviour change. Download-engine changes need a byte-exact test (compare hashes of the result).
- Do not include private URLs, cookies, tokens, browser profile data or proprietary code.
- UI changes stay in the black-and-white theme: no colour accents, no gradients, square corners. Meaning must never depend on colour alone.
- Do not add DRM circumvention or credential harvesting. Such pull requests are closed.

By contributing you agree your work is released under the project's Apache License 2.0, as described in section 5 of that license (inbound = outbound).
