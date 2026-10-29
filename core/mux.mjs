import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Runs ffmpeg and rejects with `${label}: <ffmpeg's message>`. `crashed` is set when the process was killed by a signal
// (for example SIGSEGV) instead of failing on its own, which says nothing about the media.
function runOnce(executable, args, signal, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('close', (code, killedBy) => {
      if (code === 0) return resolve();
      const failure = new Error(`${label}: ${error || (killedBy ? 'media process was stopped by ' + killedBy : 'media process exited ' + code)}`);
      failure.crashed = Boolean(killedBy);
      reject(failure);
    });
  });
}
// Some bundled ffmpeg builds crash inside CPU-specific (SIMD) code on certain processors. A crash is retried once with those
// optimizations switched off, which is slower but does not depend on the CPU.
export async function runFfmpeg(executable, args, signal, label) {
  try { return await runOnce(executable, args, signal, label); }
  catch (first) {
    if (!first.crashed || signal?.aborted) throw first;
    try { return await runOnce(executable, ['-cpuflags', '0', ...args], signal, label); }
    catch (second) { throw second.crashed ? new Error(`${first.message}; again with CPU optimizations off: ${second.message}`) : second; }
  }
}

export async function muxTracks(directory, videoCount, count, signal) {
  for (const [name, start, end] of [['video',0,videoCount],['audio',videoCount,count]]) {
    const output = await fs.open(path.join(directory, name+'.track'), 'w');
    try {
      for (let i=start;i<end;i++) {
        const input = await fs.open(path.join(directory, `${i}.part`), 'r');
        try { for await (const chunk of input.createReadStream()) { signal.throwIfAborted(); await output.writeFile(chunk); } }
        finally { await input.close(); }
      }
    } finally { await output.close(); }
  }
  const output = path.join(directory,'combined.mp4');
  const executable = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  await runFfmpeg(executable, ['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',path.join(directory,'video.track'),'-protocol_whitelist','file,pipe','-i',path.join(directory,'audio.track'),'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart',output], signal, 'Could not combine video and audio');
  return output;
}

export async function convertMedia(directory, files, format, signal) {
  if(!['mp4','mp3'].includes(format))throw new Error('Unsupported output format.');
  const source=path.join(directory,'conversion-source.track');
  const out=await fs.open(source,'w');
  try {for(const file of files){const input=await fs.open(file,'r');try{for await(const chunk of input.createReadStream()){signal.throwIfAborted();await out.writeFile(chunk);}}finally{await input.close();}}}finally{await out.close();}
  const output=path.join(directory,'converted.'+format);
  const args=['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',source];
  args.push(...(format==='mp3'?['-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','2']:['-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart']),output);
  await runFfmpeg(ffmpegPath.replace('app.asar','app.asar.unpacked'),args,signal,`Could not create ${format.toUpperCase()}`);
  return output;
}
