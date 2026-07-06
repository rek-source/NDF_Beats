// test/handout-proof.test.js  (OWNER: frontend)
// Findings #3 + #8 — the handout must never fabricate proof, and its guarantee
// must state the SAME truth as the membership agreement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDOUT = path.join(__dirname, '..', 'public', 'handout.html');
const AGREEMENT = path.join(__dirname, '..', '..', '..', 'gbb-ndf-agreements', 'home-care-membership.html');
const html = fs.readFileSync(HANDOUT, 'utf8');

test('no fabricated proof: fake phone + invented review numbers are gone', () => {
  assert.ok(!html.includes('555-0100'), 'the fake (209) 555-0100 must not appear');
  assert.ok(!/4\.9 · 300\+/.test(html), 'invented rating/review counts must not appear');
});

test('OWNER proof config exists with empty (unfabricated) values', () => {
  assert.match(html, /window\.NDF_PROOF\s*=/, 'proof config block present');
  for (const key of ['phone', 'rating', 'review_count', 'homeowners_served', 'deadline']) {
    assert.match(html, new RegExp(`${key}:\\s*""`), `${key} ships EMPTY (owner fills it)`);
  }
  // Every proof surface is a structured slot.
  for (const slot of ['phone', 'rating-line', 'served', 'quote', 'attribution', 'deadline']) {
    assert.ok(html.includes(`data-proof="${slot}"`), `slot ${slot} present`);
  }
  assert.ok(html.includes('id="photo-slot-1"') && html.includes('id="photo-slot-2"'), 'two real-photo slots');
});

test('guarantee states the ONE truth (full refund in 3 business days, then pro-rata, no fee)', () => {
  assert.match(html, /3 business days/);
  assert.match(html, /full refund/);
  assert.match(html, /pro-rata/);
  assert.match(html, /no cancellation fee/);
  assert.ok(!/no questions asked/i.test(html), 'the over-promise is gone');
});

test('handout guarantee matches the membership agreement word-for-word on the key clause',
  { skip: !fs.existsSync(AGREEMENT) }, () => {
    const agreement = fs.readFileSync(AGREEMENT, 'utf8');
    const clause = 'unused portion of your term, pro-rata';
    // Both surfaces carry the identical clause (tag-stripped comparison).
    const strip = (s) => s.replace(/<[^>]+>/g, '');
    assert.ok(strip(html).includes(clause), 'handout carries the clause');
    assert.ok(strip(agreement).includes(clause), 'agreement carries the clause');
    assert.ok(!/\$150 administrative fee/.test(agreement), 'membership agreement has no $150 fee');
  });
