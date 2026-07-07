// test/handout-proof.test.js  (OWNER: frontend)
// Findings #3 + #8 — the handout must never fabricate proof, and its guarantee
// must state the SAME truth as the membership agreement. Real owner-supplied
// proof (phone, 5★ reviews, a real testimonial) is now wired in; the guards
// ensure it is real, never the example placeholders, and never contradicts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HANDOUT = path.join(__dirname, '..', 'public', 'handout.html');
const AGREEMENT = path.join(__dirname, '..', '..', '..', 'gbb-ndf-agreements', 'home-care-membership.html');
const html = fs.readFileSync(HANDOUT, 'utf8');

test('no fabricated proof: fake phone + example placeholder numbers are gone', () => {
  assert.ok(!html.includes('555-0100'), 'the fake (209) 555-0100 must not appear');
  assert.ok(!/4\.9 · 300\+/.test(html), 'the example rating/review count must not appear');
  assert.ok(!/1,400\+/.test(html), 'the example homeowner count must not appear');
});

test('OWNER proof config + structured slots present', () => {
  assert.match(html, /window\.NDF_PROOF\s*=/, 'proof config block present');
  for (const slot of ['phone', 'rating-line', 'served', 'quote', 'attribution', 'deadline']) {
    assert.ok(html.includes(`data-proof="${slot}"`), `slot ${slot} present`);
  }
  assert.ok(html.includes('id="photo-slot-1"') && html.includes('id="photo-slot-2"'), 'two real-photo slots');
});

test('real owner proof is wired in (real NDF phone + real 5-star rating)', () => {
  assert.match(html, /phone:\s*"\(209\) 764-2055"/, 'real NDF main line set');
  assert.match(html, /rating:\s*"5\.0"/, 'real 5.0 rating set');
  assert.match(html, /review_count:\s*"75\+ five-star reviews"/, 'real review count set');
});

test('guarantee states the ONE truth: full refund in 3 business days, then NO refunds', () => {
  assert.match(html, /3 business days/);
  assert.match(html, /full refund/);
  assert.match(html, /no refunds/i);
  assert.ok(!/pro-rata/.test(html), 'the pro-rata refund promise is gone');
  assert.ok(!/no questions asked/i.test(html), 'the over-promise is gone');
});

test('handout guarantee matches the membership agreement on the key clause',
  { skip: !fs.existsSync(AGREEMENT) }, () => {
    const agreement = fs.readFileSync(AGREEMENT, 'utf8');
    const clause = 'there are no refunds';
    const strip = (s) => s.replace(/<[^>]+>/g, '');
    assert.ok(strip(html).includes(clause), 'handout carries the clause');
    assert.ok(strip(agreement).includes(clause), 'agreement carries the clause');
    assert.ok(!/\$150 administrative fee/.test(agreement), 'membership agreement has no $150 fee');
  });
