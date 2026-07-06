// src/routes/admin.routes.js
// Manager/admin portal API:
//   GET  /api/admin/overview          — reps (w/ beat counts), beats (w/ rep),
//                                        unassigned count, real data snapshot.
//   POST /api/reps                    — create a canvassing rep / manager.
//   POST /api/beats/:beatId/assign    — assign (or unassign) a beat to a rep.
//
// All data access through repo.js. No fabricated values — the data panel reports
// counts only. Money is irrelevant here (no $ fields).

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
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
  targetsDataStatus,
  listKnocksWithSignals,
} from '../db/repo.js';
import { defaultProfile, SIGNAL_KEYS } from '../scoring/profile.js';
import { updateWeights } from '../scoring/reweight.js';
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

// Human labels for the 6 scoring signals (manager-portal readout).
const SIGNAL_LABELS = {
  value: 'Home Value',
  home_age: 'Home Age',
  owner_occupied: 'Owner-Occupied',
  tenure: 'Owner Tenure',
  recently_sold: 'Recently Sold',
  income_band: 'Income Band',
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

// ---------------------------------------------------------------------------
// GET /api/admin/profile — the Ideal-Client Profile: hand-set (default) weights
// vs the Phase-2 weights LEARNED from real knock/sale outcomes, plus provenance.
// ---------------------------------------------------------------------------
adminRouter.get('/admin/profile', (_req, res) => {
  const knocks = listKnocksWithSignals();
  const learnedProfile = updateWeights(knocks, [], defaultProfile);
  const learnedDiffers = learnedProfile !== defaultProfile;

  res.json({
    signals: SIGNAL_KEYS.map((key) => ({ key, label: SIGNAL_LABELS[key] })),
    default_weights: { ...defaultProfile.weights },
    weights: { ...learnedProfile.weights },
    // null until at least one sale has been observed (nothing to learn yet).
    learned: learnedDiffers ? learnedProfile.learned : null,
  });
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
