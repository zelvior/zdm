#!/usr/bin/env node
'use strict';
// ZDM connection check: finds out why the browser extension and the app are not talking to each other.
//
//   development checkout:   node integration/doctor.cjs
//   installed app:          see docs/INSTALL.md ("The extension does not connect"), the app's own runtime runs this file
//
// It follows the same chain a browser follows and reports the first link that is broken:
//   extension ID  ->  browser connection entry  ->  launcher  ->  connector  ->  app (bridge)
// Only Node.js built-in modules are used, so it runs with the runtime bundled in the app.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const HOST = 'com.zelvior.zdm.host';
const FIREFOX_ID = 'zdm@zelvior.local';
const isWindows = platform => platform === 'win32';

// Every supported browser comes from browsers.json, the same file the app reads (desktop/platform.cjs).
const CATALOG = require('./browsers.json').browsers;
function resolvePath(token, { env, home }) {
  const [head, ...rest] = token.split('/');
  if (head === '%LOCALAPPDATA%' || head === '%APPDATA%') { const base = env[head.slice(1, -1)]; return base ? path.join(base, ...rest) : null; }
  if (head === '~support') return path.join(home, 'Library', 'Application Support', ...rest);
  if (head === '~config') return path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), ...rest);
  if (head === '~') return path.join(home, ...rest);
  return path.join(token);
}
// name -> { profile, dir (macOS/Linux manifest folder), registry (Windows key), registryFrom, family, verified }
function managedBrowsers({ platform, env, home }) {
  const key = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux', out = {};
  for (const browser of CATALOG.filter(b => b[key])) {
    const where = browser[key], profile = resolvePath(where.profile, { env, home });
    out[browser.name] = { profile, family: browser.family, verified: browser.verified !== false, registry: platform === 'win32' ? where.registry || null : undefined, registryFrom: platform === 'win32' ? where.registryFrom || null : undefined,
      dir: platform === 'win32' ? undefined : where.nativeMessaging ? resolvePath(where.nativeMessaging, { env, home }) : path.join(profile, 'NativeMessagingHosts') };
  }
  return out;
}

// Browsers installed as a Snap or Flatpak run in a sandbox that cannot start a program from the home folder.
function sandboxedBrowsers({ platform, home }) {
  if (platform !== 'linux') return [];
  const candidates = [['Firefox (Snap)', path.join(home, 'snap', 'firefox')], ['Chromium (Snap)', path.join(home, 'snap', 'chromium')],
    ['Firefox (Flatpak)', path.join(home, '.var', 'app', 'org.mozilla.firefox')], ['Chromium (Flatpak)', path.join(home, '.var', 'app', 'org.chromium.Chromium')],
    ['Chrome (Flatpak)', path.join(home, '.var', 'app', 'com.google.Chrome')], ['Brave (Flatpak)', path.join(home, '.var', 'app', 'com.brave.Browser')]];
  return candidates.filter(([, folder]) => fs.existsSync(folder)).map(([name]) => name);
}

