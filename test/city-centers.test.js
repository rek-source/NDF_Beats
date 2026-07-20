import { test } from 'node:test';
import assert from 'node:assert/strict';
const { resolveBeatCenter, COUNTY_CENTERS } = await import('../src/config.js');

test('resolveBeatCenter prefers explicit pin', () => {
  const c = resolveBeatCenter({ lat: 37.5, lng: -121.1, city: 'Modesto', county: 'Stanislaus' });
  assert.deepEqual(c, { lat: 37.5, lng: -121.1 });
});
test('resolveBeatCenter falls back to city then county', () => {
  const byCity = resolveBeatCenter({ city: 'Turlock', county: 'Stanislaus' });
  assert.ok(Number.isFinite(byCity.lat) && Number.isFinite(byCity.lng));
  const byCounty = resolveBeatCenter({ city: 'Nowhere', county: 'Merced' });
  assert.deepEqual(byCounty, COUNTY_CENTERS['Merced']);
});
