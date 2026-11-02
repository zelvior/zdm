import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('renderer/index.html'), js = read('renderer/app.js'), css = read('renderer/styles.css');

test('every element the interface script looks up exists in the markup (or is created by the script)', () => {
  const used = new Set([...js.matchAll(/\$\(\s*['"`]#([A-Za-z][\w-]*)/g)].map(m => m[1]));
  const have = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  for (const m of js.matchAll(/\.id\s*=\s*['"]([\w-]+)['"]/g)) have.add(m[1]);
  // ids built at run time from a prefix, for example `tab-${name}`
  const dynamic = [...js.matchAll(/`([a-z]+-)\$\{/g)].map(m => m[1]);
  const missing = [...used].filter(id => !have.has(id) && !dynamic.includes(id) && !dynamic.some(prefix => id === prefix));
  assert.deepEqual(missing.filter(id => !/-$/.test(id)), []);
});

test('every icon named in the markup is drawn by the script', () => {
  const block = js.slice(js.indexOf('const iconPaths = {'), js.indexOf('const SVG_NS'));
  const defined = new Set([...block.matchAll(/\b([a-z]+):\[/g)].map(m => m[1]));
  const named = new Set([...html.matchAll(/data-icon="([^"]+)"/g)].map(m => m[1]));
  for (const [, name] of js.matchAll(/svgIcon\('([a-z]+)'\)/g)) named.add(name);                                                   // icons named directly
  for (const [, name] of js.matchAll(/\b(?:Video|Audio|Images|Documents|Archives|Programs|Other):'([a-z]+)'/g)) named.add(name);   // the file type icons
  const undefinedIcons = [...named].filter(name => !defined.has(name));
  assert.deepEqual(undefinedIcons, []);
});

test('the content security policy is respected: no inline styles in the markup or the script', () => {
  assert.ok(!/\sstyle="/.test(html), 'index.html has an inline style attribute');
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(js), 'app.js sets a style attribute');
  assert.ok(!/<style[\s>]/.test(html), 'index.html has a <style> block');
});

test('the interface does not borrow another download manager\'s layout or wording', () => {
  const text = html + js;
  for (const phrase of ['Grabber', 'Download File Info', 'Start Queue', 'Stop Queue', 'Speed Limiter', 'Options on completion', 'Download status', 'Delete Completed', 'Transfer rate', 'Categories', 'Receiving data']) {
    assert.ok(!text.includes(phrase), `found "${phrase}"`);
  }
  assert.ok(!/<table[^>]*id="downloads"/.test(html), 'the downloads are cards, not a spreadsheet');
  assert.ok(/class="sidebar"/.test(html) && /id="selection-bar"/.test(html) && /id="new-download"/.test(html));
});

test('the classes the script builds are styled', () => {
  for (const cls of ['download-row', 'row-icon', 'row-name', 'row-meta', 'bar', 'pill', 'badge', 'segment-map', 'connections-table', 'browser-list', 'selection-bar', 'nav-item', 'empty-state', 'notification']) {
    assert.ok(new RegExp(`\\.${cls}[\\s,{.:\\[>]`).test(css), `styles.css has no rule for .${cls}`);
  }
  assert.ok(/prefers-color-scheme:\s*dark/.test(css), 'dark theme');
  assert.ok(/prefers-reduced-motion/.test(css), 'reduced motion is respected');
});

test('selection is decided on pointer-up, because the list captures the pointer and Chromium then sends clicks to the list', () => {
  assert.ok(/function tapRow\(/.test(js));
  assert.ok(!/row\.addEventListener\('click'/.test(js), 'a row click listener would never fire while the list holds the pointer');
  assert.ok(/setPointerCapture/.test(js) && /tapRow\(row\.dataset\.id/.test(js));
});
