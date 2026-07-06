// compliance.js — HARD knock-eligibility gate (finding #4). Pure, no DB/HTTP.
//
// Two rules, both HARD (never defaulted to "safe to knock"):
//   1. DNC / litigator / no-soliciting: any do-not-solicit flag from ANY source
//      excludes the door, period.
//   2. Owner-occupancy must be VERIFIED true. "We don't know" is NOT "yes":
//      unknown owner-occupancy fails the gate (renters can't buy Care Plans and
//      fabricated 'true' was exactly the bug being fixed).
//
// solicit_status is tri-state and is stored explicitly:
//   'do_not_solicit' — verified flag (Tracerfy DNC/litigator, posted sign, opt-out)
//   'clear'          — a real compliance source checked the door and found no flag
//   'unknown'        — nothing checked yet. NEVER coerced to 'clear'.
// A door with 'unknown' solicit status may still be walked in person (posted
// signs are honored at the door and covered in training) but the unknown state
// is preserved and surfaced — it is never recorded as verified-safe.

export const SOLICIT_STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  CLEAR: 'clear',
  DO_NOT_SOLICIT: 'do_not_solicit',
});

/**
 * Tri-state solicit status for a target row or in-memory candidate.
 * Legacy rows without the column: a no_soliciting flag maps to
 * 'do_not_solicit'; absence of a flag maps to 'unknown' — never 'clear'.
 */
export function solicitStatusOf(target) {
  // A set no_soliciting flag ALWAYS dominates, whatever solicit_status says.
  if (Number(target.no_soliciting) === 1) return SOLICIT_STATUS.DO_NOT_SOLICIT;
  const s = target.solicit_status;
  if (s === SOLICIT_STATUS.DO_NOT_SOLICIT || s === SOLICIT_STATUS.CLEAR || s === SOLICIT_STATUS.UNKNOWN) {
    return s;
  }
  return SOLICIT_STATUS.UNKNOWN;
}

/**
 * Is the owner-occupancy datum VERIFIED (vs fabricated/unknown)?
 * - explicit owner_occupied_known column wins (0 = fabricated legacy default);
 * - otherwise a concrete 0/1 value on an in-memory object counts as known,
 *   and null/undefined is unknown.
 */
export function ownerOccupancyKnown(target) {
  if (target.owner_occupied === null || target.owner_occupied === undefined) return false;
  if (target.owner_occupied_known !== undefined && target.owner_occupied_known !== null) {
    return Number(target.owner_occupied_known) === 1;
  }
  return true;
}

/**
 * HARD eligibility gate for beat inclusion / knocking.
 * @returns {boolean} true ONLY when the door is verified owner-occupied AND
 *          carries no do-not-solicit flag.
 */
export function isKnockEligible(target) {
  if (solicitStatusOf(target) === SOLICIT_STATUS.DO_NOT_SOLICIT) return false;
  if (!ownerOccupancyKnown(target)) return false; // unknown is NOT safe
  return Number(target.owner_occupied) === 1;
}

/**
 * Partition candidates for reporting: { eligible, excluded: {dnc, ownerUnknown,
 * nonOwner} }. Used by ingest/rebuild so exclusions are visible, not silent.
 */
export function partitionByEligibility(targets) {
  const eligible = [];
  const excluded = { dnc: 0, ownerUnknown: 0, nonOwner: 0 };
  for (const t of targets) {
    if (solicitStatusOf(t) === SOLICIT_STATUS.DO_NOT_SOLICIT) { excluded.dnc += 1; continue; }
    if (!ownerOccupancyKnown(t)) { excluded.ownerUnknown += 1; continue; }
    if (Number(t.owner_occupied) !== 1) { excluded.nonOwner += 1; continue; }
    eligible.push(t);
  }
  return { eligible, excluded };
}
