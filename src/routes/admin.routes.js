// src/routes/admin.routes.js
// Manager/admin portal API:
//   GET  /api/admin/overview          — reps (w/ beat counts), beats (w/ rep),
//                                        unassigned count, real data snapshot.
//   POST /api/reps                    — create a canvassing rep / manager.
//   POST /api/beats/:beatId/assign    — assign (or unassign) a beat to a rep.
//   POST /api/beats/:beatId/rename    — rename a beat.
//   POST /api/admin/reps/:repId/pin   — set / reset a rep's 4-digit login PIN.
//
// All data access through repo.js. No fabricated values — the data panel reports
// counts only. Money is irrelevant here (no $ fields).

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { resolveBeatCenter } from '../config.js';
import {
  getRepById,
  getRepByEmail,
  insertRep,
  updateRep,
  setRepPin,
  clearPinAttempts,
  listRepsWithBeatCounts,
  listAllBeats,
  getBeatById,
  assignBeatToRep,
  updateBeatName,
  targetsDataStatus,
  listKnocksWithSignals,
  saveIcpProfile,
  getActiveIcpProfile,
  listIcpProfiles,
  listAllTargets,
  updateTargetScore,
  listBeatsWithKnockCounts,
  deleteBeatIfUnknocked,
  ensureWalkinsBeat,
  listTargetsNotInBeats,
  insertBeat,
  insertBeatTarget,
  listCertsWithReps,
  transaction,
} from '../db/repo.js';
import { defaultProfile, SIGNAL_KEYS, validateProfile } from '../scoring/profile.js';
import { updateWeights } from '../scoring/reweight.js';
import { scoreTargetDetailed, signalsFromRow } from '../scoring/scoring.js';
import { clusterBeats } from '../scoring/beats.js';
import { partitionByEligibility } from '../scoring/compliance.js';
import { freeAssessorCounties } from '../adapters/assessor.js';
import { hashPin } from '../auth/pin.js';
import { injectDevAdminUser, requireAdmin } from '../auth/middleware.js';

export const adminRouter = Router();

// Every admin mutation lives under /admin/* and is gated by X-Auth-User (the
// Caddy central gate). Reads (overview/profile) are also under /admin/* so the
// whole prefix is gated at the edge. The dev-only shim runs first (no-op unless
// BEATS_DEV_ADMIN_USER is set — never in prod) so the gate stays authoritative.
adminRouter.use('/admin', injectDevAdminUser, requireAdmin);

// ---------------------------------------------------------------------------
// GET /api/admin/whoami — the authenticated manager (from the Caddy header, or
// the dev shim locally). Lets the portal show who is signed in.
// ---------------------------------------------------------------------------
adminRouter.get('/admin/whoami', (req, res) => {
  res.json({ user: req.adminUser });
});

// Human labels for the scoring signals (manager-portal readout).
const SIGNAL_LABELS = {
  value: 'Home Value',
  home_age: 'Home Age',
  owner_occupied: 'Owner-Occupied',
  tenure: 'Owner Tenure',
  recently_sold: 'Recently Sold',
  income_band: 'Income Band',
  khb_proximity: 'Near Completed KHB Project',
};

const ROLES = new Set(['rep', 'manager']);
// Pragmatic email shape check (not RFC-perfect; rejects the obvious garbage).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function shapeRep(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active === 1 || r.active === true,
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview
// ---------------------------------------------------------------------------
adminRouter.get('/admin/overview', (_req, res) => {
  const nowMs = Date.now();
  const reps = listRepsWithBeatCounts().map((r) => ({
    ...shapeRep(r),
    beat_count: r.beat_count,
    pin_set: r.pin_set === 1 || r.pin_set === true,
    pin_set_at: r.pin_set_at ?? null,
    locked: !!(r.pin_locked_until && Date.parse(r.pin_locked_until) > nowMs),
  }));

  const beats = listAllBeats().map((b) => ({
    id: b.id,
    name: b.name,
    city: b.city,
    county: b.county,
    status: b.status,
    target_count: b.target_count,
    rep_id: b.rep_id ?? null,
    rep_name: b.rep_name ?? null,
  }));

  const unassigned_count = beats.filter((b) => !b.rep_id).length;

  // Annotate each county with whether FREE assessor value/age enrichment exists
  // (so the manager can see where Tracerfy spend is/ isn't needed).
  const data = targetsDataStatus();
  const freeSet = new Set(freeAssessorCounties());
  data.counties = data.counties.map((c) => ({
    ...c,
    free_assessor: freeSet.has(c.county),
  }));

  res.json({ reps, beats, unassigned_count, data });
});

