// Downloads yt-dlp from the official GitHub release and verifies it against the release's SHA2-256SUMS file.
// Usage: node scripts/fetch-ytdlp.mjs <destination directory> [x64|ia32|mac|linux-x64|linux-arm64|linux-ia32]
// Windows targets are saved as yt-dlp.exe, macOS and Linux targets as an executable file named yt-dlp.
// The packaged app uses it to find the video on any supported web page (see core/extract.mjs).
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ytdlpTarget } from './ytdlp-assets.mjs';

const [dest = 'vendor', arch = 'x64'] = process.argv.slice(2);
const version = process.env.YTDLP_VERSION || '2026.08.19';
const { asset, output, needsPython } = ytdlpTarget(arch);
const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
async function get(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
const sums = (await get(`${base}/SHA2-256SUMS`)).toString('utf8');
const expected = sums.split(/\r?\n/).map(l => l.trim().split(/\s+\*?/)).find(([, name]) => name === asset)?.[0];
if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
  const published = sums.split(/\r?\n/).map(l => l.trim().split(/\s+\*?/)[1]).filter(Boolean).join(', ');
  throw new Error(`No checksum for ${asset} in release ${version}. That release publishes: ${published}`);
}
const data = await get(`${base}/${asset}`);
const actual = createHash('sha256').update(data).digest('hex');
if (actual !== expected.toLowerCase()) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}.`);
await fs.mkdir(dest, { recursive: true });
await fs.writeFile(path.join(dest, output), data, { mode: 0o755 });
await fs.chmod(path.join(dest, output), 0o755);
console.log(`yt-dlp ${version} (${asset}) verified and saved to ${path.join(dest, output)} (${data.length} bytes).`);
if (needsPython) console.log('Note: this target is the zipapp build and needs Python 3 on the user\'s machine.');
