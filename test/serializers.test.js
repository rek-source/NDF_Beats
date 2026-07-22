// test/serializers.test.js  (OWNER: backend)
// shapeSale is the /api response shape for a sale. It was written twice —
// `shapeSale` in sales.routes.js and an identical `shapeManualSale` in
// knocks.routes.js (the manual walk-in-sale path) — so a field could drift
// between the two sale entry points. Extracted to src/routes/serializers.js and
// pinned here: money is exposed as both integer cents and derived dollars.

import test from 'node:test';
import assert from 'node:assert/strict';
const { shapeSale } = await import('../src/routes/serializers.js');

test('shapeSale exposes the public sale fields + derived dollars', () => {
  const row = {
    id: 'sale_1', package: 'preferred', amount_cents: 30000,
    agreement_url: '/gbb/ndf/agreements/home-care-membership.html?pkg=preferred',
    sold_at: '2026-07-22T10:00:00.000Z',
    // internal columns that must NOT leak into the response:
    knock_id: 'knock_1', rep_id: 'rep_1', target_id: 'tgt_1', client_uuid: 'x',
  };
  assert.deepEqual(shapeSale(row), {
    id: 'sale_1',
    package: 'preferred',
    amount_usd: 300,
    amount_cents: 30000,
    agreement_url: '/gbb/ndf/agreements/home-care-membership.html?pkg=preferred',
    sold_at: '2026-07-22T10:00:00.000Z',
  });
});

test('amount_usd is integer-cents / 100', () => {
  assert.equal(shapeSale({ amount_cents: 15000 }).amount_usd, 150);
  assert.equal(shapeSale({ amount_cents: 69000 }).amount_usd, 690);
});
