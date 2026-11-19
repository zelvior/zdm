// Mirrors the corresponding source for the GPL-licensed FFmpeg binary that ffmpeg-static bundles.
//
// GPL-3.0 requires a binary release to be accompanied by the complete corresponding source, including the scripts
// used to build it. ZDM ships ffmpeg-static 5.3.0, which contains an FFmpeg b6.1.1 binary. This script downloads both
// source archives from their canonical GitHub tags, verifies them against pinned SHA-256 digests, and writes a
// checksum manifest that the release workflows attach beside the installers.
//
// Usage: node scripts/fetch-ffmpeg-source.mjs [output directory]   (default: release/source)
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SOURCES = [
  {
    name: 'ffmpeg-6.1.1.tar.gz',
    url: 'https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/refs/tags/n6.1.1',
    sha256: '7c1ebea95d815e49c1e60c7ee816410dec73a81b8ac002b276780d2f9048e598',
    about: 'FFmpeg n6.1.1 source (the binary release used by ffmpeg-static 5.3.0 is b6.1.1)'
  },
  {
    name: 'ffmpeg-static-5.3.0.tar.gz',
    url: 'https://codeload.github.com/eugeneware/ffmpeg-static/tar.gz/refs/tags/5.3.0',
    sha256: 'bfe1b72218d0b4c6c843f672ba400ec71c59a1099b03a39419c318576360a2c4',
    about: 'ffmpeg-static 5.3.0 build scripts and patches'
  }
];

async function download(url) {
  try {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch {
    // Node's fetch does not honour a corporate proxy CA in every environment; curl does, and is present on the
    // Ubuntu release runners that use this script. Keep it as a fallback instead of failing a release on TLS setup.
    const { execFileSync } = await import('node:child_process');
    return execFileSync('curl', ['-fsSL', '--max-time', '180', url], { maxBuffer: 256 * 1024 * 1024 });
  }
}

const destination = path.resolve(process.argv[2] || path.join('release', 'source'));
await fs.mkdir(destination, { recursive: true });
const lines = [];
for (const source of SOURCES) {
  const data = await download(source.url);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== source.sha256) throw new Error(`Checksum mismatch for ${source.name}: expected ${source.sha256}, got ${actual}.`);
  await fs.writeFile(path.join(destination, source.name), data);
  lines.push(`${actual}  ${source.name}  # ${source.about}`);
  console.log(`Verified ${source.name} (${data.length} bytes).`);
}
await fs.writeFile(path.join(destination, 'FFMPEG-SOURCE-SHA256.txt'), `${lines.join('\n')}\n`);
console.log(`GPL source mirror ready in ${destination}. Attach these files to the release.`);
