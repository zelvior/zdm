'use strict';
// Electron's launch-at-login setting only works on Windows and macOS. On Linux the equivalent is a .desktop file in the
// XDG autostart folder.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Desktop Entry Exec values are double-quoted; these characters must be escaped inside the quotes.
const quoteExec = value => `"${String(value).replace(/(["`$\\])/g, '\\$1').replaceAll('%', '%%')}"`;
function autostartEntry({ executable }) {
  return ['[Desktop Entry]', 'Type=Application', 'Name=ZDM', 'Comment=Download manager', `Exec=${quoteExec(executable)}`, 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}
const autostartFile = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), 'autostart', 'zdm.desktop');
async function setAutostart(enabled, { executable, env, home } = {}) {
  const file = autostartFile({ env, home });
  if (!enabled) { await fs.rm(file, { force: true }); return false; }
  if (!executable || !path.isAbsolute(executable)) throw new Error('Cannot enable autostart without the application path.');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, autostartEntry({ executable }), 'utf8');
  return true;
}
module.exports = { autostartEntry, autostartFile, setAutostart, quoteExec };
