// test/admin-beat-rename-ui.test.js  (OWNER: frontend)
// Wiring guard for the manager beat-rename control (backlog #3: auto-generated
// beat names like "Turlock · near El Capitan Dr N" are illegible, so a manager
// must be able to rename a beat in place). The backend endpoint + its tests
// already exist (test/admin-lifecycle.test.js); this locks the UI wiring so the
// control can't be silently dropped. File-scan in the style of
// test/admin-lifecycle-ui.test.js.

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

test('admin.js renders a rename control on each beat row', () => {
  assert.match(JS, /ad-beat__rename/, 'a rename button class must exist on beat rows');
  // The rename control must carry the beat id so the handler knows the target.
  assert.match(JS, /ad-beat__rename[\s\S]{0,120}data-beat-id/, 'rename button carries data-beat-id');
});

test('admin.js opens an inline beat-name editor and POSTs the rename', () => {
  assert.match(JS, /ad-beat__edit-form/, 'inline rename form markup exists');
  // POSTs to the existing rename endpoint (…/rename), not create/assign.
  assert.match(JS, /\/rename/, 'admin.js targets the /rename endpoint');
  assert.match(JS, /'POST'[\s\S]{0,200}\/rename|\/rename[\s\S]{0,80}'POST'/, 'rename is a POST');
});

test('admin.css styles the rename control', () => {
  assert.match(CSS, /\.ad-beat__rename/, 'rename button is styled');
});
