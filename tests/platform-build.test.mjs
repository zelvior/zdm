import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundledYtdlpPath, ytdlpFileName } from '../core/tools.mjs';
import { ytdlpTarget, targetNames } from '../scripts/ytdlp-assets.mjs';
const require = createRequire(import.meta.url);
const pkg = require('../package.json'), legacy = require('../legacy/package.json'), unix = require('../electron-builder.unix.cjs');

test('the bundled yt-dlp is an .exe only on Windows', () => {
  assert.equal(ytdlpFileName('win32'), 'yt-dlp.exe');
  assert.equal(ytdlpFileName('linux'), 'yt-dlp');
  assert.equal(ytdlpFileName('darwin'), 'yt-dlp');
  assert.equal(bundledYtdlpPath({ platform: 'linux', packaged: true, resourcesPath: '/opt/zdm/resources' }), '/opt/zdm/resources/tools/yt-dlp');
  assert.match(bundledYtdlpPath({ platform: 'win32', packaged: false }), /vendor[\\/]yt-dlp\.exe$/);
});

test('every build target maps to one official yt-dlp release file and a bundled name', () => {
  assert.equal(ytdlpTarget('x64').asset, 'yt-dlp.exe'); // existing Windows workflows keep working
  assert.equal(ytdlpTarget('ia32').asset, 'yt-dlp_x86.exe');
  assert.deepEqual(ytdlpTarget('mac'), { asset: 'yt-dlp_macos', output: 'yt-dlp' });
  assert.equal(ytdlpTarget('mac-legacy').asset, 'yt-dlp_macos_legacy');
  assert.equal(ytdlpTarget('linux-x64').asset, 'yt-dlp_linux');
  assert.equal(ytdlpTarget('linux-arm64').asset, 'yt-dlp_linux_aarch64');
  assert.equal(ytdlpTarget('linux-ia32').needsPython, true, 'there is no standalone 32-bit Linux binary');
  for (const name of targetNames()) assert.match(ytdlpTarget(name).output, /^yt-dlp(\.exe)?$/);
  assert.throws(() => ytdlpTarget('freebsd'), /Unknown yt-dlp target/);
});

test('the Windows build configuration is untouched by the macOS/Linux work', () => {
  assert.equal(pkg.build.electronDist, 'node_modules/electron/dist');
  assert.equal(pkg.build.win.target[0].target, 'nsis');
  assert.equal(pkg.scripts.dist, 'electron-builder --win nsis --x64 --publish never');
});

test('macOS and Linux build from their own config without any Windows-only parts', () => {
  for (const key of ['electronDist', 'win', 'nsis', 'portable']) assert.equal(unix[key], undefined, key);
  assert.ok(pkg.build[('electronDist')], 'the shared config object was copied, not modified');
  const text = JSON.stringify(unix.extraResources);
  assert.ok(!/\.exe|\.ps1|\.cs\b/.test(text), 'no Windows binaries in the unix resources');
  assert.ok(text.includes('"filter":["yt-dlp","*.txt"]'));
  assert.deepEqual(unix.mac.target.map(t => t.target), ['dmg', 'zip']);
  assert.deepEqual(unix.linux.target.map(t => t.target), ['AppImage', 'deb', 'rpm']);
  assert.equal(unix.mac.identity, null);
  assert.ok(unix.asarUnpack.includes('node_modules/ffmpeg-static/ffmpeg'), 'ffmpeg must be runnable outside the asar');
  assert.ok(unix.files.includes('LICENSE') && unix.files.includes('NOTICE'));
  assert.equal(pkg.scripts['dist:mac'].includes('electron-builder.unix.cjs'), true);
  assert.equal(pkg.scripts['dist:linux'].includes('electron-builder.unix.cjs'), true);
});

test('the legacy track can target older macOS and 32-bit Linux without changing the Windows scripts', () => {
  assert.match(legacy.scripts['dist:ia32'], /--win nsis --ia32/);
  assert.match(legacy.scripts['dist:mac'], /--mac dmg zip --x64/);
  assert.match(legacy.scripts['dist:linux:x64'], /--linux AppImage deb --x64/);
  // Electron 18+ does not run on 32-bit Linux; the last major that does (17.x) is pinned for exactly that target.
  assert.match(legacy.scripts['dist:linux:ia32'], /--ia32[^&]*electronVersion=17\./);
  assert.equal(legacy.devDependencies.electron, '22.3.27');
  assert.equal(legacy.build.mac.identity, null);
  assert.equal(legacy.build.linux.executableName, 'zdm-legacy');
});
