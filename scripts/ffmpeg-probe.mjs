// CI diagnostic: prints which ffmpeg binary the app bundles and whether it starts on this machine.
import ffmpeg from 'ffmpeg-static';
import { spawnSync } from 'node:child_process';
const run = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
console.log(`${ffmpeg}\nexit status: ${run.status}, stopped by signal: ${run.signal}, spawn error: ${run.error?.message ?? 'none'}`);
console.log(String(run.stdout).split('\n')[0]);
