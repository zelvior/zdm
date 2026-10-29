const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { browserLaunchers } = require('./platform.cjs');

const start = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', reject);
  child.once('spawn', () => { child.unref(); resolve(); });
});

// Opens the browser's Extensions page. Windows looks for the browser's exe; macOS uses `open -a`; Linux tries the usual command names.
async function openExtensions(browser, { platform = process.platform, env = process.env, launch = start } = {}) {
  const { pages, candidates } = browserLaunchers({ platform, env });
  const url = pages[browser];
  if (!url) throw new Error('Choose Chrome or Edge.');
  for (const candidate of candidates[browser] || []) {
    if (candidate.file) { try { await fs.access(candidate.command); } catch { continue; } }
    try { await launch(candidate.command, [...candidate.args, url]); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`${browser} was not found. Open ${url} in your browser manually.`);
}
module.exports = { openExtensions };
