const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const platformApi = require('./platform.cjs');
const { HOST, BROWSERS, isWindows, browserCatalog, registrationTarget, hostCandidates, launcherName, launcherScript } = platformApi;

// Windows keeps the pointer to the manifest in the registry; macOS and Linux have the browser read the manifest from a fixed folder.
const manifestFileName = `${HOST}.json`;
// The extension ships with a fixed manifest "key", so its ID is the same wherever it is loaded from. That lets the app pair
// with a browser on its own, without having to spot the extension in a browser profile first.
const FIXED_EXTENSION_ID = 'lhgcpodkgbalmogcjhdmmphkpijmpefm';
const FIREFOX_EXTENSION_ID = 'zdm@zelvior.local';
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

// ---- browsers: the built-in catalog plus locations the user added ----------------------------------------------------------
const customFile = dataDirectory => path.join(dataDirectory, 'custom-browsers.json');
async function readCustom(dataDirectory) {
  try { const list = JSON.parse(await fs.readFile(customFile(dataDirectory), 'utf8')); return Array.isArray(list) ? list.filter(c => c && /^custom-[0-9a-f]{8}$/.test(c.id)) : []; } catch { return []; }
}
function customEntry(custom, { platform }) {
  const windows = isWindows(platform);
  return { name: custom.id, label: custom.label, family: custom.kind, verified: true, custom: true, profileRoot: null,
    nativeMessagingDir: windows ? null : custom.location, registryRoot: windows ? custom.location : null, registryFrom: null, alwaysRegister: false };
}
// Everything that can hold a registration, keyed by name.
async function allEntries({ dataDirectory }, { platform = process.platform, env = process.env, home } = {}) {
  const entries = Object.fromEntries(browserCatalog({ platform, env, home }).map(entry => [entry.name, entry]));
  for (const custom of await readCustom(dataDirectory)) entries[custom.id] = customEntry(custom, { platform });
  return entries;
}
const targetOf = (name, entries, platform) => { const entry = entries[name]; if (!entry) return null; return isWindows(platform) && !entry.registryRoot ? entry.registryFrom : name; };
const registryKeyFor = entry => `HKCU\\Software\\${entry.registryRoot}\\NativeMessagingHosts\\${HOST}`;
// Where the registration of `browser` lives: the registry key (Windows) or the manifest file (macOS, Linux).
async function registrationKey(browser, options = {}, context = {}) {
  const platform = context.platform || process.platform, entries = await allEntries(options, context), target = targetOf(browser, entries, platform);
  if (!target) return null;
  return isWindows(platform) ? registryKeyFor(entries[target]) : path.join(entries[target].nativeMessagingDir, manifestFileName);
}

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
const defaultIdFor = entry => (entry.family === 'firefox' ? FIREFOX_EXTENSION_ID : FIXED_EXTENSION_ID);

// Health of each registration: registry key / manifest file -> manifest -> connector program.
// One entry per place that can hold a registration (on Windows several browsers can share one), with the browsers it serves.
async function registrationStatus({ dataDirectory, integrationRoot }, { query, platform = process.platform, env = process.env, home } = {}) {
  query = query || defaultQuery({ platform });
  const entries = await allEntries({ dataDirectory }, { platform, env, home });
  const known = await readKnown(dataDirectory), expectedHost = await hostPath(integrationRoot, { platform }), out = [];
  const targets = Object.keys(entries).filter(name => targetOf(name, entries, platform) === name);
  for (const browser of targets) {
    const entry = entries[browser];
    const key = isWindows(platform) ? registryKeyFor(entry) : path.join(entry.nativeMessagingDir, manifestFileName);
    const registered = await query(key);
    let manifest = null, manifestOk = false, hostOk = false;
    if (registered && await exists(registered)) { try { manifest = JSON.parse(await fs.readFile(registered, 'utf8')); manifestOk = manifest.name === HOST; } catch { /* corrupt manifest */ } }
    if (manifest?.path) hostOk = await exists(manifest.path) && manifest.path === expectedHost;
    const origins = manifest?.allowed_origins || manifest?.allowed_extensions || [];
    const ids = known[browser] || [];
    const idsOk = ids.every(id => origins.some(o => o.includes(id)));
    const covers = Object.keys(entries).filter(name => targetOf(name, entries, platform) === browser);
    const installed = covers.some(name => entries[name].profileRoot && entries[name].installed);
    out.push({ browser, label: entry.label || browser, family: entry.family, custom: Boolean(entry.custom), covers, ids, registered: Boolean(registered), manifest: manifestOk, host: hostOk, idsOk, healthy: Boolean(registered) && manifestOk && hostOk && idsOk,
      installed,
      problem: !ids.length && !registered ? 'not connected' : !registered ? (isWindows(platform) ? 'browser registry entry is missing' : 'browser connector file is missing') : !manifestOk ? 'connector manifest is missing' : !hostOk ? 'connector program moved or missing' : !idsOk ? 'extension ID changed' : '' });
  }
  return out;
}

