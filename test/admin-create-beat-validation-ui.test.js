// test/admin-create-beat-validation-ui.test.js  (OWNER: frontend)
// Wiring guard for clearer Create-a-Beat validation (backlog #4 second half).
// The old code lumped name+city into one "Beat name and city are required."
// message with no field-level signal. Now each field is validated separately,
// the offending input is marked (aria-invalid + .is-invalid) and focused, and
// the mark clears on edit. File-scan in the admin-UI convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const JS = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');
const CSS = fs
  .readFileSync(path.join(pub, 'styles', 'admin.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('Create-a-Beat gives per-field validation messages', () => {
  assert.match(JS, /Beat name is required/i, 'distinct name-required message');
  assert.match(JS, /City is required/i, 'distinct city-required message');
});

test('the offending field is marked and cleared', () => {
  assert.match(JS, /aria-invalid/, 'marks the invalid field for a11y');
  assert.match(JS, /is-invalid/, 'toggles an error class on the field');
  // an input listener clears the mark as the manager corrects it
  assert.match(JS, /removeAttribute\(['"]aria-invalid['"]\)|aria-invalid['"],\s*['"]false/, 'clears aria-invalid on edit');
});

test('admin.css styles the invalid-field state', () => {
  assert.match(CSS, /\.ad-input\.is-invalid|\.is-invalid/, 'invalid field has an error style');
});
