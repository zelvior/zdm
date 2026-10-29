'use strict';
// Everything that differs between Windows, macOS and Linux for browser integration lives here, so the rest of the
// app (and the tests) can ask "where / how" without branching on process.platform themselves.
const os = require('node:os');
const path = require('node:path');

const HOST = 'com.zelvior.zdm.host';
const BROWSERS = ['Chrome', 'Edge', 'Firefox'];
const isWindows = platform => platform === 'win32';

// profileRoot: where the browser keeps its profiles (used to detect it and to find its extensions).
// nativeMessagingDir: macOS/Linux only. The browser reads native messaging manifests from this folder; Windows uses the registry instead.
// registryRoot: Windows only.
function browserLocations({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA, roaming = env.APPDATA;
    const at = (base, ...parts) => (base ? path.join(base, ...parts) : null);
    return {
      Chrome: { profileRoot: at(local, 'Google', 'Chrome', 'User Data'), registryRoot: 'Google\\Chrome' },
      Edge: { profileRoot: at(local, 'Microsoft', 'Edge', 'User Data'), registryRoot: 'Microsoft\\Edge' },
      Firefox: { profileRoot: at(roaming, 'Mozilla', 'Firefox'), registryRoot: 'Mozilla' }
    };
  }
  if (platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    return {
      Chrome: { profileRoot: path.join(support, 'Google', 'Chrome'), nativeMessagingDir: path.join(support, 'Google', 'Chrome', 'NativeMessagingHosts') },
      Edge: { profileRoot: path.join(support, 'Microsoft Edge'), nativeMessagingDir: path.join(support, 'Microsoft Edge', 'NativeMessagingHosts') },
      Firefox: { profileRoot: path.join(support, 'Firefox'), nativeMessagingDir: path.join(support, 'Mozilla', 'NativeMessagingHosts') }
    };
  }
  // Linux and other Unix-likes follow the XDG layout.
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return {
    Chrome: { profileRoot: path.join(config, 'google-chrome'), nativeMessagingDir: path.join(config, 'google-chrome', 'NativeMessagingHosts') },
    Edge: { profileRoot: path.join(config, 'microsoft-edge'), nativeMessagingDir: path.join(config, 'microsoft-edge', 'NativeMessagingHosts') },
    Firefox: { profileRoot: path.join(home, '.mozilla', 'firefox'), nativeMessagingDir: path.join(home, '.mozilla', 'native-messaging-hosts') }
  };
}

// The program the browser starts. Windows prefers the compiled launcher and falls back to the .cmd file.
const hostCandidates = platform => (isWindows(platform) ? ['native-host.exe', 'native-host.cmd'] : ['native-host.sh']);
const launcherName = platform => (isWindows(platform) ? 'native-host.cmd' : 'native-host.sh');

const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
function launcherScript({ platform = process.platform, executable }) {
  if (isWindows(platform)) return `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${String(executable).replaceAll('%', '%%')}" "%~dp0native-host.cjs"\r\n`;
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(executable)} "$(dirname "$0")/native-host.cjs"\n`;
}

// An AppImage unpacks itself into a temporary mount that disappears when the app exits, so the browser must start
// the .AppImage file itself (APPIMAGE), never the executable inside the mount.
function runtimeExecutable({ platform = process.platform, env = process.env, exe }) {
  return platform === 'linux' && env.APPIMAGE && path.isAbsolute(env.APPIMAGE) ? env.APPIMAGE : exe;
}

// Commands that open a browser's extensions page; the first one that starts wins.
function browserLaunchers({ platform = process.platform, env = process.env } = {}) {
  const pages = { Chrome: 'chrome://extensions/', Edge: 'edge://extensions/' };
  if (platform === 'darwin') return { pages, candidates: { Chrome: [{ command: 'open', args: ['-a', 'Google Chrome', '--args'] }], Edge: [{ command: 'open', args: ['-a', 'Microsoft Edge', '--args'] }] } };
  if (platform === 'linux') return { pages, candidates: {
    Chrome: ['google-chrome-stable', 'google-chrome'].map(command => ({ command, args: [] })),
    Edge: ['microsoft-edge-stable', 'microsoft-edge'].map(command => ({ command, args: [] }))
  } };
  const relative = { Chrome: path.join('Google', 'Chrome', 'Application', 'chrome.exe'), Edge: path.join('Microsoft', 'Edge', 'Application', 'msedge.exe') };
  const roots = [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean);
  return { pages, candidates: Object.fromEntries(Object.entries(relative).map(([browser, file]) => [browser, roots.map(root => ({ command: path.join(root, file), args: [], file: true }))])) };
}

module.exports = { HOST, BROWSERS, isWindows, browserLocations, hostCandidates, launcherName, launcherScript, shellQuote, runtimeExecutable, browserLaunchers };
