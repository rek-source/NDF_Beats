// test/addresses-city.test.js  (OWNER: backend)
// The per-city address pull (getCandidateAddresses) + countyForCity were
// uncovered — only the near-point variant had a test. Pins the service-area
// guard, the city Overpass query shape, and normalize/dedupe. fetch is stubbed;
// never hits the network.

import test from 'node:test';
import assert from 'node:assert/strict';

const { getCandidateAddresses, countyForCity, SERVICE_AREA } = await import('../src/adapters/addresses.js');

const realFetch = globalThis.fetch;
const overpassResponse = (elements) => new Response(JSON.stringify({ elements }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('countyForCity resolves in-area cities and rejects the rest', () => {
  assert.equal(countyForCity('Modesto'), 'Stanislaus');
  assert.equal(countyForCity('Stockton'), 'San Joaquin');
  assert.equal(countyForCity('Merced'), 'Merced');
  assert.equal(countyForCity('San Francisco'), null);
  assert.equal(countyForCity(undefined), null);
  // every SERVICE_AREA city maps to a non-null county
  for (const city of Object.keys(SERVICE_AREA)) {
    assert.ok(countyForCity(city), `${city} resolves`);
  }
});

test('getCandidateAddresses rejects a city outside the service area (before any fetch)', async () => {
  await assert.rejects(
    () => getCandidateAddresses('San Francisco'),
    /outside the NDF service area/,
  );
});

test('getCandidateAddresses builds a city query and normalizes/dedupes doors', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = decodeURIComponent(String(opts?.body ?? url).replace(/\+/g, ' '));
    return overpassResponse([
      { type: 'node', id: 1, lat: 37.6391, lon: -120.9969,
        tags: { 'addr:housenumber': '100', 'addr:street': 'Oak Ave', 'addr:city': 'Modesto', 'addr:postcode': '95350' } },
      { type: 'way', id: 2, center: { lat: 37.6393, lon: -120.9971 },
        tags: { 'addr:housenumber': '102', 'addr:street': 'Oak Ave' } },
      // duplicate of #1 -> dropped
      { type: 'node', id: 3, lat: 37.6391, lon: -120.9969,
        tags: { 'addr:housenumber': '100', 'addr:street': 'Oak Ave' } },
      // missing street -> dropped
      { type: 'node', id: 4, lat: 37.64, lon: -120.99, tags: { 'addr:housenumber': '104' } },
    ]);
  };

  const rows = await getCandidateAddresses('Modesto', { limit: 500 });
  assert.match(sentBody, /area\["name"="California"\]/, 'scopes to California');
  assert.match(sentBody, /area\["name"="Modesto"\]/, 'scopes to the named city');
  assert.equal(rows.length, 2, 'deduped, junk dropped');
  assert.equal(rows[0].address, '100 Oak Ave');
  assert.equal(rows[0].zip, '95350');
  assert.equal(rows[1].city, 'Modesto', 'fallback city applied when tags omit it');
  assert.equal(rows[1].zip, null, 'missing ZIP stays null for ingestion to backfill');
});

test('a non-retryable Overpass error propagates (loud ingest failure, no silent empty)', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  // 400 is NOT in the retryable set (429/504), so overpass() throws immediately
  // — no backoff/sleep — rather than returning zero doors.
  globalThis.fetch = async () => new Response('bad request', { status: 400 });
  await assert.rejects(() => getCandidateAddresses('Modesto'), /Overpass HTTP 400/);
});
