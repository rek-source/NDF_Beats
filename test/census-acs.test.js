// test/census-acs.test.js  (OWNER: backend)
// ACS response parsing (bug found 2026-07-21, first day with a real key):
// the ACS data row is [income, age, occ_units, owner_units, state, county,
// tract] — values in REQUESTED order, no leading label column. The old code
// skipped the first element, shifting every value one column left (median
// income became median age, owner units became the state code "06" → 0.6%
// owner-occupancy for a 70% suburb, gating every door out).

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.CENSUS_API_KEY = process.env.CENSUS_API_KEY || 'test-key';
const { getDemographics } = await import('../src/adapters/census.js');

const realFetch = globalThis.fetch;

test('ACS columns parse in requested order — no phantom label column', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov')) {
      return new Response(JSON.stringify({
        result: { geographies: { 'Census Tracts': [{ STATE: '06', COUNTY: '099', TRACT: '990001', GEOID: '06099990001' }] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('api.census.gov')) {
      return new Response(JSON.stringify([
        ['B19013_001E', 'B01002_001E', 'B25003_001E', 'B25003_002E', 'state', 'county', 'tract'],
        ['92500', '38.5', '1800', '1260', '06', '099', '990001'],
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url);
  };

  const demo = await getDemographics(37.5236, -120.8768);
  assert.equal(demo.source, 'census.acs5');
  assert.equal(demo.median_income, 92500, 'income is the FIRST data column');
  assert.equal(demo.median_age, 38.5);
  assert.ok(Math.abs(demo.owner_occupancy_rate - 0.7) < 0.001, `owner rate 1260/1800 = 0.70, got ${demo.owner_occupancy_rate}`);
  assert.equal(demo.income_band, 7, '$92.5k median -> band 7 per the decile thresholds');
});
