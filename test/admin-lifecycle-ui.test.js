// test/admin-lifecycle-ui.test.js  (OWNER: frontend)
// Regression guard for the rep-lifecycle + PIN-management UI wiring (the
// behaviour is verified in-browser; this locks the wiring against accidental
// removal). File-scan in the style of static-paths.test.js.

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

test('admin.js wires edit (PATCH), deactivate, and unlock actions', () => {
  assert.match(JS, /'PATCH'/, 'rep edit/toggle must PATCH the rep');
  assert.match(JS, /\/unlock/, 'unlock must POST to the /unlock endpoint');
  assert.match(JS, /ad-rep__edit/);
  assert.match(JS, /ad-rep__toggle/);
  assert.match(JS, /ad-pin__unlock/);
});

test('deactivate is guarded by a confirm prompt', () => {
  assert.match(JS, /window\.confirm\(/, 'deactivating a rep must confirm first');
});

test('PIN editor requires a confirmation entry and masks input', () => {
  assert.match(JS, /ad-pin__confirm/, 'a confirm PIN field must exist');
  assert.match(JS, /don.?.?t match|PINs.*match/i, 'mismatched PINs must be rejected client-side');
  assert.match(CSS, /\.ad-pin__input--mask\s*\{[^}]*-webkit-text-security:\s*disc/, 'PIN entry must be masked');
});

test('row action buttons keep the 44px touch floor', () => {
  // the shared rule covers .ad-pin__unlock, .ad-rep__edit, .ad-rep__toggle
  assert.match(
    CSS,
    /\.ad-pin__unlock,\s*\.ad-rep__edit,\s*\.ad-rep__toggle\s*\{[^}]*min-height:\s*44px/,
    'lifecycle action buttons must be >=44px',
  );
});
