// src/adapters/zillow.stub.js
//
// ====================  S T U B   —   DO NOT CALL AT RUNTIME  ====================
// Phase 1 is local-only and mock-seeded. Zillow's official API is restricted; in
// production we fall back to Tracerly's value field or a compliant feed. This
// module makes NO network calls and uses NO credentials — it only freezes the
// Phase-2 interface (`getValue(address)`) and returns deterministic mock values.
// The running app never invokes it (SPEC §0 guardrail #2, design doc "Data stack").
// ================================================================================

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * STUB. Phase 2: real home-value + recently-sold lookup.
 * Phase 1: deterministic mock value in a Central-Valley-realistic band
 * ($250k–$750k). NEVER called at runtime in Phase 1.
 * @param {string} address
 * @returns {{ value_cents: number, recently_sold: boolean, source: 'zillow.stub' }}
 */
export function getValue(address) {
  const h = hashString(String(address));
  const dollars = 250000 + (h % 500001); // 250000..750000
  return {
    value_cents: dollars * 100,
    recently_sold: h % 100 < 12, // ~12%
    source: 'zillow.stub',
  };
}
