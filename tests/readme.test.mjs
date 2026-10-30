import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('every local image and link in the README points at a file that exists', () => {
  const targets = new Set();
  for (const [, target] of readme.matchAll(/(?:src|href)="([^"]+)"/g)) targets.add(target);
  for (const [, target] of readme.matchAll(/\]\(([^)\s]+)\)/g)) targets.add(target);
  const local = [...targets].filter(t => !/^(https?:|mailto:|#)/.test(t)).map(t => t.split('#')[0]);
  assert.ok(local.length > 15, 'the README links to its images and docs');
  for (const target of local) assert.ok(fs.existsSync(path.join(root, target)), `README points at missing ${target}`);
});

test('README anchors match real headings (GitHub drops emoji and leaves a leading hyphen)', () => {
  const slug = heading => heading.toLowerCase().replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-');
  const headings = new Set([...readme.matchAll(/^## (.+)$/gm)].map(m => slug(m[1])));
  for (const [, anchor] of readme.matchAll(/href="#([^"]+)"/g)) assert.ok(headings.has(anchor), `no heading for #${anchor}`);
});

test('the README GIFs are real, animated, looping and light enough for a repository page', () => {
  for (const file of ['docs/media/demo.gif', 'docs/media/how-it-works.gif']) {
    const data = fs.readFileSync(path.join(root, file));
    assert.equal(data.subarray(0, 6).toString('ascii'), 'GIF89a', file);
    assert.ok(data.includes(Buffer.from('NETSCAPE2.0')), `${file} loops`);
    assert.ok(data.length < 3 * 1024 * 1024, `${file} is ${(data.length / 1048576).toFixed(1)} MB`);
    const frames = [...data.toString('latin1').matchAll(/\x00\x21\xf9\x04/g)].length;
    assert.ok(frames > 20, `${file} has ${frames} frames`);
  }
});

test('the README states the facts it must: license, platforms and the DRM position', () => {
  assert.match(readme, /Apache License 2\.0/);
  assert.match(readme, /Windows, macOS and Linux/);
  assert.match(readme, /does not and will not bypass DRM/);
  assert.ok(!/black-and-white/i.test(readme), 'the interface is a classic light window, not black and white');
});
