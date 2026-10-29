const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const platform = require('../desktop/platform.cjs');
const registration = require('../desktop/browser-registration.cjs');
const { autostartEntry, autostartFile, setAutostart } = require('../desktop/linux-autostart.cjs');
const { needsNoSandbox } = require('../desktop/linux-sandbox.cjs');
const { openExtensions } = require('../desktop/browser-setup.cjs');

const HOME = '/home/ann';
const ID = 'a'.repeat(32);
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plat-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), dataDirectory = path.join(root, 'data'), integrationRoot = path.join(root, 'bi');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.mkdir(path.join(integrationRoot, 'extension'), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { root, home, dataDirectory, integrationRoot };
}

test('browser folders follow each platform convention', () => {
  const linux = platform.browserLocations({ platform: 'linux', env: {}, home: HOME });
  assert.equal(linux.Chrome.nativeMessagingDir, path.join(HOME, '.config', 'google-chrome', 'NativeMessagingHosts'));
  assert.equal(linux.Edge.nativeMessagingDir, path.join(HOME, '.config', 'microsoft-edge', 'NativeMessagingHosts'));
  assert.equal(linux.Firefox.nativeMessagingDir, path.join(HOME, '.mozilla', 'native-messaging-hosts'));
  assert.equal(platform.browserLocations({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: HOME }).Chrome.profileRoot, path.join('/xdg', 'google-chrome'));
  assert.equal(platform.browserLocations({ platform: 'linux', env: { XDG_CONFIG_HOME: 'relative' }, home: HOME }).Chrome.profileRoot, path.join(HOME, '.config', 'google-chrome'), 'a relative XDG_CONFIG_HOME is ignored');
  const mac = platform.browserLocations({ platform: 'darwin', env: {}, home: HOME });
  const support = path.join(HOME, 'Library', 'Application Support');
  assert.equal(mac.Chrome.nativeMessagingDir, path.join(support, 'Google', 'Chrome', 'NativeMessagingHosts'));
  assert.equal(mac.Edge.nativeMessagingDir, path.join(support, 'Microsoft Edge', 'NativeMessagingHosts'));
  assert.equal(mac.Firefox.nativeMessagingDir, path.join(support, 'Mozilla', 'NativeMessagingHosts'));
  const win = platform.browserLocations({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R' } });
  assert.equal(win.Chrome.registryRoot, 'Google\\Chrome');
  assert.equal(platform.browserLocations({ platform: 'win32', env: {} }).Chrome.profileRoot, null);
});

test('launcher scripts quote the executable and pick the right file per platform', () => {
  assert.deepEqual(platform.hostCandidates('win32'), ['native-host.exe', 'native-host.cmd']);
  assert.deepEqual(platform.hostCandidates('linux'), ['native-host.sh']);
  assert.equal(platform.launcherName('darwin'), 'native-host.sh');
  const sh = platform.launcherScript({ platform: 'linux', executable: "/opt/Z'DM/zdm" });
  assert.match(sh, /^#!\/bin\/sh\n/);
  assert.ok(sh.includes(`exec '/opt/Z'\\''DM/zdm'`), 'single quotes cannot break out of the quoted path');
  assert.match(platform.launcherScript({ platform: 'win32', executable: 'C:\\50%\\ZDM.exe' }), /50%%/);
});

test('an AppImage is launched through the .AppImage file, never its temporary mount', () => {
  const env = { APPIMAGE: '/home/ann/Apps/ZDM.AppImage' };
  assert.equal(platform.runtimeExecutable({ platform: 'linux', env, exe: '/tmp/.mount_ZDM1/zdm' }), env.APPIMAGE);
  assert.equal(platform.runtimeExecutable({ platform: 'linux', env: {}, exe: '/usr/lib/zdm/zdm' }), '/usr/lib/zdm/zdm');
  assert.equal(platform.runtimeExecutable({ platform: 'linux', env: { APPIMAGE: 'relative.AppImage' }, exe: '/x/zdm' }), '/x/zdm');
  assert.equal(platform.runtimeExecutable({ platform: 'darwin', env, exe: '/Applications/ZDM.app/Contents/MacOS/ZDM' }), '/Applications/ZDM.app/Contents/MacOS/ZDM');
});

for (const target of ['linux', 'darwin']) {
  test(`${target}: registering writes the manifest where the browser reads it and reports healthy`, async t => {
    const o = await setup(t), opts = { ...o, platform: target, env: {} };
    await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: target });
    const chrome = await registration.registerBrowser({ browser: 'Chrome', extensionId: ID, extensionIds: [ID] }, opts);
    const expected = platform.browserLocations({ platform: target, env: {}, home: o.home }).Chrome.nativeMessagingDir;
    assert.equal(path.dirname(chrome.manifestPath), expected);
    assert.equal(path.basename(chrome.manifestPath), `${platform.HOST}.json`);
    const manifest = JSON.parse(await fs.readFile(chrome.manifestPath, 'utf8'));
    assert.equal(manifest.path, path.join(o.integrationRoot, 'integration', 'native-host.sh'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${ID}/`]);
    const status = (await registration.registrationStatus(o, { platform: target, env: {}, home: o.home })).find(s => s.browser === 'Chrome');
    assert.equal(status.healthy, true, status.problem);
    assert.equal(status.problem, '');
  });
}

test('linux: Firefox gets allowed_extensions in its own folder, and a changed manifest keeps a backup', async t => {
  const o = await setup(t), opts = { ...o, platform: 'linux', env: {} };
  await fs.writeFile(path.join(o.integrationRoot, 'extension', 'manifest.firefox.json'), '{}');
  await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: 'linux' });
  const first = await registration.registerBrowser({ browser: 'Firefox', extensionId: 'zdm@zelvior.local' }, opts);
  assert.equal(first.manifestPath, path.join(o.home, '.mozilla', 'native-messaging-hosts', `${platform.HOST}.json`));
  assert.deepEqual(JSON.parse(await fs.readFile(first.manifestPath, 'utf8')).allowed_extensions, ['zdm@zelvior.local']);
  await registration.registerBrowser({ browser: 'Firefox', extensionId: 'other@example' }, opts);
  const backups = (await fs.readdir(path.join(o.dataDirectory, 'NativeMessaging'))).filter(name => name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  await assert.rejects(registration.registerBrowser({ browser: 'Opera', extensionId: ID }, opts), /Chrome, Edge, or Firefox/);
  await assert.rejects(registration.registerBrowser({ browser: 'Chrome', extensionId: 'not-an-id' }, opts), /extension ID/);
});

test('linux: a missing manifest is reported and repair restores it', async t => {
  const o = await setup(t);
  await registration.writeHostLauncher(o.integrationRoot, '/bin/true', { platform: 'linux' });
  await fs.mkdir(platform.browserLocations({ platform: 'linux', env: {}, home: o.home }).Chrome.profileRoot, { recursive: true });
  const found = await registration.ensureDefaultRegistrations(o, { platform: 'linux', env: {}, home: o.home });
  assert.deepEqual([...found], ['Chrome']);
  const before = (await registration.registrationStatus(o, { platform: 'linux', env: {}, home: o.home })).find(s => s.browser === 'Chrome');
  assert.equal(before.problem, 'browser connector file is missing');
  const result = await registration.repairRegistrations(o, { platform: 'linux', env: {}, home: o.home });
  assert.deepEqual(result.repaired, ['Chrome']);
  assert.equal((await registration.registrationStatus(o, { platform: 'linux', env: {}, home: o.home })).find(s => s.browser === 'Chrome').healthy, true);
});

test('the posix launcher really starts the connector with the bundled runtime', { skip: process.platform === 'win32' }, async t => {
  const o = await setup(t), dir = path.join(o.integrationRoot, 'integration');
  await fs.writeFile(path.join(dir, 'native-host.cjs'), "process.stdout.write('host:' + process.env.ELECTRON_RUN_AS_NODE);");
  const file = await registration.writeHostLauncher(o.integrationRoot, process.execPath);
  assert.equal((await fs.stat(file)).mode & 0o111, 0o111, 'the launcher is executable');
  const run = spawnSync(file, [], { encoding: 'utf8' });
  assert.equal(run.stdout, 'host:1');
  // a path with spaces and quotes works too
  const odd = path.join(o.root, "dir with 'quote"); await fs.mkdir(odd);
  await fs.symlink(process.execPath, path.join(odd, 'runtime'));
  const file2 = await registration.writeHostLauncher(o.integrationRoot, path.join(odd, 'runtime'));
  assert.equal(spawnSync(file2, [], { encoding: 'utf8' }).stdout, 'host:1');
});

test('linux autostart writes a valid, quoted .desktop entry and removes it again', async t => {
  const o = await setup(t), env = { XDG_CONFIG_HOME: path.join(o.root, 'xdg') };
  const entry = autostartEntry({ executable: '/home/ann/My Apps/ZDM $1.AppImage' });
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\n/);
  assert.ok(entry.includes('Exec="/home/ann/My Apps/ZDM \\$1.AppImage"'));
  assert.equal(autostartFile({ env, home: o.home }), path.join(o.root, 'xdg', 'autostart', 'zdm.desktop'));
  assert.equal(await setAutostart(true, { executable: '/usr/bin/zdm', env, home: o.home }), true);
  assert.match(await fs.readFile(autostartFile({ env }), 'utf8'), /Exec="\/usr\/bin\/zdm"/);
  assert.equal(await setAutostart(false, { env, home: o.home }), false);
  await assert.rejects(fs.access(autostartFile({ env })));
  await assert.doesNotReject(setAutostart(false, { env, home: o.home }), 'disabling twice is fine');
  await assert.rejects(setAutostart(true, { executable: 'zdm', env, home: o.home }), /application path/);
});

test('the process sandbox is only turned off for an AppImage where the kernel blocks user namespaces', () => {
  const read = values => file => { if (file in values) return values[file]; throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
  const appimage = { APPIMAGE: '/a.AppImage' };
  assert.equal(needsNoSandbox({ platform: 'linux', env: appimage, read: read({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n' }) }), true);
  assert.equal(needsNoSandbox({ platform: 'linux', env: appimage, read: read({ '/proc/sys/kernel/unprivileged_userns_clone': '0' }) }), true);
  assert.equal(needsNoSandbox({ platform: 'linux', env: appimage, read: read({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0' }) }), false);
  assert.equal(needsNoSandbox({ platform: 'linux', env: appimage, read: read({}) }), false);
  assert.equal(needsNoSandbox({ platform: 'linux', env: {}, read: read({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false, 'installed .deb/.rpm keep the sandbox');
  assert.equal(needsNoSandbox({ platform: 'darwin', env: appimage, read: read({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false);
});

test('opening the browser extensions page uses the right command per platform', async () => {
  const calls = [];
  const launch = async (command, args) => { calls.push([command, ...args]); if (command === 'google-chrome-stable') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await openExtensions('Chrome', { platform: 'linux', launch });
  assert.deepEqual(calls.at(-1), ['google-chrome', 'chrome://extensions/']);
  await openExtensions('Edge', { platform: 'darwin', launch });
  assert.deepEqual(calls.at(-1), ['open', '-a', 'Microsoft Edge', '--args', 'edge://extensions/']);
  await assert.rejects(openExtensions('Firefox', { platform: 'linux', launch }), /Chrome or Edge/);
  await assert.rejects(openExtensions('Edge', { platform: 'linux', launch: async () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), /was not found/);
  await assert.rejects(openExtensions('Chrome', { platform: 'linux', launch: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } }), /denied/);
});
