// scoring.js — Ideal-Client scoring (SPEC §6.1). Pure JS, no DB/HTTP, no
// randomness. Deterministic given (target, profile).
//
// Reads the profile shape defined in profile.js: per-signal config (value band,
// home-age sweet spot, owner-occupied lift, tenure saturation, recently-sold
// bump, income band) + weights that sum to 1. Each signal yields a 0..1
// sub-score; sub-scores are weight-combined, scaled to 0..100, rounded, clamped.
//
// NOTE: owned by `scoring`. The backend ships a contract-correct implementation
// so the app runs end-to-end; the body may be replaced without changing the
// frozen §6.1 signature.

import { defaultProfile } from './profile.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

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
 * Per-signal 0..1 sub-scores for a target (the inputs scoreTarget weight-combines).
 * Exported so Phase-2 reweighting (reweight.js) can correlate each signal with
 * real outcomes using the EXACT same membership math, not a re-derivation.
 * @param {Object} target  - { value_cents, home_age, owner_occupied(0|1),
 *                             tenure_years, recently_sold(0|1), income_band(1..10) }
 * @param {Object} profile - see profile.js (defaults to defaultProfile)
 * @returns {{value:number, home_age:number, owner_occupied:number,
 *            tenure:number, recently_sold:number, income_band:number}}
 */
export function subScores(target, profile = defaultProfile) {
  // value
  const value = trapezoid(
    Number(target.value_cents),
    profile.value.min_cents,
    profile.value.max_cents,
    profile.value.falloff_cents,
  );

  // home age
  const home_age = trapezoid(
    Number(target.home_age),
    profile.home_age.min_years,
    profile.home_age.max_years,
    profile.home_age.falloff_years,
  );

  // owner-occupied (binary lift)
  const owner_occupied = target.owner_occupied
    ? profile.owner_occupied.occupied_score
    : profile.owner_occupied.non_occupied_score;

  // tenure (saturating)
  const sat = profile.tenure.saturation_years;
  const tenure = sat > 0 ? clamp01(Number(target.tenure_years) / sat) : 0;

  // recently sold: additive bump on top of tenure, capped at 1.
  // Use the recently-sold-adjusted value as the "recently_sold" signal, and the
  // raw tenure as the tenure signal, so both weights contribute distinctly.
  const recently_sold = target.recently_sold
    ? clamp01(tenure + profile.recently_sold.bump)
    : tenure;

  // income band
  const income_band = trapezoid(
    Number(target.income_band),
    profile.income_band.min_band,
    profile.income_band.max_band,
    profile.income_band.falloff_bands,
  );

  return { value, home_age, owner_occupied, tenure, recently_sold, income_band };
}

/**
 * Score a target 0..100 against an Ideal-Client Profile.
 * @param {Object} target  - see subScores
 * @param {Object} profile - see profile.js (defaults to defaultProfile)
 * @returns {number} integer 0..100
 */
export function scoreTarget(target, profile = defaultProfile) {
  const w = profile.weights;
  const s = subScores(target, profile);

  const combined =
    w.value * s.value +
    w.home_age * s.home_age +
    w.owner_occupied * s.owner_occupied +
    w.tenure * s.tenure +
    w.recently_sold * s.recently_sold +
    w.income_band * s.income_band;

  const score = Math.round(clamp01(combined) * 100);
  return score < 0 ? 0 : score > 100 ? 100 : score;
}
