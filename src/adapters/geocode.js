// src/adapters/geocode.js
//
// ====================  R E A L   —   FREE  ====================================
// Forward geocoding: one-line address -> { lat, lng }. Two free providers:
//   1. US Census "onelineaddress" geocoder — keyless, no signup. NOTE: its WAF
//      rejects datacenter IPs (observed live on the sandbox box 2026-07-21:
//      HTTP 200 with an HTML "Request Rejected" body), so it mostly works from
//      residential networks / local dev only.
//   2. OSM Nominatim — fallback when Census yields nothing. Light use only
//      (their policy: ~1 req/s); walk-in doors are a few per day. Descriptive
//      User-Agent per policy.
//
// Used by POST /api/knocks/manual so a walk-in door pins at the real house
// instead of stacking on the beat center. Contract: NEVER throws and NEVER
// invents coordinates — any failure (no match, HTTP error, timeout, junk
// coordinates) returns null and the caller falls back to the beat center.
// ==============================================================================

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'ndf-beats/1.0 (ryan@kitchenhomeandbath.com)';

/**
 * Geocode a one-line address. Census first, Nominatim fallback.
 * @param {string} oneLine   e.g. "1332 Merritt St Turlock CA"
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{lat:number,lng:number,matched:string|null}|null>}
 */
export async function geocodeAddress(oneLine, { timeoutMs = 3500 } = {}) {
  const address = typeof oneLine === 'string' ? oneLine.trim() : '';
  if (!address) return null;
  return (await censusLookup(address, timeoutMs))
      ?? (await nominatimLookup(address, timeoutMs));
}

async function censusLookup(address, timeoutMs) {
  const url =
    `${CENSUS_URL}?address=${encodeURIComponent(address)}` +
    '&benchmark=Public_AR_Current&format=json';
  const json = await fetchJson(url, timeoutMs);
  const match = json?.result?.addressMatches?.[0];
  return shape(match?.coordinates?.y, match?.coordinates?.x, match?.matchedAddress);
}

async function nominatimLookup(address, timeoutMs) {
  const url =
    `${NOMINATIM_URL}?q=${encodeURIComponent(address)}` +
    '&format=jsonv2&limit=1&countrycodes=us';
  const json = await fetchJson(url, timeoutMs);
  const hit = Array.isArray(json) ? json[0] : null;
  return shape(hit?.lat, hit?.lon, hit?.display_name);
}

async function fetchJson(url, timeoutMs) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) return null;
    return await res.json(); // WAF-rejection HTML bodies throw here -> null
  } catch {
    return null;
  }
}

function shape(rawLat, rawLng, matched) {
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, matched: matched ?? null };
}
