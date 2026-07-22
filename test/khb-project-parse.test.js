// test/khb-project-parse.test.js  (OWNER: backend)
// Pure helpers for the KHB-project seed extraction (scripts/khb-projects/).
// BuilderTrend job names look like "Fiesta Ct-Masquelier-Full Home" — street,
// client surname, and project type in inconsistent order. streetCandidates()
// proposes which segments could be the street (suffixed segments first);
// pickAddress() majority-votes the full address from noisy corpus matches.

import test from 'node:test';
import assert from 'node:assert/strict';

const { streetCandidates, pickAddress } = await import('../scripts/khb-projects/parse.js');

test('streetCandidates: suffixed street segment ranks first, type words dropped', () => {
  assert.deepEqual(streetCandidates('Fiesta Ct-Masquelier-Full Home'), ['Fiesta Ct', 'Masquelier']);
  assert.deepEqual(streetCandidates('Macbeth-Moitra Cir-Addition'), ['Moitra Cir', 'Macbeth']);
  assert.deepEqual(streetCandidates('Mooneyham Ct - Custom Kitchen - Yepez'), ['Mooneyham Ct', 'Yepez']);
});

test('streetCandidates: strips project-type words inside a segment', () => {
  assert.deepEqual(streetCandidates('Regulus Full Home'), ['Regulus']);
  assert.deepEqual(streetCandidates('41st-Montez-Home Addition'), ['41st', 'Montez']);
});

test('streetCandidates: suffix-less segments all become candidates, none invented', () => {
  assert.deepEqual(streetCandidates('Madsen-Full Home-Laurelwood'), ['Madsen', 'Laurelwood']);
  assert.deepEqual(streetCandidates('ADU Barn Project'), []);
});

test('pickAddress: majority vote across noisy corpus matches, city+zip extracted', () => {
  const got = pickAddress([
    '410 Fiesta Court Tracy, CA',
    '410 Fiesta Court',
    '401 Fiesta Ct, Tracy Ca',
    '410 Fiesta Court Tracy',
  ]);
  assert.equal(got.address, '410 Fiesta Court');
  assert.equal(got.city, 'Tracy');
  assert.equal(got.votes, 3);
  assert.ok(got.alternatives.includes('401 Fiesta Ct'), 'loser recorded for human review');
});

test('pickAddress: zip captured when present, null city when never stated', () => {
  const got = pickAddress([
    '2540 Mooneyham Ct, Turlock, CA 95382',
    '2540 Mooneyham Ct',
  ]);
  assert.equal(got.address, '2540 Mooneyham Ct');
  assert.equal(got.city, 'Turlock');
  assert.equal(got.zip, '95382');

  const bare = pickAddress(['77 Nowhere Ln']);
  assert.equal(bare.city, null);
  assert.equal(bare.zip, null);
});

test('pickAddress: empty input -> null', () => {
  assert.equal(pickAddress([]), null);
});
