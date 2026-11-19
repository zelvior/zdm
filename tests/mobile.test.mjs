import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const loadBridge = win => vm.runInNewContext(read('mobile/shared/zdm.js'), { window: win });
// Objects created inside the VM have a different prototype; compare their data, not their realm.
const plain = value => JSON.parse(JSON.stringify(value));

test('the shared mobile bridge resolves synchronous Android calls', async () => {
  const calls = [];
  const win = {
    zdmNative: {
      call(method, json) {
        calls.push([method, JSON.parse(json)]);
        return JSON.stringify({ ok: true, ids: ['one'] });
      }
    }
  };
  loadBridge(win);
  const result = await win.zdmMobile.call('downloads', { urls: ['https://example.com/file.bin'] });
  assert.deepEqual(plain(result), { ok: true, ids: ['one'] });
  assert.equal(JSON.stringify(plain(calls)), JSON.stringify([['downloads', { urls: ['https://example.com/file.bin'] }]]));
});

test('the shared mobile bridge resolves asynchronous iOS replies', async () => {
  let posted;
  const win = {
    webkit: { messageHandlers: { zdmNative: { postMessage(message) { posted = message; } } } }
  };
  loadBridge(win);
  const pending = win.zdmMobile.call('status');
  assert.equal(posted.method, 'status');
  assert.equal(JSON.stringify(plain(posted.payload)), '{}');
  win.zdmResolve(posted.id, JSON.stringify({ ok: true, items: [] }));
  assert.deepEqual(plain(await pending), { ok: true, items: [] });
});

test('the shared mobile bridge reports a missing native host instead of hanging', async () => {
  const win = {};
  loadBridge(win);
  assert.deepEqual(plain(await win.zdmMobile.call('status')), { ok: false, error: 'Native bridge is unavailable.' });
});

test('the native engines implement ranges, resume, checksums and cancellation generations', () => {
  const kotlin = read('mobile/android/app/src/main/java/com/zelvior/zdm/DownloadService.kt');
  for (const token of ['Accept-Ranges', 'bytes=$from-${block.end}', 'Content-Range', 'CountDownLatch',
    'state.json', 'MessageDigest', 'generation', 'pause']) {
    assert.ok(kotlin.includes(token), `Kotlin engine is missing ${token}`);
  }
  const swift = read('mobile/ios/ZDM/DownloadService.swift');
  for (const token of ['Range', 'URLSession', 'state.json', 'Insecure.MD5', 'SHA256', 'generation', 'DispatchQueue.concurrentPerform']) {
    assert.ok(swift.includes(token), `Swift engine is missing ${token}`);
  }
});

test('the iOS project targets 64-bit devices and permits direct HTTP downloads', () => {
  const plist = read('mobile/ios/ZDM/Info.plist');
  assert.match(plist, /<key>UIRequiredDeviceCapabilities<\/key><array><string>arm64<\/string><\/array>/);
  assert.match(plist, /NSAllowsArbitraryLoads/);
  const spec = read('mobile/ios/project.yml');
  assert.match(spec, /IPHONEOS_DEPLOYMENT_TARGET: "13.0"/);
  assert.match(spec, /path: \.\.\/shared/);
});

test('the shared mobile UI wires all three bridge methods and checksum input', () => {
  const html = read('mobile/shared/index.html');
  for (const token of ['zdm.js', "call('status')", "call('downloads'", "call('control'", 'id="checksum"']) {
    assert.ok(html.includes(token), `mobile UI is missing ${token}`);
  }
  const contract = JSON.parse(read('mobile/protocol/bridge.json'));
  assert.deepEqual(Object.keys(contract.methods), ['status', 'downloads', 'control', 'formats']);
  assert.match(contract.methods.downloads.request.checksum, /sha256/);
  assert.equal(contract.limits.blockSize, 2 * 1024 * 1024);
});

test('the mobile release workflow publishes native builds, not prototype shells', () => {
  const workflow = read('.github/workflows/release-mobile.yml');
  assert.ok(!/\bprototype\b/i.test(workflow));
  for (const token of ['assembleRelease', 'ZDM-Android-universal.apk', 'ZDM-Android-armeabi-v7a.apk',
    'ZDM-Android-arm64-v8a.apk', 'ZDM-iOS-unsigned.ipa', 'gh release upload', 'gh release create']) {
    assert.ok(workflow.includes(token), `workflow is missing ${token}`);
  }
});
