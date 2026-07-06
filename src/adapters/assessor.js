// src/adapters/assessor.js
//
// ====================  R E A L   —   FREE  ====================================
// Per-parcel ASSESSED VALUE + YEAR BUILT from county open-data ArcGIS REST
// services — a $0, keyless alternative to paid Tracerfy/ParcelQuest for the
// home value + age signals.
//
// Coverage (verified 2026-06-15, see docs):
//   - San Joaquin : FULL — free keyless FeatureServer, point-in-polygon by
//                   lat/lng, returns LAND_VALUE + IMPROVEMENT_VALUE + YEAR_BUILT.
//   - Stanislaus  : NONE free — public parcel layer has APN/situs only; value &
//                   year are sold via paid Assessor Data Subscriptions.
//   - Merced      : NONE free — county Assessor MapServer is 504/blocked.
//
// Used at ingestion time only; the running server never calls this. Always
// resolves (never throws on a network error) so ingestion proceeds.
// ==============================================================================

// county -> { url, outFields }. Only counties with a usable free value+year
// endpoint appear here. Add a county once its endpoint is verified live.
const COUNTY_ENDPOINTS = Object.freeze({
  'San Joaquin': {
    url:
      'https://services2.arcgis.com/GQhSReJEO6f7tsvy/arcgis/rest/services/' +
      'Parcels/FeatureServer/0/query',
    outFields: 'APN,FULL_ADDRESS,LAND_VALUE,IMPROVEMENT_VALUE,YEAR_BUILT,VALUE_ROLL_YEAR',
  },
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Map raw ArcGIS parcel attributes to the NDF enrichment shape. Pure +
 * deterministic (inject `asOfYear` so home-age is testable without a clock).
 * Returns null when there's nothing usable (no value AND no valid year).
 *
 * @param {Object|null} attrs - ArcGIS feature.attributes
 * @param {number} asOfYear   - current year (for home_age)
 * @returns {{value_cents:number|null, year_built:number|null, home_age:number|null,
 *            apn:string|null, full_address:string|null, roll_year:string|null,
 *            source:string}|null}
 */
export function parseAssessorFeature(attrs, asOfYear = new Date().getFullYear()) {
  if (!attrs || typeof attrs !== 'object') return null;

  const total = num(attrs.LAND_VALUE) + num(attrs.IMPROVEMENT_VALUE ?? attrs.STRUCTURE_VALUE);
  const yb = parseInt(attrs.YEAR_BUILT, 10);
  const year_built = Number.isFinite(yb) && yb > 1800 && yb <= asOfYear ? yb : null;

  if (total <= 0 && year_built === null) return null; // nothing to learn

  return {
    value_cents: total > 0 ? Math.round(total * 100) : null,
    year_built,
    home_age: year_built !== null ? Math.max(0, asOfYear - year_built) : null,
    apn: attrs.APN ?? null,
    full_address: attrs.FULL_ADDRESS ?? null,
    roll_year: attrs.VALUE_ROLL_YEAR ?? null,
    source: 'assessor.free',
  };
}

/** Whether a county has a verified FREE value+year assessor endpoint. */
export function hasFreeAssessor(county) {
  return Object.prototype.hasOwnProperty.call(COUNTY_ENDPOINTS, county);
}

/** Counties with free assessor coverage (for cost-planning readouts). */
export function freeAssessorCounties() {
  return Object.keys(COUNTY_ENDPOINTS);
}

/**
 * FREE per-parcel enrichment for a coordinate, via the county's open assessor
 * service (point-in-polygon). Returns the parsed enrichment, or null when the
 * county has no free endpoint, the point hits no parcel, or the lookup fails.
 * Never throws.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {string} county
 * @returns {Promise<object|null>}
 */
export async function lookupParcel(lat, lng, county) {
  const ep = COUNTY_ENDPOINTS[county];
  if (!ep) return null;

  const url =
    `${ep.url}?geometry=${encodeURIComponent(lng)},${encodeURIComponent(lat)}` +
    `&geometryType=esriGeometryPoint&inSR=4326` +
    `&spatialRel=esriSpatialRelIntersects&outFields=${encodeURIComponent(ep.outFields)}` +
    `&returnGeometry=false&f=json`;

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'ndf-beats-ingest/1.0' } });
    if (!res.ok) throw new Error(`assessor HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error) throw new Error(`assessor error ${json.error.code ?? ''}`);
    const feat = Array.isArray(json?.features) ? json.features[0] : null;
    return feat ? parseAssessorFeature(feat.attributes) : null;
  } catch (err) {
    console.log(`  [assessor] ${county} lookup failed (${err.message}); skipping free enrichment`);
    return null;
  }
}
