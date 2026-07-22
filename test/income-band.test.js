// test/income-band.test.js  (OWNER: backend)
// Unit coverage for incomeToBand — a scoring input (feeds signals.income_band).
// It was exported but never tested directly: the "neutral on bad input" guard
// and the top band (income above every decile threshold) were uncovered
// branches. This pins the decile mapping so a threshold edit can't silently
// shift a door's income score.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CENSUS_API_KEY = process.env.CENSUS_API_KEY || 'test-key';
const { incomeToBand } = await import('../src/adapters/census.js');

test('bad / missing income is neutral band 5', () => {
  for (const bad of [undefined, null, NaN, 0, -100, 'nope', Infinity]) {
    assert.equal(incomeToBand(bad), 5, `${String(bad)} -> 5`);
  }
});

test('decile thresholds map to bands 1..9 (upper-bound inclusive)', () => {
  const thresholds = [30000, 42000, 52000, 62000, 72000, 84000, 98000, 118000, 150000];
  thresholds.forEach((t, i) => {
    assert.equal(incomeToBand(t), i + 1, `${t} (upper bound) -> band ${i + 1}`);
    assert.equal(incomeToBand(t - 1), i + 1, `just under ${t} -> band ${i + 1}`);
  });
});

test('income above every threshold is the top band 10', () => {
  assert.equal(incomeToBand(150001), 10);
  assert.equal(incomeToBand(500000), 10);
});

test('a mid-band income lands in the expected decile', () => {
  // 90000 is between 84000 (band 6 upper) and 98000 (band 7 upper) -> band 7.
  assert.equal(incomeToBand(90000), 7);
});
