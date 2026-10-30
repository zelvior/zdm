import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { needsServiceTableRemoval, stripServiceTables } from './ts-strip.mjs';

// Runs ffmpeg and rejects with `${label}: <ffmpeg's message>`. A process killed by a signal (for example SIGSEGV) says so.
export function runFfmpeg(executable, args, signal, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = ''; child.stderr.on('data', chunk => { error = (error + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('close', (code, killedBy) => {
      if (code === 0) return resolve();
      reject(new Error(`${label}: ${error || (killedBy ? 'media process was stopped by ' + killedBy : 'media process exited ' + code)}`));
    });
  });
}

// MPEG-TS tracks (HLS) are cleaned of DVB service tables first, because the static Linux ffmpeg crashes on them (see ts-strip.mjs).
export async function prepareTrack(file, signal, platform = process.platform) {
  return needsServiceTableRemoval(platform) ? stripServiceTables(file, signal) : 0;
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
  for (const name of ['video','audio']) await prepareTrack(path.join(directory, name+'.track'), signal);
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
  await prepareTrack(source, signal);
  const output=path.join(directory,'converted.'+format);
  const args=['-nostdin','-v','error','-y','-protocol_whitelist','file,pipe','-i',source];
  args.push(...(format==='mp3'?['-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','2']:['-map','0:v:0','-map','0:a:0?','-c','copy','-movflags','+faststart']),output);
  await runFfmpeg(ffmpegPath.replace('app.asar','app.asar.unpacked'),args,signal,`Could not create ${format.toUpperCase()}`);
  return output;
}
