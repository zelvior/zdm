import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { stripServiceTables, needsServiceTableRemoval, TS_PACKET } from '../core/ts-strip.mjs';

const PAT = 0x0000, VIDEO = 0x100, AUDIO = 0x101, NULL = 0x1fff;
const SI = [0x10, 0x11, 0x12, 0x13, 0x14];
const packet = (pid, fill = pid & 0xff) => { const b = Buffer.alloc(TS_PACKET, fill); b[0] = 0x47; b[1] = (pid >> 8) & 0x1f; b[2] = pid & 0xff; b[3] = 0x10; return b; };
const pidOf = (buffer, i) => ((buffer[i + 1] & 0x1f) << 8) | buffer[i + 2];
async function temp(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-strip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'x.track');
  await fs.writeFile(file, content);
  return file;
}

test('only DVB service-information packets are removed; PAT, PMT, video, audio and null packets stay in order', async t => {
  const kept = [packet(PAT), packet(0x1000), packet(VIDEO, 1), packet(AUDIO, 2), packet(NULL), packet(0x15, 3), packet(0x0f, 4)];
  const input = Buffer.concat([kept[0], packet(0x11), kept[1], packet(0x12), kept[2], packet(0x10), kept[3], packet(0x14), kept[4], packet(0x13), kept[5], kept[6]]);
  const file = await temp(t, input);
  assert.equal(await stripServiceTables(file), 5 * TS_PACKET);
  assert.ok((await fs.readFile(file)).equals(Buffer.concat(kept)));
});

test('a large file with service tables everywhere is rewritten byte-exact in place, across many read chunks', async t => {
  let seed = 12345; const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const expected = [], all = [];
  for (let i = 0; i < 30000; i++) { // 5.6 MB: several chunks of 4096 packets
    const pid = random() < 0.2 ? SI[Math.floor(random() * 5)] : [PAT, VIDEO, AUDIO, NULL, 0x1000][Math.floor(random() * 5)];
    const p = packet(pid, Math.floor(random() * 256)); all.push(p); if (!SI.includes(pid)) expected.push(p);
  }
  const file = await temp(t, Buffer.concat(all));
  const removed = await stripServiceTables(file);
  const result = await fs.readFile(file);
  assert.ok(result.equals(Buffer.concat(expected)));
  assert.equal(removed, (all.length - expected.length) * TS_PACKET);
});

test('data without service tables is not touched, and non-TS data is left alone', async t => {
  const clean = Buffer.concat([packet(PAT), packet(VIDEO), packet(AUDIO), packet(NULL)]);
  const cleanFile = await temp(t, clean);
  assert.equal(await stripServiceTables(cleanFile), 0);
  assert.ok((await fs.readFile(cleanFile)).equals(clean));
  const adts = Buffer.alloc(5000, 0xaa); adts[0] = 0xff; adts[1] = 0xf1;
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(4000)]);
  const misaligned = Buffer.concat([packet(PAT), Buffer.from([0x00]), packet(0x11), packet(VIDEO)]); // sync at 0 but not at 188
  const tiny = Buffer.from([0x47, 0x00]);
  for (const data of [adts, mp4, misaligned, tiny, Buffer.alloc(0)]) {
    const file = await temp(t, data);
    assert.equal(await stripServiceTables(file), 0);
    assert.ok((await fs.readFile(file)).equals(data));
  }
});

test('when the 188-byte framing breaks, everything after the break is kept exactly as it was', async t => {
  const head = Buffer.concat([packet(PAT), packet(0x11), packet(VIDEO), packet(0x12), packet(AUDIO)]);
  const tail = Buffer.concat([Buffer.from('not-a-transport-stream-anymore'), packet(0x11), packet(0x12)]);
  const file = await temp(t, Buffer.concat([head, tail]));
  assert.equal(await stripServiceTables(file), 2 * TS_PACKET);
  assert.ok((await fs.readFile(file)).equals(Buffer.concat([packet(PAT), packet(VIDEO), packet(AUDIO), tail])));
});

test('a trailing partial packet is kept', async t => {
  const partial = Buffer.from([0x47, 0x01, 0x00, 0x10, 9, 9, 9]);
  const file = await temp(t, Buffer.concat([packet(PAT), packet(0x11), packet(VIDEO), partial]));
  await stripServiceTables(file);
  assert.ok((await fs.readFile(file)).equals(Buffer.concat([packet(PAT), packet(VIDEO), partial])));
});

test('an aborted download stops the clean-up, and only Linux needs it', async t => {
  const file = await temp(t, Buffer.concat([packet(PAT), packet(0x11), packet(VIDEO), packet(AUDIO)]));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(stripServiceTables(file, controller.signal), { name: 'AbortError' });
  assert.equal(needsServiceTableRemoval('linux'), true);
  assert.equal(needsServiceTableRemoval('win32'), false);
  assert.equal(needsServiceTableRemoval('darwin'), false);
});

test('with the bundled ffmpeg: a real TS (which carries an SDT) is cleaned and still remuxes into an MP4 with both tracks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-real-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const run = (args) => spawnSync(ffmpegPath, ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
  const ts = path.join(dir, 'av.track'), out = path.join(dir, 'out.mp4');
  const made = run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'mpegts', ts]);
  assert.equal(made.status, 0, made.stderr);
  const before = await fs.readFile(ts), count = (b, pid) => { let n = 0; for (let i = 0; i + TS_PACKET <= b.length; i += TS_PACKET) if (pidOf(b, i) === pid) n++; return n; };
  assert.ok(count(before, 0x11) > 0, 'ffmpeg\'s own TS output carries an SDT, the table that crashes static Linux builds');
  await stripServiceTables(ts);
  const after = await fs.readFile(ts);
  assert.equal(count(after, 0x11), 0);
  assert.ok(count(after, VIDEO) > 0 && count(after, PAT) > 0);
  const remux = run(['-i', ts, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', out]);
  assert.equal(remux.error, undefined);
  assert.equal(remux.signal, null, `ffmpeg was stopped by ${remux.signal}`);
  assert.equal(remux.status, 0, remux.stderr);
  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', out], { encoding: 'utf8' }).stderr;
  assert.match(probe, /Video: h264/); assert.match(probe, /Audio: aac/);
});
