// src/adapters/census.js
//
// ====================  R E A L   —   FREE  ====================================
// Demographics by location. Two free U.S. Census services:
//   1. Census Geocoder (keyless): lat/lng -> {state, county, tract} GEOID.
//   2. ACS 5-year Data API: tract -> median household income, median age,
//      owner-occupancy rate.
//
// IMPORTANT: as of 2024 the ACS Data API requires an API key — the old keyless
// endpoint now redirects to a "Missing Key" page. So:
//   - With CENSUS_API_KEY set: real ACS demographics per tract.
//   - Without a key: we still geocode (free, keyless) and return a NEUTRAL
//     demographic estimate (mid income band) so ingestion proceeds and scoring
//     stays sane — clearly flagged via `source: 'census.neutral'`.
//
// FREE: no charge either way. Get a key at https://api.census.gov/data/key_signup.html
// Used at ingestion time only; the running server never calls this.
// ==============================================================================

const GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates';
const ACS_YEAR = process.env.CENSUS_ACS_YEAR ?? '2022';
const ACS_URL = `https://api.census.gov/data/${ACS_YEAR}/acs/acs5`;
const CENSUS_API_KEY = process.env.CENSUS_API_KEY ?? null;

// ACS variables:
//   B19013_001E  median household income (dollars)
//   B01002_001E  median age (years)
//   B25003_001E  occupied housing units (denominator)
//   B25003_002E  owner-occupied housing units (numerator)
const ACS_VARS = 'B19013_001E,B01002_001E,B25003_001E,B25003_002E';

// In-process memo so repeated lookups in the same tract don't re-hit the API.
const tractCache = new Map();

/**
 * Map a median-household-income dollar figure to a 1..10 decile band that
 * matches the schema's `income_band` field and the scoring profile.
 * Bands are anchored to a Central-Valley-realistic income distribution
 * ($25k..$160k spread across deciles). Deterministic, no I/O.
 */
export function incomeToBand(medianIncome) {
  if (!Number.isFinite(medianIncome) || medianIncome <= 0) return 5; // neutral
  // Decile thresholds (upper bound of each band, in dollars).
  const thresholds = [30000, 42000, 52000, 62000, 72000, 84000, 98000, 118000, 150000];
  for (let i = 0; i < thresholds.length; i++) {
    if (medianIncome <= thresholds[i]) return i + 1;
  }
  return 10;
}

/**
 * Reverse-geocode a coordinate to its Census tract GEOID (free, keyless).
 * @returns {Promise<{state,county,tract,geoid}|null>}
 */
export async function geocodeTract(lat, lng) {
  const url =
    `${GEOCODER_URL}?x=${encodeURIComponent(lng)}&y=${encodeURIComponent(lat)}` +
    `&benchmark=Public_AR_Current&vintage=Current_Current&format=json`;
  const res = await fetch(url, { headers: { 'User-Agent': 'ndf-beats-ingest/1.0' } });
  if (!res.ok) throw new Error(`Census geocoder HTTP ${res.status}`);
  const json = await res.json();
  const tracts = json?.result?.geographies?.['Census Tracts'];
  const t = Array.isArray(tracts) ? tracts[0] : null;
  if (!t) return null;
  return {
    state: t.STATE,
    county: t.COUNTY,
    tract: t.TRACT,
    geoid: t.GEOID,
  };
}

/**
 * Pull ACS 5-year demographics for a tract (requires CENSUS_API_KEY).
 * @returns {Promise<{median_income,median_age,owner_occupancy_rate}|null>}
 */
async function fetchAcsForTract({ state, county, tract }) {
  if (!CENSUS_API_KEY) return null;
  const cacheKey = `${state}/${county}/${tract}`;
  if (tractCache.has(cacheKey)) return tractCache.get(cacheKey);

  const url =
    `${ACS_URL}?get=${ACS_VARS}&for=tract:${tract}` +
    `&in=state:${state}&in=county:${county}&key=${encodeURIComponent(CENSUS_API_KEY)}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`ACS HTTP ${res.status}`);
  const body = await res.text();
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error(`ACS returned non-JSON (likely a key/redirect issue): ${body.slice(0, 120)}`);
  }
  // rows[0] is the header; rows[1] is the data.
  const data = Array.isArray(rows) && rows.length > 1 ? rows[1] : null;
  if (!data) {
    tractCache.set(cacheKey, null);
    return null;
  }
  const [, income, age, occUnits, ownerUnits] = data.map((v) => Number(v));
  const result = {
    median_income: income > 0 ? income : null,
    median_age: age > 0 ? age : null,
    owner_occupancy_rate: occUnits > 0 ? ownerUnits / occUnits : null,
  };
  tractCache.set(cacheKey, result);
  return result;
}

/**
 * REAL demographics for a coordinate.
 * @param {number} lat
 * @param {number} lng
 * @returns {Promise<{
 *   income_band: number, median_income: number|null, median_age: number|null,
 *   owner_occupancy_rate: number|null, tract_geoid: string|null,
 *   source: 'census.acs5' | 'census.neutral'
 * }>}
 *
 * Always resolves (never throws on a missing key): with a key it returns real
 * ACS values; without one (or if the tract has no ACS data) it returns a neutral
 * mid band so ingestion + scoring keep working, flagged via `source`.
 */
export async function getDemographics(lat, lng) {
  let geo = null;
  try {
    geo = await geocodeTract(lat, lng);
  } catch (err) {
    console.log(`  [census] geocode failed (${err.message}); using neutral demographics`);
  }

  let acs = null;
  if (geo && CENSUS_API_KEY) {
    try {
      acs = await fetchAcsForTract(geo);
    } catch (err) {
      console.log(`  [census] ACS lookup failed (${err.message}); using neutral demographics`);
    }
  }

  if (acs && acs.median_income != null) {
    return {
      income_band: incomeToBand(acs.median_income),
      median_income: acs.median_income,
      median_age: acs.median_age,
      owner_occupancy_rate: acs.owner_occupancy_rate,
      tract_geoid: geo?.geoid ?? null,
      source: 'census.acs5',
    };
  }

  // Neutral fallback (no key, or tract has no published ACS data).
  return {
    income_band: 5,
    median_income: null,
    median_age: null,
    owner_occupancy_rate: null,
    tract_geoid: geo?.geoid ?? null,
    source: 'census.neutral',
  };
}

/** Whether a real ACS key is configured (for ingestion logging). */
export function hasCensusKey() {
  return Boolean(CENSUS_API_KEY);
}
