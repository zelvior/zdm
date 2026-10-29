import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bundled yt-dlp is called yt-dlp.exe on Windows and plain yt-dlp on macOS and Linux (scripts/fetch-ytdlp.mjs saves it that way).
export const ytdlpFileName = (platform = process.platform) => (platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Packaged app: <resources>/tools/. Development and tests: <repo>/vendor/.
export function bundledYtdlpPath({ platform = process.platform, packaged = Boolean(process.versions.electron && process.resourcesPath && !process.defaultApp), resourcesPath = process.resourcesPath } = {}) {
  const name = ytdlpFileName(platform);
  return packaged ? path.join(resourcesPath, 'tools', name) : fileURLToPath(new URL(`../vendor/${name}`, import.meta.url));
}
