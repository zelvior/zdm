const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const platformApi = require('./platform.cjs');
const { HOST, BROWSERS, isWindows, browserLocations, hostCandidates, launcherName, launcherScript } = platformApi;

const REG_ROOTS = { Chrome: 'Google\\Chrome', Edge: 'Microsoft\\Edge', Firefox: 'Mozilla' };
const registryKey = browser => `HKCU\\Software\\${REG_ROOTS[browser]}\\NativeMessagingHosts\\${HOST}`;
// Windows keeps the pointer to the manifest in the registry; macOS and Linux have the browser read the manifest from a fixed folder.
const manifestFileName = `${HOST}.json`;
const registrationKey = (browser, { platform = process.platform, env = process.env, home } = {}) =>
  isWindows(platform) ? registryKey(browser) : path.join(browserLocations({ platform, env, home })[browser].nativeMessagingDir, manifestFileName);
// The extension ships with a fixed manifest "key", so its ID is the same wherever it is loaded from. That lets the app pair
// with Chrome/Edge on its own, without having to spot the extension in a browser profile first.
const FIXED_EXTENSION_ID = 'lhgcpodkgbalmogcjhdmmphkpijmpefm';
const FIREFOX_EXTENSION_ID = 'zdm@zelvior.local';
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

// The connector the browser launches: the compiled launcher, or the .cmd launcher when the .NET compiler was unavailable.
async function hostPath(integrationRoot, { platform = process.platform } = {}) {
  const folder = path.join(integrationRoot, 'integration');
  for (const name of hostCandidates(platform)) if (await exists(path.join(folder, name))) return path.join(folder, name);
  return null;
}
async function queryRegistry(key) {
  try { return (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout.match(/REG_SZ\s+(.+?)\r?\n/)?.[1]?.trim() || null; }
  catch { return null; }
}
// Returns what the browser would currently use as its manifest: the registry value on Windows, the manifest file elsewhere.
const defaultQuery = options => async key => (isWindows(options.platform || process.platform) ? queryRegistry(key) : ((await exists(key)) ? key : null));
// Extension IDs the user connected before; they survive reinstalls so a lost registration can be restored without the user.
const knownFile = dataDirectory => path.join(dataDirectory, 'known-extensions.json');
async function readKnown(dataDirectory) { try { const v = JSON.parse(await fs.readFile(knownFile(dataDirectory), 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
async function rememberIds(dataDirectory, browser, ids) {
  const known = await readKnown(dataDirectory);
  known[browser] = [...new Set([...(known[browser] || []), ...ids])].filter(id => typeof id === 'string').slice(-8);
  await fs.mkdir(dataDirectory, { recursive: true });
  await fs.writeFile(knownFile(dataDirectory), JSON.stringify(known, null, 2));
}
// Health of each browser's registration: registry key -> manifest file -> connector executable.
async function registrationStatus({ dataDirectory, integrationRoot }, { query, platform = process.platform, env = process.env, home } = {}) {
  query = query || defaultQuery({ platform });
  const known = await readKnown(dataDirectory), expectedHost = await hostPath(integrationRoot, { platform }), out = [];
  for (const browser of BROWSERS) {
    const registered = await query(registrationKey(browser, { platform, env, home }));
    let manifest = null, manifestOk = false, hostOk = false, origins = [];
    if (registered && await exists(registered)) { try { manifest = JSON.parse(await fs.readFile(registered, 'utf8')); manifestOk = manifest.name === HOST; } catch { /* corrupt manifest */ } }
    if (manifest?.path) hostOk = await exists(manifest.path) && manifest.path === expectedHost;
    origins = manifest?.allowed_origins || manifest?.allowed_extensions || [];
    const ids = known[browser] || [];
    const idsOk = ids.every(id => origins.some(o => o.includes(id)));
    out.push({ browser, ids, registered: Boolean(registered), manifest: manifestOk, host: hostOk, idsOk, healthy: Boolean(registered) && manifestOk && hostOk && idsOk,
      problem: !ids.length && !registered ? 'not connected' : !registered ? (isWindows(platform) ? 'browser registry entry is missing' : 'browser connector file is missing') : !manifestOk ? 'connector manifest is missing' : !hostOk ? 'connector program moved or missing' : !idsOk ? 'extension ID changed' : '' });
  }
  return out;
}
// Registers the built-in extension ID for every installed browser that is not connected yet.
async function ensureDefaultRegistrations(options, { env = process.env, platform = process.platform, home } = {}) {
  const found = [], locations = browserLocations({ platform, env, home });
  for (const browser of BROWSERS) {
    const folder = locations[browser].profileRoot;
    if (!folder || !await exists(folder)) continue;
    await rememberIds(options.dataDirectory, browser, [browser === 'Firefox' ? FIREFOX_EXTENSION_ID : FIXED_EXTENSION_ID]);
    found.push(browser);
  }
  return found;
}
// Re-creates registrations that vanished (uninstall of another build, antivirus, manual cleanup, moved install folder).
async function repairRegistrations(options, { query, platform = process.platform, env = process.env, home } = {}) {
  const statuses = await registrationStatus(options, { query, platform, env, home }), repaired = [];
  for (const status of statuses) {
    if (!status.ids.length || status.healthy) continue;
    try {
      await registerBrowser({ browser: status.browser, extensionId: status.ids[0], extensionIds: status.ids }, { ...options, platform, env, home });
      repaired.push(status.browser);
    } catch (error) { status.repairError = error.message; }
  }
  return { statuses, repaired };
}
async function registerBrowser({ browser, extensionId, extensionIds }, { dataDirectory, integrationRoot, platform = process.platform, env = process.env, home }) {
  if (!BROWSERS.includes(browser)) throw new Error('Choose Chrome, Edge, or Firefox.');
  const allIds = [...new Set([extensionId, ...(extensionIds || [])].filter(Boolean))], idPattern = browser === 'Firefox' ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/;
  if (!allIds.length || !allIds.every(id => typeof id === 'string' && idPattern.test(id))) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const windows = isWindows(platform), key = registryKey(browser);
  const folder = path.join(dataDirectory, 'NativeMessaging');
  // Windows: our own copy that the registry points at. macOS/Linux: the file the browser itself reads.
  const manifestPath = windows ? path.join(folder, `${browser}.json`) : registrationKey(browser, { platform, env, home });
  const manifest = { name: HOST, description: 'ZDM browser bridge', path: await hostPath(integrationRoot, { platform }), type: 'stdio' };
  if (browser === 'Firefox') manifest.allowed_extensions = allIds;
  else manifest.allowed_origins = allIds.map(id => `chrome-extension://${id}/`);
  const content = JSON.stringify(manifest, null, 2);
  if (!manifest.path) throw new Error(windows ? 'The browser connector program was not found. Reinstall ZDM or install .NET Framework 4 so it can be built.' : 'The browser connector program was not found. Reinstall ZDM or restart it so it can be recreated.');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  if (previous && previous !== content) await fs.writeFile(path.join(folder, `${browser}.${stamp}.bak`), previous);
  let previousPath;
  if (windows) {
    let registry = null;
    try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
    catch (error) { if (error.code !== 1) throw error; }
    previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
    if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${browser}.${stamp}.registry-backup.txt`), registry);
  }
  if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  if (windows && previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  let extensionPath = path.join(integrationRoot, 'extension');
  if (browser === 'Firefox') {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  await rememberIds(dataDirectory, browser, allIds);
  return { ok: true, manifestPath, extensionPath };
}
// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, platform = process.platform, env = process.env, home }) {
  const results = [], locations = browserLocations({ platform, env, home });
  // Windows and macOS file systems ignore case by default; Linux does not.
  const same = (a, b) => (platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
  for (const browser of ['Chrome', 'Edge']) {
    const root = locations[browser].profileRoot;
    if (!root) continue;
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const ids = new Set();
    for (const profile of profiles.filter(p => p.isDirectory() && /^(Default|Profile \d+)$/.test(p.name))) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings = JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions?.settings || {};
          for (const [id, entry] of Object.entries(settings)) {
            if (!/^[a-p]{32}$/.test(id) || !entry.path || !path.isAbsolute(entry.path)) continue;
            const installed = await fs.realpath(entry.path).catch(() => null);
            const expected = await fs.realpath(path.join(integrationRoot, 'extension'));
            let ownExtension=Boolean(installed)&&same(installed,expected);
            if(installed&&!ownExtension){
              const manifest=JSON.parse(await fs.readFile(path.join(installed,'manifest.json'),'utf8'));
              const background=await fs.readFile(path.join(installed,'background.js'),'utf8');
              ownExtension=manifest.name==='ZDM Integration'&&manifest.background?.service_worker==='background.js'&&background.includes("const HOST = 'com.zelvior.zdm.host'");
            }
            if (ownExtension) ids.add(id);
          }
        } catch { /* A running browser can temporarily replace a preference file. */ }
      }
    }
    if (ids.size) {
      // Every profile's ID, the built-in fixed ID and previously seen IDs all stay allowed, so nothing is rewritten back and forth.
      const all = [...new Set([...ids, ...((await readKnown(dataDirectory))[browser] || []), FIXED_EXTENSION_ID])];
      await registerBrowser({ browser, extensionId: [...ids][0], extensionIds: all }, { dataDirectory, integrationRoot, platform, env, home });
      results.push({ browser, connected: true });
    }
  }
  return results;
}
// Writes the small launcher script a browser starts (native-host.cmd on Windows, native-host.sh elsewhere) that runs the
// connector with the app's own bundled runtime, so browsers need no Node.js on PATH.
async function writeHostLauncher(integrationRoot, executable, { platform = process.platform } = {}) {
  const folder = path.join(integrationRoot, 'integration'), file = path.join(folder, launcherName(platform));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(file, launcherScript({ platform, executable }), { mode: 0o755 });
  if (!isWindows(platform)) await fs.chmod(file, 0o755); // writeFile keeps an old file's mode
  return file;
}
async function prepareNativeHost(integrationRoot, executable, { platform = process.platform } = {}) {
  const folder = path.join(integrationRoot, 'integration');
  const target = path.join(folder, 'native-host.exe');
  if (!isWindows(platform)) { await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8'); return; }
  try { await fs.access(target); }
  catch {
    // 64-bit Windows keeps the original compiler first; 32-bit and older systems fall back.
    const windir = process.env.WINDIR || 'C:\\Windows', net = path.join(windir, 'Microsoft.NET');
    const compilers = [path.join(net, 'Framework64', 'v4.0.30319', 'csc.exe'), path.join(net, 'Framework', 'v4.0.30319', 'csc.exe'), path.join(net, 'Framework', 'v3.5', 'csc.exe')];
    let compiler = null;
    for (const candidate of compilers) { try { await fs.access(candidate); compiler = candidate; break; } catch { /* try next */ } }
    if (!compiler) throw new Error('The .NET Framework compiler was not found. Install .NET Framework 4.0 or newer to enable browser integration.');
    await exec(compiler, ['/nologo', '/target:exe', `/out:${target}`, path.join(folder, 'NativeHostLauncher.cs')], { windowsHide: true });
  }
  await fs.writeFile(path.join(folder, 'runtime-path.txt'), executable, 'utf8');
}
module.exports = { FIXED_EXTENSION_ID, FIREFOX_EXTENSION_ID, ensureDefaultRegistrations, registerBrowser, connectInstalledBrowsers, prepareNativeHost, writeHostLauncher, registrationStatus, repairRegistrations, hostPath, registrationKey };
