/**
 * profile.js — the editable Ideal-Client Profile (ICP).
 *
 * Single source of truth for the scoring bands + weights. Imported by:
 *   - scoring.js  (to score targets)
 *   - the seed    (to compute each target's score at insert time)
 *   - reweight.js (Phase 2 will return an updated copy of this shape)
 *
 * Pure data + a tiny validator. No DB, no HTTP, no randomness.
 *
 * Contract (SPEC §6.4):
 *   defaultProfile — value band [min,max] (cents), home-age sweet spot,
 *   weights object (MUST sum to 1), income-band target.
 *
 * NDF market reality (Central Valley: Stanislaus / San Joaquin / Merced):
 *   - Care Plans sell best to owner-occupied homes old enough to need ongoing
 *     maintenance, with owners who have tenure (sticky) or who just bought
 *     (motivated to protect a new purchase), in mid value/income bands —
 *     not the very bottom (can't afford) nor the very top (have a concierge).
 */

/**
 * The six scoring signals and their relative importance.
 * Weights MUST sum to 1.0. They are deliberately ordered by NDF's belief
 * about what predicts a Care Plan sale; Phase 2 (reweight.js) will learn them
 * from real knock/sale outcomes.
 */
export const defaultProfile = Object.freeze({
  /** Human label so the profile can surface in an editor UI later. */
  label: 'NDF Care Plan — Default Ideal-Client Profile',
  version: 1,

  /**
   * Estimated home value sweet spot, in integer cents.
   * Full credit inside [min,max]; linear falloff outside across `falloff` cents.
   * Central Valley realistic: $300k–$650k core, tapering to 0 by ~$150k out.
   */
  value: Object.freeze({
    min_cents: 30_000_000, //  $300,000
    max_cents: 65_000_000, //  $650,000
    falloff_cents: 15_000_000, // $150,000 of linear taper on each side
  }),

  /**
   * Home-age sweet spot, in years since built.
   * Older homes need more maintenance → better Care Plan fit, but brand-new
   * and ancient extremes score lower (new = under warranty; very old = often
   * already heavily renovated or beyond plan scope).
   * Full credit inside [min,max]; linear falloff across `falloff` years.
   */
  home_age: Object.freeze({
    min_years: 20,
    max_years: 50,
    falloff_years: 20,
  }),

  /**
   * Owner-occupancy: a binary lift. Owner-occupied homes are the only real
   * Care Plan buyers (renters don't pay for maintenance plans). `non_occupied`
   * is the residual score a non-owner-occupied home keeps.
   */
  owner_occupied: Object.freeze({
    occupied_score: 1.0,
    non_occupied_score: 0.1,
  }),

  /**
   * Tenure: years the current owner has held the home.
   * Longer tenure = stickier, more invested owner. Saturates: most of the
   * value is earned by `saturation_years`; beyond that it's flat at 1.0.
   */
  tenure: Object.freeze({
    saturation_years: 12,
  }),

  /**
   * Recently sold (within ~18mo): new owners actively invest in protecting
   * their purchase, so a recent sale is a strong positive bump that is ADDED
   * (capped at 1) on top of the tenure sub-score, rather than competing with it.
   */
  recently_sold: Object.freeze({
    bump: 0.6,
  }),

  /**
   * Income band: ACS block-group income decile, 1..10.
   * Sweet spot is mid-to-upper-mid (can afford a plan, not wealthy enough to
   * have a private property manager). Full credit inside [min,max], linear
   * falloff across `falloff` deciles.
   */
  income_band: Object.freeze({
    min_band: 4,
    max_band: 8,
    falloff_bands: 3,
  }),

  /**
   * Proximity to the nearest COMPLETED KHB project (meters). Neighbor-proof
   * marketing (2026-07-21): a finished six-figure remodel nearby is both
   * social proof at the door and a wealth-clustering signal. Full credit
   * within `full_credit_m`; linear falloff to 0 across `falloff_m` more.
   */
  khb_proximity: Object.freeze({
    full_credit_m: 150,
    falloff_m: 350,
  }),

  /**
   * Weights per signal. MUST sum to 1.0 (validated below).
   * owner_occupied is the dominant gate; value/income shape affordability;
   * age/tenure/recently_sold capture maintenance need + buyer motivation;
   * khb_proximity is the neighbor-proof signal (completed-project radius).
   */
  weights: Object.freeze({
    value: 0.14,
    home_age: 0.14,
    owner_occupied: 0.20,
    tenure: 0.11,
    recently_sold: 0.08,
    income_band: 0.11,
    khb_proximity: 0.22,
  }),
});

/** The canonical list of signal keys (also the weight keys). */
export const SIGNAL_KEYS = Object.freeze([
  'value',
  'home_age',
  'owner_occupied',
  'tenure',
  'recently_sold',
  'income_band',
  'khb_proximity',
]);

const WEIGHT_SUM_TOLERANCE = 1e-9;

/**
 * Validate a profile's shape and that its weights sum to 1.
 * Throws on an invalid profile so misconfiguration fails loudly at startup /
 * in tests rather than silently producing garbage scores.
 *
 * @param {Object} profile
 * @returns {Object} the same profile (for chaining)
 */
export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('profile must be an object');
  }
  const w = profile.weights;
  if (!w || typeof w !== 'object') {
    throw new Error('profile.weights must be an object');
  }
  let sum = 0;
  for (const key of SIGNAL_KEYS) {
    const val = w[key];
    if (typeof val !== 'number' || Number.isNaN(val) || val < 0) {
      throw new Error(`profile.weights.${key} must be a non-negative number`);
    }
    sum += val;
  }
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `profile.weights must sum to 1 (got ${sum.toFixed(6)})`,
    );
  }
  return profile;
}

// Fail fast if the shipped default ever drifts out of contract.
validateProfile(defaultProfile);
