const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const registration = require('../desktop/browser-registration.cjs');
const platformApi = require('../desktop/platform.cjs');
const catalog = require('./browsers.json').browsers;

const ID = registration.FIXED_EXTENSION_ID;
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zdm-browsers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dataDirectory = path.join(root, 'data'), integrationRoot = path.join(root, 'bi');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.mkdir(path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.writeFile(path.join(integrationRoot, 'extension', 'manifest.firefox.json'), '{}');
  await fs.mkdir(home, { recursive: true });
  return { root, home, dataDirectory, integrationRoot };
}
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

test('the catalog is well formed: unique names, a data folder for every platform entry, and every shared key points at a real browser', () => {
  const names = catalog.map(b => b.name);
  assert.equal(new Set(names).size, names.length);
  for (const browser of catalog) {
    assert.ok(['chromium', 'firefox'].includes(browser.family), browser.name);
    for (const key of ['win32', 'darwin', 'linux'].filter(k => browser[k])) {
      assert.ok(browser[key].profile, `${browser.name} ${key} has a data folder`);
      if (key === 'win32') assert.ok(browser.win32.registry || catalog.find(b => b.name === browser.win32.registryFrom)?.win32?.registry, `${browser.name} has a Windows registry key, own or inherited`);
    }
  }
  for (const wanted of ['Chrome', 'Edge', 'Chromium', 'Brave', 'Vivaldi', 'Opera', 'Supermium', 'Firefox', 'Waterfox']) assert.ok(names.includes(wanted), wanted);
});

test('Windows: Supermium follows the Chromium registry key, Waterfox follows Firefox, and every browser resolves to a real key', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local', APPDATA: 'C:\\Users\\A\\AppData\\Roaming' };
  const options = { platform: 'win32', env };
  assert.equal(platformApi.registrationTarget('Supermium', options), 'Chromium');
  assert.equal(platformApi.registrationTarget('Opera', options), 'Chromium');
  assert.equal(platformApi.registrationTarget('Waterfox', options), 'Firefox');
  assert.equal(platformApi.registrationTarget('Brave', options), 'Brave');
  assert.equal(platformApi.registrationTarget('Arc', options), null, 'Arc does not exist on Windows');
  const locations = platformApi.browserLocations(options);
  assert.equal(locations.Brave.registryRoot, 'BraveSoftware\\Brave-Browser');
  assert.equal(locations.Vivaldi.registryRoot, 'Vivaldi');
  assert.match(locations.Supermium.profileRoot.replaceAll('\\', '/'), /Supermium\/User Data$/);
  for (const name of Object.keys(locations)) assert.ok(platformApi.registrationTarget(name, options), `${name} has a target`);
});

test('Windows: an installed Supermium is registered through the Chromium key, and Chrome and Chromium are always registered', async t => {
  const o = await setup(t), local = path.join(o.root, 'local');
  await fs.mkdir(path.join(local, 'Supermium', 'User Data'), { recursive: true });
  const options = { dataDirectory: o.dataDirectory, integrationRoot: o.integrationRoot };
  const found = await registration.ensureDefaultRegistrations(options, { platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: path.join(o.root, 'roaming') } });
  assert.deepEqual(found, ['Supermium'], 'only installed browsers are reported');
  const known = JSON.parse(await fs.readFile(path.join(o.dataDirectory, 'known-extensions.json'), 'utf8'));
  assert.deepEqual(known.Chromium, [ID], 'the Chromium key is where Supermium looks');
  assert.deepEqual(known.Chrome, [ID], 'the Chrome key is always registered on Windows');
  assert.equal(known.Supermium, undefined, 'a browser without its own key stores nothing under its own name');
  const statuses = await registration.registrationStatus(options, { platform: 'win32', env: { LOCALAPPDATA: local, APPDATA: '' }, query: async key => (key.includes('Software\\Chromium\\') ? 'C:\\x.json' : null) });
  const chromium = statuses.find(s => s.browser === 'Chromium');
  assert.deepEqual(chromium.covers.sort(), ['Chromium', 'Opera', 'Supermium', 'Thorium', 'Yandex Browser']);
});

for (const [target, name, folder] of [['linux', 'Brave', ['.config', 'BraveSoftware', 'Brave-Browser']], ['linux', 'Vivaldi', ['.config', 'vivaldi']], ['linux', 'Chromium', ['.config', 'chromium']],
  ['darwin', 'Brave', ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser']], ['darwin', 'Arc', ['Library', 'Application Support', 'Arc', 'User Data']], ['darwin', 'Vivaldi', ['Library', 'Application Support', 'Vivaldi']]]) {
  test(`${target}: ${name} gets its own connection file inside its own data folder`, async t => {
    const o = await setup(t), opts = { ...o, platform: target, env: {} };
    await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: target });
    await fs.mkdir(path.join(o.home, ...folder), { recursive: true });
    const found = await registration.ensureDefaultRegistrations(opts, { platform: target, env: {}, home: o.home });
    assert.deepEqual(found, [name]);
    const repaired = await registration.repairRegistrations(opts, { platform: target, env: {}, home: o.home });
    assert.deepEqual(repaired.repaired, [name]);
    const manifest = JSON.parse(await fs.readFile(path.join(o.home, ...folder, 'NativeMessagingHosts', `${platformApi.HOST}.json`), 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    const overview = await registration.browserOverview(opts, { platform: target, env: {}, home: o.home });
    assert.deepEqual(overview.map(b => [b.name, b.connected]), [[name, true]]);
  });
}

test('linux: Waterfox is Firefox-based: its own folder, extension IDs instead of origins', async t => {
  const o = await setup(t), opts = { ...o, platform: 'linux', env: {} };
  await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: 'linux' });
  await fs.mkdir(path.join(o.home, '.waterfox'), { recursive: true });
  await registration.ensureDefaultRegistrations(opts, { platform: 'linux', env: {}, home: o.home });
  await registration.repairRegistrations(opts, { platform: 'linux', env: {}, home: o.home });
  const manifest = JSON.parse(await fs.readFile(path.join(o.home, '.waterfox', 'native-messaging-hosts', `${platformApi.HOST}.json`), 'utf8'));
  assert.deepEqual(manifest.allowed_extensions, [registration.FIREFOX_EXTENSION_ID]);
  assert.equal(manifest.allowed_origins, undefined);
});

