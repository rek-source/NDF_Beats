// test/admin-create-beat-ui.test.js  (OWNER: frontend)
// Wiring guard for the manager "Create a Beat" card (onboarding 2026-07-20).
// File-scan in the style of admin-lifecycle-ui.test.js: the markup ids and the
// admin.js POST wiring must exist so the feature can't be silently removed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const HTML = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
const JS = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');

test('admin.html has the Create-a-Beat card markup', () => {
  assert.match(HTML, /id="beat-form"/, 'beat form exists');
  assert.match(HTML, /id="beat-name"/, 'beat name input exists');
  assert.match(HTML, /id="beat-city"/, 'beat city input exists');
  assert.match(HTML, /id="beat-county"/, 'beat county select exists');
  assert.match(HTML, /id="beat-rep"/, 'beat rep select exists');
  assert.match(HTML, /id="beat-submit"/, 'beat submit button exists');
  // The county select offers exactly the 3 allowed counties.
  for (const county of ['Stanislaus', 'San Joaquin', 'Merced']) {
    assert.match(HTML, new RegExp(`<option value="${county}"`), `county option ${county}`);
  }
});

test('admin.js POSTs the new beat to /admin/beats', () => {
  // The literal '/admin/beats' (closing quote, no trailing slash) is the create
  // endpoint — the assign endpoint is '/admin/beats/' + id and doesn't match.
  assert.ok(JS.includes("'/admin/beats'"), 'admin.js POSTs to /admin/beats');
  assert.match(JS, /beat-form|beatForm/, 'admin.js wires the beat form');
});
