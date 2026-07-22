// src/routes/beats.routes.js
// GET /api/reps/:repId/beats  (SPEC §5.1)
// GET /api/beats/:beatId      (SPEC §5.2)
// All data via repo.js. Money returned as dollars under *_usd keys.

import { Router } from 'express';
import {
  getRepById,
  listBeatsForRep,
  getBeatById,
  getBeatTargets,
} from '../db/repo.js';
import { ownerOccupancyKnown } from '../scoring/compliance.js';
import { SIGNAL_KEYS } from '../scoring/profile.js';

export const beatsRouter = Router();

// How many of the scoring signals were REAL for this door (from known_signals),
// so the sheet can show an honest "N of 7 signals" hint that explains a low,
// coverage-scaled score. null when unknown (legacy rows) — never invented.
function knownSignalCount(knownSignalsJson) {
  if (knownSignalsJson == null) return null;
  try {
    const arr = JSON.parse(knownSignalsJson);
    if (!Array.isArray(arr)) return null;
    return arr.filter((k) => SIGNAL_KEYS.includes(k)).length;
  } catch {
    return null;
  }
}

// 5.1 List beats for a rep.
beatsRouter.get('/reps/:repId/beats', (req, res) => {
  const rep = getRepById(req.params.repId);
  if (!rep) {
    return res.status(404).json({ error: 'rep not found' });
  }

  const rows = listBeatsForRep(rep.id);
  const beats = rows.map((b) => {
    const knocked = b.knocked_count ?? 0;
    const remaining = Math.max(0, b.target_count - knocked);
    return {
      id: b.id,
      name: b.name,
      city: b.city,
      county: b.county,
      status: b.status,
      target_count: b.target_count,
      center: { lat: b.center_lat, lng: b.center_lng },
      progress: { knocked, remaining },
    };
  });

  res.json({ rep: { id: rep.id, name: rep.name }, beats });
});

// 5.2 Get a beat with ordered targets.
beatsRouter.get('/beats/:beatId', (req, res) => {
  const beat = getBeatById(req.params.beatId);
  if (!beat) {
    return res.status(404).json({ error: 'beat not found' });
  }

  const targets = getBeatTargets(beat.id).map((t) => ({
    seq: t.seq,
    id: t.id,
    address: t.address,
    city: t.city,
    zip: t.zip,
    lat: t.lat,
    lng: t.lng,
    value_usd: Math.round(t.value_cents / 100),
    home_age: t.home_age,
    owner_occupied: t.owner_occupied === 1,
    // Tri-state honesty: false owner_occupied means EITHER verified renter OR
    // "unknown". This flag lets the sheet tell them apart instead of printing
    // an unknown door as a flat "No" (see src/scoring/compliance.js).
    owner_occupied_known: ownerOccupancyKnown(t),
    tenure_years: t.tenure_years,
    score: t.score,
    no_soliciting: t.no_soliciting === 1,
    last_disposition: t.last_disposition ?? null,
    // Honesty display: which signals were REAL at ingest
    tract_owner_occ_rate: t.tract_owner_occ_rate ?? null,
    khb_project_dist_m: t.khb_project_dist_m ?? null,
    // Data-coverage hint inputs: how many of the SIGNAL_KEYS were known (null =
    // unknown/legacy). Lets the sheet explain a low, coverage-scaled score.
    signals_known: knownSignalCount(t.known_signals),
    signals_total: SIGNAL_KEYS.length,
  }));

  res.json({
    beat: {
      id: beat.id,
      name: beat.name,
      city: beat.city,
      county: beat.county,
      status: beat.status,
      center: { lat: beat.center_lat, lng: beat.center_lng },
    },
    targets,
  });
});
