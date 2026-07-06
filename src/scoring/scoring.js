// scoring.js — Ideal-Client scoring (SPEC §6.1). Pure JS, no DB/HTTP, no
// randomness. Deterministic given (target, profile).
//
// UNKNOWN-AWARE (finding #1): a signal whose underlying datum is absent
// (null/undefined) is carried as an explicit `null` sub-score — it is NEVER
// silently replaced with a sweet-spot constant. The final score renormalizes
// the weights over the KNOWN signals and then scales by data coverage (the
// summed weight of known signals), so:
//   - a fully-known ideal door still scores high (identical to the old math),
//   - a data-starved door scores LOW (no data -> score 0), instead of every
//     unknown door collapsing onto the same fabricated "92".
//
// NOTE: owned by `scoring`. The §6.1 signature scoreTarget(target, profile)
// is frozen; scoreTargetDetailed/subScores/signalsFromRow are additive.

import { defaultProfile, SIGNAL_KEYS } from './profile.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** True when a signal datum is actually present (not fabricated). */
const known = (v) => v !== null && v !== undefined && !Number.isNaN(Number(v));

/**
 * Trapezoidal membership: 1.0 inside [min,max], linear taper to 0 across
 * `falloff` units on each side.
 */
function trapezoid(x, min, max, falloff) {
  if (x >= min && x <= max) return 1;
  if (falloff <= 0) return 0;
  if (x < min) return clamp01(1 - (min - x) / falloff);
  return clamp01(1 - (x - max) / falloff);
}

/**
 * Per-signal 0..1 sub-scores for a target — or `null` where the signal is
 * UNKNOWN (datum absent). Exported so Phase-2 reweighting (reweight.js) can
 * correlate each signal with real outcomes using the EXACT same membership
 * math, skipping unknowns instead of learning from fabrications.
 * @param {Object} target  - { value_cents, home_age, owner_occupied(0|1|null),
 *                             tenure_years, recently_sold(0|1|null), income_band(1..10) }
 * @param {Object} profile - see profile.js (defaults to defaultProfile)
 * @returns {{value:?number, home_age:?number, owner_occupied:?number,
 *            tenure:?number, recently_sold:?number, income_band:?number}}
 */
export function subScores(target, profile = defaultProfile) {
  // value
  const value = known(target.value_cents)
    ? trapezoid(
        Number(target.value_cents),
        profile.value.min_cents,
        profile.value.max_cents,
        profile.value.falloff_cents,
      )
    : null;

  // home age
  const home_age = known(target.home_age)
    ? trapezoid(
        Number(target.home_age),
        profile.home_age.min_years,
        profile.home_age.max_years,
        profile.home_age.falloff_years,
      )
    : null;

  // owner-occupied (binary lift; unknown stays unknown — see compliance.js for
  // the HARD eligibility gate that unknown owner-occupancy also fails)
  const owner_occupied = known(target.owner_occupied)
    ? (Number(target.owner_occupied)
        ? profile.owner_occupied.occupied_score
        : profile.owner_occupied.non_occupied_score)
    : null;

  // tenure (saturating)
  const sat = profile.tenure.saturation_years;
  const tenure = known(target.tenure_years)
    ? (sat > 0 ? clamp01(Number(target.tenure_years) / sat) : 0)
    : null;

  // recently sold: additive bump on top of tenure, capped at 1. When the flag
  // is unknown the signal is unknown. When the flag is 0 the signal mirrors
  // tenure (so it is unknown when tenure is unknown too).
  let recently_sold = null;
  if (known(target.recently_sold)) {
    if (Number(target.recently_sold)) {
      recently_sold = clamp01((tenure ?? 0) + profile.recently_sold.bump);
    } else {
      recently_sold = tenure; // may be null when tenure unknown
    }
  }

  // income band
  const income_band = known(target.income_band)
    ? trapezoid(
        Number(target.income_band),
        profile.income_band.min_band,
        profile.income_band.max_band,
        profile.income_band.falloff_bands,
      )
    : null;

  return { value, home_age, owner_occupied, tenure, recently_sold, income_band };
}

/**
 * Detailed score: weights renormalized over KNOWN signals, scaled by coverage
 * (the summed weight of known signals) so data-starved doors score LOW.
 * @returns {{score:number, coverage:number, known:string[],
 *            sub:Object}} score is an integer 0..100; coverage 0..1.
 */
export function scoreTargetDetailed(target, profile = defaultProfile) {
  const w = profile.weights;
  const s = subScores(target, profile);

  let knownWeight = 0;
  let weighted = 0;
  const knownKeys = [];
  for (const key of SIGNAL_KEYS) {
    if (s[key] === null) continue;
    knownKeys.push(key);
    knownWeight += w[key];
    weighted += w[key] * s[key];
  }

  if (knownWeight <= 0) {
    return { score: 0, coverage: 0, known: [], sub: s };
  }

  // Renormalized fit over what we actually know…
  const fit = clamp01(weighted / knownWeight);
  // …scaled by coverage so "we know nothing" can never masquerade as "ideal".
  const score = Math.round(clamp01(fit * knownWeight) * 100);
  return {
    score: score < 0 ? 0 : score > 100 ? 100 : score,
    coverage: knownWeight,
    known: knownKeys,
    sub: s,
  };
}

/**
 * Score a target 0..100 against an Ideal-Client Profile (frozen §6.1 API).
 * @param {Object} target  - see subScores
 * @param {Object} profile - see profile.js (defaults to defaultProfile)
 * @returns {number} integer 0..100
 */
export function scoreTarget(target, profile = defaultProfile) {
  return scoreTargetDetailed(target, profile).score;
}

/**
 * Reconstruct honest (unknown-aware) signal inputs from a persisted targets
 * row. The DB stores NOT NULL columns for legacy-schema compatibility, plus a
 * `known_signals` JSON array recording which signals were REAL at ingest:
 *   - known_signals present  -> anything not listed is unknown (null).
 *   - known_signals absent (legacy row) -> owner_occupied is trusted only when
 *     owner_occupied_known=1 (fabricated legacy defaults stay unknown); other
 *     columns are taken at face value.
 * @param {Object} row - a targets table row
 * @returns {Object} signal object suitable for subScores/scoreTarget
 */
export function signalsFromRow(row) {
  let knownSet = null;
  if (row.known_signals) {
    try { knownSet = new Set(JSON.parse(row.known_signals)); } catch { knownSet = null; }
  }
  const has = (k) => (knownSet ? knownSet.has(k) : true);
  const ownerKnown = knownSet
    ? knownSet.has('owner_occupied')
    : row.owner_occupied_known === undefined || row.owner_occupied_known === null
      ? true
      : Number(row.owner_occupied_known) === 1;
  return {
    value_cents: has('value') ? row.value_cents : null,
    home_age: has('home_age') ? row.home_age : null,
    owner_occupied: ownerKnown ? row.owner_occupied : null,
    tenure_years: has('tenure') ? row.tenure_years : null,
    recently_sold: has('recently_sold') ? row.recently_sold : null,
    income_band: has('income_band') ? row.income_band : null,
  };
}
