// test/training-touch-targets.test.js  (OWNER: frontend)
// Guard: the certification quiz is taken on an iPad — its answer rows and action
// buttons are the interactive controls. The answer `.choice` rows (~39px) and
// `.btn` buttons (~45px) sat below the 64px floor the rep app / scoreboard honor.
// Scans training.css the same way admin-/scoreboard-touch-targets do.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs
  .readFileSync(path.join(__dirname, '..', 'public', 'styles', 'training.css'), 'utf8')
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

for (const sel of ['.btn', '.quiz-q .choice']) {
  test(`${sel} meets the 64px iPad touch floor`, () => {
    const body = ruleBody(CSS, sel);
    assert.ok(body, `no rule found for ${sel}`);
    const mh = pxValue(decl(body, 'min-height'));
    assert.ok(mh >= 64, `${sel} min-height is ${mh}px, need >=64px`);
  });
}
