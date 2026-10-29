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
  return { file, dir };
}

test('a crashed media process is retried once with CPU optimizations off', posix, async t => {
  const { file, dir } = await fake(t, 'case "$*" in *"-cpuflags 0"*) echo ok > "$LAST"; exit 0;; *) kill -SEGV $$;; esac'.replace('$LAST', '"$(dirname "$0")/done"'));
  await runFfmpeg(file, ['-i', 'x'], undefined, 'Could not combine');
  assert.equal((await fs.readFile(path.join(dir, 'done'), 'utf8')).trim(), 'ok');
});

test('a media process that fails normally is not retried and keeps its own message', posix, async t => {
  const { file, dir } = await fake(t, 'echo run >> "$(dirname "$0")/runs"; echo "bad input" >&2; exit 1');
  await assert.rejects(runFfmpeg(file, [], undefined, 'Could not combine'), /Could not combine: bad input/);
  assert.equal((await fs.readFile(path.join(dir, 'runs'), 'utf8')).trim().split('\n').length, 1);
});

test('if the retry crashes too, both attempts are reported', posix, async t => {
  const { file } = await fake(t, 'kill -SEGV $$');
  await assert.rejects(runFfmpeg(file, [], undefined, 'Could not combine'), error => /stopped by SIGSEGV; again with CPU optimizations off: Could not combine: media process was stopped by SIGSEGV/.test(error.message));
});

test('an aborted download is not retried', posix, async t => {
  const { file } = await fake(t, 'kill -SEGV $$');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runFfmpeg(file, [], controller.signal, 'Could not combine'), { name: 'AbortError' });
});