// Honest (unknown-aware) reweighting input: knock rows with fabricated/unknown
// signals nulled out via known_signals/owner_occupied_known.
function knocksForLearning() {
  return listKnocksWithSignals().map((r) => ({
    ...signalsFromRow(r),
    disposition: r.disposition,
    target_id: r.target_id,
  }));
}

// The profile scoring runs on: the persisted, manager-approved version if one
// exists, else the hand-set default.
function activeProfile() {
  const saved = getActiveIcpProfile();
  if (!saved) return { profile: defaultProfile, persisted: null };
  try {
    return { profile: validateProfile(saved.profile), persisted: saved };
  } catch {
    return { profile: defaultProfile, persisted: null };
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/profile — the Ideal-Client Profile: the ACTIVE (persisted)
// weights vs a fresh Phase-2 learning preview from real knock/sale outcomes,
// plus provenance. Preview becomes real only via POST /admin/profile/approve.
// ---------------------------------------------------------------------------
adminRouter.get('/admin/profile', (_req, res) => {
  const { profile, persisted } = activeProfile();
  const learnedProfile = updateWeights(knocksForLearning(), [], profile);
  const learnedDiffers = learnedProfile !== profile;

  res.json({
    signals: SIGNAL_KEYS.map((key) => ({ key, label: SIGNAL_LABELS[key] })),
    default_weights: { ...defaultProfile.weights },
    active_version: persisted ? persisted.version : (defaultProfile.version ?? 1),
    active_approved_by: persisted ? persisted.approved_by : null,
    active_weights: { ...profile.weights },
    weights: { ...learnedProfile.weights }, // learning PREVIEW (not yet applied)
    // null until at least one sale has been observed (nothing to learn yet).
    learned: learnedDiffers ? learnedProfile.learned : null,
    pending_approval: learnedDiffers,
  });
});

// GET /api/admin/profile/history — persisted profile versions.
adminRouter.get('/admin/profile/history', (_req, res) => {
  res.json({ versions: listIcpProfiles() });
});

// ---------------------------------------------------------------------------
// POST /api/admin/profile/approve — finding #12: make learning REAL.
// Persists the learned profile as the new active version, RE-SCORES every
// target with it (unknown-aware), and REBUILDS all not-yet-walked beats with a
// 7% exploration budget. Beats with knock history are preserved (in-flight
// work + FK integrity); their doors keep their new scores.
// ---------------------------------------------------------------------------
const EXPLORATION_FRACTION = 0.07; // 5–10% budget: learn outside current beliefs

adminRouter.post('/admin/profile/approve', (req, res) => {
  const { profile } = activeProfile();
  const learnedProfile = updateWeights(knocksForLearning(), [], profile);
  if (learnedProfile === profile && !req.body?.force) {
    return res.status(409).json({
      error: 'nothing new to learn yet (no sales observed or no discriminating signal); pass {"force":true} to re-approve the current profile anyway',
    });
  }
  const toPersist = learnedProfile === profile ? { ...profile } : learnedProfile;

  const summary = transaction(() => {
    // 1. Persist the new active version.
    saveIcpProfile({
      id: `icp_${randomUUID()}`,
      version: toPersist.version ?? 1,
      label: toPersist.label ?? 'Ideal-Client Profile',
      profile: toPersist,
      learned: toPersist.learned ?? null,
      approved_by: req.adminUser,
    });

    // 2. Re-score EVERY target under the approved profile (unknown-aware).
    let rescored = 0;
    for (const row of listAllTargets()) {
      const { score } = scoreTargetDetailed(signalsFromRow(row), toPersist);
      if (score !== row.score) {
        updateTargetScore(row.id, score);
        rescored += 1;
      }
    }

    // 3. Rebuild beats that have no knock history yet.
    let beatsDeleted = 0;
    let beatsKept = 0;
    for (const b of listBeatsWithKnockCounts()) {
      if (b.kind !== 'auto') { beatsKept += 1; continue; } // custom + walk-in beats are manager/rep-owned
      if (b.knock_count > 0) { beatsKept += 1; continue; }
      beatsDeleted += deleteBeatIfUnknocked(b.id);
    }
    const { eligible, excluded } = partitionByEligibility(listTargetsNotInBeats());
    const pool = eligible.slice().sort((a, b) => b.score - a.score);
    const rebuilt = clusterBeats(pool, 50, { explorationFraction: EXPLORATION_FRACTION });
    let explored = 0;
    for (const b of rebuilt) {
      const beatId = `beat_${randomUUID()}`;
      insertBeat({
        id: beatId, name: b.name, city: b.city, county: b.county,
        rep_id: null, status: 'ready',
        center_lat: b.center.lat, center_lng: b.center.lng,
        target_count: b.target_count,
      });
      for (const m of b.targets) {
        if (m.explore) explored += 1;
        insertBeatTarget({ beat_id: beatId, target_id: m.target_id, seq: m.seq, explore: m.explore });
      }
    }

    return {
      approved_version: toPersist.version ?? 1,
      approved_by: req.adminUser,
      rescored_targets: rescored,
      beats_kept: beatsKept,
      beats_deleted: beatsDeleted,
      beats_rebuilt: rebuilt.length,
      exploration_doors: explored,
      excluded,
    };
  });

  res.status(201).json(summary);
});

// ---------------------------------------------------------------------------
// GET /api/admin/certs — server-recorded training certifications (finding #10).
// ---------------------------------------------------------------------------
adminRouter.get('/admin/certs', (_req, res) => {
  res.json({ certs: listCertsWithReps() });
});

// ---------------------------------------------------------------------------
// POST /api/admin/reps  — add a rep (Ryan req #1). Gated by X-Auth-User.
// ---------------------------------------------------------------------------
adminRouter.post('/admin/reps', (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const role = body.role ?? 'rep';

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'invalid email' });
  }
  if (!ROLES.has(role)) {
    return res.status(400).json({ error: 'invalid role' });
  }
  if (getRepByEmail(email)) {
    return res.status(409).json({ error: 'email already exists' });
  }

  const rep = { id: `rep_${randomUUID()}`, name, email, role, active: 1 };
  try {
    insertRep(rep);
  } catch (err) {
    // UNIQUE(email) race or constraint trip -> 409.
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'email already exists' });
    }
    throw err;
  }

  // Every rep gets a walk-in beat for off-beat door logging (onboarding 2026-07-20).
  ensureWalkinsBeat(rep);

  res.status(201).json({ rep: shapeRep(rep) });
});

