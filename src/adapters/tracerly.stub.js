// src/adapters/tracerly.stub.js
//
// ====================  S T U B   —   DO NOT CALL AT RUNTIME  ====================
// Phase 1 is local-only and mock-seeded. Tracerly is a PAID skip-trace / property
// API. This module makes NO network calls and uses NO credentials. It exists only
// to freeze the Phase-2 interface (`getProperty(address)`) and to return
// deterministic mock data for offline experiments. The running app never invokes
// it — all property data comes from the seed (SPEC §0 guardrail #2, §2).
// ================================================================================

/**
 * Deterministic non-cryptographic hash so the same address yields stable mock
 * output across runs (no randomness, no I/O).
 * @param {string} s
 * @returns {number} 32-bit unsigned int
 */
function hashString(s) {
  let h = 2166136261 >>> 0; // FNV-1a offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const FIRST_NAMES = ['Maria', 'James', 'Linda', 'Robert', 'Sofia', 'David', 'Aisha', 'Hector'];
const LAST_NAMES = ['Nguyen', 'Garcia', 'Patel', 'Johnson', 'Lopez', 'Singh', 'Brown', 'Reyes'];

/**
 * STUB. Phase 2: real Tracerly owner/property/skip-trace lookup.
 * Phase 1: returns deterministic mock owner + property facts. NEVER called at
 * runtime in Phase 1.
 * @param {string} address - full street address
 * @returns {{
 *   owner_name: string, owner_occupied: boolean, tenure_years: number,
 *   year_built: number, source: 'tracerly.stub'
 * }}
 */
export function getProperty(address) {
  const h = hashString(String(address));
  return {
    owner_name: `${FIRST_NAMES[h % FIRST_NAMES.length]} ${LAST_NAMES[(h >> 8) % LAST_NAMES.length]}`,
    owner_occupied: (h & 0b11) !== 0, // ~75% true
    tenure_years: h % 31, // 0..30
    year_built: 1955 + ((h >> 4) % 66), // 1955..2020
    source: 'tracerly.stub',
  };
}
