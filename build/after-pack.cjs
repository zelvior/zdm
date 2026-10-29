'use strict';
// macOS: Apple Silicon refuses to run an app that has no signature at all, and there is no Developer ID certificate in this
// project. An ad-hoc signature ("-") is enough to launch it; users still approve the first start in Gatekeeper.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = fs.readdirSync(context.appOutDir).find(name => name.endsWith('.app'));
  if (!app) throw new Error(`No .app bundle found in ${context.appOutDir}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(context.appOutDir, app)], { stdio: 'inherit' });
};
