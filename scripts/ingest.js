// scripts/ingest.js
//
// REAL data-ingestion CLI for NDF Beats. Replaces the mock seed with REAL
// targets for the service area (Stanislaus / San Joaquin / Merced, CA) by
// combining:
//   - Overpass (FREE)  : WHICH doors exist (candidate addresses + lat/lng/zip)
//   - Tracerfy (PAID)  : enrich a CAPPED subset with owner/value/age/contacts
//   - Census ACS (FREE): per-tract income band + demographics
// then runs the EXISTING scoring + beat-clustering and writes reps/targets/beats
// to SQLite via repo.js. The API routes, frontend, and scoreboard are untouched.
//
// ─── HARD COST CONTROL ──────────────────────────────────────────────────────
//   * --max=N (or MAX_LOOKUPS env), DEFAULT 0 (FREE-first). NEVER exceeded.
//     Paid Tracerfy enrichment is strictly opt-in: pass --max=N to allow N.
//   * Every PAID (uncached, live) Tracerfy call is counted; the run stops paying
//     the instant the cap is hit and finishes the remaining doors for FREE
//     (stub fallback) so the dataset is still complete.
//   * Each Tracerfy response is cached to data/cache/tracerfy/ keyed by address;
//     re-runs are FREE and never re-charge (idempotent + resumable).
//   * No token (TRACERFY_API_TOKEN unset) => Tracerfy is skipped entirely;
//     ingestion runs on scored Overpass + Census only, $0.
//   * Cost is logged continuously and summarized at the end ($ = lookups * 0.20).
//
// Usage:
//   node scripts/ingest.js --cities=Modesto --max=25
//   node scripts/ingest.js --cities=Modesto,Turlock --max=10 --per-city=400
//   MAX_LOOKUPS=5 node scripts/ingest.js            # default city Modesto
//
// Run after `node src/db/migrate.js` (or `npm run seed` once) so the schema
// exists. ingest.js applies the schema itself too (idempotent), so a fresh DB
// works directly.

import { randomUUID } from 'node:crypto';

import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/connection.js';
import {
  insertRep,
  insertTarget,
  insertBeat,
  insertBeatTarget,
  listActiveReps,
  getActiveIcpProfile,
  transaction,
  resetAll,
  tableCounts,
} from '../src/db/repo.js';
import { scoreTargetDetailed } from '../src/scoring/scoring.js';
import { clusterBeats } from '../src/scoring/beats.js';
import { partitionByEligibility } from '../src/scoring/compliance.js';
import { defaultProfile } from '../src/scoring/profile.js';

import { getCandidateAddresses, countyForCity } from '../src/adapters/addresses.js';
import { getDemographics, hasCensusKey } from '../src/adapters/census.js';
import { lookupProperty, hasTracerfyToken } from '../src/adapters/tracerfy.js';
import { lookupParcel, hasFreeAssessor } from '../src/adapters/assessor.js';

const COST_PER_LOOKUP = 0.2; // USD, per the Tracerfy contract (~$0.20/lookup)
const STATE = 'CA';

// Score against the manager-approved profile when one is persisted (set after
// migrate() inside ingest()); falls back to the hand-set default.
let activeIcpProfile = defaultProfile;

// ─── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

const CITIES = String(args.cities ?? 'Modesto')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Cap: --max wins, then MAX_LOOKUPS env, then default 0 (FREE-FIRST). Never
// negative. Default 0 means an accidental run spends $0 on Tracerfy — paid
// enrichment is strictly opt-in via --max=N (Ryan: keep it cheap, lean on FREE).
const MAX_LOOKUPS = Math.max(
  0,
  Math.trunc(Number(args.max ?? process.env.MAX_LOOKUPS ?? 0)),
);

// How many candidate addresses to pull per city from Overpass (FREE).
const PER_CITY = Math.max(50, Math.trunc(Number(args['per-city'] ?? 800)));

// ─── State for cost accounting ────────────────────────────────────────────────
let lookupsCharged = 0; // PAID (live) Tracerfy calls — the only spend
let lookupsCached = 0; // served from disk cache (free)
let lookupsStub = 0; // stub fallback (free)
let assessorFilled = 0; // FREE county-assessor value/age fills

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Default ZIP per city for rows Overpass leaves without a postcode (so the
// schema's NOT NULL zip is satisfied and Tracerfy gets a hint).
const CITY_DEFAULT_ZIP = {
  Modesto: '95350', Turlock: '95380', Ceres: '95307', Oakdale: '95361',
  Stockton: '95202', Manteca: '95336', Tracy: '95376', Lodi: '95240',
  Merced: '95340', Atwater: '95301', 'Los Banos': '93635',
};

// ─── Reps: reuse existing, else create a default team ─────────────────────────
function stableUuid(label) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let a = h >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let s = '';
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) s += '-';
    s += Math.floor(next() * 16).toString(16);
  }
  return s;
}

