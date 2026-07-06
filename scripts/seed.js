// scripts/seed.js
// Deterministic mock seed (SPEC §11). Generates ~600 scored targets across the
// NDF service area, 4 reps (3 reps + 1 manager), geo-clustered beats, and a
// partial day/week/month of knocks + sales so all three scoreboard periods
// return data.
//
// Hard rules honored here:
//  - Scores come from scoring.scoreTarget(target, defaultProfile) — NOT hardcoded.
//  - Beats come from scoring.clusterBeats(topTargets, 50).
//  - ALL inserts go through repo.js (no raw SQL in the seed) — data abstraction.
//  - Seeded PRNG => stable reruns. No network, no adapter calls.
//
// Run via `npm run seed` (migrate first) or `node scripts/seed.js` after migrate.

import { randomUUID } from 'node:crypto';

import { migrate } from '../src/db/migrate.js';
import { closeDb } from '../src/db/connection.js';
import {
  insertRep,
  insertTarget,
  insertBeat,
  insertBeatTarget,
  insertKnock,
  insertSale,
  transaction,
  resetAll,
  tableCounts,
} from '../src/db/repo.js';
import { PACKAGE_CATALOG, buildAgreementUrl } from '../src/config.js';
import { scoreTarget } from '../src/scoring/scoring.js';
import { clusterBeats } from '../src/scoring/beats.js';
import { defaultProfile } from '../src/scoring/profile.js';
import { CITIES, SPREAD_DEG, STREET_NAMES } from './seed-data/geo-bounds.js';

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic across runs.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260615);

const rand = () => rng();
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const chance = (p) => rand() < p;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

/** Weighted log-normal-ish home value in cents, $250k–$750k. */
function randomValueCents() {
  // Sum of two uniforms biases toward the middle; scale to band.
  const u = (rand() + rand()) / 2; // ~triangular, peak 0.5
  const dollars = Math.round(250000 + u * 500000);
  return dollars * 100;
}

/** Income band 1..10 weighted toward the middle. */
function randomIncomeBand() {
  const u = (rand() + rand() + rand()) / 3; // tight middle
  return Math.min(10, Math.max(1, Math.round(1 + u * 9)));
}

