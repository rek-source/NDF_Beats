// src/adapters/census.stub.js
//
// ====================  S T U B   —   DO NOT CALL AT RUNTIME  ====================
// Census/ACS is a FREE API, but Phase 1 still does not call it — all demographic
// data comes from the mock seed. This module makes NO network calls; it freezes
// the Phase-2 interface (`getBlockGroup(lat, lng)`) and returns deterministic
// mock income/age/occupancy by block group. The running app never invokes it
// (SPEC §0 guardrail #2, §2).
// ================================================================================

/**
 * STUB. Phase 2: real ACS block-group lookup by coordinate.
 * Phase 1: deterministic mock demographics. NEVER called at runtime in Phase 1.
 * @param {number} lat
 * @param {number} lng
 * @returns {{
 *   income_band: number, median_age: number, owner_occupancy_rate: number,
 *   source: 'census.stub'
 * }}
 */
export function getBlockGroup(lat, lng) {
  // Quantize coordinates to a coarse grid so nearby points share a block group,
  // then derive stable pseudo-values from the grid cell.
  const cell = Math.abs(Math.round(lat * 50) * 1000 + Math.round(lng * 50));
  return {
    income_band: (cell % 10) + 1, // 1..10
    median_age: 28 + (cell % 35), // 28..62
    owner_occupancy_rate: 0.45 + ((cell % 50) / 100), // 0.45..0.95
    source: 'census.stub',
  };
}
