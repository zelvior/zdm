# Mobile port

Native Android and iOS builds of ZDM. See [docs/MOBILE.md](../docs/MOBILE.md) for the feature set, platform limits and
release workflow.

- `shared/` — HTML/CSS/JS UI and the Promise bridge adapter used by both platforms.
- `protocol/bridge.json` — the `status` / `downloads` / `control` contract.
- `android/` — Kotlin + OkHttp engine and WebView host (32-bit, 64-bit and universal APKs).
- `ios/` — Swift + URLSession engine and WKWebView host (64-bit IPA).

These builds are independent of `npm run dist` and produce their own release assets.
