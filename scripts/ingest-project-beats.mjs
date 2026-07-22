// scripts/ingest-project-beats.mjs
//
// NEIGHBOR-PROOF BEATS ($0 data budget, owner-approved 2026-07-21).
// Seeds beats from COMPLETED KHB projects (data/khb-projects.json, produced by
// scripts/khb-projects/extract.mjs) instead of paid per-door enrichment:
//
//   1. Every real OSM door within WALK_RADIUS_M of each completed project.
//   2. FREE Census enrichment per door: real tract income band (needs
//      CENSUS_API_KEY; census.gov is WAF-blocked from the prod box — run this
//      from the workstation) + tract owner-occupancy rate (relaxed-gate input).
//   3. Honest scoring: value/age/owner/tenure stay UNKNOWN; score comes from
//      khb_proximity + income_band and is coverage-scaled (so ~35 is a GOOD
//      score under this data budget — it ranks correctly, it doesn't flatter).
//   4. NON-DESTRUCTIVE: knocks, sales, reps, walk-in + custom beats, and any
//      knocked beat are preserved. Only unknocked kind='auto' beats are
//      replaced (same policy as the profile-approval rebuild).
//
// Usage: node scripts/ingest-project-beats.mjs [--radius=420] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { getAddressesNearPoint } from '../src/adapters/addresses.js';
import { getDemographics, hasCensusKey } from '../src/adapters/census.js';
import { countyForCity } from '../src/adapters/addresses.js';
import { scoreTargetDetailed } from '../src/scoring/scoring.js';
import { clusterBeats } from '../src/scoring/beats.js';
import { partitionByEligibility } from '../src/scoring/compliance.js';
import {
  insertTarget, insertBeat, insertBeatTarget, transaction,
  listAllTargets, listTargetsNotInBeats, listBeatsWithKnockCounts,
  deleteBeatIfUnknocked, updateTargetGeoSignals, tableCounts,
} from '../src/db/repo.js';
import { closeDb } from '../src/db/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEDS = path.join(__dirname, '..', 'data', 'khb-projects.json');