// Chrome derives an extension's ID from its public key: the first 128 bits of SHA-256, written with the letters a-p.
function extensionIdFromKey(key) {
  return [...crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)].map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const frame = message => { const body = Buffer.from(JSON.stringify(message)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };

function postStatus(port, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({});
    const request = http.request({ host: '127.0.0.1', port, path: '/status', method: 'POST', timeout: 4000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${token}` } }, response => {
      let data = ''; response.on('data', c => { data += c; }); response.on('end', () => resolve({ status: response.statusCode, body: data }));
    });
    request.on('timeout', () => request.destroy(new Error('timed out'))); request.on('error', reject); request.end(body);
  });
}

function askLauncher(launcher, platform, home, origin) {
  return new Promise(resolve => {
    const command = isWindows(platform) && /\.cmd$/i.test(launcher) ? ['cmd.exe', ['/c', launcher, origin]] : [launcher, [origin]];
    let child;
    try { child = spawn(command[0], command[1], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { return resolve({ error: error.message }); }
    let out = Buffer.alloc(0), err = '', done = false;
    const finish = result => { if (!done) { done = true; clearTimeout(timer); try { child.kill(); } catch { /* already gone */ } resolve({ ...result, stderr: err.trim() }); } };
    const timer = setTimeout(() => finish({ error: 'no reply within 10 seconds' }), 10000);
    child.stderr.on('data', c => { err += c; });
    child.stdout.on('data', chunk => { out = Buffer.concat([out, chunk]); if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) { try { finish({ reply: JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()) }); } catch (error) { finish({ error: `unreadable reply: ${error.message}` }); } } });
    child.on('error', error => finish({ error: error.message }));
    child.on('close', (code, signal) => finish({ error: signal ? `the connector was stopped by ${signal}` : `the connector exited (code ${code}) without replying` }));
    child.stdin.on('error', () => {});
    child.stdin.write(frame({ action: 'status' }));
  });
}

const defaultRegistryQuery = key => new Promise(resolve => {
  execFile('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true }, (error, stdout) => resolve(error ? null : (String(stdout).match(/REG_SZ\s+(.+?)\r?\n/)?.[1] || '').trim() || null));
});

/** Runs every check and returns [{ status: 'ok'|'fail'|'warn'|'info', title, detail?, fix? }]. */
async function runChecks({ platform = process.platform, env = process.env, home = os.homedir(), integrationDir = __dirname, queryRegistry = defaultRegistryQuery } = {}) {
  const results = [];
  const add = (status, title, detail, fix) => results.push({ status, title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });
  add('info', `System: ${platform}, home folder ${home}`);

  // 1. the extension and its ID
  let extensionId = null;
  const manifestFile = path.join(integrationDir, '..', 'extension', 'manifest.json');
  try {
    const manifest = readJson(manifestFile);
    if (!manifest.key) throw new Error('the manifest has no "key", so the browser would invent a different ID');
    extensionId = extensionIdFromKey(manifest.key);
    add('ok', `Extension files found: ${path.dirname(manifestFile)}`, `Its ID must be ${extensionId}. On your browser's extensions page the ZDM extension must show exactly this ID.`);
  } catch (error) {
    add('fail', 'Extension files are missing or unreadable', `${manifestFile}: ${error.message}`, 'Start ZDM once (it copies the extension to this folder) or reinstall it.');
  }

  // 2. launcher and connector
  const launcherNames = isWindows(platform) ? ['native-host.exe', 'native-host.cmd'] : ['native-host.sh'];
  const launcher = launcherNames.map(name => path.join(integrationDir, name)).find(file => fs.existsSync(file)) || null;
  if (!launcher) add('fail', `Launcher not found (looked for ${launcherNames.join(' or ')} in ${integrationDir})`, 'The browser has nothing to start.', 'Start ZDM once; it creates the launcher at startup.');
  else {
    add('ok', `Launcher found: ${launcher}`);
    if (!isWindows(platform)) { try { fs.accessSync(launcher, fs.constants.X_OK); } catch { add('fail', 'The launcher is not executable', launcher, `Run: chmod +x "${launcher}"`); } }
    const text = launcher.endsWith('.exe') ? '' : fs.readFileSync(launcher, 'utf8');
    const target = (text.match(/^(?:ELECTRON_RUN_AS_NODE=1 exec )?'([^']+)'/m) || text.match(/^"([^"]+)" "%~dp0/m) || [])[1];
    if (target && !fs.existsSync(target.replaceAll('%%', '%'))) add('fail', `The launcher points at a program that does not exist: ${target}`, 'ZDM was moved, updated or reinstalled after the launcher was written.', 'Start ZDM once so it rewrites the launcher.');
  }
  if (!fs.existsSync(path.join(integrationDir, 'native-host.cjs'))) add('fail', 'native-host.cjs is missing next to the launcher', undefined, 'Start ZDM once so it copies the connector, or reinstall.');
  try {
    const launch = readJson(path.join(integrationDir, 'desktop-launch.json'));
    if (path.isAbsolute(launch.executable) && fs.existsSync(launch.executable)) add('ok', `The connector can start ZDM when it is closed (${launch.executable})`);
    else add('warn', `desktop-launch.json points at a missing program: ${launch.executable}`, 'Downloads sent while ZDM is closed will not start it.', 'Start ZDM once.');
  } catch { add('warn', 'desktop-launch.json is missing or unreadable', 'Downloads sent while ZDM is closed will not start it.', 'Start ZDM once.'); }

  // 3. is the app running?
  let appRunning = false;
  try {
    const bridge = readJson(path.join(home, '.zdm', 'bridge.json'));
    try {
      const response = await postStatus(bridge.port, bridge.token);
      if (response.status >= 200 && response.status < 300) { appRunning = true; add('ok', `ZDM is running and its bridge answers on port ${bridge.port}`); }
      else add('fail', `The bridge answered with HTTP ${response.status}`, response.body.slice(0, 200), 'Close and start ZDM again.');
    } catch (error) { add('warn', `ZDM is not running (nothing answers on port ${bridge.port}: ${error.code || error.message})`, 'A leftover bridge.json from a previous run.', 'Start ZDM.'); }
  } catch { add('warn', `ZDM is not running (no ${path.join(home, '.zdm', 'bridge.json')})`, undefined, 'Start ZDM.'); }

  // 4. the whole chain, driven exactly as a browser drives it
  if (launcher) {
    const origin = extensionId ? `chrome-extension://${extensionId}/` : 'chrome-extension://unknown/';
    const run = await askLauncher(launcher, platform, home, origin);
    if (run.reply?.ok) add('ok', 'Browser to app works: the launcher started the connector and the app answered');
    else if (run.reply) add(appRunning ? 'fail' : 'warn', `The connector started and answered: "${run.reply.error || JSON.stringify(run.reply)}"`, appRunning ? 'The app is running but refused the request.' : undefined, appRunning ? 'Close and start ZDM again.' : 'Start ZDM and run this check again.');
    else add('fail', `The launcher could not run the connector: ${run.error}`, run.stderr ? `Its error output: ${run.stderr}` : undefined, 'Start ZDM once so it rewrites the launcher, then run this check again.');
  }

  // 5. what each installed browser will use. On Windows a browser may follow another browser's registry key (Supermium: Chromium).
  const browsers = managedBrowsers({ platform, env, home });
  for (const [name, where] of Object.entries(browsers)) {
    const installed = Boolean(where.profile) && fs.existsSync(where.profile);
    if (!installed) continue; // browsers that are not installed are not worth a line
    const owner = isWindows(platform) && !where.registry ? browsers[where.registryFrom] : where, family = where.family;
    const label = owner === where ? name : `${name} (uses the ${where.registryFrom} entry)`;
    let registered = null;
    if (isWindows(platform)) registered = await queryRegistry(`HKCU\\Software\\${owner.registry}\\NativeMessagingHosts\\${HOST}`);
    else { const file = path.join(where.dir, `${HOST}.json`); registered = fs.existsSync(file) ? file : null; }
    if (!registered) { add('fail', `${label}: is installed but is not connected to ZDM`, `No connection entry for ${HOST}.`, 'Start ZDM (it registers installed browsers when it starts), then reload the extension. If it stays this way, add the browser under Browser connection > My browser is not listed.'); continue; }
    try {
      const manifest = readJson(registered);
      const problems = [];
      if (launcher && manifest.path !== launcher) problems.push(`it starts ${manifest.path}, not ${launcher}`);
      if (!manifest.path || !fs.existsSync(manifest.path)) problems.push(`the program it starts does not exist (${manifest.path})`);
      const allowed = family === 'firefox' ? manifest.allowed_extensions || [] : manifest.allowed_origins || [];
      const want = family === 'firefox' ? FIREFOX_ID : `chrome-extension://${extensionId}/`;
      if (extensionId && !allowed.includes(want)) problems.push(`it does not allow this extension (${want}); it allows: ${allowed.join(', ') || 'nothing'}`);
      if (problems.length) add('fail', `${label}: the connection entry is wrong: ${problems.join('; ')}`, registered, 'Start ZDM (it repairs this every 15 seconds), or open Browser connection in ZDM.');
      else add('ok', `${label}: connected (${registered})`);
      if (!where.verified) add('warn', `${name}: the entry exists, but this browser's lookup location is expected, not confirmed`, 'If the extension still says "not connected" in this browser, the browser reads another location.', 'Add the exact location under Browser connection > My browser is not listed.');
    } catch (error) { add('fail', `${label}: the connection entry cannot be read (${registered}): ${error.message}`, undefined, 'Start ZDM so it rewrites it.'); }
  }
  if (!Object.values(browsers).some(b => b.profile && fs.existsSync(b.profile))) add('warn', 'No supported browser was found on this system', 'ZDM looks for the data folders of Chrome, Edge, Chromium, Brave, Vivaldi, Opera, Supermium, Thorium, Yandex Browser, Arc, Firefox and Waterfox.', 'If your browser is not in that list, add it under Browser connection > My browser is not listed.');
  for (const name of sandboxedBrowsers({ platform, home })) add('warn', `${name} runs in a sandbox`, 'A sandboxed browser cannot start the connector from your home folder, so it can never connect.', 'Install the browser as a normal package (.deb or .rpm), not as a Snap or Flatpak.');
  return results;
}

const ICON = { ok: '[ OK ]', fail: '[FAIL]', warn: '[WARN]', info: '[ .. ]' };
function format(results) {
  const lines = [];
  for (const r of results) { lines.push(`${ICON[r.status]} ${r.title}`); if (r.detail) lines.push(`         ${r.detail}`); if (r.fix) lines.push(`         -> ${r.fix}`); }
  const failed = results.filter(r => r.status === 'fail').length, warned = results.filter(r => r.status === 'warn').length;
  lines.push('', failed ? `${failed} problem(s) found. Fix the first [FAIL] above, then run this check again.`
    : warned ? 'No hard failure, but see the [WARN] lines above.'
    : 'Everything on the ZDM side is in order. If the extension still reports no connection: open your browser\'s extensions page, remove the ZDM extension, load it again from the folder shown above, and compare its ID.');
  return lines.join('\n');
}

if (require.main === module) {
  runChecks().then(results => { console.log(`ZDM connection check\n${'='.repeat(20)}\n${format(results)}`); process.exitCode = results.some(r => r.status === 'fail') ? 1 : 0; })
    .catch(error => { console.error('The check itself failed:', error); process.exitCode = 2; });
}
module.exports = { runChecks, format, extensionIdFromKey, managedBrowsers };
