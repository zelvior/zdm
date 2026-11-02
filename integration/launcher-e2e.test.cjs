// The chain a browser really drives on macOS and Linux:
//   browser starts native-host.sh -> it starts the runtime on native-host.cjs -> native messaging frames on stdin/stdout ->
//   bridge.json in ~/.zdm -> the HTTP bridge of the running app -> the engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { writeHostLauncher } = require('../desktop/browser-registration.cjs');

const posix = { skip: process.platform === 'win32' && 'the .sh launcher is for macOS and Linux' };
const frame = message => { const body = Buffer.from(JSON.stringify(message)); const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]); };

// Starts the launcher like a browser does and returns the first reply it sends back.
function askHost(launcher, home, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(launcher, ['chrome-extension://lhgcpodkgbalmogcjhdmmphkpijmpefm/'], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0), err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no reply from the native host. stderr: ${err}`)); }, 8000);
    child.stderr.on('data', c => { err += c; });
    child.stdout.on('data', chunk => {
      out = Buffer.concat([out, chunk]);
      if (out.length >= 4 && out.length >= 4 + out.readUInt32LE(0)) { clearTimeout(timer); child.kill(); resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString())); }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.write(frame(message));
  });
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zdm-launcher-'));
  const stops = [];  // run in reverse order at the end: the engine and bridge stop before their folder is deleted
  t.after(async () => { for (const stop of stops.reverse()) await stop(); });
  stops.push(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), integrationRoot = path.join(home, '.zdm', 'BrowserIntegration');
  await fs.mkdir(path.join(integrationRoot, 'integration'), { recursive: true });
  await fs.copyFile(path.join(__dirname, 'native-host.cjs'), path.join(integrationRoot, 'integration', 'native-host.cjs'));
  const launcher = await writeHostLauncher(integrationRoot, process.execPath);
  return { root, home, integrationRoot, launcher, stops };
}

test('the launcher reaches a running app: a status request from the "browser" is answered by the engine', posix, async t => {
  const { root, home, launcher, stops } = await setup(t);
  const { DownloadEngine } = await import('../core/engine.mjs'), { startBridge } = await import('../core/bridge.mjs');
  const engine = await new DownloadEngine({ dataDirectory: path.join(root, 'd'), downloadDirectory: path.join(root, 'dl'), tickMs: 60000 }).init();
  const bridge = await startBridge(engine, { dataDirectory: path.join(home, '.zdm'), port: 0 }); // the same place the app writes bridge.json
  stops.push(async () => { await bridge.close(); await engine.close?.(); });
  const [id] = await engine.add({ url: 'https://example.com/file.zip', queueOnly: true });
  const reply = await askHost(launcher, home, { action: 'status' });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  assert.equal(reply.items[0].id, id);
});

test('with the app not running the launcher still answers, and says to start ZDM', posix, async t => {
  const { home, launcher } = await setup(t);
  const reply = await askHost(launcher, home, { action: 'status' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /Start ZDM/);
});

test('a download request starts the app when it is not running, using the saved launch command', posix, async t => {
  const { root, home, integrationRoot, launcher } = await setup(t);
  // A stand-in "app": when started it opens the real bridge, which is what ZDM does at startup.
  const standIn = path.join(root, 'fake-app.cjs');
  const repo = path.resolve(__dirname, '..').replaceAll('\\', '\\\\');
  await fs.writeFile(standIn, `(async()=>{const {DownloadEngine}=await import('${repo}/core/engine.mjs');const {startBridge}=await import('${repo}/core/bridge.mjs');
    const e=await new DownloadEngine({dataDirectory:'${root}/d2',downloadDirectory:'${root}/dl2',tickMs:60000}).init();
    await startBridge(e,{dataDirectory:'${home}/.zdm',port:0});setTimeout(()=>process.exit(0),6000);})();`);
  await fs.writeFile(path.join(integrationRoot, 'integration', 'desktop-launch.json'), JSON.stringify({ executable: process.execPath, args: [standIn] }));
  const reply = await askHost(launcher, home, { action: 'download', url: 'https://example.com/a.zip', queueOnly: true });
  assert.equal(reply.ok, true, JSON.stringify(reply));
});