// ---------------------------------------------------------------------------
// Build the ~600 targets.
// ---------------------------------------------------------------------------
function buildTargets(total = 600) {
  // Expand cities into a weighted bag.
  const bag = [];
  for (const c of CITIES) for (let i = 0; i < c.weight; i++) bag.push(c);

  const targets = [];
  for (let i = 0; i < total; i++) {
    const city = bag[Math.floor(rand() * bag.length)];
    const lat = city.lat + (rand() * 2 - 1) * SPREAD_DEG;
    const lng = city.lng + (rand() * 2 - 1) * SPREAD_DEG;

    const value_cents = randomValueCents();
    const home_age = randInt(5, 70);
    const owner_occupied = chance(0.75) ? 1 : 0;
    const tenure_years = randInt(0, 30);
    const recently_sold = chance(0.12) ? 1 : 0;
    const income_band = randomIncomeBand();
    const no_soliciting = chance(0.04) ? 1 : 0;

    // Score from the scoring module (NOT hardcoded). Pass only the signal fields
    // the contract (§6.1) specifies.
    const score = scoreTarget(
      { value_cents, home_age, owner_occupied, tenure_years, recently_sold, income_band },
      defaultProfile,
    );

    const houseNum = randInt(100, 9999);
    const street = pick(STREET_NAMES);

    targets.push({
      id: `tgt_${randomUUID()}`,
      address: `${houseNum} ${street}`,
      city: city.name,
      county: city.county,
      zip: pick(city.zips),
      lat: round6(lat),
      lng: round6(lng),
      value_cents,
      home_age,
      owner_occupied,
      // Synthetic demo world: values are intentionally "verified" so the
      // compliance gate behaves like a fully-enriched dataset.
      owner_occupied_known: 1,
      tenure_years,
      recently_sold,
      income_band,
      score,
      no_soliciting,
      solicit_status: no_soliciting ? 'do_not_solicit' : 'clear',
      known_signals: JSON.stringify(['value', 'home_age', 'owner_occupied', 'tenure', 'recently_sold', 'income_band']),
    });
  }
  return targets;
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// Reps (SPEC §11: 3 reps + 1 manager, stable names/emails).
// ---------------------------------------------------------------------------
function buildReps() {
  return [
    { id: `rep_${stableUuid('maria')}`, name: 'Maria Delgado', email: 'maria@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('deshawn')}`, name: 'DeShawn Carter', email: 'deshawn@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('priya')}`, name: 'Priya Nair', email: 'priya@ndf.example', role: 'rep', active: 1 },
    { id: `rep_${stableUuid('carlos')}`, name: 'Carlos Mendez', email: 'carlos@ndf.example', role: 'manager', active: 1 },
  ];
}

// Deterministic UUID-shaped id from a label (so rep ids are stable across runs).
function stableUuid(label) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const seq = mulberry32(h);
  const hex = (n) => Math.floor(seq() * 16).toString(16);
  let s = '';
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) s += '-';
    s += hex();
  }
  return s;
}

// ---------------------------------------------------------------------------
// Timestamp helpers — spread events across today / earlier-this-week /
// earlier-this-month so every scoreboard period is non-empty.
// We use simple UTC offsets from "now"; the scoreboard's LA-local windowing is
// generous enough that these land correctly in each bucket.
// ---------------------------------------------------------------------------
const NOW = Date.now();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

function tsTodayHoursAgo(h) {
  return new Date(NOW - h * HOUR).toISOString();
}
function tsDaysAgo(d, hourJitter = 0) {
  return new Date(NOW - d * DAY - hourJitter * HOUR).toISOString();
}

// ---------------------------------------------------------------------------
// Disposition + package mixes (SPEC §11).
// ---------------------------------------------------------------------------
function rollDisposition() {
  const r = rand();
  if (r < 0.40) return 'not_home';        // 40%
  if (r < 0.55) return 'refused';         // 15%
  if (r < 0.65) return 'callback';        // 10%
  if (r < 0.85) return 'not_interested';  // 20%
  return 'sold';                          // 15%
}
function rollPackage() {
  const r = rand();
  if (r < 0.40) return 'essential';   // 40%
  if (r < 0.80) return 'preferred';   // 40%
  return 'total_home';                // 20%
}

// ---------------------------------------------------------------------------
// Main seed.
// ---------------------------------------------------------------------------
function seed() {
  migrate(); // idempotent DDL

  // Clean slate so reruns are deterministic (via the repo — FK-safe order).
  resetAll();

  const reps = buildReps();
  const repsOnly = reps.filter((r) => r.role === 'rep');
  const targets = buildTargets(600);

  // Top-scored, solicitable targets feed beat clustering.
  const eligible = targets
    .filter((t) => t.no_soliciting === 0)
    .slice()
    .sort((a, b) => b.score - a.score);
  const topTargets = eligible.slice(0, 350); // enough for ~7 beats of ~50

  // clusterBeats returns beats with {name, city, county, center:{lat,lng},
  // targets:[{target_id, seq}], target_count} (SPEC §6.2).
  const clustered = clusterBeats(topTargets, 50);
  // Keep 6–8 beats.
  const beatDefs = clustered.slice(0, Math.min(8, Math.max(6, clustered.length)));

  // Assign ~2 beats to each of the 3 reps; leave the remainder unassigned/ready.
  const beats = beatDefs.map((b, i) => {
    const assignedRepIndex = Math.floor(i / 2); // beats 0,1->rep0; 2,3->rep1; 4,5->rep2
    const assignTo = assignedRepIndex < repsOnly.length ? repsOnly[assignedRepIndex] : null;
    // First beat of an assigned rep is 'active', the rest 'ready'.
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
      _members: b.targets, // [{target_id, seq}]
    };
  });

  // Persist everything in one transaction via the repo layer.
  transaction(() => {
    for (const r of reps) insertRep(r);
    for (const t of targets) insertTarget(t);

    for (const b of beats) {
      insertBeat({
        id: b.id,
        name: b.name,
        city: b.city,
        county: b.county,
        rep_id: b.rep_id,
        status: b.status,
        center_lat: b.center_lat,
        center_lng: b.center_lng,
        target_count: b.target_count,
      });
      for (const m of b._members) {
        insertBeatTarget({ beat_id: b.id, target_id: m.target_id, seq: m.seq });
      }
    }

    // Simulate canvassing on assigned beats, spread across periods.
    simulateActivity(beats);
  });

  console.log('[seed] done:', JSON.stringify(tableCounts()));
}

/**
 * Walk part of each assigned beat producing a realistic disposition mix, and
 * create a sale row for each 'sold' knock. Timestamps are spread so today,
 * this-week, and this-month scoreboard periods all return data.
 *
 * For each assigned beat we generate three "sessions":
 *   - today (a few hours ago)
 *   - earlier this week (3 days ago)
 *   - earlier this month (15 days ago)
 * each covering a slice of the beat's ordered targets.
 */
function simulateActivity(beats) {
  const assigned = beats.filter((b) => b.rep_id);

  for (const beat of assigned) {
    const members = beat._members; // {target_id, seq}
    // Sessions: [label, doorCount, timestampFn]
    const sessions = [
      { count: Math.min(18, members.length), ts: (i) => tsTodayHoursAgo(1 + (i % 6)) },
      { count: Math.min(14, members.length), ts: (i) => tsDaysAgo(3, i % 5) },
      { count: Math.min(12, members.length), ts: (i) => tsDaysAgo(15, i % 5) },
    ];

    let cursor = 0;
    for (const session of sessions) {
      for (let i = 0; i < session.count; i++) {
        const member = members[(cursor + i) % members.length];
        const disposition = rollDisposition();
        const answered = disposition === 'not_home' ? 0 : 1;
        const knockedAt = session.ts(i);
        const knockId = `knock_${randomUUID()}`;

        insertKnock({
          id: knockId,
          beat_id: beat.id,
          target_id: member.target_id,
          rep_id: beat.rep_id,
          disposition,
          answered,
          note: null,
          client_uuid: `seed-${knockId}`,
          knocked_at: knockedAt,
        });

        if (disposition === 'sold') {
          const pkg = rollPackage();
          const amount_cents = PACKAGE_CATALOG[pkg].amount_cents;
          insertSale({
            id: `sale_${randomUUID()}`,
            knock_id: knockId,
            rep_id: beat.rep_id,
            target_id: member.target_id,
            package: pkg,
            amount_cents,
            agreement_url: buildAgreementUrl(pkg, member.target_id),
            client_uuid: `seed-sale-${knockId}`,
            // Sold a few minutes after the knock; reuse the knock timestamp.
            sold_at: knockedAt,
          });
        }
      }
      cursor += session.count;
    }
  }
}

// Run.
try {
  seed();
} finally {
  closeDb();
}
