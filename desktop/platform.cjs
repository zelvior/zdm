'use strict';
// Everything that differs between Windows, macOS and Linux for browser integration lives here, so the rest of the
// app (and the tests) can ask "where / how" without branching on process.platform themselves.
const os = require('node:os');
const path = require('node:path');

const HOST = 'com.zelvior.zdm.host';
// Every supported browser lives in integration/browsers.json (shared with the connection check).
const CATALOG = require('../integration/browsers.json').browsers;
const BROWSERS = CATALOG.map(browser => browser.name);
const isWindows = platform => platform === 'win32';

// Turns a path token from browsers.json into a real path. Returns null when a Windows variable is not set.
function resolvePath(token, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (!token) return null;
  const [head, ...rest] = token.split('/');
  if (head === '%LOCALAPPDATA%' || head === '%APPDATA%') { const base = env[head.slice(1, -1)]; return base ? path.join(base, ...rest) : null; }
  if (head === '~support') return path.join(home, 'Library', 'Application Support', ...rest);
  if (head === '~config') return path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), ...rest);
  if (head === '~') return path.join(home, ...rest);
  return path.join(token);
}

// One entry per browser available on this platform.
//   profileRoot:        the browser's data folder (to detect it and to find its extensions)
//   nativeMessagingDir: macOS/Linux, where the browser reads native messaging manifests (Chromium: <data folder>/NativeMessagingHosts)
//   registryRoot:       Windows, the vendor key under HKCU\Software that the browser reads; registryFrom: the browser whose key it follows
function browserCatalog({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const key = isWindows(platform) ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  return CATALOG.filter(browser => browser[key]).map(browser => {
    const where = browser[key], profileRoot = resolvePath(where.profile, { platform, env, home });
    return {
      name: browser.name, family: browser.family, verified: browser.verified !== false, profileRoot,
      nativeMessagingDir: isWindows(platform) ? null : (where.nativeMessaging ? resolvePath(where.nativeMessaging, { platform, env, home }) : path.join(profileRoot, 'NativeMessagingHosts')),
      registryRoot: isWindows(platform) ? where.registry || null : null,
      registryFrom: isWindows(platform) ? where.registryFrom || null : null,
      alwaysRegister: (browser.alwaysRegister || []).includes(key)
    };
  });
}

// The same data keyed by browser name (the shape the rest of the app uses).
function browserLocations(options = {}) {
  return Object.fromEntries(browserCatalog(options).map(browser => [browser.name, browser]));
}

// The browser whose registration serves `name`: itself, or (Windows) the browser whose registry key it follows.
function registrationTarget(name, options = {}) {
  const entry = browserLocations(options)[name];
  if (!entry) return null;
  return isWindows(options.platform || process.platform) ? (entry.registryRoot ? name : entry.registryFrom) : name;
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
const EXTENSIONS_SCHEME = { Edge: 'edge', Brave: 'brave', Vivaldi: 'vivaldi', Opera: 'opera' };
const MAC_APP = { Chrome: 'Google Chrome', Edge: 'Microsoft Edge', Chromium: 'Chromium', Brave: 'Brave Browser', Vivaldi: 'Vivaldi', Opera: 'Opera', Arc: 'Arc', Thorium: 'Thorium', 'Yandex Browser': 'Yandex' };
const LINUX_COMMANDS = { Chrome: ['google-chrome-stable', 'google-chrome'], Edge: ['microsoft-edge-stable', 'microsoft-edge'], Chromium: ['chromium', 'chromium-browser'], Brave: ['brave-browser', 'brave'], Vivaldi: ['vivaldi-stable', 'vivaldi'], Opera: ['opera'], Thorium: ['thorium-browser'], 'Yandex Browser': ['yandex-browser'] };
const WINDOWS_EXE = { Chrome: 'Google/Chrome/Application/chrome.exe', Edge: 'Microsoft/Edge/Application/msedge.exe', Chromium: 'Chromium/Application/chrome.exe', Brave: 'BraveSoftware/Brave-Browser/Application/brave.exe', Vivaldi: 'Vivaldi/Application/vivaldi.exe', Opera: 'Programs/Opera/opera.exe', Supermium: 'Supermium/Application/chrome.exe', Thorium: 'Thorium/Application/thorium.exe', 'Yandex Browser': 'Yandex/YandexBrowser/Application/browser.exe' };
function browserLaunchers({ platform = process.platform, env = process.env } = {}) {
  const chromium = CATALOG.filter(browser => browser.family === 'chromium').map(browser => browser.name);
  const pages = Object.fromEntries(chromium.map(name => [name, `${EXTENSIONS_SCHEME[name] || 'chrome'}://extensions/`]));
  const candidates = {};
  for (const name of chromium) {
    if (platform === 'darwin') candidates[name] = MAC_APP[name] ? [{ command: 'open', args: ['-a', MAC_APP[name], '--args'] }] : [];
    else if (platform === 'linux') candidates[name] = (LINUX_COMMANDS[name] || []).map(command => ({ command, args: [] }));
    else candidates[name] = WINDOWS_EXE[name] ? [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map(root => ({ command: path.join(root, ...WINDOWS_EXE[name].split('/')), args: [], file: true })) : [];
  }
  return { pages, candidates };
}

module.exports = { HOST, BROWSERS, CATALOG, isWindows, resolvePath, browserCatalog, registrationTarget, browserLocations, hostCandidates, launcherName, launcherScript, shellQuote, runtimeExecutable, browserLaunchers };
