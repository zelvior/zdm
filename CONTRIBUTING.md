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

## Changing the logo

The two source logos live in `docs/branding/` (`zdm-logo.jpg`, white on black, and the transparent `zdm-wordmark.png`). Every icon and
installer image is generated from `zdm-logo.jpg` so that all sizes stay consistent:

```sh
pip install pillow numpy
python scripts/generate-brand-assets.py
npm test            # tests/branding.test.mjs checks sizes, ICO frames and the macOS menu bar template
```

Below 96 px the "Z" mark is used (the full wordmark is unreadable that small), from 96 px up the full logo with its tagline.
If you replace `zdm-logo.jpg` with different artwork, adjust the coordinates at the top of the script (the letter box and the cut line
between Z and D).

## Updating the README images

`docs/media/` holds the screenshots and GIFs. They are generated, not hand-made, so they can be refreshed after a UI change:

```sh
pip install pillow numpy playwright && python -m playwright install chromium
python scripts/capture-readme-media.py   # real renderer/ UI with sample downloads -> screenshots + demo.gif
python scripts/generate-readme-art.py    # banner, social preview and the how-it-works diagram
```

The capture script serves `renderer/` locally and replaces only the desktop bridge with sample data, so what you see is the real
interface. Set `docs/branding/social-preview.png` as the repository's social preview image in *Settings > General*.