function defaultReps() {
  return [
    { id: `rep_${stableUuid('maria')}`, name: 'Maria Delgado', email: 'maria@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('deshawn')}`, name: 'DeShawn Carter', email: 'deshawn@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('priya')}`, name: 'Priya Nair', email: 'priya@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('carlos')}`, name: 'Carlos Mendez', email: 'carlos@ndf.example', role: 'manager', active: 1 },
  ];
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ─── Build one target row from a candidate address + enrichment ───────────────
// HONEST DATA ONLY (finding #1/#4): a signal with no real source stays UNKNOWN
// (null). No sweet-spot constants, no fabricated owner-occupancy, no "safe"
// compliance default. Scoring renormalizes over the known signals (data-starved
// doors score LOW), and known_signals/owner_occupied_known/solicit_status
// persist exactly what was real.
function buildTarget(addr, county, enrich, demo) {
  const value_cents = enrich.value_cents ?? null;
  const home_age = enrich.home_age ?? null;
  const owner_occupied = enrich.owner_occupied ?? null;      // null = UNKNOWN
  const tenure_years = enrich.tenure_years ?? null;
  const recently_sold = enrich.recently_sold ?? null;
  // Census income is real only from ACS (keyed); the keyless 'neutral' band is
  // a fabrication — treat it as unknown.
  const income_band = demo.source === 'census.acs5' ? (demo.income_band ?? null) : null;
  const no_soliciting = enrich.no_soliciting ?? null;
  const solicit_status = enrich.solicit_status
    ?? (no_soliciting === 1 ? 'do_not_solicit' : no_soliciting === 0 && enrich.source === 'tracerfy' ? 'clear' : 'unknown');

  const signals = { value_cents, home_age, owner_occupied, tenure_years, recently_sold, income_band };
  const detail = scoreTargetDetailed(signals, activeIcpProfile);

  return {
    id: `tgt_${randomUUID()}`,
    address: addr.address,
    city: addr.city,
    county,
    zip: addr.zip ?? CITY_DEFAULT_ZIP[addr.city] ?? '00000',
    lat: round6(addr.lat),
    lng: round6(addr.lng),
    value_cents,
    home_age,
    owner_occupied,
    owner_occupied_known: owner_occupied === null ? 0 : 1,
    tenure_years,
    recently_sold,
    income_band,
    score: detail.score,
    no_soliciting: no_soliciting === 1 ? 1 : 0,
    solicit_status,
    known_signals: JSON.stringify(detail.known),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function ingest() {
  console.log('═══ NDF Beats — REAL data ingestion ═══');
  console.log(`Service area cities : ${CITIES.join(', ')}`);
  console.log(`Tracerfy token      : ${hasTracerfyToken() ? 'SET (paid lookups enabled)' : 'UNSET (free stub fallback)'}`);
  console.log(`Census ACS key      : ${hasCensusKey() ? 'SET (real demographics)' : 'UNSET (neutral demographics)'}`);
  console.log(`MAX_LOOKUPS (cap)   : ${MAX_LOOKUPS}  (max spend ≈ $${(MAX_LOOKUPS * COST_PER_LOOKUP).toFixed(2)})`);
  console.log(`Addresses per city  : up to ${PER_CITY} (Overpass, free)`);
  console.log('');

  // Validate cities up front.
  for (const c of CITIES) {
    if (!countyForCity(c)) {
      throw new Error(`"${c}" is outside the NDF service area. Aborting (no charges incurred).`);
    }
  }

  migrate(); // idempotent schema
  const saved = getActiveIcpProfile();
  if (saved) {
    activeIcpProfile = saved.profile;
    console.log(`[profile] scoring with persisted ICP v${saved.version} (approved by ${saved.approved_by ?? 'n/a'})`);
  }

  // 1. FREE — candidate addresses from Overpass, per city.
  const candidates = [];
  for (const city of CITIES) {
    console.log(`[overpass] fetching addresses for ${city}…`);
    const rows = await getCandidateAddresses(city, { limit: PER_CITY });
    console.log(`  → ${rows.length} candidate doors in ${city}`);
    for (const r of rows) candidates.push({ ...r, county: countyForCity(city) });
    await sleep(1200); // be polite to the shared Overpass instance
  }

  if (candidates.length === 0) {
    throw new Error('Overpass returned no addresses. Aborting (no charges incurred).');
  }
  // Dedup by normalized address+city — Overpass returns a node AND a way for the
  // same building, which otherwise produces duplicate target rows.
  {
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
      const k = ((c.address || '') + '|' + (c.city || '')).toLowerCase().replace(/\s+/g, ' ').trim();
      if (!c.address || seen.has(k)) continue;
      seen.add(k);
      unique.push(c);
    }
    console.log(`Deduped ${candidates.length} → ${unique.length} unique doors`);
    candidates.length = 0;
    candidates.push(...unique);
  }
  console.log(`\nTotal candidate doors: ${candidates.length}`);

  // Choose WHICH doors to spend Tracerfy on: highest candidates first is moot
  // pre-enrichment, so we take an evenly-spread sample up to the cap to cover
  // the geography, then enrich the rest for free (stub/neutral).
  const enrichCount = Math.min(MAX_LOOKUPS, candidates.length);
  console.log(
    `Will PAY to enrich up to ${enrichCount} door(s) via Tracerfy; ` +
      `the remaining ${candidates.length - enrichCount} use free fallback.\n`,
  );

  // 2 + 3. Enrich each candidate. Tracerfy is capped; Census is free for all.
  const targets = [];
  for (let i = 0; i < candidates.length; i++) {
    const addr = candidates[i];

    // Census demographics (FREE) for every door.
    let demo;
    try {
      demo = await getDemographics(addr.lat, addr.lng);
    } catch (err) {
      console.log(`  [census] ${addr.address}: ${err.message}; neutral band`);
      demo = { income_band: 5, source: 'census.neutral' };
    }

    // Tracerfy enrichment — only while under the cap do we allow a paid call.
    const underCap = lookupsCharged < MAX_LOOKUPS;
    const wantPaid = hasTracerfyToken() && i < enrichCount;
    const allowNetwork = wantPaid && underCap;

    const zip = addr.zip ?? CITY_DEFAULT_ZIP[addr.city] ?? '';
    let enrich;
    let wasCharged = false;
    try {
      const { data, charged, source } = await lookupProperty(
        { address: addr.address, city: addr.city, state: STATE, zip_code: zip },
        { allowNetwork },
      );
      enrich = data;
      if (charged) {
        wasCharged = true;
        lookupsCharged += 1;
        console.log(
          `  [tracerfy PAID ${lookupsCharged}/${MAX_LOOKUPS}] ${addr.address}, ${addr.city} ` +
            `(value=${data.value_cents ? '$' + (data.value_cents / 100).toLocaleString() : 'n/a'}, ` +
            `built=${data.year_built ?? 'n/a'}, owner_occ=${data.owner_occupied})`,
        );
      } else if (source === 'tracerfy.cache') {
        lookupsCached += 1;
      } else {
        lookupsStub += 1;
      }
    } catch (err) {
      // A failed paid call should NOT abort the whole run; fall back to stub.
      console.log(`  [tracerfy] ${addr.address}: ${err.message}; using free fallback`);
      const { data } = await lookupProperty(
        { address: addr.address, city: addr.city, state: STATE, zip_code: zip },
        { allowNetwork: false },
      );
      enrich = data;
      lookupsStub += 1;
    }

    // FREE county-assessor enrichment ($0) — for doors we did NOT pay to enrich,
    // fill (or correct) value + home-age from open parcel data where the county
    // has a verified free endpoint (San Joaquin today). Real roll value beats a
    // synthetic fallback; never aborts the run.
    if (!wasCharged && hasFreeAssessor(addr.county)) {
      const parcel = await lookupParcel(addr.lat, addr.lng, addr.county);
      if (parcel && (parcel.value_cents != null || parcel.home_age != null)) {
        if (parcel.value_cents != null) enrich.value_cents = parcel.value_cents;
        if (parcel.home_age != null) enrich.home_age = parcel.home_age;
        enrich.enrich_source = parcel.source; // 'assessor.free'
        assessorFilled += 1;
      }
    }

    targets.push(buildTarget(addr, addr.county, enrich, demo));

    if ((i + 1) % 50 === 0) {
      console.log(
        `  …processed ${i + 1}/${candidates.length} doors ` +
          `(paid ${lookupsCharged}, cached ${lookupsCached}, free ${lookupsStub})`,
      );
    }
  }

  // 4. Score is already computed per target. Apply the HARD compliance gate
  //    (verified owner-occupancy + no do-not-solicit flag; unknown ≠ safe),
  //    then cluster the eligible doors into beats.
  console.log('\n[scoring] applying compliance gate + clustering into beats…');
  const { eligible: gated, excluded } = partitionByEligibility(targets);
  const eligible = gated.slice().sort((a, b) => b.score - a.score);
  console.log(
    `  eligibility: ${eligible.length} knockable · excluded ${excluded.dnc} DNC/no-solicit, ` +
      `${excluded.ownerUnknown} owner-occupancy UNKNOWN (needs enrichment), ${excluded.nonOwner} non-owner-occupied`,
  );
  if (eligible.length === 0) {
    console.log(
      '  NOTE: no doors passed the compliance gate. Owner-occupancy must be VERIFIED\n' +
        '  (Tracerfy --max=N enrichment) before doors are beat-eligible — the gate never\n' +
        '  defaults to "safe to knock". Targets were still ingested and scored.',
    );
  }
  const clustered = clusterBeats(eligible, 50);
  console.log(`  → ${clustered.length} beat(s) from ${eligible.length} eligible doors`);

  // Reps: reuse any existing active reps, else create the default team.
  const existingReps = listActiveReps();
  const reps = existingReps.length ? existingReps : defaultReps();
  const repsOnly = reps.filter((r) => r.role === 'rep');

  // Assign ~2 beats per rep; leave the rest unassigned/ready.
  const beats = clustered.map((b, i) => {
    const repIndex = Math.floor(i / 2);
    const assignTo = repIndex < repsOnly.length ? repsOnly[repIndex] : null;
    let status = 'ready';
    if (assignTo) status = i % 2 === 0 ? 'active' : 'ready';
    return {
      id: `beat_${randomUUID()}`,
      name: b.name,
      city: b.city,
      county: b.county,
      rep_id: assignTo ? assignTo.id : null,
      status,
      center_lat: round6(b.center.lat),
      center_lng: round6(b.center.lng),
      target_count: b.target_count,
      _members: b.targets,
    };
  });

  // 5. Persist via repo.js (data abstraction honored). Rebuild from clean slate
  //    so ingestion is deterministic per input + idempotent.
  console.log('\n[db] writing reps / targets / beats via repo…');
  transaction(() => {
    resetAll();
    for (const r of reps) insertRep(r);
    for (const t of targets) insertTarget(t);
    for (const b of beats) {
      insertBeat({
        id: b.id, name: b.name, city: b.city, county: b.county,
        rep_id: b.rep_id, status: b.status,
        center_lat: b.center_lat, center_lng: b.center_lng,
        target_count: b.target_count,
      });
      for (const m of b._members) {
        insertBeatTarget({ beat_id: b.id, target_id: m.target_id, seq: m.seq, explore: m.explore ?? 0 });
      }
    }
  });

  // ─── Summary + COST report ──────────────────────────────────────────────────
  const counts = tableCounts();
  const spend = (lookupsCharged * COST_PER_LOOKUP).toFixed(2);
  console.log('\n═══ Ingestion complete ═══');
  console.log(`DB rows           : ${JSON.stringify(counts)}`);
  console.log(`Tracerfy PAID     : ${lookupsCharged} lookup(s)  →  ESTIMATED COST $${spend}`);
  console.log(`Tracerfy cached   : ${lookupsCached} (free, re-run)`);
  console.log(`Free fallback     : ${lookupsStub} (stub/no-token)`);
  console.log(`Free assessor fill: ${assessorFilled} door(s) got real value/age from county open data ($0)`);
  console.log(`Cap (MAX_LOOKUPS) : ${MAX_LOOKUPS} — ${lookupsCharged <= MAX_LOOKUPS ? 'respected' : 'EXCEEDED (bug!)'}`);
  if (!hasTracerfyToken()) {
    console.log('NOTE: no TRACERFY_API_TOKEN — ran fully on free Overpass+Census (+stub). $0 spent.');
  }
  console.log('\nStart the app:  npm start   →   http://localhost:4178/');
}

ingest()
  .catch((err) => {
    console.error('\n[ingest] FAILED:', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    closeDb();
  });
