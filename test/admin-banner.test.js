// test/admin-banner.test.js  (OWNER: frontend)
// Guard: the action banner ("Beat assignment updated." / errors) must stay
// visible to a manager who triggers an action while scrolled down the page.
// It is the first child of <main> (top of the document), so without sticky
// positioning it renders off-screen when the manager is at the beats table.
// CSS-scan guard (like static-paths.test.js); the timing/race fix is verified
// behaviourally in the browser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'styles', 'admin.css'), 'utf8')
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
  if (body == null) return null;
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m ? m[1].trim() : null;
}

test('.ad-banner is sticky-positioned so it stays in view when scrolled', () => {
  const body = ruleBody(CSS, '.ad-banner');
  assert.ok(body, 'no .ad-banner rule found');
  assert.match(decl(body, 'position') || '', /sticky/, '.ad-banner needs position:sticky');
  assert.equal(decl(body, 'top'), '0', '.ad-banner needs top:0 to pin to the viewport');
});
