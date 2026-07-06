// test/admin-responsive.test.js  (OWNER: frontend)
// Guard: on a narrow/portrait screen the beats table must reflow to stacked
// cards (each row a card, per-cell labels from data-label) instead of a
// horizontal-scroll table — the assign <select> is the most-used control and a
// standing, one-handed manager must not have to scroll sideways to reach it.
// The headless test browser viewport is fixed at 780px so the <=768px layout
// can't be screenshotted; this scan is the regression guard for those rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'styles', 'admin.css'),
  'utf8',
);
const JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');

/** Extract the body of the first @media (max-width: <=Npx) block that mentions sel. */
function mediaBlock(css, maxWidthAtMost, mustContain) {
  const re = /@media[^{]*?max-width:\s*(\d+)px[^{]*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(css))) {
    const width = parseInt(m[1], 10);
    if (width <= maxWidthAtMost && m[2].includes(mustContain)) return m[2];
  }
  return null;
}

test('renderBeats emits data-label attributes for the card reflow', () => {
  assert.match(JS, /data-label="Beat"/);
  assert.match(JS, /data-label="City"/);
  assert.match(JS, /data-label="Assigned Rep"/);
});

test('a <=768px media block reflows the beats table to stacked cards', () => {
  const body = mediaBlock(CSS, 768, '.ad-table');
  assert.ok(body, 'expected an @media (max-width<=768px) block targeting .ad-table');
  assert.match(body, /\.ad-table thead\s*\{[^}]*display:\s*none/, 'thead should be hidden in card mode');
  assert.match(body, /td::before/, 'cells need ::before labels from data-label');
  assert.match(body, /attr\(data-label\)/, '::before must pull the data-label');
  assert.match(body, /\.ad-assign\s*\{[^}]*width:\s*100%/, 'assign select should go full-width (no h-scroll)');
});
