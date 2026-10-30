import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '../core/mux.mjs';

const posix = { skip: process.platform === 'win32' && 'needs /bin/sh' };
async function fake(t, script) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mux-crash-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ffmpeg');
  await fs.writeFile(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

test('a media process killed by a signal says which signal, instead of "exited null"', posix, async t => {
  const file = await fake(t, 'kill -SEGV $$');
  await assert.rejects(runFfmpeg(file, [], undefined, 'Could not combine video and audio'), /Could not combine video and audio: media process was stopped by SIGSEGV/);
});

test('a media process that fails normally reports its own message and exit', posix, async t => {
  const message = await fake(t, 'echo "bad input" >&2; exit 1');
  await assert.rejects(runFfmpeg(message, [], undefined, 'Could not create MP4'), /Could not create MP4: bad input/);
  const silent = await fake(t, 'exit 3');
  await assert.rejects(runFfmpeg(silent, [], undefined, 'Could not create MP4'), /media process exited 3/);
});

test('an aborted download stops the media process', posix, async t => {
  const file = await fake(t, 'sleep 5');
  const controller = new AbortController();
  const pending = runFfmpeg(file, [], controller.signal, 'Could not combine');
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { name: 'AbortError' });
});
