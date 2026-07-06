// src/adapters/tracerfy.js
//
// ====================  R E A L   —   PAID  (~$0.20 / lookup)  ==================
// Tracerfy Property Data API: enriches a GIVEN address with owner, property
// facts (value, year built, equity, last sale), and contacts (phones/emails with
// DNC/litigator flags). It does NOT discover addresses — that's the (free)
// Overpass adapter's job.
//
// COST CONTROL lives in the caller (scripts/ingest.js), which enforces a hard
// MAX_LOOKUPS cap. This module ALSO protects spend two ways:
//   1. Disk cache (data/cache/tracerfy/<hash>.json): a previously-looked-up
//      address is served from cache and NEVER re-charged. Re-runs are free.
//   2. No token => no call: if TRACERFY_API_TOKEN is unset, lookups fall back to
//      tracerly.stub.js (the existing deterministic mock) so ingestion still
//      produces a scored dataset for free. The stub is the ONLY fallback path.
//
// Every real (uncached) network call is reported back to the caller via the
// returned `charged` flag so the ingestion script can count spend exactly.
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ROOT_DIR } from '../config.js';

const API_URL = process.env.TRACERFY_API_URL ?? 'https://tracerfy.com/v1/api/lead-builder/lookup/';
const API_TOKEN = process.env.TRACERFY_API_TOKEN ?? null;
const CACHE_DIR = path.join(ROOT_DIR, 'data', 'cache', 'tracerfy');

const CURRENT_YEAR = new Date().getUTCFullYear();

/** True when a real token is configured (ingestion logs this up front). */
export function hasTracerfyToken() {
  return Boolean(API_TOKEN);
}

/** Stable cache filename for an address lookup (normalized, hashed). */
function cacheKey({ address, city, state, zip_code }) {
  const norm = [address, city, state, zip_code]
    .map((s) => String(s ?? '').trim().toLowerCase())
    .join('|');
  const hash = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 32);
  return path.join(CACHE_DIR, `${hash}.json`);
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

