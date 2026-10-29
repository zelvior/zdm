'use strict';
// electron-builder configuration for the macOS and Linux builds. It starts from the "build" section of package.json
// (shared files, licenses, extension) and replaces everything that is Windows-specific.
// Usage:  electron-builder --config electron-builder.unix.cjs --mac --x64|--arm64 --publish never
//         electron-builder --config electron-builder.unix.cjs --linux --x64|--arm64 --publish never
const pkg = require('./package.json');

const config = structuredClone(pkg.build);
// These belong to the Windows build. electronDist in particular would reuse the Electron of the machine running the build,
// which is the wrong architecture whenever macOS/Linux builds target another CPU.
for (const key of ['electronDist', 'win', 'nsis', 'portable']) delete config[key];

config.extraResources = [
  // ffmpeg-static names its notices after the binary: ffmpeg.LICENSE here, ffmpeg.exe.LICENSE on Windows.
  { from: 'node_modules/ffmpeg-static/ffmpeg.LICENSE', to: 'licenses/FFmpeg-LICENSE.txt' },
  { from: 'node_modules/ffmpeg-static/ffmpeg.README', to: 'licenses/FFmpeg-BUILD.txt' },
  { from: 'node_modules/ffmpeg-static/LICENSE', to: 'licenses/ffmpeg-static-LICENSE.txt' },
  { from: 'node_modules/googlevideo/LICENSE', to: 'licenses/googlevideo-LICENSE.txt' },
  { from: 'vendor', to: 'tools', filter: ['yt-dlp', '*.txt'] },
  { from: 'extension', to: 'browser/extension', filter: ['**/*', '!*.test.cjs'] },
  // The browser launcher (native-host.sh) is generated at runtime; only the connector script is shipped.
  { from: 'integration', to: 'browser/integration', filter: ['native-host.cjs', 'README.md'] }
];
config.asarUnpack = ['core/**/*', 'node_modules/ffmpeg-static/ffmpeg'];
config.files = [...config.files, '!integration/*.cs'];

config.afterPack = 'build/after-pack.cjs';

config.mac = {
  target: [{ target: 'dmg' }, { target: 'zip' }],
  category: 'public.app-category.utilities',
  icon: 'assets/app-icon.png',
  artifactName: 'ZDM-mac-${arch}.${ext}',
  // Not notarized: build/after-pack.cjs ad-hoc signs the app, which Apple Silicon requires to run it at all.
  identity: null,
  hardenedRuntime: false,
  gatekeeperAssess: false
};
config.dmg = { sign: false };

config.linux = {
  target: [{ target: 'AppImage' }, { target: 'deb' }, { target: 'rpm' }],
  category: 'Network',
  icon: 'assets/app-icon.png',
  executableName: 'zdm',
  artifactName: 'ZDM-linux-${arch}.${ext}',
  synopsis: 'Download manager with segmented transfers and browser video capture',
  description: 'ZDM is a download manager with segmented, resumable transfers, HTTP/2 multiplexing, on-the-fly integrity checks, browser takeover and video capture.',
  maintainer: 'ZDM contributors <Zelvior@proton.me>'
};

module.exports = config;
