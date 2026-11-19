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
    'state.json', 'MessageDigest', 'generation', 'pause', 'snapshot', 'settings', 'clipboard',
    'formats', 'review', 'scheduledAt', 'mirrors', 'maxConcurrent', 'blockPool',
    'coerceIn(1, 64)']) {
    assert.ok(kotlin.includes(token), `Kotlin engine is missing ${token}`);
  }
  const swift = read('mobile/ios/ZDM/DownloadService.swift');
  for (const token of ['Range', 'URLSession', 'state.json', 'Insecure.MD5', 'SHA256', 'generation',
    'DispatchQueue.global', 'snapshot', 'settings', 'UIPasteboard', 'formats', 'review',
    'scheduledAt', 'mirrors', 'maxConcurrent', 'ytInitialPlayerResponse', 'BackgroundActivity',
    'min(64, max(1']) {
    assert.ok(swift.includes(token), `Swift engine is missing ${token}`);
  }
});

test('the mobile bridge exposes the full desktop renderer API', async () => {
  const calls = [];
  const win = {
    zdmMobile: {
      async call(method, payload) {
        calls.push([method, payload]);
        if (method === 'snapshot') return { ok: true, downloads: [], settings: {}, integration: {} };
        return { ok: true, value: 'saved' };
      }
    },
    location: { pathname: '/index.html' },
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [] },
    setInterval: () => 1
  };
  vm.runInNewContext(read('renderer/mobile-bridge.js'), { window: win, setInterval: win.setInterval, location: win.location, document: win.document });
  assert.equal(typeof win.downloader.snapshot, 'function');
  assert.equal(typeof win.downloader.subscribe, 'function');
  assert.deepEqual(plain(await win.downloader.add({ urls: ['https://example.com/f'] })), 'saved');
  assert.equal(JSON.stringify(plain(calls)), JSON.stringify([['add', { urls: ['https://example.com/f'] }]]));
  const html = read('renderer/index.html');
  assert.ok(html.indexOf('mobile-bridge.js') < html.indexOf('app.js'), 'the adapter must load before the desktop UI script');
});

test('the mobile bridge adapter creates the native bridge when only zdmNative exists', async () => {
  const win = {
    zdmNative: { call: (method, json) => JSON.stringify({ ok: true, value: JSON.parse(json).urls.length }) },
    location: { pathname: '/renderer/index.html' },
    document: { readyState: 'complete', addEventListener() {}, querySelectorAll: () => [] }
  };
  vm.runInNewContext(read('renderer/mobile-bridge.js'), { window: win, document: win.document, location: win.location });
  assert.deepEqual(plain(await win.downloader.add({ urls: ['https://a.test/1', 'https://a.test/2'] })), 2);
});

test('mobile builds package the full desktop renderer and assets', () => {
  const androidGradle = read('mobile/android/app/build.gradle.kts');
  assert.ok(androidGradle.includes('../../../renderer'));
  assert.ok(androidGradle.includes('../../../assets'));
  const iosSpec = read('mobile/ios/project.yml');
  assert.ok(iosSpec.includes('path: ../../renderer'));
  assert.ok(iosSpec.includes('path: ../../assets'));
  const androidHost = read('mobile/android/app/src/main/java/com/zelvior/zdm/ZdmActivity.kt');
  assert.ok(androidHost.includes('renderer/index.html'));
  const iosHost = read('mobile/ios/ZDM/ZdmViewController.swift');
  assert.ok(iosHost.includes('subdirectory: "renderer"'));
});

test('the iOS project targets 64-bit devices and permits direct HTTP downloads', () => {
  const plist = read('mobile/ios/ZDM/Info.plist');
  assert.match(plist, /<key>UIRequiredDeviceCapabilities<\/key><array><string>arm64<\/string><\/array>/);
  assert.match(plist, /NSAllowsArbitraryLoads/);
  const spec = read('mobile/ios/project.yml');
  assert.match(spec, /IPHONEOS_DEPLOYMENT_TARGET: "13.4"/);
  assert.match(spec, /path: \.\.\/shared/);
});

test('the shared mobile UI wires all three bridge methods and checksum input', () => {
  const html = read('mobile/shared/index.html');
  for (const token of ['zdm.js', "call('status')", "call('downloads'", "call('control'", 'id="checksum"']) {
    assert.ok(html.includes(token), `mobile UI is missing ${token}`);
  }
  const contract = JSON.parse(read('mobile/protocol/bridge.json'));
  assert.deepEqual(Object.keys(contract.methods), ['snapshot', 'status', 'add', 'downloads', 'control', 'action',
    'formats', 'review', 'settings', 'clipboard', 'chooseDirectory', 'integration', 'browserSetup', 'openProgress', 'about']);
  assert.match(contract.methods.add.request.checksum, /sha256/);
  assert.equal(contract.limits.blockSize, 2 * 1024 * 1024);
});

test('mobile builds keep downloads alive in the background and allow 64 split connections', () => {
  const swiftSource = read('mobile/ios/ZDM/DownloadService.swift');
  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
  assert.match(manifest, /android:foregroundServiceType="dataSync"/);
  const settings = read('renderer/index.html');
  assert.match(settings, /id="connections"[^>]*max="64"/);
  assert.ok(!swiftSource.includes('NSFileHandle'), 'NSFileHandle is obsolete in the current SDK');
  const iosBackground = read('mobile/ios/ZDM/BackgroundActivity.swift');
  assert.match(iosBackground, /beginBackgroundTask/);
  assert.match(iosBackground, /UNUserNotificationCenter/);
  const androidService = read('mobile/android/app/src/main/java/com/zelvior/zdm/TransferForegroundService.kt');
  assert.match(androidService, /startForeground\(/);
  assert.match(androidService, /setProgress\(/);
});

test('the Android workflow does not depend on the retired SDK tools package', () => {
  const workflow = read('.github/workflows/release-mobile.yml');
  assert.ok(!workflow.includes('android-actions/setup-android'));
  assert.match(workflow, /Prepare Android SDK/);
  assert.match(workflow, /platforms;android-34/);
  assert.match(workflow, /build-tools;34\.0\.0/);
  assert.ok(!workflow.includes('chmod +x'), 'sdkmanager is already executable on GitHub runners');
});

test('the Android Gradle build declares dependency repositories', () => {
  const settings = read('mobile/android/settings.gradle.kts');
  assert.match(settings, /dependencyResolutionManagement/);
  assert.match(settings, /repositories\s*\{[^}]*google\(\)[^}]*mavenCentral\(\)/s);
});

test('the iOS singleton initializes stored properties before using computed paths', () => {
  const swift = read('mobile/ios/ZDM/DownloadService.swift');
  const init = swift.slice(swift.indexOf('private init()'));
  assert.ok(init.indexOf('settings = defaults') < init.indexOf('createDirectory(at: outURL'),
    'settings must be assigned before outURL is accessed in init');
});

test('the mobile release workflow publishes native builds, not prototype shells', () => {
  const workflow = read('.github/workflows/release-mobile.yml');
  assert.ok(!/\bprototype\b/i.test(workflow));
  for (const token of ['assembleRelease', 'ZDM-Android-universal.apk', 'ZDM-Android-armeabi-v7a.apk',
    'ZDM-Android-arm64-v8a.apk', 'ZDM-iOS-unsigned.ipa', 'gh release upload', 'gh release create']) {
    assert.ok(workflow.includes(token), `workflow is missing ${token}`);
  }
});
