// test/assessor-lookup.test.js  (OWNER: backend)
// lookupParcel is the free county-assessor enrichment. It must NEVER throw —
// ingestion continues without the extra value/age when a county has no free
// endpoint or the service is down. Existing tests cover parseAssessorFeature;
// this pins lookupParcel's branches (fetch stubbed, never hits a county server).

import test from 'node:test';
import assert from 'node:assert/strict';

const { lookupParcel, freeAssessorCounties, hasFreeAssessor } =
  await import('../src/adapters/assessor.js');

const realFetch = globalThis.fetch;
const arcgis = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' },
});

test('freeAssessorCounties lists exactly the counties with a free endpoint', () => {
  const counties = freeAssessorCounties();
  assert.ok(Array.isArray(counties));
  assert.deepEqual(counties, counties.filter(hasFreeAssessor), 'all listed counties are free');
  assert.ok(counties.includes('San Joaquin'));
});

test('a county with no free endpoint returns null without fetching', async (t) => {
  let called = false;
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => { called = true; return arcgis({}); };
  const out = await lookupParcel(37.9, -121.2, 'Stanislaus');
  assert.equal(out, null);
  assert.equal(called, false, 'no network call for an unsupported county');
});

test('a valid feature is parsed into value cents + home age', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = async () => arcgis({
    features: [{ attributes: { LAND_VALUE: 100000, IMPROVEMENT_VALUE: 200000, YEAR_BUILT: '1990', VALUE_ROLL_YEAR: 2026 } }],
  });
  const out = await lookupParcel(37.95, -121.29, 'San Joaquin');
  assert.ok(out && out.value_cents === 30000000, `land+improvement -> cents, got ${out && out.value_cents}`);
});

test('HTTP error, service error, and empty features all degrade to null', async (t) => {
  t.after(() => { globalThis.fetch = realFetch; });

  globalThis.fetch = async () => new Response('boom', { status: 500 });
  assert.equal(await lookupParcel(37.95, -121.29, 'San Joaquin'), null, 'HTTP error -> null');

  globalThis.fetch = async () => arcgis({ error: { code: 400, message: 'bad' } });
  assert.equal(await lookupParcel(37.95, -121.29, 'San Joaquin'), null, 'service error -> null');

  globalThis.fetch = async () => arcgis({ features: [] });
  assert.equal(await lookupParcel(37.95, -121.29, 'San Joaquin'), null, 'no features -> null');
});
