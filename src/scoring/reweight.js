// reweight.js — Phase 2 adaptive Ideal-Client reweighting (SPEC §6.3).
//
// Learns which signals actually convert from real door outcomes and returns an
// UPDATED Ideal-Client Profile (same shape as profile.js). Interpretable +
// deterministic — no ML library, no randomness — so a manager can read WHY the
// weights moved.
//
// Method (signal-lift, prior-blended):
//   1. For each knocked target, compute its 6 sub-scores with the CURRENT
//      profile (reuses scoring.subScores — identical membership math).
//   2. A knock is a "sale" outcome when disposition === 'sold' (or its target
//      appears in `sales`). For each signal, lift = mean(sub-score | sold) −
//      mean(sub-score | not-sold). Positive lift ⇒ that signal predicts sales.
//   3. learned weight ∝ max(0, lift), normalized to sum 1.
//   4. Blend with the prior weights by a confidence α = nSold / (nSold + K):
//      thin data stays near the hand-set prior; weight shifts toward the
//      learned signals as outcomes accumulate. (K = SMOOTHING.)
//   5. Renormalize to sum exactly 1 and return a new profile (prior untouched).
//
// Guard rails: with no sales, or when no signal discriminates, the input profile
// is returned unchanged (nothing reliable to learn). Output always satisfies
// profile.js validateProfile (non-negative, sums to 1).
//
// NOTE: owned by `scoring`. Pure: no DB/HTTP/randomness.

import { subScores } from './scoring.js';
import { SIGNAL_KEYS, validateProfile } from './profile.js';

// Pseudo-count of "prior" sales. Larger = slower to trust observed data.
// At nSold === SMOOTHING the learned signals get half the weight (α = 0.5).
const SMOOTHING = 8;

const isSold = (k, soldTargetIds) =>
  k && (k.disposition === 'sold' || (k.target_id && soldTargetIds.has(k.target_id)));

/**
 * Learn an updated profile from observed knocks/sales.
 * @param {Array} knocks  - knock rows carrying target signals + `disposition`
 *                          (value_cents, home_age, owner_occupied, tenure_years,
 *                           recently_sold, income_band, disposition[, target_id])
 * @param {Array} sales   - sale rows (used only to mark sold target_ids)
 * @param {Object} profile - current Ideal-Client Profile (profile.js shape)
 * @returns {Object} a NEW profile with learned weights, or `profile` unchanged
 *                   when there's nothing reliable to learn.
 */
export function updateWeights(knocks, sales, profile) {
  const ks = Array.isArray(knocks) ? knocks : [];
  const soldTargetIds = new Set(
    (Array.isArray(sales) ? sales : []).map((s) => s && s.target_id).filter(Boolean),
  );

  // Partition observed sub-scores into sold / not-sold buckets.
  const sumSold = zeroSignals();
  const sumNot = zeroSignals();
  let nSold = 0;
  let nNot = 0;
  for (const k of ks) {
    const s = subScores(k, profile);
    if (isSold(k, soldTargetIds)) {
      for (const key of SIGNAL_KEYS) sumSold[key] += s[key];
      nSold += 1;
    } else {
      for (const key of SIGNAL_KEYS) sumNot[key] += s[key];
      nNot += 1;
    }
  }

  // Nothing converted yet → can't learn; keep the hand-set prior.
  if (nSold === 0) {
    console.info('[reweight] no sales observed — profile unchanged.');
    return profile;
  }

  // Per-signal lift = mean(sold) − mean(not-sold). With no not-sold rows, the
  // baseline is 0 so lift = mean(sold) (still a valid relative ranking).
  const lift = {};
  let liftSum = 0;
  for (const key of SIGNAL_KEYS) {
    const meanSold = sumSold[key] / nSold;
    const meanNot = nNot > 0 ? sumNot[key] / nNot : 0;
    const l = Math.max(0, meanSold - meanNot);
    lift[key] = l;
    liftSum += l;
  }

  // No signal discriminates (e.g. sold & not-sold identical) → keep prior.
  if (liftSum <= 0) {
    console.info('[reweight] no discriminating signal — profile unchanged.');
    return profile;
  }

  // Confidence in the observed data grows with the number of sales.
  const alpha = nSold / (nSold + SMOOTHING);

  // Blend prior weight with the normalized learned weight per signal.
  const blended = {};
  let blendSum = 0;
  for (const key of SIGNAL_KEYS) {
    const learned = lift[key] / liftSum;
    const prior = profile.weights[key];
    const w = (1 - alpha) * prior + alpha * learned;
    blended[key] = w;
    blendSum += w;
  }

  // Renormalize to sum exactly 1 (guards float drift).
  const weights = {};
  for (const key of SIGNAL_KEYS) weights[key] = blended[key] / blendSum;

  const learnedProfile = {
    ...profile,
    version: (profile.version ?? 1) + 1,
    label: `${stripLearned(profile.label)} (learned)`,
    weights,
    // Provenance so the manager portal can show WHY weights moved.
    learned: {
      n_sold: nSold,
      n_observed: nSold + nNot,
      alpha: round4(alpha),
      lift: roundSignals(lift),
      updated_from_version: profile.version ?? 1,
    },
  };

  return validateProfile(learnedProfile);
}

function zeroSignals() {
  const o = {};
  for (const key of SIGNAL_KEYS) o[key] = 0;
  return o;
}

function roundSignals(obj) {
  const o = {};
  for (const key of SIGNAL_KEYS) o[key] = round4(obj[key]);
  return o;
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;

const stripLearned = (label) =>
  typeof label === 'string' ? label.replace(/\s*\(learned\)\s*$/, '') : 'Ideal-Client Profile';
