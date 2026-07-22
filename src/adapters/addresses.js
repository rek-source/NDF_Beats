// src/adapters/addresses.js
//
// ====================  R E A L   —   FREE  ====================================
// Candidate-address source. Uses the OpenStreetMap Overpass API to fetch
// residential addresses (OSM elements tagged with addr:housenumber + addr:street)
// inside a city/admin area, returning {street, housenumber, address, city, zip,
// lat, lng}. This is the source of WHICH doors exist in the service area; the
// PAID Tracerfy adapter only enriches a given address — it does not discover them.
//
// FREE: no key, no charge. Overpass is rate-limited and asks for a descriptive
// User-Agent; we send one and back off politely. Used at ingestion time only
// (scripts/ingest.js), never at request time by the running server.
// ==============================================================================

const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
// A plain UA token. Overpass's Apache front-end 406s requests whose UA contains
// punctuation like parentheses/semicolons, so keep it simple (it still 406s an
// EMPTY user-agent, which is the real thing being guarded against).
const USER_AGENT = 'ndf-beats-ingest/1.0';

/** Cities allowed in this service area (county is attached for the schema). */
export const SERVICE_AREA = Object.freeze({
  // Stanislaus
  Modesto: 'Stanislaus',
  Turlock: 'Stanislaus',
  Ceres: 'Stanislaus',
  Oakdale: 'Stanislaus',
  // San Joaquin
  Stockton: 'San Joaquin',
  Manteca: 'San Joaquin',
  Tracy: 'San Joaquin',
  Lodi: 'San Joaquin',
  // Merced
  Merced: 'Merced',
  Atwater: 'Merced',
  'Los Banos': 'Merced',
});

/** Resolve a city name to its NDF county, or null if outside the service area. */
export function countyForCity(city) {
  return SERVICE_AREA[city] ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build an Overpass QL query for residential addressed nodes/ways within a
 * named California city. We restrict to admin areas (admin_level 6=county,
 * 8=city) named like the city, in California, and pull elements that carry both
 * a housenumber and a street (a real mailing address). `out center` gives ways
 * a representative lat/lng.
 *
 * @param {string} city
 * @param {number} limit - max elements to return from Overpass
 */
function buildQuery(city, limit) {
  // Escape double quotes in the city name for the QL string literal.
  const safe = String(city).replace(/"/g, '\\"');
  return `
    [out:json][timeout:60];
    area["name"="California"]["admin_level"="4"]->.ca;
    area["name"="${safe}"]["boundary"="administrative"](area.ca)->.city;
    (
      node["addr:housenumber"]["addr:street"](area.city);
      way["addr:housenumber"]["addr:street"]["building"](area.city);
    );
    out center ${Math.max(1, Math.trunc(limit))};
  `.trim();
}

/**
 * Overpass QL for every addressed door within `radiusM` meters of a point —
 * project-seeded beats (2026-07-21): the walkable ring around a completed
 * KHB project.
 */
function buildAroundQuery(lat, lng, radiusM, limit) {
  const r = Math.max(1, Math.trunc(radiusM));
  return `
    [out:json][timeout:60];
    (
      node["addr:housenumber"]["addr:street"](around:${r},${lat},${lng});
      way["addr:housenumber"]["addr:street"](around:${r},${lat},${lng});
    );
    out center ${Math.max(1, Math.trunc(limit))};
  `.trim();
}

/**
 * POST a query to Overpass with retry/backoff on 429/504 (the documented
 * rate-limit/timeout codes). Returns parsed JSON.
 */
async function overpass(query, { retries = 3 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass's Apache front-end returns 406 to clients that omit a plain
        // Accept header (e.g. Node's fetch), so send one explicitly.
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: new URLSearchParams({ data: query }).toString(),
    });

    if (res.ok) return res.json();

    // 429 (rate limited) and 504 (gateway timeout) are retryable.
    if ((res.status === 429 || res.status === 504) && attempt < retries) {
      const waitMs = 2000 * 2 ** attempt;
      console.log(
        `  [overpass] HTTP ${res.status}; backing off ${waitMs}ms (attempt ${attempt + 1}/${retries})`,
      );
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    const body = await res.text().catch(() => '');
    throw new Error(`Overpass HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Normalize one Overpass element into a candidate address row, or null if it
 * lacks the fields we need.
 * @param {string} city - the city we queried (used when the element omits addr:city)
 */
function normalizeElement(el, city) {
  const tags = el.tags ?? {};
  const housenumber = tags['addr:housenumber'];
  const street = tags['addr:street'];
  if (!housenumber || !street) return null;

  // Nodes carry lat/lon directly; ways carry a `center` from `out center`.
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  return {
    address: `${housenumber} ${street}`,
    housenumber: String(housenumber),
    street: String(street),
    city: tags['addr:city'] ?? city,
    zip: tags['addr:postcode'] ?? null,
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    osm_type: el.type,
    osm_id: el.id,
    source: 'overpass',
  };
}

/**
 * Fetch candidate residential addresses for a city.
 * @param {string} city - e.g. "Modesto" (must be in SERVICE_AREA)
 * @param {Object} [opts]
 * @param {number} [opts.limit=1500] - max addresses to fetch from Overpass
 * @returns {Promise<Array<{address,housenumber,street,city,zip,lat,lng,osm_type,osm_id,source}>>}
 *
 * Deduplicated by (address, rounded lat/lng) so the same door isn't returned
 * twice. Rows missing a ZIP keep zip=null; the ingestion script backfills ZIP
 * from Tracerfy or a city default.
 */
/**
 * Fetch every addressed door within radiusM meters of a point (Overpass
 * `around:`). Same normalization + dedupe as getCandidateAddresses.
 * @param {number} lat
 * @param {number} lng
 * @param {number} radiusM  walking radius in meters (e.g. 420)
 * @param {{city?: string, limit?: number}} [opts] fallback city for rows
 *        whose OSM tags omit addr:city
 */
export async function getAddressesNearPoint(lat, lng, radiusM, { city = null, limit = 800 } = {}) {
  const json = await overpass(buildAroundQuery(lat, lng, radiusM, limit));
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const seen = new Set();
  const rows = [];
  for (const el of elements) {
    const row = normalizeElement(el, city);
    if (!row) continue;
    const key = `${row.address.toLowerCase()}|${row.lat}|${row.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

export async function getCandidateAddresses(city, { limit = 1500 } = {}) {
  if (!countyForCity(city)) {
    throw new Error(`"${city}" is outside the NDF service area (${Object.keys(SERVICE_AREA).join(', ')})`);
  }

  const json = await overpass(buildQuery(city, limit));
  const elements = Array.isArray(json.elements) ? json.elements : [];

  const seen = new Set();
  const rows = [];
  for (const el of elements) {
    const row = normalizeElement(el, city);
    if (!row) continue;
    const key = `${row.address.toLowerCase()}|${row.lat}|${row.lng}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}
