# Install and use ZDM

## Install

ZDM targets **Windows 10 and 11 (64-bit)**. Windows 7 / 8 / 8.1 and 32-bit PCs: see [LEGACY.md](LEGACY.md).

1. Open the project's Releases page and download **ZDM-Setup.exe** from *Assets*. Do not use the automatic "Source code" archives.
2. Run the installer and follow the wizard. It installs for the current user; no administrator rights are needed.
3. The installer is unsigned, so Windows SmartScreen may warn about an unknown publisher. Compare the file's SHA-256 with
   `SHA256SUMS.txt` on the release page before running it. Do not turn off your antivirus.
4. Start **ZDM** from the Start menu. Closing its window keeps it in the system tray; right-click the tray icon to quit.

If an old copy is running, the installer closes it for you.

## Connect your browser

The extension lets ZDM take over browser downloads and adds *Download this video* buttons. It ships with the app.

1. In ZDM open **Browser Integration** and click **Copy extension folder path** (normally `C:\Users\YOU\.zdm\BrowserIntegration\extension`).
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and switch on **Developer mode**.
3. Click **Load unpacked**, press **Ctrl+L** in the folder window, paste the path, press **Enter**, then **Select Folder**.
4. The extension appears as **ZDM Integration**. Open its popup: it should say **Connected to ZDM**.

The extension has a fixed ID, so ZDM registers the browser connection by itself when it starts and repairs it if it ever disappears.
No extension ID or command is needed. Firefox: load `manifest.firefox.json` as a temporary add-on.

**Not connected?** Keep ZDM running, open Browser Integration and click **Refresh browsers**; the dialog names the broken step
(registry entry, manifest, connector program or extension ID). Then reload the extension and the page.

## Download

- **A file:** *Add URL* in the app, or just click a link in the browser. The extension sends every file type to ZDM; the browser keeps
  the download if ZDM is not running. Exclude sites or types (`example.com, .pdf`) in the extension popup.
- **A video from a web page:** click *Download this page's video* in the popup, use the button over the player, or tick
  *This address is a web page* in the add dialog. Choose quality and container. Works with YouTube, Vimeo, social media and
  roughly 1,800 other sites through `yt-dlp`.
- **Copied links:** copy a link and ZDM offers to add it. Turn this off under Options → General.
- In **Download File Info** choose a name, folder and category, then **Start Download**, **Download Later** or **Cancel**.

### Limits

DRM-protected video (Netflix, Disney+ and similar), live streams and videos that need a sign-in the site will not give to a
downloader cannot be saved. Only download content you are allowed to keep.

## Update and uninstall

Run the newer installer; it replaces the old version and keeps your settings and downloads list. Uninstall from
**Settings → Apps**. Your downloads and the `.zdm` folder in your user profile are not deleted. Remove the browser extension separately.
