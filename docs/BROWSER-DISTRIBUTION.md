# Browser distribution

## Today

The extension is loaded unpacked from the folder ZDM installs (`~/.zdm/BrowserIntegration/extension`). It carries a fixed manifest
`key`, so its ID is always `lhgcpodkgbalmogcjhdmmphkpijmpefm`; ZDM registers its native messaging host for that ID in Chrome and Edge on
every start (Firefox uses the add-on ID `zdm@zelvior.local`). Nothing has to be copied or typed by the user.

Chrome cannot silently enable an unpacked extension, so the user still loads it once with **Load unpacked**.

## Store submission

Run `powershell -File integration/package-extension.ps1`. The ZIP in `release-extension` has `manifest.json` at its root and excludes tests
and the Firefox manifest. Submit it through your Chrome Web Store developer account and complete the privacy and permission disclosures
from the extension's real behaviour. Edge accepts the same package in its own store; Firefox needs `manifest.firefox.json` through
addons.mozilla.org.

When a store ID exists, add it to the native messaging allow-list in `desktop/browser-registration.cjs` alongside the fixed development ID,
then verify on a fresh browser profile: install the app, accept the browser's extension prompt, select a video and receive the download
dialog. Do not claim automatic installation until that flow has been verified.

References:
- https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions
- https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options