// ---------------------------------------------------------------------------
// PATCH /api/admin/reps/:repId — edit a rep (name / email / role) and/or
// deactivate/reactivate (active). Partial: send only the fields you change.
// Deactivating immediately blocks login (requireRepToken checks rep.active).
// ---------------------------------------------------------------------------
adminRouter.patch('/admin/reps/:repId', (req, res) => {
  const rep = getRepById(req.params.repId);
  if (!rep) {
    return res.status(404).json({ error: 'rep not found' });
  }

  const body = req.body ?? {};
  const fields = {};

  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'name cannot be empty' });
    fields.name = name;
  }
  if ('email' in body) {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });
    const other = getRepByEmail(email);
    if (other && other.id !== rep.id) {
      return res.status(409).json({ error: 'email already exists' });
    }
    fields.email = email;
  }
  if ('role' in body) {
    if (!ROLES.has(body.role)) return res.status(400).json({ error: 'invalid role' });
    fields.role = body.role;
  }
  if ('active' in body) {
    fields.active = body.active ? 1 : 0;
  }

  if (Object.keys(fields).length === 0) {
    return res.status(400).json({ error: 'no editable fields provided' });
  }

  updateRep(rep.id, fields);
  res.json({ rep: shapeRep(getRepById(rep.id)) });
});

// ---------------------------------------------------------------------------
// POST /api/admin/reps/:repId/unlock — clear a PIN lockout + attempt counter
// (without forcing a PIN reset), so a locked-out rep can sign in immediately.
// ---------------------------------------------------------------------------
adminRouter.post('/admin/reps/:repId/unlock', (req, res) => {
  const rep = getRepById(req.params.repId);
  if (!rep) {
    return res.status(404).json({ error: 'rep not found' });
  }
  clearPinAttempts(rep.id);
  res.json({ ok: true, rep: { id: rep.id, name: rep.name, locked: false } });
});

