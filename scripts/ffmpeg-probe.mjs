// CI diagnostic: shows which ffmpeg binary the app bundles, whether it starts, and whether the HLS video+audio mux
// (MPEG-TS video + raw AAC copied into an MP4) crashes with it. It never fails the build; it only prints.
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripServiceTables } from '../core/ts-strip.mjs';

const run = (args) => spawnSync(ffmpeg, ['-nostdin', '-v', 'error', '-y', ...args], { encoding: 'utf8' });
const outcome = (r) => (r.error ? `spawn error: ${r.error.message}` : r.signal ? `CRASH (${r.signal})` : r.status === 0 ? 'ok' : `failed (exit ${r.status}) ${String(r.stderr).trim().slice(0, 120)}`);

const version = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
console.log(`binary: ${ffmpeg}\nversion: ${String(version.stdout).split('\n')[0]} -> ${outcome(version)}`);
console.log(`cpu: ${os.cpus()[0]?.model} x${os.cpus().length}, ${os.platform()} ${os.release()}`);
if (process.platform === 'linux') {
  try { console.log('cpu flags:', fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:\s*(.*)$/m)?.[1].split(' ').filter(f => /avx|sse4|bmi|fma/.test(f)).join(' ')); } catch { /* not available */ }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ffprobe-'));
const v = path.join(dir, 'video.track'), a = path.join(dir, 'audio.track');
console.log('make TS video   :', outcome(run(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '1', '-an', '-c:v', 'libx264', '-f', 'mpegts', v])));
console.log('make ADTS audio :', outcome(run(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', 'aac', '-f', 'adts', a])));
const inputs = ['-protocol_whitelist', 'file,pipe', '-i', v, '-protocol_whitelist', 'file,pipe', '-i', a, '-map', '0:v:0', '-map', '1:a:0'];
const variants = {
  'app command (copy, faststart)': [...inputs, '-c', 'copy', '-movflags', '+faststart'],
  'without faststart': [...inputs, '-c', 'copy'],
  'explicit aac_adtstoasc': [...inputs, '-c', 'copy', '-bsf:a', 'aac_adtstoasc'],
  'audio only copy': ['-i', a, '-c', 'copy'],
  'video only copy': ['-i', v, '-c', 'copy'],
};
// The cause of the crash: DVB service tables (SDT, PID 0x11) in the MPEG-TS, which the static Linux ffmpeg cannot parse.
// This is what ZDM now does before every mux: remove them, then run the very same command.
const cleaned = path.join(dir, 'video.clean.track');
fs.copyFileSync(v, cleaned);
const removed = await stripServiceTables(cleaned);
console.log(`service tables removed from the TS copy: ${removed} bytes`);
variants['app command on the cleaned TS (what ZDM does)'] = ['-protocol_whitelist', 'file,pipe', '-i', cleaned, '-protocol_whitelist', 'file,pipe', '-i', a, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart'];
for (const [name, args] of Object.entries(variants)) {
  const out = path.join(dir, `${name.replace(/\W+/g, '_')}.${name.startsWith('audio only') ? 'm4a' : 'mp4'}`);
  console.log(`${name.padEnd(34)}:`, outcome(run([...args, out])));
}
fs.rmSync(dir, { recursive: true, force: true });
