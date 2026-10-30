// Which official yt-dlp release file belongs to which ZDM build target, and what it is called once bundled.
// 'x64' and 'ia32' are kept for the Windows workflows that already use them.
const TARGETS = {
  'x64': { asset: 'yt-dlp.exe', windows: true },
  'win-x64': { asset: 'yt-dlp.exe', windows: true },
  'ia32': { asset: 'yt-dlp_x86.exe', windows: true },
  'win-ia32': { asset: 'yt-dlp_x86.exe', windows: true },
  // Universal (Intel + Apple Silicon), macOS 10.15 or newer. yt-dlp no longer publishes a build for older macOS (the standalone
  // "legacy" file was discontinued), so the legacy macOS app bundles this one too; on macOS 10.13 / 10.14 it cannot start and
  // page-video extraction is unavailable there, while direct downloads, HLS and DASH still work.
  'mac': { asset: 'yt-dlp_macos' },
  'linux-x64': { asset: 'yt-dlp_linux' },
  'linux-arm64': { asset: 'yt-dlp_linux_aarch64' },
  // There is no standalone 32-bit Linux binary: the portable zipapp is used, which needs Python 3 on the machine.
  'linux-ia32': { asset: 'yt-dlp', needsPython: true }
};
export const targetNames = () => Object.keys(TARGETS);
export function ytdlpTarget(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown yt-dlp target "${name}". Use one of: ${targetNames().join(', ')}.`);
  return { ...target, output: target.windows ? 'yt-dlp.exe' : 'yt-dlp' };
}