const argOf = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : dflt;
};
const WALK_RADIUS_M = Number(argOf('radius', '420'));
const DRY_RUN = process.argv.includes('--dry-run');

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Haversine in METERS (beats.js keeps its own km version private).
function distanceM(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const normAddr = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  console.log(`═══ NDF Beats — project-seeded ingest (radius ${WALK_RADIUS_M}m${DRY_RUN ? ', DRY RUN' : ''}) ═══`);
  if (!fs.existsSync(SEEDS)) {
    throw new Error(`${SEEDS} missing — run scripts/khb-projects/extract.mjs first`);
  }
  if (!hasCensusKey()) {
    console.log('WARNING: CENSUS_API_KEY unset — income bands will be neutral/unknown.');
  }
  const { projects } = JSON.parse(fs.readFileSync(SEEDS, 'utf8'));
  console.log(`${projects.length} completed-project seeds: ${projects.map((p) => `${p.address} (${p.city})`).join(' · ')}`);

  // ── 1. doors within walking radius of each project ────────────────────────
  const projectAddrs = new Set(projects.map((p) => normAddr(p.address)));
  const existing = new Set(listAllTargets().map((t) => `${normAddr(t.address)}|${normAddr(t.city)}`));
  const doorByKey = new Map();
  for (const p of projects) {
    const rows = await getAddressesNearPoint(p.lat, p.lng, WALK_RADIUS_M, { city: p.city });
    console.log(`  ${p.address}, ${p.city}: ${rows.length} doors within ${WALK_RADIUS_M}m`);
    for (const row of rows) {
      const key = `${normAddr(row.address)}|${normAddr(row.city)}`;
      if (projectAddrs.has(normAddr(row.address))) continue; // already a customer
      if (existing.has(key)) continue;                        // already in the DB
      if (!doorByKey.has(key)) doorByKey.set(key, row);
    }
    await sleep(1500); // Overpass politeness
  }
  const doors = [...doorByKey.values()];
  console.log(`${doors.length} new unique doors (project homes + already-known doors excluded)`);

  // ── 2. enrich + score (honest: unknown stays unknown) ─────────────────────
  const targets = [];
  let censusFails = 0;
  for (let i = 0; i < doors.length; i++) {
    const d = doors[i];
    let demo;
    try {
      demo = await getDemographics(d.lat, d.lng); // in-process tract cache
    } catch {
      censusFails += 1;
      demo = { income_band: 5, source: 'census.neutral', owner_occupancy_rate: null };
    }
    const income_band = demo.source === 'census.acs5' ? (demo.income_band ?? null) : null;
    const tract_owner_occ_rate = demo.owner_occupancy_rate ?? null;
    const khb_project_dist_m = Math.round(Math.min(...projects.map((p) => distanceM(d, p))));

    const signals = {
      value_cents: null, home_age: null, owner_occupied: null,
      tenure_years: null, recently_sold: null,
      income_band, khb_project_dist_m,
    };
    const detail = scoreTargetDetailed(signals);
    targets.push({
      id: `tgt_${randomUUID()}`,
      address: d.address, city: d.city,
      county: countyForCity(d.city) ?? 'Stanislaus',
      zip: d.zip ?? '00000',
      lat: round6(d.lat), lng: round6(d.lng),
      value_cents: null, home_age: null, owner_occupied: null,
      owner_occupied_known: 0, tenure_years: null, recently_sold: null,
      income_band, score: detail.score,
      no_soliciting: 0, solicit_status: 'unknown',
      known_signals: JSON.stringify(detail.known),
      khb_project_dist_m, tract_owner_occ_rate,
    });
    if ((i + 1) % 100 === 0) console.log(`  …enriched ${i + 1}/${doors.length}`);
  }
  if (censusFails) console.log(`  [census] ${censusFails} door(s) fell back to neutral demographics`);

  // ── 2b. EXISTING in-radius doors (OSM coverage near some projects is thin;
  // the DB already holds real city-wide OSM doors from the earlier ingest).
  // Their fabricated legacy signals are NOT trusted: unless known_signals
  // lists a signal as real, it is treated as unknown; score is recomputed
  // honestly from proximity + tract data. Knocked/beat-member doors keep
  // their history — only beat-less doors join the clustering pool.
  const existingUpdates = [];
  const legacyRows = listAllTargets().filter((t) => !doorByKey.has(`${normAddr(t.address)}|${normAddr(t.city)}`));
  for (const t of legacyRows) {
    const dist = Math.round(Math.min(...projects.map((p) => distanceM(t, p))));
    if (dist > WALK_RADIUS_M) continue;
    let demo;
    try {
      demo = await getDemographics(t.lat, t.lng);
    } catch {
      demo = { income_band: 5, source: 'census.neutral', owner_occupancy_rate: null };
    }
    const real = new Set(JSON.parse(t.known_signals || '[]'));
    const signals = {
      value_cents: real.has('value') ? t.value_cents : null,
      home_age: real.has('home_age') ? t.home_age : null,
      owner_occupied: real.has('owner_occupied') ? t.owner_occupied : null,
      tenure_years: real.has('tenure') ? t.tenure_years : null,
      recently_sold: real.has('recently_sold') ? t.recently_sold : null,
      income_band: demo.source === 'census.acs5' ? (demo.income_band ?? null) : null,
      khb_project_dist_m: dist,
    };
    const detail = scoreTargetDetailed(signals);
    existingUpdates.push({
      id: t.id, row: t,
      khb_project_dist_m: dist,
      tract_owner_occ_rate: demo.owner_occupancy_rate ?? null,
      score: detail.score,
      known_signals: JSON.stringify(detail.known),
    });
  }
  console.log(`${existingUpdates.length} EXISTING doors sit within ${WALK_RADIUS_M}m of a project (honest re-score)`);

  // ── 3+4. rebuild inside one transaction, preserving all history ───────────
  // Order matters: delete unknocked auto-beats FIRST (frees their member
  // doors), apply honest re-scores, insert the new doors, THEN gate + cluster
  // every beat-less in-radius door and write the new beats.
  if (DRY_RUN) {
    const { eligible, excluded } = partitionByEligibility(
      [...targets, ...existingUpdates.map((u) => ({ ...u.row, ...u }))],
    );
    console.log(
      `DRY RUN pool (approx): ${eligible.length} knockable · excluded ${excluded.dnc} DNC, ` +
        `${excluded.ownerUnknown} owner-unknown, ${excluded.nonOwner} non-owner — nothing written.`,
    );
    return;
  }

  let beatsDeleted = 0;
  let beats = [];
  transaction(() => {
    for (const b of listBeatsWithKnockCounts()) {
      if (b.kind !== 'auto' || b.knock_count > 0) continue;
      beatsDeleted += deleteBeatIfUnknocked(b.id);
    }
    for (const u of existingUpdates) {
      updateTargetGeoSignals(u.id, {
        khb_project_dist_m: u.khb_project_dist_m,
        tract_owner_occ_rate: u.tract_owner_occ_rate,
        score: u.score,
        known_signals: u.known_signals,
      });
    }
    for (const t of targets) insertTarget(t);

    const free = listTargetsNotInBeats().filter(
      (t) => t.khb_project_dist_m !== null && t.khb_project_dist_m <= WALK_RADIUS_M,
    );
    const { eligible, excluded } = partitionByEligibility(free);
    const pool = eligible.slice().sort((a, b) => b.score - a.score);
    console.log(
      `eligibility: ${pool.length} knockable · excluded ${excluded.dnc} DNC, ` +
        `${excluded.ownerUnknown} owner-unknown (low/no tract rate), ${excluded.nonOwner} non-owner`,
    );

    const clustered = clusterBeats(pool, 50);
    beats = clustered.map((b) => {
      const nearest = projects.reduce((best, p) =>
        distanceM(b.center, p) < distanceM(b.center, best) ? p : best);
      const street = nearest.address.replace(/^\d+[A-Za-z]?\s+/, '');
      return { ...b, name: `${b.city} · near ${street}` };
    });
    const nameCount = new Map();
    for (const b of beats) {
      const n = (nameCount.get(b.name) ?? 0) + 1;
      nameCount.set(b.name, n);
      if (n > 1) b.name = `${b.name} ${n}`;
    }

    for (const b of beats) {
      const beatId = `beat_${randomUUID()}`;
      insertBeat({
        id: beatId, name: b.name, city: b.city,
        county: countyForCity(b.city) ?? 'Stanislaus',
        rep_id: null, status: 'ready',
        center_lat: round6(b.center.lat), center_lng: round6(b.center.lng),
        target_count: b.target_count,
      });
      for (const m of b.targets) {
        insertBeatTarget({ beat_id: beatId, target_id: m.target_id, seq: m.seq, explore: m.explore ?? 0 });
      }
    }
  });

  console.log('\n═══ Project-seeded ingest complete ═══');
  console.log(`old unknocked auto-beats removed : ${beatsDeleted}`);
  console.log(`new doors ingested               : ${targets.length}`);
  console.log(`existing doors honestly re-scored: ${existingUpdates.length}`);
  for (const b of beats) console.log(`  beat: ${b.name} — ${b.target_count} doors`);
  console.log(`DB rows: ${JSON.stringify(tableCounts())}`);
  console.log('\nAssign beats in the manager portal; scores are honest (coverage-scaled).');
}

main()
  .catch((err) => { console.error('\n[ingest-project-beats] FAILED:', err); process.exitCode = 1; })
  .finally(() => closeDb());
