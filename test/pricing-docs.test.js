// Guards doc/schema pricing against the canonical catalog in src/config.js.
// The stale $99/$249/$499 (9900/24900/49900) numbers predate the monthly-led
// $150/$300/$690 pricing and were left in README/SPEC/schema comments. This
// test fails if any of them creep back, and asserts the true amounts appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { PACKAGE_CATALOG, ROOT_DIR } = await import('../src/config.js');

const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8');
const DOCS = ['README.md', 'SPEC.md', 'src/db/schema.sql'];

// Dollar amounts the docs must never claim again (old annual prices + cents).
const STALE = ['$99', '$249', '$499', '9900', '24900', '49900'];
// Canonical dollar amounts derived from the frozen catalog.
const LIVE_DOLLARS = Object.values(PACKAGE_CATALOG).map((p) => `$${p.amount_cents / 100}`);

test('docs contain no stale package pricing', () => {
  for (const rel of DOCS) {
    const body = read(rel);
    for (const bad of STALE) {
      assert.ok(!body.includes(bad), `${rel} still references stale pricing "${bad}"`);
    }
  }
});

test('README and SPEC show the canonical dollar amounts', () => {
  for (const rel of ['README.md', 'SPEC.md']) {
    const body = read(rel);
    for (const good of LIVE_DOLLARS) {
      assert.ok(body.includes(good), `${rel} is missing canonical price ${good}`);
    }
  }
});
