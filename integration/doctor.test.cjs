const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runChecks, format, extensionIdFromKey, managedBrowsers } = require('./doctor.cjs');
const registration = require('../desktop/browser-registration.cjs');
const platformApi = require('../desktop/platform.cjs');

const posix = { skip: process.platform === 'win32' && 'the launcher is a shell script' };
const find = (results, text) => results.find(r => r.title.includes(text));

test('the extension ID the doctor computes is the one the app pairs with', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'extension', 'manifest.json'), 'utf8'));
  assert.equal(extensionIdFromKey(manifest.key), registration.FIXED_EXTENSION_ID);
});

test('the doctor and the app agree on every browser, on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const env = { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' }, home = '/home/ann';
    const mine = managedBrowsers({ platform, env, home }), app = platformApi.browserLocations({ platform, env, home });
    assert.deepEqual(Object.keys(mine), Object.keys(app), `${platform} browser list`);
    for (const name of Object.keys(app)) {
      assert.equal(mine[name].profile, app[name].profileRoot, `${platform} ${name} profile`);
      assert.equal(mine[name].dir, platform === 'win32' ? undefined : app[name].nativeMessagingDir, `${platform} ${name} manifest folder`);
      assert.equal(mine[name].registry, platform === 'win32' ? app[name].registryRoot || null : undefined, `${platform} ${name} registry`);
      assert.equal(mine[name].registryFrom, platform === 'win32' ? app[name].registryFrom || null : undefined, `${platform} ${name} registryFrom`);
    }
  }
});

async function world(t, { register = true, bridge = true, launcherExe = process.execPath, wrongId = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zdm-doctor-'));
  const stops = [() => fs.rm(root, { recursive: true, force: true })];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); });
  const home = path.join(root, 'home'), integrationRoot = path.join(home, '.zdm', 'BrowserIntegration'), integrationDir = path.join(integrationRoot, 'integration');
  await fs.mkdir(integrationDir, { recursive: true });
  await fs.cp(path.join(__dirname, '..', 'extension'), path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'native-host.cjs'), path.join(integrationDir, 'native-host.cjs'));
  await registration.writeHostLauncher(integrationRoot, launcherExe);
  await fs.writeFile(path.join(integrationDir, 'desktop-launch.json'), JSON.stringify({ executable: process.execPath, args: [] }));
  await fs.mkdir(path.join(home, '.config', 'google-chrome'), { recursive: true }); // Chrome is "installed"
  const opts = { dataDirectory: path.join(home, '.zdm'), integrationRoot, platform: 'linux', env: {}, home };
  if (register) await registration.registerBrowser({ browser: 'Chrome', extensionId: wrongId ? 'b'.repeat(32) : registration.FIXED_EXTENSION_ID }, opts);
  if (bridge) {
    const { DownloadEngine } = await import('../core/engine.mjs'), { startBridge } = await import('../core/bridge.mjs');
    const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'd'), downloadDirectory: path.join(root, 'dl'), tickMs: 60000 }).init();
    const server = await startBridge(engine, { dataDirectory: path.join(home, '.zdm'), port: 0 });
    stops.push(async () => { await server.close(); await engine.close?.(); });
  }
  return { home, integrationDir, check: () => runChecks({ platform: 'linux', env: {}, home, integrationDir }) };
}

test('a healthy setup passes every link of the chain', posix, async t => {
  const results = await (await world(t)).check();
  assert.deepEqual(results.filter(r => r.status === 'fail'), []);
  assert.ok(find(results, 'Browser to app works'));
  assert.ok(find(results, 'ZDM is running'));
  assert.ok(find(results, 'Chrome: connected'));
  assert.match(format(results), /Everything on the ZDM side is in order/);
});

test('a browser that is installed but was never registered is reported with the fix', posix, async t => {
  const results = await (await world(t, { register: false })).check();
  const chrome = find(results, 'Chrome: is installed but is not connected');
  assert.equal(chrome.status, 'fail');
  assert.match(chrome.fix, /Start ZDM/);
});

test('a connection entry that allows a different extension ID is caught', posix, async t => {
  const results = await (await world(t, { wrongId: true })).check();
  const chrome = find(results, 'Chrome: the connection entry is wrong');
  assert.equal(chrome.status, 'fail');
  assert.ok(chrome.title.includes(`chrome-extension://${registration.FIXED_EXTENSION_ID}/`));
});

test('a launcher that points at a program that no longer exists is caught', posix, async t => {
  const results = await (await world(t, { launcherExe: '/no/such/ZDM' })).check();
  assert.equal(find(results, 'points at a program that does not exist').status, 'fail');
  assert.equal(find(results, 'The launcher could not run the connector').status, 'fail');
});

test('with the app closed the connector is fine and the doctor says to start ZDM, not that something is broken', posix, async t => {
  const results = await (await world(t, { bridge: false })).check();
  assert.equal(find(results, 'ZDM is not running').status, 'warn');
  assert.equal(find(results, 'The connector started and answered').status, 'warn');
  assert.deepEqual(results.filter(r => r.status === 'fail'), []);
});

test('a browser that is installed but not connected is named, whatever its family', posix, async t => {
  const w = await world(t);
  await fs.mkdir(path.join(w.home, '.config', 'BraveSoftware', 'Brave-Browser'), { recursive: true }); // Brave installed, never registered
  const results = await w.check();
  assert.equal(find(results, 'Brave: is installed but is not connected').status, 'fail');
});

test('a browser whose location is expected rather than confirmed gets an honest warning', posix, async t => {
  const w = await world(t);
  const opera = path.join(w.home, '.config', 'opera');
  await fs.mkdir(opera, { recursive: true });
  await registration.registerBrowser({ browser: 'Opera', extensionId: registration.FIXED_EXTENSION_ID }, { dataDirectory: path.join(w.home, '.zdm'), integrationRoot: path.join(w.home, '.zdm', 'BrowserIntegration'), platform: 'linux', env: {}, home: w.home });
  const results = await w.check();
  assert.equal(find(results, 'Opera: connected').status, 'ok');
  assert.equal(find(results, 'Opera: the entry exists').status, 'warn');
});

test('sandboxed browsers are named as the likely reason', posix, async t => {
  const w = await world(t);
  await fs.mkdir(path.join(w.home, 'snap', 'firefox'), { recursive: true });
  assert.equal(find(await w.check(), 'Firefox (Snap) runs in a sandbox').status, 'warn');
});
