// test/addresses-near.test.js  (OWNER: backend)
// getAddressesNearPoint — Overpass `around:` radius pull for project-seeded
// beats: every real door within walking distance of a completed KHB project.
// Same normalization/dedupe as the per-city pull; never hits the network in
// tests (fetch stubbed).

import test from 'node:test';
import assert from 'node:assert/strict';

const { getAddressesNearPoint } = await import('../src/adapters/addresses.js');

const realFetch = globalThis.fetch;

function overpassResponse(elements) {
  return new Response(JSON.stringify({ elements }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

test('near-point query uses around: radius and normalizes/dedupes doors', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = decodeURIComponent(String(opts?.body ?? url).replace(/\+/g, ' '));
    return overpassResponse([
      { type: 'node', id: 1, lat: 37.4941, lon: -120.8355,
        tags: { 'addr:housenumber': '2542', 'addr:street': 'Mooneyham Ct', 'addr:city': 'Turlock', 'addr:postcode': '95382' } },
      { type: 'way', id: 2, center: { lat: 37.4943, lon: -120.8357 },
        tags: { 'addr:housenumber': '2544', 'addr:street': 'Mooneyham Ct' } },
      // duplicate of the first door
      { type: 'node', id: 3, lat: 37.4941, lon: -120.8355,
        tags: { 'addr:housenumber': '2542', 'addr:street': 'Mooneyham Ct' } },
      // no housenumber -> dropped
      { type: 'node', id: 4, lat: 37.49, lon: -120.83, tags: { 'addr:street': 'Mooneyham Ct' } },
    ]);
  };

  const rows = await getAddressesNearPoint(37.4941, -120.8355, 420, { city: 'Turlock' });
  assert.ok(/around:420,37\.4941,-120\.8355/.test(sentBody), 'around: radius in the query');
  assert.equal(rows.length, 2, 'deduped, junk dropped');
  assert.equal(rows[0].address, '2542 Mooneyham Ct');
  assert.equal(rows[0].zip, '95382');
  assert.equal(rows[1].city, 'Turlock', 'fallback city applied when tags omit it');
});
