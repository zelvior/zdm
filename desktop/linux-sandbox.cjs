'use strict';
// An AppImage lives on a nosuid mount, so Chromium cannot use its setuid sandbox there. Where the kernel also restricts
// unprivileged user namespaces (Ubuntu 23.10+ with AppArmor), the namespace sandbox fails too and the app would not start at all.
// Only in that exact situation is the process sandbox turned off; installed packages (.deb/.rpm) keep it.
const fs = require('node:fs');
function needsNoSandbox({ platform = process.platform, env = process.env, read = file => fs.readFileSync(file, 'utf8') } = {}) {
  if (platform !== 'linux' || !env.APPIMAGE) return false;
  const value = file => { try { return read(file).trim(); } catch { return null; } };
  return value('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' || value('/proc/sys/kernel/unprivileged_userns_clone') === '0';
}
module.exports = { needsNoSandbox };
