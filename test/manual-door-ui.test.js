// test/manual-door-ui.test.js  (OWNER: frontend)
// Wiring guard for the field app's "＋ Log a door" manual/walk-in entry
// (onboarding 2026-07-20). File-scan in the style of admin-lifecycle-ui.test.js:
// the markup ids and the app.js POST/geolocation wiring must exist.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const JS = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');

test('index.html has the Log-a-door button and manual sheet markup', () => {
  assert.match(HTML, /id="logDoorBtn"/, 'log-a-door toolbar button exists');
  assert.match(HTML, /id="manualSheet"/, 'manual entry sheet exists');
  assert.match(HTML, /id="manualAddr"/, 'manual address input exists');
  assert.match(HTML, /id="manualGeo"/, 'use-my-location button exists');
});

test('app.js posts manual doors to /knocks/manual and uses geolocation', () => {
  assert.ok(JS.includes("'/knocks/manual'"), 'app.js enqueues to /knocks/manual');
  assert.match(JS, /navigator\.geolocation/, 'app.js captures the device location');
});
