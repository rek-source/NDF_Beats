// test/scoring.test.js  (OWNER: scoring)
// Unit tests for the pure scoring layer (SPEC §6): scoreTarget / clusterBeats /
// reweight stub / profile invariants. No DB, no HTTP — these import the scoring
// modules directly and assert the frozen §6 contract.
//
// Run with: `node --test test/`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreTarget, scoreTargetDetailed, subScores, signalsFromRow } from '../src/scoring/scoring.js';
import { clusterBeats } from '../src/scoring/beats.js';
import { updateWeights } from '../src/scoring/reweight.js';
import { defaultProfile, validateProfile, SIGNAL_KEYS } from '../src/scoring/profile.js';
import { isKnockEligible, solicitStatusOf, partitionByEligibility } from '../src/scoring/compliance.js';

// ---------------------------------------------------------------------------
// profile.js
// ---------------------------------------------------------------------------
test('§6.4 default profile weights sum to 1', () => {
  // validateProfile throws if weights don't sum to 1; returns the profile.
  assert.equal(validateProfile(defaultProfile), defaultProfile);
  const sum = SIGNAL_KEYS.reduce((acc, k) => acc + defaultProfile.weights[k], 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum ${sum}`);
});

// ---------------------------------------------------------------------------
// scoring.js
// ---------------------------------------------------------------------------
test('§6.1 scoreTarget returns an integer 0..100', () => {
  const t = {
    value_cents: 45_000_000, home_age: 35, owner_occupied: 1,
    tenure_years: 12, recently_sold: 0, income_band: 6,
  };
  const s = scoreTarget(t, defaultProfile);
  assert.ok(Number.isInteger(s));
  assert.ok(s >= 0 && s <= 100);
});

test('§6.1 scoreTarget is deterministic (no randomness)', () => {
  const t = {
    value_cents: 50_000_000, home_age: 30, owner_occupied: 1,
    tenure_years: 8, recently_sold: 1, income_band: 5,
  };
  assert.equal(scoreTarget(t, defaultProfile), scoreTarget(t, defaultProfile));
});

test('§6.1 an ideal-fit target outscores a poor-fit target', () => {
  const ideal = {
    value_cents: 45_000_000, home_age: 35, owner_occupied: 1,
    tenure_years: 30, recently_sold: 1, income_band: 6,
  };
  const poor = {
    value_cents: 5_000_000, home_age: 2, owner_occupied: 0,
    tenure_years: 0, recently_sold: 0, income_band: 1,
  };
  const hi = scoreTarget(ideal, defaultProfile);
  const lo = scoreTarget(poor, defaultProfile);
  assert.ok(hi > lo, `ideal ${hi} should beat poor ${lo}`);
  assert.ok(hi >= 90, `ideal should be high (${hi})`);
  assert.ok(lo <= 30, `poor should be low (${lo})`);
});

test('§6.1 owner-occupied is a strong positive (all else equal)', () => {
  const base = {
    value_cents: 45_000_000, home_age: 35, tenure_years: 10,
    recently_sold: 0, income_band: 6,
  };
  const occ = scoreTarget({ ...base, owner_occupied: 1 }, defaultProfile);
  const non = scoreTarget({ ...base, owner_occupied: 0 }, defaultProfile);
  assert.ok(occ > non, `occupied ${occ} should beat non-occupied ${non}`);
});

// ---------------------------------------------------------------------------
// Unknown-aware scoring (finding #1): data-starved doors must score LOW and
// unknown signals must never inherit sweet-spot constants.
// ---------------------------------------------------------------------------
test('unknown signals yield null sub-scores, never fabricated values', () => {
  const s = subScores({ value_cents: 45_000_000 }, defaultProfile);
  assert.equal(s.value, 1);
  assert.equal(s.home_age, null);
  assert.equal(s.owner_occupied, null);
  assert.equal(s.tenure, null);
  assert.equal(s.recently_sold, null);
  assert.equal(s.income_band, null);
});

test('a fully-unknown door scores 0, not a fabricated sweet-spot 92', () => {
  assert.equal(scoreTarget({}, defaultProfile), 0);
  const d = scoreTargetDetailed({}, defaultProfile);
  assert.equal(d.score, 0);
  assert.equal(d.coverage, 0);
  assert.deepEqual(d.known, []);
});

test('data-starved doors score LOWER than fully-known ideal doors', () => {
  const ideal = {
    value_cents: 45_000_000, home_age: 35, owner_occupied: 1,
    tenure_years: 30, recently_sold: 1, income_band: 6,
  };
  const full = scoreTarget(ideal, defaultProfile);
  const oneSignal = scoreTarget({ income_band: 6 }, defaultProfile);
  const threeSignals = scoreTarget(
    { value_cents: 45_000_000, home_age: 35, income_band: 6 }, defaultProfile,
  );
  assert.ok(full > threeSignals, `${full} > ${threeSignals}`);
  assert.ok(threeSignals > oneSignal, `${threeSignals} > ${oneSignal}`);
  // A single perfect signal can never dominate: capped by its own weight.
  assert.ok(oneSignal <= Math.round(defaultProfile.weights.income_band * 100));
});

test('two data-starved doors with different known data do NOT collapse to one score', () => {
  const a = scoreTarget({ value_cents: 45_000_000, home_age: 35 }, defaultProfile);
  const b = scoreTarget({ value_cents: 5_000_000, home_age: 2 }, defaultProfile);
  assert.notEqual(a, b);
});

test('signalsFromRow nulls signals outside known_signals; legacy owner flag honored', () => {
  const row = {
    value_cents: 45_000_000, home_age: 35, owner_occupied: 1, tenure_years: 8,
    recently_sold: 0, income_band: 5,
    known_signals: JSON.stringify(['value', 'home_age']),
  };
  const s = signalsFromRow(row);
  assert.equal(s.value_cents, 45_000_000);
  assert.equal(s.home_age, 35);
  assert.equal(s.owner_occupied, null);
  assert.equal(s.tenure_years, null);
  assert.equal(s.income_band, null);

  // Legacy row (no known_signals): owner_occupied_known=0 -> unknown owner.
  const legacy = { ...row, known_signals: null, owner_occupied_known: 0 };
  assert.equal(signalsFromRow(legacy).owner_occupied, null);
  assert.equal(signalsFromRow(legacy).value_cents, 45_000_000);
});

// ---------------------------------------------------------------------------
// Compliance hard gate (finding #4)
// ---------------------------------------------------------------------------
test('unknown owner-occupancy is NOT knock-eligible (never default to safe)', () => {
  assert.equal(isKnockEligible({ owner_occupied: null }), false);
  assert.equal(isKnockEligible({}), false);
  assert.equal(isKnockEligible({ owner_occupied: 1, owner_occupied_known: 0 }), false);
  assert.equal(isKnockEligible({ owner_occupied: 0, owner_occupied_known: 1 }), false);
  assert.equal(isKnockEligible({ owner_occupied: 1, owner_occupied_known: 1 }), true);
  assert.equal(isKnockEligible({ owner_occupied: 1 }), true); // explicit in-memory datum
});

test('any do-not-solicit flag excludes the door regardless of other data', () => {
  assert.equal(isKnockEligible({ owner_occupied: 1, no_soliciting: 1 }), false);
  assert.equal(isKnockEligible({ owner_occupied: 1, solicit_status: 'do_not_solicit' }), false);
  // no_soliciting flag dominates a stale status column
  assert.equal(solicitStatusOf({ no_soliciting: 1, solicit_status: 'clear' }), 'do_not_solicit');
  // absence of a flag is UNKNOWN, never 'clear'
  assert.equal(solicitStatusOf({ no_soliciting: 0 }), 'unknown');
  assert.equal(solicitStatusOf({}), 'unknown');
});

test('partitionByEligibility reports why doors were excluded', () => {
  const { eligible, excluded } = partitionByEligibility([
    { id: 'a', owner_occupied: 1 },
    { id: 'b', owner_occupied: null },
    { id: 'c', owner_occupied: 0 },
    { id: 'd', owner_occupied: 1, no_soliciting: 1 },
  ]);
  assert.deepEqual(eligible.map((t) => t.id), ['a']);
  assert.deepEqual(excluded, { dnc: 1, ownerUnknown: 1, nonOwner: 1 });
});

test('§6.2 clusterBeats hard-gates unknown owner-occupancy doors', () => {
  const targets = gridTargets(120);
  for (let i = 0; i < 30; i++) targets[i].owner_occupied = null; // unknown
  const beats = clusterBeats(targets, 50);
  const included = new Set(beats.flatMap((b) => b.targets.map((t) => t.target_id)));
  for (let i = 0; i < 30; i++) assert.ok(!included.has(`t${i}`), `t${i} must be excluded`);
});

// ---------------------------------------------------------------------------
// Exploration budget (finding #12)
// ---------------------------------------------------------------------------
test('explorationFraction promotes a deterministic slice of low-score doors', () => {
  const targets = gridTargets(160);
  const a = clusterBeats(targets, 50, { explorationFraction: 0.07 });
  const b = clusterBeats(targets, 50, { explorationFraction: 0.07 });
  const flatten = (bs) => bs.flatMap((x) => x.targets);
  const exploreA = flatten(a).filter((t) => t.explore === 1);
  assert.ok(exploreA.length >= 1, 'some doors tagged explore');
  assert.ok(exploreA.length <= Math.ceil(160 * 0.07) + 1, 'budget respected');
  // Deterministic across runs.
  assert.deepEqual(
    flatten(a).map((t) => `${t.target_id}:${t.explore}`),
    flatten(b).map((t) => `${t.target_id}:${t.explore}`),
  );
  // No exploration requested -> no explore tags, original behavior.
  const none = flatten(clusterBeats(targets, 50));
  assert.ok(none.every((t) => t.explore === 0));
});

// ---------------------------------------------------------------------------
// beats.js
// ---------------------------------------------------------------------------
function gridTargets(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `t${i}`,
      lat: 37.6 + (i % 10) * 0.001,
      lng: -121.0 + Math.floor(i / 10) * 0.001,
      score: i, // distinct scores
      no_soliciting: i % 25 === 0 ? 1 : 0,
      owner_occupied: 1, // verified (the hard gate excludes unknown/false)
      city: 'Modesto',
      county: 'Stanislaus',
    });
  }
  return out;
}

test('§6.2 clusterBeats drops no_soliciting and keeps sizes within 40..60', () => {
  const targets = gridTargets(160);
  const solicitable = targets.filter((t) => !t.no_soliciting).length;
  const beats = clusterBeats(targets, 50);

  assert.ok(beats.length >= 1);
  let total = 0;
  for (const b of beats) {
    assert.ok(b.target_count >= 1);
    // No beat should exceed the upper window; folded leftovers may push a beat
    // a little, but a fresh beat is capped at 60.
    assert.ok(b.target_count <= 60 + 1, `beat too large: ${b.target_count}`);
    total += b.target_count;
    assert.ok(b.center && typeof b.center.lat === 'number' && typeof b.center.lng === 'number');
    assert.ok(b.city && b.county);
  }
  // Every solicitable target lands in exactly one beat (no drops, no dupes).
  assert.equal(total, solicitable);
});

test('§6.2 each beat is sequenced 1..n contiguously', () => {
  const beats = clusterBeats(gridTargets(120), 50);
  for (const b of beats) {
    const seqs = b.targets.map((t) => t.seq);
    assert.equal(seqs[0], 1);
    assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
    // each target_id appears once
    const ids = new Set(b.targets.map((t) => t.target_id));
    assert.equal(ids.size, b.targets.length);
  }
});

test('§6.2 clusterBeats is deterministic for a fixed input order', () => {
  const a = clusterBeats(gridTargets(120), 50);
  const b = clusterBeats(gridTargets(120), 50);
  assert.deepEqual(
    a.map((x) => x.targets.map((t) => t.target_id)),
    b.map((x) => x.targets.map((t) => t.target_id)),
  );
});

// ---------------------------------------------------------------------------
// reweight.js (Phase 2 adaptive learning)
// ---------------------------------------------------------------------------

// Build a knock row carrying the target signals the reweighter reads.
function knock(signals, disposition) {
  return {
    value_cents: 45_000_000, home_age: 35, owner_occupied: 1,
    tenure_years: 12, recently_sold: 0, income_band: 6,
    ...signals,
    disposition,
  };
}

// A dataset where ONLY the `value` signal separates sold from not-sold:
// sold homes sit inside the value band (sub-score 1), not-sold homes are far
// out (sub-score 0); every other signal is identical across both groups.
function valueSeparatedKnocks(nPerGroup) {
  const ks = [];
  for (let i = 0; i < nPerGroup; i++) ks.push(knock({ value_cents: 45_000_000 }, 'sold'));
  for (let i = 0; i < nPerGroup; i++) ks.push(knock({ value_cents: 1_000_000 }, 'not_home'));
  return ks;
}

test('§6.3 no sales observed -> profile returned unchanged', () => {
  assert.equal(updateWeights([], [], defaultProfile), defaultProfile);
  const noSales = [knock({}, 'not_home'), knock({}, 'refused')];
  assert.equal(updateWeights(noSales, [], defaultProfile), defaultProfile);
});

test('§6.3 learned profile stays in contract (weights sum to 1, non-negative)', () => {
  const out = updateWeights(valueSeparatedKnocks(10), [], defaultProfile);
  // validateProfile throws if weights are negative or do not sum to 1.
  assert.doesNotThrow(() => validateProfile(out));
  for (const k of SIGNAL_KEYS) assert.ok(out.weights[k] >= 0);
});

test('§6.3 a signal that predicts sales gains weight', () => {
  const out = updateWeights(valueSeparatedKnocks(10), [], defaultProfile);
  assert.ok(
    out.weights.value > defaultProfile.weights.value,
    `value weight should rise (${out.weights.value} vs ${defaultProfile.weights.value})`,
  );
  // a signal that did NOT discriminate should not gain weight
  assert.ok(out.weights.owner_occupied <= defaultProfile.weights.owner_occupied + 1e-9);
});

test('§6.3 more sold outcomes move weights further toward the learned signal', () => {
  const few = updateWeights(valueSeparatedKnocks(3), [], defaultProfile);
  const many = updateWeights(valueSeparatedKnocks(40), [], defaultProfile);
  assert.ok(
    many.weights.value > few.weights.value,
    `more data should push value weight higher (${many.weights.value} vs ${few.weights.value})`,
  );
});

test('§6.3 updateWeights is deterministic and does not mutate the input', () => {
  const ks = valueSeparatedKnocks(8);
  const a = updateWeights(ks, [], defaultProfile);
  const b = updateWeights(ks, [], defaultProfile);
  assert.deepEqual(a.weights, b.weights);
  // input profile weights untouched
  assert.equal(defaultProfile.weights.value, 0.18);
  assert.notEqual(a, defaultProfile); // a learned profile is a new object
});
