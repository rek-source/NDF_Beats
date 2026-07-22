// test/khb-proximity.test.js  (OWNER: scoring)
// Neighbor-proof scoring + relaxed gate (Ryan, 2026-07-21): with a $0 data
// budget, beats are seeded by completed KHB projects. Two changes:
//   1. New scoring signal `khb_proximity` — distance to the nearest completed
//      KHB project (m). Near = strong Care-Plan signal (social proof + income
//      clustering). Unknown distance stays unknown (renormalizing math).
//   2. Gate policy: DNC and KNOWN renters still excluded; UNKNOWN
//      owner-occupancy is now allowed when the door's Census tract
//      owner-occupancy rate is >= 0.6 — probabilistic, and surfaced honestly.

import test from 'node:test';
import assert from 'node:assert/strict';

const { defaultProfile, SIGNAL_KEYS, validateProfile } = await import('../src/scoring/profile.js');
const { scoreTargetDetailed, subScores } = await import('../src/scoring/scoring.js');
const { isKnockEligible, partitionByEligibility } = await import('../src/scoring/compliance.js');

// ── profile v2 ──────────────────────────────────────────────────────────────

test('profile v2: khb_proximity is a weighted signal, weights still sum to 1', () => {
  assert.ok(SIGNAL_KEYS.includes('khb_proximity'), 'signal key registered');
  assert.ok(defaultProfile.weights.khb_proximity >= 0.15, 'proximity carries real weight');
  validateProfile(defaultProfile); // throws unless weights sum to 1
  assert.ok(defaultProfile.khb_proximity.full_credit_m > 0);
  assert.ok(defaultProfile.khb_proximity.falloff_m > 0);
});

// ── sub-score shape ─────────────────────────────────────────────────────────

test('khb_proximity sub-score: full credit near, linear falloff, 0 far, null unknown', () => {
  const p = defaultProfile;
  const at = (m) => subScores({ khb_project_dist_m: m }, p).khb_proximity;
  assert.equal(at(0), 1, 'at the project door');
  assert.equal(at(p.khb_proximity.full_credit_m), 1, 'edge of full credit');
  const mid = at(p.khb_proximity.full_credit_m + p.khb_proximity.falloff_m / 2);
  assert.ok(mid > 0.4 && mid < 0.6, `midpoint of falloff ≈ 0.5, got ${mid}`);
  assert.equal(at(p.khb_proximity.full_credit_m + p.khb_proximity.falloff_m), 0, 'beyond falloff');
  assert.equal(subScores({}, p).khb_proximity, null, 'unknown distance stays unknown');
});

test('a door near a completed project outscores the identical door far from one', () => {
  const base = { income_band: 6, tract_owner_occ_rate: 0.7 };
  const near = scoreTargetDetailed({ ...base, khb_project_dist_m: 50 });
  const far = scoreTargetDetailed({ ...base, khb_project_dist_m: 2000 });
  const unknown = scoreTargetDetailed(base);
  assert.ok(near.score > far.score, 'near beats far');
  assert.ok(near.score > unknown.score, 'near beats unknown');
  assert.ok(near.known.includes('khb_proximity'));
  assert.ok(!unknown.known.includes('khb_proximity'));
});

// ── relaxed gate ────────────────────────────────────────────────────────────

const CLEAN = { no_soliciting: 0, solicit_status: 'unknown' };

test('gate: unknown owner-occupancy allowed when tract owner-occ rate >= 0.6', () => {
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: null, tract_owner_occ_rate: 0.74 }), true);
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: null, tract_owner_occ_rate: 0.6 }), true);
});

test('gate: unknown owner-occupancy still excluded in low-owner tracts or with no tract data', () => {
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: null, tract_owner_occ_rate: 0.35 }), false);
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: null }), false);
});

test('gate: KNOWN renters and DNC doors are excluded regardless of tract rate', () => {
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: 0, owner_occupied_known: 1, tract_owner_occ_rate: 0.9 }), false);
  assert.equal(isKnockEligible({ no_soliciting: 1, owner_occupied: 1, owner_occupied_known: 1, tract_owner_occ_rate: 0.9 }), false);
});

test('gate: verified owner-occupied doors still pass with no tract data', () => {
  assert.equal(isKnockEligible({ ...CLEAN, owner_occupied: 1, owner_occupied_known: 1 }), true);
});

test('partitionByEligibility reports the tract-based decisions distinctly', () => {
  const { eligible, excluded } = partitionByEligibility([
    { ...CLEAN, owner_occupied: null, tract_owner_occ_rate: 0.8 },   // in (tract)
    { ...CLEAN, owner_occupied: null, tract_owner_occ_rate: 0.3 },   // out (low tract)
    { ...CLEAN, owner_occupied: null },                              // out (no data)
    { ...CLEAN, owner_occupied: 0, owner_occupied_known: 1 },        // out (renter)
    { no_soliciting: 1 },                                            // out (DNC)
    { ...CLEAN, owner_occupied: 1, owner_occupied_known: 1 },        // in (verified)
  ]);
  assert.equal(eligible.length, 2);
  assert.equal(excluded.dnc, 1);
  assert.equal(excluded.nonOwner, 1);
  assert.equal(excluded.ownerUnknown, 2, 'low-tract + no-data both counted as owner-unknown');
});

// ── repo: geo-signal update for existing rows ───────────────────────────────

test('updateTargetGeoSignals persists dist/tract/score/known_signals', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  process.env.DB_PATH = path.join(os.tmpdir(), `ndf-geosig-${randomUUID()}.db`);
  const { migrate } = await import('../src/db/migrate.js');
  migrate();
  const repo = await import('../src/db/repo.js');
  const { closeDb } = await import('../src/db/connection.js');

  const id = `tgt_${randomUUID()}`;
  repo.insertTarget({
    id, address: '1 Legacy Way', city: 'Modesto', county: 'Stanislaus', zip: '95355',
    lat: 37.66, lng: -121.03, value_cents: 42000000, home_age: 30, owner_occupied: 1,
    owner_occupied_known: 0, tenure_years: 5, recently_sold: 0, income_band: 5,
    score: 82, no_soliciting: 0, solicit_status: 'unknown', known_signals: null,
  });
  const changed = repo.updateTargetGeoSignals(id, {
    khb_project_dist_m: 210, tract_owner_occ_rate: 0.74, score: 27, known_signals: '["khb_proximity"]',
  });
  assert.equal(changed, 1);
  const row = repo.getTargetById(id);
  assert.equal(row.khb_project_dist_m, 210);
  assert.equal(row.tract_owner_occ_rate, 0.74);
  assert.equal(row.score, 27);
  assert.equal(row.known_signals, '["khb_proximity"]');
  closeDb();
});
