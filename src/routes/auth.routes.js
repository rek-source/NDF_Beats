// src/routes/auth.routes.js
// Rep PIN login -> signed session token (design 2026-06-15).
//   POST /api/auth/login  {rep_id, pin}
//     200 {token, rep:{id,name}, exp}  | 401 wrong/unknown (+attempts_remaining)
//     423 locked (+locked_until)        | 409 no PIN set
//   POST /api/auth/logout : client discards the token; server is stateless here.
//
// Security comes from server-side lockout, not the (low-entropy) 4-digit PIN.
// 401 is returned identically for "unknown rep" and "wrong PIN" so the endpoint
// doesn't reveal which reps exist.

import { Router } from 'express';
import {
  BEATS_TOKEN_SECRET,
  BEATS_SESSION_HOURS,
  BEATS_PIN_MAX_ATTEMPTS,
  BEATS_PIN_LOCKOUT_MIN,
} from '../config.js';
import {
  getRepById,
  incrementPinAttempts,
  clearPinAttempts,
  setPinLockout,
} from '../db/repo.js';
import { verifyPin } from '../auth/pin.js';
import { signToken } from '../auth/token.js';

export const authRouter = Router();

function isLocked(rep, nowMs) {
  return rep.pin_locked_until && Date.parse(rep.pin_locked_until) > nowMs;
}

authRouter.post('/auth/login', (req, res) => {
  const body = req.body ?? {};
  const repId = typeof body.rep_id === 'string' ? body.rep_id : '';
  const pin = body.pin == null ? '' : String(body.pin);

  if (!repId || !pin) {
    return res.status(400).json({ error: 'rep_id and pin are required' });
  }

  const rep = getRepById(repId);
  // Unknown or inactive rep -> 401 (same as a wrong PIN; don't enumerate reps).
  if (!rep || !rep.active) {
    return res.status(401).json({ error: 'invalid rep or PIN' });
  }

  const nowMs = Date.now();
  if (isLocked(rep, nowMs)) {
    return res.status(423).json({ error: 'too many attempts; try again later', locked_until: rep.pin_locked_until });
  }

  if (!rep.pin_hash || !rep.pin_salt) {
    return res.status(409).json({ error: 'no PIN set; ask your manager' });
  }

  if (!verifyPin(pin, rep.pin_hash, rep.pin_salt)) {
    const attempts = incrementPinAttempts(repId);
    if (attempts >= BEATS_PIN_MAX_ATTEMPTS) {
      const until = new Date(nowMs + BEATS_PIN_LOCKOUT_MIN * 60_000).toISOString();
      setPinLockout(repId, until);
      return res.status(423).json({ error: 'too many attempts; try again later', locked_until: until });
    }
    return res.status(401).json({
      error: 'invalid rep or PIN',
      attempts_remaining: Math.max(0, BEATS_PIN_MAX_ATTEMPTS - attempts),
    });
  }

  // Success: clear counters, issue a token bound to rep_id + current version.
  clearPinAttempts(repId);
  const token = signToken(
    { rep_id: rep.id, ver: rep.token_version },
    { secret: BEATS_TOKEN_SECRET, sessionHours: BEATS_SESSION_HOURS, nowMs },
  );
  const exp = Math.floor(nowMs / 1000) + Math.round(BEATS_SESSION_HOURS * 3600);
  return res.json({ token, rep: { id: rep.id, name: rep.name }, exp });
});

// Stateless logout: the client throws the token away. (Kept so the frontend has
// a real endpoint to call and we can add server-side revocation later.)
authRouter.post('/auth/logout', (_req, res) => {
  res.json({ ok: true });
});
