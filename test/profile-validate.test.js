// test/profile-validate.test.js  (OWNER: backend)
// validateProfile is the fail-loud guard on the ICP scoring weights — a bad
// profile must throw at startup / on approval rather than silently produce
// garbage scores. Existing tests only ever pass it VALID profiles, so all four
// rejection branches were uncovered. This pins each one.

import test from 'node:test';
import assert from 'node:assert/strict';
const { validateProfile, defaultProfile, SIGNAL_KEYS } = await import('../src/scoring/profile.js');

const validWeights = () => ({ ...defaultProfile.weights });

test('rejects a non-object profile', () => {
  for (const bad of [null, undefined, 42, 'nope']) {
    assert.throws(() => validateProfile(bad), /profile must be an object/);
  }
});

test('rejects a profile whose weights are missing / not an object', () => {
  assert.throws(() => validateProfile({}), /weights must be an object/);
  assert.throws(() => validateProfile({ weights: 'x' }), /weights must be an object/);
});

test('rejects a non-negative-number weight (NaN, negative, missing, non-number)', () => {
  const key = SIGNAL_KEYS[0];
  for (const badVal of [Number.NaN, -0.1, undefined, '0.2']) {
    const weights = validWeights();
    weights[key] = badVal;
    assert.throws(() => validateProfile({ weights }), new RegExp(`weights\\.${key} must be a non-negative number`));
  }
});

test('rejects weights that do not sum to 1', () => {
  const weights = validWeights();
  weights[SIGNAL_KEYS[0]] += 0.5; // valid numbers, but sum is now 1.5
  assert.throws(() => validateProfile({ weights }), /must sum to 1/);
});

test('returns the same profile object on success (chaining)', () => {
  assert.equal(validateProfile(defaultProfile), defaultProfile);
});
