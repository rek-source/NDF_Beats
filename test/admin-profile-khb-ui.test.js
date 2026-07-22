// test/admin-profile-khb-ui.test.js  (OWNER: frontend)
// Wiring guard for the ICP profile card surfacing the KHB proximity distance
// band (backlog #4). The card already renders the khb_proximity WEIGHT; this
// adds the RADIUS that defines "near a completed project" so a manager can read
// the tuning, not just the weight. File-scan in the admin-UI convention.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(__dirname, '..', 'public');
const JS = fs.readFileSync(path.join(pub, 'admin.js'), 'utf8');

test('admin.js reads the khb_proximity band from the profile payload', () => {
  assert.match(JS, /khb_proximity/, 'renderProfile consumes the khb_proximity band');
  assert.match(JS, /full_credit_m/, 'uses the full-credit radius');
  assert.match(JS, /falloff_m/, 'uses the falloff radius');
});

test('admin.js renders a proximity-band note element', () => {
  assert.match(JS, /ad-w__note/, 'a note element carries the band explanation');
});