// Marks which catalog browsers are really installed (their data folder exists).
async function detectInstalled(entries) {
  for (const entry of Object.values(entries)) entry.installed = Boolean(entry.profileRoot) && await exists(entry.profileRoot);
  return entries;
}
// What the interface shows: every browser that is installed or already registered, and whether the extension can reach the app through it.
async function browserOverview(options, context = {}) {
  const platform = context.platform || process.platform;
  const entries = await detectInstalled(await allEntries(options, context)), statuses = await registrationStatus(options, context);
  const out = [];
  for (const name of Object.keys(entries)) {
    const entry = entries[name], target = targetOf(name, entries, platform), status = statuses.find(s => s.browser === target);
    if (!entry.installed && !entry.custom && !(status?.registered && target === name && !entry.alwaysRegister)) continue;
    out.push({ name, label: entry.label || name, family: entry.family, verified: entry.verified, custom: Boolean(entry.custom), installed: entry.installed, shared: target !== name ? target : null,
      connected: Boolean(status?.healthy), problem: status?.healthy ? '' : status?.problem || 'not connected' });
  }
  return out;
}

// Registers the built-in extension ID for every installed browser (and, on Windows, for the Chrome and Chromium keys that most
// Chromium-based browsers follow even when they are not on the list). Returns the installed browsers that were found.
async function ensureDefaultRegistrations(options, { env = process.env, platform = process.platform, home } = {}) {
  const found = [], entries = await detectInstalled(await allEntries(options, { platform, env, home }));
  for (const entry of Object.values(entries)) {
    if (entry.custom) { await rememberIds(options.dataDirectory, entry.name, [defaultIdFor(entry)]); continue; }
    const target = targetOf(entry.name, entries, platform);
    if (entry.installed && target) { await rememberIds(options.dataDirectory, target, [defaultIdFor(entries[target])]); found.push(entry.name); }
    else if (entry.alwaysRegister && target) await rememberIds(options.dataDirectory, target, [defaultIdFor(entry)]);
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
  const entries = await allEntries({ dataDirectory }, { platform, env, home });
  const target = targetOf(browser, entries, platform);
  if (!target) throw new Error(BROWSERS.includes(browser) ? `${browser} is not available on this system.` : 'Choose a browser from the list.');
  const entry = entries[target], firefoxLike = entry.family === 'firefox';
  const allIds = [...new Set([extensionId, ...(extensionIds || [])].filter(Boolean))], idPattern = firefoxLike ? /^[A-Za-z0-9@._{}-]{1,128}$/ : /^[a-p]{32}$/;
  if (!allIds.length || !allIds.every(id => typeof id === 'string' && idPattern.test(id))) throw new Error('Copy the extension ID from your browser’s extensions page.');
  const windows = isWindows(platform), key = windows ? registryKeyFor(entry) : null;
  const folder = path.join(dataDirectory, 'NativeMessaging');
  // Windows: our own copy that the registry points at. macOS/Linux: the file the browser itself reads.
  const manifestPath = windows ? path.join(folder, `${target.replace(/[^A-Za-z0-9._-]/g, '_')}.json`) : path.join(entry.nativeMessagingDir, manifestFileName);
  const manifest = { name: HOST, description: 'ZDM browser bridge', path: await hostPath(integrationRoot, { platform }), type: 'stdio' };
  if (firefoxLike) manifest.allowed_extensions = allIds;
  else manifest.allowed_origins = allIds.map(id => `chrome-extension://${id}/`);
  const content = JSON.stringify(manifest, null, 2);
  if (!manifest.path) throw new Error(windows ? 'The browser connector program was not found. Reinstall ZDM or install .NET Framework 4 so it can be built.' : 'The browser connector program was not found. Reinstall ZDM or restart it so it can be recreated.');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  let previous;
  try { previous = await fs.readFile(manifestPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-'), safe = target.replace(/[^A-Za-z0-9._-]/g, '_');
  if (previous && previous !== content) await fs.writeFile(path.join(folder, `${safe}.${stamp}.bak`), previous);
  let previousPath;
  if (windows) {
    let registry = null;
    try { registry = (await exec('reg.exe', ['QUERY', key, '/ve'], { windowsHide: true })).stdout; }
    catch (error) { if (error.code !== 1) throw error; }
    previousPath = registry?.match(/REG_SZ\s+(.+)\r?\n?/)?.[1]?.trim();
    if (registry && previousPath !== manifestPath) await fs.writeFile(path.join(folder, `${safe}.${stamp}.registry-backup.txt`), registry);
  }
  if (previous !== content) await fs.writeFile(manifestPath, content, 'utf8');
  if (windows && previousPath !== manifestPath) await exec('reg.exe', ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { windowsHide: true });
  let extensionPath = path.join(integrationRoot, 'extension');
  if (firefoxLike) {
    extensionPath = path.join(folder, 'firefox-extension');
    await fs.cp(path.join(integrationRoot, 'extension'), extensionPath, { recursive: true });
    await fs.copyFile(path.join(extensionPath, 'manifest.firefox.json'), path.join(extensionPath, 'manifest.json'));
  }
  await rememberIds(dataDirectory, target, allIds);
  return { ok: true, manifestPath, extensionPath };
}

// A browser that is not on the list: the user gives the place it reads native messaging entries from.
//   macOS / Linux: the folder (its NativeMessagingHosts folder, or the browser's data folder, which holds it)
//   Windows:       the vendor key under HKCU\Software, for example  Vivaldi  or  Opera Software\Opera
function normalizeCustomLocation(location, platform) {
  const value = String(location || '').trim();
  if (isWindows(platform)) {
    const key = value.replace(/^HKCU\\Software\\/i, '').replace(/\\NativeMessagingHosts\\?$/i, '').replace(/\\+$/, ''); // a leading backslash is not part of a key
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]*(\\[A-Za-z0-9][A-Za-z0-9 ._-]*){0,3}$/.test(key) || key.includes('..') || key.length > 120) throw new Error('Enter the browser\'s registry vendor key under HKCU\\Software, for example Vivaldi or Opera Software\\Opera.');
    return key;
  }
  if (!path.isAbsolute(value) || value.includes('\0')) throw new Error('Enter the full path of the browser\'s data folder or of its NativeMessagingHosts folder.');
  const folder = path.normalize(value).replace(/[\\/]+$/, '');
  return path.basename(folder) === 'NativeMessagingHosts' ? folder : path.join(folder, 'NativeMessagingHosts');
}
async function registerCustom({ label, kind = 'chromium', location }, options) {
  const platform = options.platform || process.platform;
  if (!['chromium', 'firefox'].includes(kind)) throw new Error('Choose Chromium-based or Firefox-based.');
  const place = normalizeCustomLocation(location, platform);
  const name = String(label || '').trim().replace(/\s+/g, ' ').slice(0, 40) || (isWindows(platform) ? place : path.basename(path.dirname(place)));
  const id = `custom-${crypto.createHash('sha256').update(`${kind}|${place}`).digest('hex').slice(0, 8)}`;
  const list = (await readCustom(options.dataDirectory)).filter(c => c.id !== id);
  list.push({ id, label: name, kind, location: place });
  await fs.mkdir(options.dataDirectory, { recursive: true });
  await fs.writeFile(customFile(options.dataDirectory), JSON.stringify(list, null, 2));
  const result = await registerBrowser({ browser: id, extensionId: kind === 'firefox' ? FIREFOX_EXTENSION_ID : FIXED_EXTENSION_ID }, options);
  return { ...result, id, label: name };
}
async function removeCustom(id, { dataDirectory }) {
  const list = (await readCustom(dataDirectory)).filter(c => c.id !== id);
  await fs.writeFile(customFile(dataDirectory), JSON.stringify(list, null, 2));
}

// Read only extension registrations, never browser history, cookies, or page data.
async function connectInstalledBrowsers({ dataDirectory, integrationRoot, platform = process.platform, env = process.env, home }) {
  const results = [], entries = await detectInstalled(await allEntries({ dataDirectory }, { platform, env, home }));
  // Windows and macOS file systems ignore case by default; Linux does not.
  const same = (a, b) => (platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
  for (const entry of Object.values(entries).filter(e => e.family === 'chromium' && e.installed)) {
    const browser = entry.name, root = entry.profileRoot;
    let profiles;
    try { profiles = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
    const ids = new Set();
    for (const profile of profiles.filter(p => p.isDirectory() && /^(Default|Profile \d+)$/.test(p.name))) {
      for (const file of ['Preferences', 'Secure Preferences']) {
        try {
          const settings = JSON.parse(await fs.readFile(path.join(root, profile.name, file), 'utf8')).extensions?.settings || {};
          for (const [id, extension] of Object.entries(settings)) {
            if (!/^[a-p]{32}$/.test(id) || !extension.path || !path.isAbsolute(extension.path)) continue;
            const installed = await fs.realpath(extension.path).catch(() => null);
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
      const target = targetOf(browser, entries, platform);
      // Every profile's ID, the built-in fixed ID and previously seen IDs all stay allowed, so nothing is rewritten back and forth.
      const all = [...new Set([...ids, ...((await readKnown(dataDirectory))[target] || []), FIXED_EXTENSION_ID])];
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
module.exports = { FIXED_EXTENSION_ID, FIREFOX_EXTENSION_ID, ensureDefaultRegistrations, registerBrowser, registerCustom, removeCustom, connectInstalledBrowsers, prepareNativeHost, writeHostLauncher, registrationStatus, browserOverview, repairRegistrations, hostPath, registrationKey, normalizeCustomLocation };
