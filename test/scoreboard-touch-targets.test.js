// test/scoreboard-touch-targets.test.js  (OWNER: frontend)
// Guard: the scoreboard's view tabs, period toggles and refresh are tapped on an
// iPad (and a wall display), but sat at 40px / 32×32px — below the 64px floor the
// rep app (app.css) already honors for field-facing touch surfaces. Scans
// scoreboard.css the same way admin-touch-targets.test.js scans admin.css.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'styles', 'scoreboard.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(css, selector) {
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

// Tappable header controls that must clear the 64px iPad floor.
for (const sel of ['.sb-tab', '.sb-period']) {
  test(`${sel} meets the 64px iPad touch floor`, () => {
    const body = ruleBody(CSS, sel);
    assert.ok(body, `no rule found for ${sel}`);
    const mh = pxValue(decl(body, 'min-height'));
    assert.ok(mh >= 64, `${sel} min-height is ${mh}px, need >=64px`);
  });
}

test('.sb-live__refresh is a >=64px square hit area', () => {
  const body = ruleBody(CSS, '.sb-live__refresh');
  assert.ok(body, 'no rule for .sb-live__refresh');
  const mh = pxValue(decl(body, 'min-height'));
  const mw = pxValue(decl(body, 'min-width'));
  assert.ok(mh >= 64, `min-height ${mh}px, need >=64px`);
  assert.ok(mw >= 64, `min-width ${mw}px, need >=64px`);
});
