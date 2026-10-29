# Install and use ZDM

## Install

ZDM runs on **Windows 10/11 (64-bit)**, **macOS** and **Linux**. Windows 7 / 8 / 8.1, 32-bit PCs and older macOS/Linux: see
[LEGACY.md](LEGACY.md). Steps for Windows come first; [macOS](#macos) and [Linux](#linux) follow below.

1. Open the project's Releases page and download **ZDM-Setup.exe** from *Assets*. Do not use the automatic "Source code" archives.
2. Run the installer and follow the wizard. It installs for the current user; no administrator rights are needed.
3. The installer is unsigned, so Windows SmartScreen may warn about an unknown publisher. Compare the file's SHA-256 with
   `SHA256SUMS.txt` on the release page before running it. Do not turn off your antivirus.
4. Start **ZDM** from the Start menu. Closing its window keeps it in the system tray; right-click the tray icon to quit.

If an old copy is running, the installer closes it for you.

### macOS

1. Download the `.dmg` that matches your Mac from *Assets*: `ZDM-mac-arm64.dmg` (Apple Silicon: M1 and newer) or `ZDM-mac-x64.dmg` (Intel).
   Compare its SHA-256 with `SHA256SUMS-macos-linux.txt`.
2. Open the `.dmg` and drag **ZDM** to **Applications**.
3. The app is not notarized by Apple, so the first start is blocked. Right-click **ZDM** > **Open** > **Open**, or in Terminal run
   `xattr -dr com.apple.quarantine /Applications/ZDM.app`.
4. ZDM lives in the menu bar; closing its window keeps it running there. Quit with **ZDM > Quit** (Command+Q).

### Linux

Pick the package for your system from *Assets* (64-bit Intel/AMD = `amd64`/`x86_64`, ARM = `arm64`/`aarch64`):

- **Debian, Ubuntu, Mint:** `sudo apt install ./ZDM-linux-amd64.deb`
- **Fedora, openSUSE, RHEL:** `sudo dnf install ./ZDM-linux-x86_64.rpm`
- **Any distribution:** `chmod +x ZDM-linux-x86_64.AppImage && ./ZDM-linux-x86_64.AppImage`

Notes: the tray icon needs a desktop that shows tray icons (on GNOME install the *AppIndicator* extension; without it use the app
window and launch ZDM again to bring it back). On Ubuntu 23.10 and newer an AppImage runs without Chromium's process sandbox because
the system forbids the sandbox it would need; prefer the `.deb` there. *Start ZDM when I sign in* adds an entry in `~/.config/autostart`.
The browser connection needs a browser that is installed as a normal package: a Snap or Flatpak browser cannot start ZDM's connector.

## Connect your browser

The extension lets ZDM take over browser downloads and adds *Download this video* buttons. It ships with the app.

1. In ZDM open **Browser Integration** and click **Copy extension folder path** (normally `C:\Users\YOU\.zdm\BrowserIntegration\extension`
   on Windows, `~/.zdm/BrowserIntegration/extension` on macOS and Linux).
2. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge) and switch on **Developer mode**.
3. Click **Load unpacked**, press **Ctrl+L** in the folder window (macOS: **Command+Shift+G**), paste the path, press **Enter**, then **Select Folder**.
4. The extension appears as **ZDM Integration**. Open its popup: it should say **Connected to ZDM**.

The extension has a fixed ID, so ZDM registers the browser connection by itself when it starts and repairs it if it ever disappears.
No extension ID or command is needed. Firefox: load `manifest.firefox.json` as a temporary add-on.

**Not connected?** Keep ZDM running, open Browser Integration and click **Refresh browsers**; the dialog names the broken step
(registry entry or connector file, manifest, connector program or extension ID). Then reload the extension and the page.

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
**Settings → Apps** (macOS: drag ZDM to the Trash; Linux: `sudo apt remove zdm` / `sudo dnf remove zdm`, or delete the AppImage). Your downloads and the `.zdm` folder in your user profile are not deleted. Remove the browser extension separately.
