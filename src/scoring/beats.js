// beats.js — geo-cluster scored targets into walkable beats (SPEC §6.2).
// Pure + deterministic given input order. No DB/HTTP/randomness.
//
// Approach:
//   1. Drop ineligible targets via the HARD compliance gate (compliance.js):
//      any do-not-solicit flag OR unverified/false owner-occupancy excludes a
//      door — eligibility is never defaulted to "safe to knock".
//   2. Sort by score desc (prefer higher-score homes), stable on input order.
//   3. Greedy grow clusters of ~size: seed each cluster from the highest-score
//      unassigned target, then pull in nearest unassigned neighbors until full.
//   4. Within a cluster, sequence by nearest-neighbor walk starting from the
//      NW-most point (max lat, then min lng).
//
// NOTE: owned by `scoring`. The backend ships a contract-correct implementation
// so beats exist for the seed/app; body may be replaced without changing the
// frozen §6.2 signature.

import { isKnockEligible } from './compliance.js';

const EARTH = 6371; // km, for haversine

function haversine(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Clamp the requested beat size into the 40..60 contract window. */
function clampSize(size) {
  const s = Math.round(size);
  if (s < 40) return 40;
  if (s > 60) return 60;
  return s;
}

/** Deterministic 0..1 hash of an id (for the exploration lottery — no RNG). */
function hash01(id) {
  let h = 2166136261 >>> 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Cluster targets into walkable beats.
 * @param {Array} targets - rows incl. {id,lat,lng,score,owner_occupied,
 *                          solicit_status/no_soliciting,city,county}
 * @param {number} size   - desired doors per beat (default 50, clamped 40..60)
 * @param {Object} [opts]
 * @param {number} [opts.explorationFraction=0] - 0..0.2: a deterministic slice
 *        of LOW-score doors gets promoted into the walk-first seeding order so
 *        the adaptive profile can learn OUTSIDE its current beliefs. Promoted
 *        members carry `explore: true`.
 * @returns {Array} beats: [{ name, city, county, center:{lat,lng},
 *                            targets:[{target_id, seq, explore}], target_count }]
 */
export function clusterBeats(targets, size = 50, opts = {}) {
  const beatSize = clampSize(size);
  const exploreFrac = Math.min(0.2, Math.max(0, Number(opts.explorationFraction) || 0));

  const pool = targets
    .filter((t) => isKnockEligible(t))
    .map((t) => ({
      id: t.id,
      lat: Number(t.lat),
      lng: Number(t.lng),
      score: Number(t.score) || 0,
      city: t.city,
      county: t.county,
      explore: false,
    }));

  // Exploration budget: promote a deterministic ~explorationFraction of the
  // bottom-half doors to top-quartile seed priority. Their true score is kept;
  // only the seeding order changes, and they are tagged explore=true.
  if (exploreFrac > 0 && pool.length >= 8) {
    const byScore = pool.slice().sort((a, b) => b.score - a.score);
    const p75 = byScore[Math.floor(byScore.length * 0.25)].score;
    const bottomHalf = byScore.slice(Math.floor(byScore.length / 2));
    const budget = Math.max(1, Math.floor(pool.length * exploreFrac));
    const lottery = bottomHalf
      .slice()
      .sort((a, b) => hash01(a.id) - hash01(b.id))
      .slice(0, budget);
    for (const t of lottery) {
      t.explore = true;
      t._seedScore = p75; // seeding priority only
    }
  }
  for (const t of pool) if (t._seedScore === undefined) t._seedScore = t.score;

  // Highest seed priority first; stable for determinism.
  pool.sort((a, b) => b._seedScore - a._seedScore);

  const assigned = new Set();
  const beats = [];
  // Counter of beats per city for stable naming.
  const cityBeatNo = new Map();

  for (const seed of pool) {
    if (assigned.has(seed.id)) continue;

    // Build a cluster around this seed: take the nearest unassigned targets.
    const remaining = pool.filter((t) => !assigned.has(t.id));
    remaining.sort((a, b) => haversine(seed, a) - haversine(seed, b));
    const cluster = remaining.slice(0, beatSize);
    if (cluster.length < Math.min(beatSize, 40) && beats.length > 0) {
      // Too small to be its own beat and we already have beats — fold the
      // leftovers into the nearest existing beat instead of making a stub.
      for (const t of cluster) {
        assigned.add(t.id);
        const nearest = nearestBeat(beats, t);
        nearest._members.push(t);
      }
      continue;
    }
    for (const t of cluster) assigned.add(t.id);

    beats.push({ _members: cluster });
  }

  // Finalize: center, NW-start nearest-neighbor sequencing, naming.
  return beats.map((b) => {
    const members = b._members;
    const center = centroid(members);
    const ordered = nearestNeighborWalk(members);

    // Dominant city/county for the beat label.
    const city = mode(members.map((m) => m.city));
    const county = mode(members.map((m) => m.county));
    const n = (cityBeatNo.get(city) ?? 0) + 1;
    cityBeatNo.set(city, n);

    return {
      name: `${city} - Beat ${n}`,
      city,
      county,
      center: { lat: center.lat, lng: center.lng },
      targets: ordered.map((t, i) => ({ target_id: t.id, seq: i + 1, explore: t.explore ? 1 : 0 })),
      target_count: ordered.length,
    };
  });
}

function nearestBeat(beats, t) {
  let best = beats[0];
  let bestD = Infinity;
  for (const b of beats) {
    const c = centroid(b._members);
    const d = haversine(c, t);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

function centroid(members) {
  let lat = 0;
  let lng = 0;
  for (const m of members) {
    lat += m.lat;
    lng += m.lng;
  }
  return { lat: lat / members.length, lng: lng / members.length };
}

/** Nearest-neighbor walk from the NW-most point (max lat, then min lng). */
function nearestNeighborWalk(members) {
  if (members.length <= 1) return members.slice();
  const pts = members.slice();
  // NW-most start.
  pts.sort((a, b) => (b.lat - a.lat) || (a.lng - b.lng));
  const start = pts[0];
  const remaining = new Set(pts);
  remaining.delete(start);
  const route = [start];
  let cur = start;
  while (remaining.size) {
    let next = null;
    let nd = Infinity;
    for (const p of remaining) {
      const d = haversine(cur, p);
      if (d < nd) {
        nd = d;
        next = p;
      }
    }
    route.push(next);
    remaining.delete(next);
    cur = next;
  }
  return route;
}

function mode(arr) {
  const counts = new Map();
  let best = arr[0];
  let bestC = 0;
  for (const v of arr) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestC) {
      bestC = c;
      best = v;
    }
  }
  return best;
}
