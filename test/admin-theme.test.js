// test/admin-theme.test.js  (OWNER: frontend)
// Guard: the manager portal must expose the high-contrast "sunlight" theme. The
// `[data-theme="hc"]` AAA palette is already frozen in tokens.css and the rep app
// (app.js) already ships a toggle; the portal must offer the same affordance so a
// manager on an iPad in the sun can read it. Mirrors the rep-app pattern
// (ndfbeats.theme localStorage key, data-theme attribute on <html>).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
const JS = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');
const CSS = fs
  .readFileSync(path.join(pub, 'styles', 'admin.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(css, selector) {
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
  }
  return null;
}
function decl(body, prop) {
  const m = body && new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m ? m[1].trim() : null;
}
const px = (v) => (v && /(-?\d+(?:\.\d+)?)px/.exec(v) ? parseFloat(/(-?\d+(?:\.\d+)?)px/.exec(v)[1]) : NaN);

test('admin.html exposes a theme toggle control in the header', () => {
  assert.match(HTML, /id="themeToggle"/, 'admin.html needs a #themeToggle button');
  assert.match(HTML, /class="theme-toggle"/, 'theme toggle should reuse the .theme-toggle class');
});

test('admin.js wires the toggle to data-theme + persists the choice (rep-app pattern)', () => {
  assert.match(JS, /ndfbeats\.theme/, 'should share the ndfbeats.theme localStorage key');
  assert.match(JS, /data-theme/, 'should set the data-theme attribute');
  assert.match(JS, /localStorage/, 'should persist the theme choice');
});

test('the theme toggle meets the 44px touch floor', () => {
  const body = ruleBody(CSS, '.theme-toggle');
  assert.ok(body, 'admin.css needs a .theme-toggle rule');
  assert.ok(px(decl(body, 'min-height')) >= 44, 'theme toggle must be >=44px tall');
});