test('the overview lists installed browsers only, and says why one is not connected', async t => {
  const o = await setup(t), opts = { ...o, platform: 'linux', env: {} };
  await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: 'linux' });
  await fs.mkdir(path.join(o.home, '.config', 'google-chrome'), { recursive: true });
  await fs.mkdir(path.join(o.home, '.config', 'opera'), { recursive: true });
  const before = await registration.browserOverview(opts, { platform: 'linux', env: {}, home: o.home });
  assert.deepEqual(before.map(b => b.name), ['Chrome', 'Opera']);
  assert.ok(before.every(b => !b.connected && b.problem === 'not connected'));
  assert.equal(before.find(b => b.name === 'Opera').verified, false);
  assert.equal(before.find(b => b.name === 'Chrome').verified, true);
});

test('a browser that is not on the list can be added by its folder, remembered, repaired and removed', async t => {
  const o = await setup(t), opts = { ...o, platform: 'linux', env: {} };
  await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: 'linux' });
  const dataFolder = path.join(o.root, 'MyBrowser');
  const added = await registration.registerCustom({ label: 'My Browser', location: dataFolder }, opts);
  const file = path.join(dataFolder, 'NativeMessagingHosts', `${platformApi.HOST}.json`);
  assert.equal(added.label, 'My Browser');
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).allowed_origins, [`chrome-extension://${ID}/`]);
  const overview = await registration.browserOverview(opts, { platform: 'linux', env: {}, home: o.home });
  assert.deepEqual(overview.map(b => [b.label, b.custom, b.connected]), [['My Browser', true, true]]);
  await fs.rm(file); // something deletes the connection file
  const repaired = await registration.repairRegistrations(opts, { platform: 'linux', env: {}, home: o.home });
  assert.deepEqual(repaired.repaired, [added.id]);
  assert.ok(await exists(file));
  await registration.removeCustom(added.id, opts);
  assert.deepEqual(await registration.browserOverview(opts, { platform: 'linux', env: {}, home: o.home }), []);
  // the same folder given as the NativeMessagingHosts folder itself is the same browser
  const again = await registration.registerCustom({ label: 'x', location: path.join(dataFolder, 'NativeMessagingHosts') + path.sep }, opts);
  assert.equal(again.id, added.id);
});

test('custom locations are validated: absolute folders on macOS/Linux, a short vendor key under HKCU\\Software on Windows', () => {
  const n = registration.normalizeCustomLocation;
  // Folders are normalized with the host's own path rules (on Windows '/' becomes '\\'), so the expected values are built the same way.
  assert.equal(n('/home/a/.config/foo', 'linux'), path.join('/home/a/.config/foo', 'NativeMessagingHosts'));
  assert.equal(n('/home/a/.config/foo/NativeMessagingHosts', 'darwin'), path.normalize('/home/a/.config/foo/NativeMessagingHosts'));
  assert.equal(n(`/home/a/.config/foo${path.sep}`, 'linux'), path.join('/home/a/.config/foo', 'NativeMessagingHosts'), 'a trailing separator makes no difference');
  assert.throws(() => n('relative/path', 'linux'), /full path/);
  assert.throws(() => n('', 'linux'), /full path/);
  assert.equal(n('Vivaldi', 'win32'), 'Vivaldi');
  assert.equal(n('HKCU\\Software\\Opera Software\\Opera\\NativeMessagingHosts', 'win32'), 'Opera Software\\Opera');
  for (const bad of ['', '..\\Windows', 'A\\..\\B', 'C:\\Windows', 'A\\B\\C\\D\\E\\F', '\\\\server\\share', 'x'.repeat(130)]) assert.throws(() => n(bad, 'win32'), /registry vendor key/, bad);
});

test('an unknown browser name is refused with a clear message', async t => {
  const o = await setup(t);
  await assert.rejects(registration.registerBrowser({ browser: 'Netscape', extensionId: ID }, { ...o, platform: 'linux', env: {}, home: o.home }), /Choose a browser from the list/);
  await assert.rejects(registration.registerBrowser({ browser: 'Arc', extensionId: ID }, { ...o, platform: 'win32', env: {}, home: o.home }), /Choose a browser from the list|not available/);
});
