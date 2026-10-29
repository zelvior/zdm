import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative));
function png(relative) {
  const data = read(relative);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${relative} is a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colorType: data[25], data };
}
const bmp = relative => { const d = read(relative); assert.equal(d.subarray(0, 2).toString(), 'BM', `${relative} is a BMP`); return { width: d.readInt32LE(18), height: Math.abs(d.readInt32LE(22)), bits: d.readUInt16LE(28) }; };
function ico(relative) {
  const d = read(relative);
  assert.deepEqual([d.readUInt16LE(0), d.readUInt16LE(2)], [0, 1], `${relative} is an ICO`);
  return Array.from({ length: d.readUInt16LE(4) }, (_, i) => { const e = 6 + 16 * i; return { size: d[e] || 256, bytes: d.readUInt32LE(e + 8), offset: d.readUInt32LE(e + 12), data: d }; });
}

test('application icons have the sizes every platform expects', () => {
  assert.deepEqual([png('assets/app-icon.png').width, png('assets/app-icon.png').height], [512, 512]); // electron-builder builds .icns and Linux sizes from this: needs 512+
  assert.equal(png('assets/icon-mark.png').width, 128);
  assert.equal(png('assets/tray-icon.png').width, 32);
  assert.equal(png('assets/tray-icon@2x.png').width, 64);
  for (const size of [16, 32, 48, 128]) { const p = png(`extension/icons/icon${size}.png`); assert.deepEqual([p.width, p.height], [size, size]); }
});

test('Windows icons carry every size as PNG frames, identical for app, installer and uninstaller', () => {
  for (const file of ['build/icon.ico', 'build/installerIcon.ico', 'build/uninstallerIcon.ico']) {
    const frames = ico(file);
    assert.deepEqual(frames.map(f => f.size), [16, 24, 32, 48, 64, 128, 256], file);
    for (const f of frames) assert.equal(f.data.subarray(f.offset, f.offset + 8).toString('hex'), '89504e470d0a1a0a', `${file} ${f.size}px frame is PNG`);
  }
  assert.ok(read('build/icon.ico').equals(read('build/installerIcon.ico')));
});

test('installer artwork has the exact NSIS sizes', () => {
  assert.deepEqual(bmp('build/installerSidebar.bmp'), { width: 164, height: 314, bits: 24 });
  assert.deepEqual(bmp('build/uninstallerSidebar.bmp'), { width: 164, height: 314, bits: 24 });
  assert.deepEqual(bmp('build/installerHeader.bmp'), { width: 150, height: 57, bits: 24 });
});

test('the macOS menu bar icon is a template image: black artwork on transparency, with a retina twin', () => {
  const one = png('assets/tray-iconTemplate.png'), two = png('assets/tray-iconTemplate@2x.png');
  assert.deepEqual([one.width, two.width], [18, 36]);
  for (const p of [one, two]) assert.equal(p.colorType, 6, 'RGBA, so the transparency is real');
  // decode the larger one: every visible pixel must be black and some pixels must be fully transparent
  const idat = []; let o = 8;
  while (o < two.data.length) { const len = two.data.readUInt32BE(o), type = two.data.toString('ascii', o + 4, o + 8); if (type === 'IDAT') idat.push(two.data.subarray(o + 8, o + 8 + len)); o += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = 1 + two.width * 4;
  let visible = 0, transparent = 0, bright = 0;
  const rows = []; // undo PNG row filters just enough for the two filters Pillow uses here (none/sub/up/avg/paeth)
  for (let y = 0; y < two.height; y++) {
    const filter = raw[y * stride], line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride)), prev = rows[y - 1] || Buffer.alloc(line.length);
    for (let x = 0; x < line.length; x++) {
      const a = x >= 4 ? line[x - 4] : 0, b = prev[x], c = x >= 4 ? prev[x - 4] : 0;
      const pr = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (() => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; })() : 0;
      line[x] = (line[x] + pr) & 255;
    }
    rows.push(line);
    for (let x = 0; x < two.width; x++) { const [r, g, bl, al] = line.subarray(x * 4, x * 4 + 4); if (al === 0) transparent++; else { visible++; if (al > 200 && (r || g || bl)) bright++; } }
  }
  assert.ok(visible > 20 && transparent > 100, `visible ${visible}, transparent ${transparent}`);
  assert.equal(bright, 0, 'opaque pixels are pure black');
});

test('every icon the app and the browser extension refer to exists', () => {
  const about = fs.readFileSync(path.join(root, 'renderer/about.html'), 'utf8');
  for (const [, src] of about.matchAll(/<img[^>]*src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, 'renderer', src)), `about.html uses ${src}`);
  for (const manifest of ['manifest.json', 'manifest.firefox.json', 'manifest.legacy.json']) {
    const json = JSON.parse(fs.readFileSync(path.join(root, 'extension', manifest), 'utf8'));
    for (const file of [...Object.values(json.icons || {}), ...Object.values(json.action?.default_icon || {}), ...Object.values(json.browser_action?.default_icon || {})]) assert.ok(fs.existsSync(path.join(root, 'extension', file)), `${manifest} uses ${file}`);
  }
  const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8');
  for (const name of ['app-icon.png', 'tray-icon.png', 'tray-iconTemplate.png']) assert.ok(main.includes(name) && fs.existsSync(path.join(root, 'assets', name)), name);
  assert.ok(!fs.existsSync(path.join(root, 'assets/app-icon.svg')), 'the old logo is gone');
});

test('the source logos are kept for the README and the generator, outside the packaged app', () => {
  assert.ok(fs.statSync(path.join(root, 'docs/branding/zdm-logo.jpg')).size > 10000);
  assert.ok(fs.statSync(path.join(root, 'docs/branding/zdm-wordmark.png')).size > 10000);
  const files = JSON.parse(read('package.json')).build.files;
  assert.ok(!files.some(f => f.startsWith('docs')), 'docs/ is not shipped inside the app');
});
