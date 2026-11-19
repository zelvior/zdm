// Dependency setup that survives restricted networks.
//
// `npm ci` runs two upstream postinstall downloaders (Electron and ffmpeg-static) that fail when GitHub release
// assets are blocked or a proxy CA is not trusted. This script installs packages without lifecycle scripts and then
// attempts each binary download separately, so a failure is reported precisely instead of aborting the whole install.
//
//   node scripts/install-deps.mjs                       # npm ci + Electron + ffmpeg
//   node scripts/install-deps.mjs --binaries-only       # only retry the binary downloads
//   node scripts/install-deps.mjs --arch=ia32 --skip-electron
//   npm run setup                                      # same as the first form
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const value = name => [...args].find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const arch = value('arch') || process.env.npm_config_arch || process.arch;
const platform = value('platform') || process.env.npm_config_platform || process.platform;
const binariesOnly = args.has('--binaries-only');

function run(label, command, commandArgs, env = {}) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env }
  });
  if (result.error || result.status !== 0) {
    console.warn(`! ${label} failed: ${result.error?.message || `exit code ${result.status}`}`);
    return false;
  }
  return true;
}

function executable(file) {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

if (!binariesOnly) {
  if (!run('Installing npm packages', 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])) {
    console.error('\nPackage installation failed. Check your registry connection and try again.');
    process.exit(1);
  }
}

const env = { npm_config_arch: arch, npm_config_platform: platform };
if (!args.has('--skip-ffmpeg')) {
  const installer = path.join(root, 'node_modules', 'ffmpeg-static', 'install.js');
  if (existsSync(installer)) {
    const ok = run(`Downloading ffmpeg for ${platform}-${arch}`, process.execPath, [installer], env);
    const binary = path.join(root, 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (!ok || !executable(binary)) {
      console.warn('! ffmpeg is unavailable. Video extraction/muxing will not work; direct downloads still do.');
      console.warn('  Set FFMPEG_STATIC_BINARIES_URL to a reachable mirror and re-run with --binaries-only.');
    }
  }
}

if (!args.has('--skip-electron')) {
  const installer = path.join(root, 'node_modules', 'electron', 'install.js');
  if (existsSync(installer) && !run(`Downloading Electron for ${platform}-${arch}`, process.execPath, [installer], env)) {
    console.warn('! Electron was not downloaded. `npm start` needs it; electron-builder downloads its own copy when packaging.');
    console.warn('  Set ELECTRON_MIRROR to a reachable mirror and re-run with --binaries-only.');
  }
}

console.log('\nSetup finished. Run `npm test` and `npm start`.');
console.log('ffmpeg-dependent tests are skipped automatically when the binary is missing.');
