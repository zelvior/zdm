import { promises as fs } from 'node:fs';

// WHY THIS EXISTS
// The ffmpeg that ships for Linux (ffmpeg-static) is a fully static glibc build. When it reads an MPEG-TS file that contains DVB
// service information (the SDT/EIT tables almost every HLS segment carries) it crashes with SIGSEGV while decoding the service
// names (FFmpeg ticket #10439). Windows and macOS builds are not affected. ffmpeg does not need those tables to remux, so they
// are removed from the data before ffmpeg ever sees it.
export const TS_PACKET = 188;
const SYNC = 0x47;
// DVB SI PIDs: NIT 0x10, SDT/BAT 0x11, EIT 0x12, RST 0x13, TDT/TOT 0x14. PAT (0x0000) and the PMT stay: they describe the streams.
const isServiceInformation = pid => pid >= 0x10 && pid <= 0x14;
const CHUNK = TS_PACKET * 4096; // about 750 KB

// Only the Linux static build is affected; elsewhere the data is passed through untouched (no extra disk I/O).
export const needsServiceTableRemoval = (platform = process.platform) => platform === 'linux';

/**
 * Removes DVB service-information packets from an MPEG-TS file, in place (no second copy on disk). Files that are not aligned
 * MPEG-TS (ADTS audio, MP4, ...) are left alone, and so is everything after the first byte that breaks the 188-byte framing.
 * Returns the number of bytes removed.
 */
export async function stripServiceTables(file, signal) {
  const handle = await fs.open(file, 'r+');
  try {
    const size = (await handle.stat()).size;
    const probe = Buffer.alloc(TS_PACKET * 3);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (bytesRead < probe.length || probe[0] !== SYNC || probe[TS_PACKET] !== SYNC || probe[2 * TS_PACKET] !== SYNC) return 0;

    const input = Buffer.allocUnsafe(CHUNK), output = Buffer.allocUnsafe(CHUNK);
    let read = 0, written = 0, carry = 0, passthrough = false, rewriting = false;
    while (read < size) {
      signal?.throwIfAborted();
      const { bytesRead: count } = await handle.read(input, carry, CHUNK - carry, read);
      if (!count) break;
      read += count;
      const have = carry + count;
      const usable = passthrough ? have : have - (have % TS_PACKET);
      let kept = 0;
      if (passthrough) { input.copy(output, 0, 0, usable); kept = usable; }
      else {
        for (let i = 0; i < usable; i += TS_PACKET) {
          if (input[i] !== SYNC) { passthrough = true; input.copy(output, kept, i, usable); kept += usable - i; break; }
          if (isServiceInformation(((input[i + 1] & 0x1f) << 8) | input[i + 2])) continue;
          input.copy(output, kept, i, i + TS_PACKET); kept += TS_PACKET;
        }
      }
      // Until the first packet is dropped the file is already correct where it is; after that, kept data moves down
      // (always to an offset at or below what was read, so unread data is never overwritten).
      if (kept !== usable) rewriting = true;
      if (rewriting) await handle.write(output, 0, kept, written);
      written += kept;
      carry = have - usable;
      if (carry) input.copy(input, 0, usable, have);
    }
    if (rewriting) {
      if (carry) await handle.write(input, 0, carry, written); // a trailing partial packet is kept as it was
      written += carry;
      await handle.truncate(written);
      return size - written;
    }
    return 0;
  } finally {
    await handle.close();
  }
}