/** Normalize an address-ish string for the owner-occupancy heuristic. */
function normAddr(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Infer owner-occupancy: true when the mailing address matches the property
 * address (owner gets mail at the home). When the API gives no mailing address
 * the answer is UNKNOWN (null) — never fabricated 'true'. Unknown doors fail
 * the hard compliance gate until verified (finding #4).
 */
function inferOwnerOccupied(propertyAddress, mailing) {
  const m = mailing?.address ?? mailing?.street ?? mailing?.full_address ?? null;
  if (!m) return null;
  const a = normAddr(propertyAddress);
  const b = normAddr(m);
  if (!a || !b) return null;
  // Match on the leading house-number + street token run.
  return b.startsWith(a) || a.startsWith(b) || b.includes(a);
}

/** Years since the last sale date (for tenure), or null if unparseable. */
function tenureFromSaleDate(lastSaleDate) {
  if (!lastSaleDate) return null;
  const t = Date.parse(lastSaleDate);
  if (Number.isNaN(t)) return null;
  const years = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
  return years < 0 ? 0 : Math.round(years);
}

/** Sold within ~18 months => recently_sold flag; null when the date is unknown. */
function recentlySold(lastSaleDate) {
  const tenure = tenureFromSaleDate(lastSaleDate);
  if (tenure == null) return null; // UNKNOWN, not "no"
  return tenure <= 1 ? 1 : 0; // <=1 rounded year ~ within ~18mo
}

/**
 * Map a raw Tracerfy response into the canonical target/enrichment shape the
 * ingestion script feeds to scoring + the repo.
 * @param {Object} raw - Tracerfy JSON
 * @param {string} propertyAddress - the address we looked up (for owner-occ inference)
 */
export function mapTracerfyResponse(raw, propertyAddress) {
  const prop = raw?.property ?? {};
  const owners = Array.isArray(raw?.owners) ? raw.owners : [];
  const contacts = raw?.contacts ?? {};
  const phones = Array.isArray(contacts.phones) ? contacts.phones : [];
  const emails = Array.isArray(contacts.emails) ? contacts.emails : [];

  const owner = owners[0]
    ? `${owners[0].first_name ?? ''} ${owners[0].last_name ?? ''}`.trim()
    : null;

  const yearBuilt = Number(prop.year_built) || null;
  const homeAge = yearBuilt ? Math.max(0, CURRENT_YEAR - yearBuilt) : null;

  const valueDollars = Number(prop.estimated_value) || null;
  const valueCents = valueDollars ? Math.round(valueDollars * 100) : null;

  const tenureYears = tenureFromSaleDate(prop.last_sale_date);
  const sold = recentlySold(prop.last_sale_date);

  const ownerOccupied = inferOwnerOccupied(propertyAddress, raw?.mailing_address);

  // DNC / litigator => mark the door no_soliciting (skip it). Any phone flagged
  // DNC, or a litigator flag, trips it. A verified-clean contact check yields
  // 'clear'; when Tracerfy returned no contacts to check, status stays UNKNOWN.
  const anyDnc = phones.some((p) => p.dnc === true || p.dnc === 1);
  const litigator = raw?.contacts?.litigator === true || raw?.litigator === true;
  const noSoliciting = anyDnc || litigator ? 1 : 0;
  const solicitStatus = noSoliciting ? 'do_not_solicit' : (phones.length > 0 ? 'clear' : 'unknown');

  return {
    hit: raw?.hit !== false,
    owner_name: owner,
    owner_occupied: ownerOccupied === null ? null : (ownerOccupied ? 1 : 0),
    solicit_status: solicitStatus,
    value_cents: valueCents,
    home_age: homeAge,
    year_built: yearBuilt,
    tenure_years: tenureYears,
    recently_sold: sold,
    no_soliciting: noSoliciting,
    estimated_equity: Number(prop.estimated_equity) || null,
    equity_percent: Number(prop.equity_percent) || null,
    lender_name: prop.lender_name ?? null,
    // Contacts kept for the rep app / future use (not in the targets schema).
    contacts: {
      phones: phones.map((p) => ({
        number: p.number,
        type: p.type,
        dnc: Boolean(p.dnc),
        tcpa: Boolean(p.tcpa),
        carrier: p.carrier ?? null,
        rank: p.rank ?? null,
      })),
      emails: emails.map((e) => ({ email: e.email, rank: e.rank ?? null })),
      litigator,
      has_contact: Boolean(contacts.has_contact),
    },
    source: 'tracerfy',
  };
}

/**
 * Look up a single property.
 *
 * Resolution order (and what it costs):
 *   1. Disk cache hit               -> returns mapped data, charged=false (FREE)
 *   2. No token configured          -> stub fallback,      charged=false (FREE)
 *   3. Live API call                -> returns mapped data, charged=true  ($0.20)
 *
 * The caller MUST check `charged` and count it against MAX_LOOKUPS. This module
 * never makes a charged call when a cache entry exists.
 *
 * @param {{address:string, city:string, state:string, zip_code:string}} q
 * @param {Object} [opts]
 * @param {boolean} [opts.allowNetwork=true] - false => never make a paid call
 *        (cache + stub only); the ingestion script flips this off once the cap
 *        is reached so it can finish the run for free.
 * @returns {Promise<{data:Object, charged:boolean, source:string}>}
 */
export async function lookupProperty(q, { allowNetwork = true } = {}) {
  const file = cacheKey(q);

  // 1. Cache (free, idempotent — re-runs never re-charge).
  const cached = readCache(file);
  if (cached) {
    return {
      data: mapTracerfyResponse(cached, q.address),
      charged: false,
      source: 'tracerfy.cache',
    };
  }

  // 2. No token, or network disabled (cap reached) => HONEST UNKNOWNS (free).
  // We used to substitute the deterministic mock here, but fabricated
  // owner/tenure/age data poisoned scoring AND compliance (every un-enriched
  // door looked identical + "safe"). Unknown data now stays unknown: scoring
  // renormalizes over known signals, and the compliance gate excludes doors
  // whose owner-occupancy was never verified. (tracerly.stub.js remains for
  // offline experiments via getStubProperty — never fed into real ingestion.)
  if (!API_TOKEN || !allowNetwork) {
    return {
      data: {
        hit: false,
        owner_name: null,
        owner_occupied: null,   // UNKNOWN, not fabricated
        value_cents: null,
        home_age: null,
        year_built: null,
        tenure_years: null,
        recently_sold: null,
        no_soliciting: null,    // UNKNOWN — never defaulted to "safe"
        solicit_status: 'unknown',
        estimated_equity: null,
        equity_percent: null,
        lender_name: null,
        contacts: { phones: [], emails: [], litigator: false, has_contact: false },
        source: 'unenriched',
      },
      charged: false,
      source: 'unenriched',
    };
  }

  // 3. Live, paid call. THIS is the only path that costs money.
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      address: q.address,
      city: q.city,
      state: q.state,
      zip_code: q.zip_code,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tracerfy HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const raw = await res.json();
  // Cache the RAW response so re-runs are free and we can re-map later without
  // re-charging. Even a miss (hit:false) is cached — we paid to learn it.
  writeCache(file, raw);

  return {
    data: mapTracerfyResponse(raw, q.address),
    charged: true,
    source: 'tracerfy',
  };
}