// ---------------------------------------------------------------------------
// POST /api/admin/beats — manager creates a named CUSTOM beat (onboarding
// 2026-07-20). Empty by design: the rep logs each door as they knock it
// (POST /api/knocks/manual). Optionally assigned to a rep at creation.
// ---------------------------------------------------------------------------
const BEAT_COUNTIES = new Set(['Stanislaus', 'San Joaquin', 'Merced']);

adminRouter.post('/admin/beats', (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const county = body.county;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!city) return res.status(400).json({ error: 'city is required' });
  if (!BEAT_COUNTIES.has(county)) return res.status(400).json({ error: 'invalid county' });

  let rep = null;
  if (body.rep_id) {
    rep = getRepById(body.rep_id);
    if (!rep) return res.status(400).json({ error: 'rep not found' });
  }

  const center = resolveBeatCenter({ lat: body.lat, lng: body.lng, city, county });
  const beatId = `beat_${randomUUID()}`;
  insertBeat({
    id: beatId, name, city, county, rep_id: rep ? rep.id : null,
    status: 'ready', center_lat: center.lat, center_lng: center.lng,
    target_count: 0, kind: 'custom',
  });

  res.status(201).json({
    beat: { id: beatId, name, city, county, status: 'ready', target_count: 0,
      kind: 'custom', rep_id: rep ? rep.id : null, rep_name: rep ? rep.name : null },
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/beats/:beatId/assign — assign / unassign a beat (Ryan req #1).
// Gated by X-Auth-User.
// ---------------------------------------------------------------------------
adminRouter.post('/admin/beats/:beatId/assign', (req, res) => {
  const beat = getBeatById(req.params.beatId);
  if (!beat) {
    return res.status(404).json({ error: 'beat not found' });
  }

  // rep_id null/empty => unassign.
  const repId = req.body?.rep_id ?? null;
  let rep = null;
  if (repId) {
    rep = getRepById(repId);
    if (!rep) {
      return res.status(400).json({ error: 'rep not found' });
    }
  }

  assignBeatToRep(beat.id, repId);

  res.json({
    beat: {
      id: beat.id,
      name: beat.name,
      rep_id: repId,
      rep_name: rep ? rep.name : null,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/reps/:repId/pin  — set / reset a rep's 4-digit login PIN.
// Hashes the PIN, clears the lockout, and bumps token_version (invalidating any
// outstanding tokens for that rep). Gated by X-Auth-User.
// ---------------------------------------------------------------------------
const PIN_RE = /^\d{4}$/;

adminRouter.post('/admin/reps/:repId/pin', (req, res) => {
  const rep = getRepById(req.params.repId);
  if (!rep) {
    return res.status(404).json({ error: 'rep not found' });
  }
  const pin = req.body?.pin == null ? '' : String(req.body.pin);
  if (!PIN_RE.test(pin)) {
    return res.status(400).json({ error: 'pin must be exactly 4 digits' });
  }
  const { hash, salt } = hashPin(pin);
  setRepPin(rep.id, hash, salt);
  res.json({ ok: true, rep: { id: rep.id, name: rep.name, pin_set: true } });
});

// ---------------------------------------------------------------------------
// POST /api/admin/beats/:beatId/rename  — rename a beat.
// Trims whitespace; rejects empty names. Gated by X-Auth-User.
// ---------------------------------------------------------------------------
adminRouter.post('/admin/beats/:beatId/rename', (req, res) => {
  const beat = getBeatById(req.params.beatId);
  if (!beat) {
    return res.status(404).json({ error: 'beat not found' });
  }
  const newName = req.body?.name ?? '';
  const trimmed = String(newName).trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'beat name cannot be empty' });
  }
  const changed = updateBeatName(beat.id, trimmed);
  if (changed === 0) {
    return res.status(500).json({ error: 'failed to update beat name' });
  }
  const updated = getBeatById(beat.id);
  res.json({ ok: true, beat: { id: updated.id, name: updated.name } });
});
