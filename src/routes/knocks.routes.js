// src/routes/knocks.routes.js
// POST /api/knocks  (SPEC §5.3)
// Idempotent on client_uuid: replaying the same uuid returns 200 + existing knock.
// `answered` is derived server-side. A 'sold' disposition does NOT auto-create a
// sale — the client follows with POST /api/sales.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { PACKAGE_CATALOG, PACKAGE_KEYS, DISPOSITIONS, buildAgreementUrl } from '../config.js';
import {
  getKnockByClientUuid,
  getBeatById,
  getTargetById,
  getRepById,
  insertKnock,
  getKnockById,
  ensureWalkinsBeat,
  nextSeqForBeat,
  insertTarget,
  insertBeatTarget,
  bumpBeatTargetCount,
  insertSale,
  getSaleByKnockId,
  transaction,
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

// ---------------------------------------------------------------------------
// POST /api/knocks/manual — walk-in / off-beat door (onboarding 2026-07-20).
// Creates an HONEST ad-hoc target (score 0, unknown signals — no fabricated
// data), appends it to the resolved beat (explicit beat_id, else the rep's
// walk-in beat), logs the knock, and — for a sold door — the sale, preserving
// the normal agreement/QBO attribution path. Idempotent on client_uuid.
// ---------------------------------------------------------------------------
const ALLOWED_COUNTIES = new Set(['Stanislaus', 'San Joaquin', 'Merced']);

knocksRouter.post('/knocks/manual', (req, res) => {
  const b = req.body ?? {};
  const rep = getRepById(req.repId);
  if (!rep) return res.status(400).json({ error: 'rep not found' });

  // Idempotency: replaying a client_uuid returns the existing knock (+ sale).
  if (b.client_uuid) {
    const existing = getKnockByClientUuid(b.client_uuid);
    if (existing) {
      const sale = getSaleByKnockId(existing.id);
      return res.status(200).json({
        knock: shapeKnock(existing),
        reused: true,
        sale: sale ? shapeManualSale(sale) : null,
      });
    }
  }

  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!DISPOSITIONS.includes(b.disposition)) {
    return res.status(400).json({ error: 'invalid disposition' });
  }
  if (b.disposition === 'sold' && !PACKAGE_KEYS.includes(b.package)) {
    return res.status(400).json({ error: 'a valid package is required for a sold door' });
  }

  // Resolve the target beat: explicit beat, else the rep's walk-in beat.
  let beat = b.beat_id ? getBeatById(b.beat_id) : null;
  if (!beat) beat = ensureWalkinsBeat(rep);

  const county = ALLOWED_COUNTIES.has(b.county) ? b.county : beat.county;
  const safeCounty = ALLOWED_COUNTIES.has(county) ? county : 'Stanislaus';
  const lat = Number.isFinite(b.lat) ? b.lat : beat.center_lat;
  const lng = Number.isFinite(b.lng) ? b.lng : beat.center_lng;
  const ts = normalizeTimestamp(b.knocked_at);

  const out = transaction(() => {
    const targetId = `target_${randomUUID()}`;
    insertTarget({
      id: targetId, address, city: (b.city || beat.city || '—'),
      county: safeCounty, zip: (b.zip || '00000'),
      lat, lng, ad_hoc: 1, score: 0,
      owner_occupied: 0, owner_occupied_known: 0,
      solicit_status: 'unknown', known_signals: '[]',
    });
    insertBeatTarget({ beat_id: beat.id, target_id: targetId, seq: nextSeqForBeat(beat.id) });
    bumpBeatTargetCount(beat.id, 1);

    const knockId = `knock_${randomUUID()}`;
    insertKnock({
      id: knockId, beat_id: beat.id, target_id: targetId, rep_id: rep.id,
      disposition: b.disposition, answered: b.disposition === 'not_home' ? 0 : 1,
      note: typeof b.note === 'string' ? b.note : null,
      client_uuid: b.client_uuid ?? null, knocked_at: ts,
    });

    let sale = null;
    if (b.disposition === 'sold') {
      const saleId = `sale_${randomUUID()}`;
      const amount_cents = PACKAGE_CATALOG[b.package].amount_cents;
      const agreement_url = buildAgreementUrl(b.package, targetId, { saleId, repId: rep.id });
      insertSale({
        id: saleId, knock_id: knockId, rep_id: rep.id, target_id: targetId,
        package: b.package, amount_cents, agreement_url,
        client_uuid: b.sold_client_uuid ?? null, sold_at: ts,
      });
      sale = getSaleByKnockId(knockId);
    }
    return { knock: getKnockById(knockId), target_id: targetId, sale };
  });

  res.status(201).json({
    knock: shapeKnock(out.knock),
    target: { id: out.target_id, address, city: (b.city || beat.city || '—'),
              lat, lng, score: 0, ad_hoc: true, beat_id: beat.id },
    beat: { id: beat.id, name: beat.name, kind: beat.kind },
    sale: out.sale ? shapeManualSale(out.sale) : null,
  });
});

function shapeManualSale(s) {
  return { id: s.id, package: s.package, amount_usd: Math.round(s.amount_cents) / 100,
    amount_cents: s.amount_cents, agreement_url: s.agreement_url, sold_at: s.sold_at };
}

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
