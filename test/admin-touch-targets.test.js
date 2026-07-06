// test/admin-touch-targets.test.js  (OWNER: frontend)
// Guard: the manager portal is used standing/one-handed on an iPad. Every
// interactive control must meet the 44px touch floor (Apple HIG / WCAG 2.5.8),
// and text inputs/selects must use a >=16px font so iOS Safari doesn't zoom on
// focus. This scans admin.css the same way static-paths.test.js scans HTML — a
// cheap regression guard; the behavioral check is the in-browser re-verify.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'styles', 'admin.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments so they don't pollute selectors

/** Body of the first rule whose selector list exactly contains `selector`. */
function ruleBody(css, selector) {
  // Match "<selectors> { <body> }" where one comma-separated selector === target.
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.includes(selector)) return m[2];
  }
  return null;
}

function decl(body, prop) {
  if (body == null) return null;
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+)`, 'i').exec(body);
  return m ? m[1].trim() : null;
}

function pxValue(v) {
  if (v == null) return NaN;
  const m = /(-?\d+(?:\.\d+)?)px/.exec(v);
  return m ? parseFloat(m[1]) : NaN;
}

// Controls that MUST clear the 44px touch floor.
const TOUCH_44 = [
  '.ad-assign',        // beat-assign dropdown — the most-used control
  '.ad-refresh',       // header refresh button
  '.ad-input',         // add-rep name/email/role
  '.ad-header__nav a', // Scoreboard / Rep App nav links
];

for (const sel of TOUCH_44) {
  test(`${sel} meets the 44px touch floor`, () => {
    const body = ruleBody(CSS, sel);
    assert.ok(body, `no rule found for ${sel}`);
    const mh = pxValue(decl(body, 'min-height'));
    assert.ok(mh >= 44, `${sel} min-height is ${mh}px, need >=44px`);
  });
}

// Text inputs / selects need a >=16px font to stop iOS zoom-on-focus.
for (const sel of ['.ad-assign', '.ad-input']) {
  test(`${sel} uses a >=16px font (no iOS zoom-on-focus)`, () => {
    const body = ruleBody(CSS, sel);
    assert.ok(body, `no rule found for ${sel}`);
    const fs16 = pxValue(decl(body, 'font-size'));
    assert.ok(fs16 >= 16, `${sel} font-size is ${fs16}px, need >=16px`);
  });
}

test('nav links are flex-centered so min-height produces a real hit area', () => {
  const body = ruleBody(CSS, '.ad-header__nav a');
  assert.ok(body);
  assert.match(decl(body, 'display') || '', /flex/, 'nav links need display:*flex to apply min-height');
});
