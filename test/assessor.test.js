// test/assessor.test.js  (OWNER: adapters)
// Unit tests for the FREE county-assessor enrichment adapter's pure parsing +
// coverage helpers. No network — feeds canned ArcGIS feature attributes in.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAssessorFeature,
  hasFreeAssessor,
  freeAssessorCounties,
} from '../src/adapters/assessor.js';

// A real San Joaquin parcel record shape (from the live FeatureServer).
const SJ_ATTRS = {
  APN: '25335013',
  FULL_ADDRESS: '6893 W SAINT ANDREWS LN',
  LAND_VALUE: 125409,
  IMPROVEMENT_VALUE: 299316,
  YEAR_BUILT: '1998',
  VALUE_ROLL_YEAR: '2025',
};

test('parseAssessorFeature maps value (land+improvement) to cents + home age', () => {
  const out = parseAssessorFeature(SJ_ATTRS, 2026);
  assert.equal(out.value_cents, (125409 + 299316) * 100); // 42,472,500
  assert.equal(out.year_built, 1998);
  assert.equal(out.home_age, 2026 - 1998); // 28
  assert.equal(out.apn, '25335013');
  assert.ok(out.source.startsWith('assessor'));
});

test('parseAssessorFeature returns null when there is nothing usable', () => {
  // commercial/vacant parcel: zero values, no year
  assert.equal(parseAssessorFeature({ LAND_VALUE: 0, IMPROVEMENT_VALUE: 0, YEAR_BUILT: '0' }, 2026), null);
  assert.equal(parseAssessorFeature(null, 2026), null);
});

test('parseAssessorFeature tolerates a missing/partial value or year', () => {
  // value but no year
  const a = parseAssessorFeature({ LAND_VALUE: 100000, IMPROVEMENT_VALUE: 200000 }, 2026);
  assert.equal(a.value_cents, 30000000);
  assert.equal(a.year_built, null);
  assert.equal(a.home_age, null);

  // year but no value
  const b = parseAssessorFeature({ YEAR_BUILT: '1975' }, 2026);
  assert.equal(b.value_cents, null);
  assert.equal(b.year_built, 1975);
  assert.equal(b.home_age, 2026 - 1975);

  // garbage year is rejected, not turned into a negative age
  const c = parseAssessorFeature({ LAND_VALUE: 50000, YEAR_BUILT: '3025' }, 2026);
  assert.equal(c.year_built, null);
  assert.equal(c.home_age, null);
});

test('free-assessor coverage map reflects the verified counties', () => {
  assert.equal(hasFreeAssessor('San Joaquin'), true);
  // Stanislaus = APN/situs only (value/year is paid); Merced endpoint is down.
  assert.equal(hasFreeAssessor('Stanislaus'), false);
  assert.equal(hasFreeAssessor('Merced'), false);
  assert.ok(freeAssessorCounties().includes('San Joaquin'));
});
