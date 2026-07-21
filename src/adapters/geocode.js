// src/adapters/geocode.js
//
// ====================  R E A L   —   FREE  ====================================
// Forward geocoding: one-line address -> { lat, lng }. US Census "onelineaddress"
// geocoder — free, keyless, no signup (same service census.js uses for tracts).
//
// Used by POST /api/knocks/manual so a walk-in door pins at the real house
// instead of stacking on the beat center. Contract: NEVER throws and NEVER
// invents coordinates — any failure (no match, HTTP error, timeout, junk
// coordinates) returns null and the caller falls back to the beat center.
// ==============================================================================

const ONELINE_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';

/**
 * Geocode a one-line address (free, keyless Census geocoder).
 * @param {string} oneLine   e.g. "1332 Merritt St Turlock CA"
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{lat:number,lng:number,matched:string|null}|null>}
 */
export async function geocodeAddress(oneLine, { timeoutMs = 3500 } = {}) {
  const address = typeof oneLine === 'string' ? oneLine.trim() : '';
  if (!address) return null;

  const url =
    `${ONELINE_URL}?address=${encodeURIComponent(address)}` +
    '&benchmark=Public_AR_Current&format=json';
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': 'ndf-beats/1.0' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const match = json?.result?.addressMatches?.[0];
    const lat = Number(match?.coordinates?.y);
    const lng = Number(match?.coordinates?.x);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng, matched: match.matchedAddress ?? null };
  } catch {
    return null;
  }
}
