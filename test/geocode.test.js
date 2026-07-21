// test/geocode.test.js  (OWNER: backend)
// src/adapters/geocode.js — forward-geocode a typed address to lat/lng via the
// FREE, keyless US Census "onelineaddress" geocoder. Used by POST
// /api/knocks/manual so walk-in doors pin at the real house instead of all
// stacking on the beat center (Jam 2026-07-21). Contract: never throws, never
// invents coordinates — any failure returns null and the caller falls back.

import test from 'node:test';
import assert from 'node:assert/strict';

const { geocodeAddress } = await import('../src/adapters/geocode.js');

const realFetch = globalThis.fetch;

// Intercept BOTH geocoding providers (Census primary, Nominatim fallback) —
// tests must never hit the network. Unhandled providers return "no result".
function stubFetch(census, nominatim) {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov')) {
      return census ? census(u, opts) : jsonResponse({ result: { addressMatches: [] } });
    }
    if (u.includes('nominatim.openstreetmap.org')) {
      return nominatim ? nominatim(u, opts) : jsonResponse([]);
    }
    return realFetch(url, opts);
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function censusMatch(lat, lng, matched) {
  return {
    result: {
      addressMatches: [
        { coordinates: { x: lng, y: lat }, matchedAddress: matched },
      ],
    },
  };
}

test('geocodeAddress resolves a one-line address to lat/lng', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let requested = null;
  stubFetch((u) => {
    requested = u;
    return jsonResponse(censusMatch(37.4947, -120.8466, '1332 MERRITT ST, TURLOCK, CA, 95380'));
  });

  const got = await geocodeAddress('1332 Merritt St Turlock CA');
  assert.deepEqual(got, {
    lat: 37.4947,
    lng: -120.8466,
    matched: '1332 MERRITT ST, TURLOCK, CA, 95380',
  });
  assert.ok(requested.includes('onelineaddress'), 'uses the onelineaddress endpoint');
  assert.ok(requested.includes(encodeURIComponent('1332 Merritt St Turlock CA')),
    'sends the typed address');
});

test('geocodeAddress returns null when the geocoder has no match', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(() => jsonResponse({ result: { addressMatches: [] } }));
  assert.equal(await geocodeAddress('nowhere at all'), null);
});

test('geocodeAddress returns null on HTTP error and on network failure', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(() => jsonResponse({ oops: true }, 500));
  assert.equal(await geocodeAddress('1332 Merritt St'), null);

  stubFetch(() => { throw new Error('network down'); });
  assert.equal(await geocodeAddress('1332 Merritt St'), null);
});

test('geocodeAddress returns null for a blank address without calling the network', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let called = 0;
  stubFetch(() => { called++; return jsonResponse(censusMatch(1, 2, 'X')); });
  assert.equal(await geocodeAddress(''), null);
  assert.equal(await geocodeAddress('   '), null);
  assert.equal(called, 0, 'no network call for blank input');
});

test('geocodeAddress rejects non-numeric coordinates from the geocoder', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(() => jsonResponse({
    result: { addressMatches: [{ coordinates: { x: 'nope', y: null }, matchedAddress: 'BAD' }] },
  }));
  assert.equal(await geocodeAddress('1332 Merritt St'), null);
});

// ---------------------------------------------------------------------------
// Nominatim fallback: census.gov's WAF rejects requests from datacenter IPs
// (observed live on the sandbox box, 2026-07-21 — HTTP 200 with an HTML
// "Request Rejected" body). When Census yields nothing, fall back to OSM
// Nominatim; when Census answers, Nominatim must never be called.
// ---------------------------------------------------------------------------

test('geocodeAddress falls back to Nominatim when the Census WAF rejects', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let nominatimUrl = null;
  stubFetch(
    () => new Response('<html><head><title>Request Rejected</title></head></html>',
      { status: 200, headers: { 'content-type': 'text/html' } }),
    (u) => { nominatimUrl = u; return jsonResponse([
      { lat: '37.4947', lon: '-120.8466', display_name: '1332, Merritt Street, Turlock, CA' },
    ]); },
  );
  const got = await geocodeAddress('1332 Merritt St Turlock CA');
  assert.deepEqual(got, {
    lat: 37.4947, lng: -120.8466, matched: '1332, Merritt Street, Turlock, CA',
  });
  assert.ok(nominatimUrl.includes(encodeURIComponent('1332 Merritt St Turlock CA')),
    'nominatim got the typed address');
});

test('geocodeAddress does not call Nominatim when Census matches', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  let nominatimCalls = 0;
  stubFetch(
    () => jsonResponse(censusMatch(37.5, -120.9, 'CENSUS MATCH')),
    () => { nominatimCalls++; return jsonResponse([]); },
  );
  const got = await geocodeAddress('1332 Merritt St');
  assert.equal(got.matched, 'CENSUS MATCH');
  assert.equal(nominatimCalls, 0, 'census answered — no fallback call');
});

test('geocodeAddress returns null when both providers come up empty', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(
    () => jsonResponse({ result: { addressMatches: [] } }),
    () => jsonResponse([]),
  );
  assert.equal(await geocodeAddress('nowhere'), null);
});

test('geocodeAddress rejects junk Nominatim coordinates', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  stubFetch(
    () => jsonResponse({ result: { addressMatches: [] } }),
    () => jsonResponse([{ lat: 'junk', lon: null, display_name: 'BAD' }]),
  );
  assert.equal(await geocodeAddress('1 Bad St'), null);
});
