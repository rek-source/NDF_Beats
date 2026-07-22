// test/census-fallback.test.js  (OWNER: backend)
// getDemographics must ALWAYS resolve — never throw — so ingestion keeps going
// when the keyless geocoder or the ACS endpoint misbehaves. The happy path is
// covered by census-acs.test.js; this pins the error/fallback branches (the
// bulk of census.js's uncovered lines): geocoder HTTP error, empty geocoder
// result, ACS non-JSON, ACS header-only, and a Census null income sentinel —
// each must degrade to neutral demographics, not crash the run.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CENSUS_API_KEY = process.env.CENSUS_API_KEY || 'test-key';
const { getDemographics, geocodeTract, hasCensusKey } = await import('../src/adapters/census.js');

const realFetch = globalThis.fetch;
const geoOk = (tract) => new Response(JSON.stringify({
  result: { geographies: { 'Census Tracts': [{ STATE: '06', COUNTY: '099', TRACT: tract, GEOID: `06099${tract}` }] } },
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('hasCensusKey reflects the configured key', () => {
  assert.equal(hasCensusKey(), true);
});

test('geocoder HTTP error -> neutral demographics, no throw', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const demo = await getDemographics(37.5, -120.9);
  assert.equal(demo.source, 'census.neutral');
  assert.equal(demo.income_band, 5);
  assert.equal(demo.tract_geoid, null, 'no geo -> no tract id');
});

test('empty geocoder result -> geocodeTract null -> neutral', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: { geographies: { 'Census Tracts': [] } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal(await geocodeTract(37.5, -120.9), null);
  const demo = await getDemographics(37.5, -120.9);
  assert.equal(demo.source, 'census.neutral');
});

test('ACS non-JSON body -> ACS lookup fails -> neutral with tract id', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov')) return geoOk('990010');
    return new Response('<html>redirect to key error</html>', { status: 200 });
  };
  const demo = await getDemographics(37.5, -120.9);
  assert.equal(demo.source, 'census.neutral');
  assert.equal(demo.tract_geoid, '06099990010', 'geo succeeded so the tract id survives');
});

test('ACS header-only response -> no data row -> neutral', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov')) return geoOk('990020');
    return new Response(JSON.stringify([['B19013_001E', 'state', 'county', 'tract']]),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const demo = await getDemographics(37.5, -120.9);
  assert.equal(demo.source, 'census.neutral');
});

test('ACS null-income sentinel -> neutral even though a row exists', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov')) return geoOk('990030');
    // Census uses large negative sentinels for "no data"; income<=0 -> null.
    return new Response(JSON.stringify([
      ['B19013_001E', 'B01002_001E', 'B25003_001E', 'B25003_002E', 'state', 'county', 'tract'],
      ['-666666666', '40.0', '0', '0', '06', '099', '990030'],
    ]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const demo = await getDemographics(37.5, -120.9);
  assert.equal(demo.source, 'census.neutral', 'null income falls back to neutral');
  assert.equal(demo.median_income, null);
});
