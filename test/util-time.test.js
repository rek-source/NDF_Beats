// test/util-time.test.js  (OWNER: backend)
// normalizeTimestamp was copy-pasted identically in sales.routes.js and
// knocks.routes.js. Extracted to src/util/time.js and tested here: a valid
// client ISO string is honored (normalized to UTC ISO); anything unusable
// (bad string, non-string, empty) falls back to server time so a knock/sale
// always records a real timestamp.

import test from 'node:test';
import assert from 'node:assert/strict';
const { normalizeTimestamp } = await import('../src/util/time.js');

const isIso = (s) => typeof s === 'string' && !Number.isNaN(new Date(s).getTime())
  && new Date(s).toISOString() === s;

test('a valid client ISO string is normalized to UTC ISO', () => {
  assert.equal(normalizeTimestamp('2026-07-22T10:00:00Z'), '2026-07-22T10:00:00.000Z');
  // date-only is a valid Date -> normalized to midnight UTC ISO
  assert.equal(normalizeTimestamp('2026-07-22'), '2026-07-22T00:00:00.000Z');
});

test('an unusable input falls back to a valid server-time ISO', () => {
  for (const bad of ['not-a-date', '', null, undefined, 0, 1737540000000, {}]) {
    const out = normalizeTimestamp(bad);
    assert.ok(isIso(out), `${JSON.stringify(bad)} -> valid ISO fallback, got ${out}`);
  }
});
