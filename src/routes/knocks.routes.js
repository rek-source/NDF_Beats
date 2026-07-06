// src/routes/knocks.routes.js
// POST /api/knocks  (SPEC §5.3)
// Idempotent on client_uuid: replaying the same uuid returns 200 + existing knock.
// `answered` is derived server-side. A 'sold' disposition does NOT auto-create a
// sale — the client follows with POST /api/sales.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { DISPOSITIONS } from '../config.js';
import {
  getKnockByClientUuid,
  getBeatById,
  getTargetById,
  getRepById,
  insertKnock,
  getKnockById,
} from '../db/repo.js';

export const knocksRouter = Router();

function shapeKnock(k) {
  return {
    id: k.id,
    disposition: k.disposition,
    answered: k.answered === 1,
    knocked_at: k.knocked_at,
  };
}

knocksRouter.post('/knocks', (req, res) => {
  const body = req.body ?? {};
  const { beat_id, target_id, disposition, note, client_uuid, knocked_at } = body;
  // Attribution is token-bound: the rep is whoever the verified token says
  // (set by requireRepToken), NEVER a client-supplied body.rep_id.
  const rep_id = req.repId;

  // Idempotency: if we've already recorded this client_uuid, return it (200).
  if (client_uuid) {
    const existing = getKnockByClientUuid(client_uuid);
    if (existing) {
      return res.status(200).json({ knock: shapeKnock(existing) });
    }
  }

  if (!DISPOSITIONS.includes(disposition)) {
    return res.status(400).json({ error: 'invalid disposition' });
  }
  if (!beat_id || !target_id) {
    return res.status(400).json({ error: 'beat_id and target_id are required' });
  }

  // Referential checks (FKs are on, but explicit 400s give clearer client errors).
  if (!getBeatById(beat_id)) return res.status(400).json({ error: 'beat not found' });
  if (!getTargetById(target_id)) return res.status(400).json({ error: 'target not found' });
  if (!getRepById(rep_id)) return res.status(400).json({ error: 'rep not found' });

  const answered = disposition === 'not_home' ? 0 : 1;
  const ts = normalizeTimestamp(knocked_at);
  const id = `knock_${randomUUID()}`;

  try {
    insertKnock({
      id,
      beat_id,
      target_id,
      rep_id,
      disposition,
      answered,
      note: typeof note === 'string' ? note : null,
      client_uuid: client_uuid ?? null,
      knocked_at: ts,
    });
  } catch (err) {
    // Concurrent replay of the same client_uuid can race past the early check.
    if (isUniqueViolation(err) && client_uuid) {
      const existing = getKnockByClientUuid(client_uuid);
      if (existing) return res.status(200).json({ knock: shapeKnock(existing) });
    }
    throw err;
  }

  return res.status(201).json({ knock: shapeKnock(getKnockById(id)) });
});

/** Accept a client-supplied ISO timestamp; fall back to server time. */
function normalizeTimestamp(input) {
  if (typeof input === 'string') {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function isUniqueViolation(err) {
  return (
    err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT')
  );
}
