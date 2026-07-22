// src/routes/sales.routes.js
// POST /api/sales  (SPEC §5.4)
// The knock must exist AND be disposition 'sold'. Price is server-authoritative
// (from the package catalog) — the client cannot set the amount. The agreement
// URL is built server-side. Idempotent on client_uuid; one sale per knock (409).

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { PACKAGE_CATALOG, PACKAGE_KEYS, buildAgreementUrl } from '../config.js';
import { isUniqueViolation } from '../db/errors.js';
import {
  getSaleByClientUuid,
  getKnockById,
  getSaleByKnockId,
  insertSale,
} from '../db/repo.js';

export const salesRouter = Router();

function shapeSale(s) {
  return {
    id: s.id,
    package: s.package,
    amount_usd: Math.round(s.amount_cents) / 100,
    amount_cents: s.amount_cents,
    agreement_url: s.agreement_url,
    sold_at: s.sold_at,
  };
}

salesRouter.post('/sales', (req, res) => {
  const body = req.body ?? {};
  const { knock_id, package: pkg, client_uuid, sold_at } = body;

  // Idempotency on client_uuid first.
  if (client_uuid) {
    const existing = getSaleByClientUuid(client_uuid);
    if (existing) {
      return res.status(200).json({ sale: shapeSale(existing) });
    }
  }

  if (!PACKAGE_KEYS.includes(pkg)) {
    return res.status(400).json({ error: 'invalid package' });
  }
  if (!knock_id) {
    return res.status(400).json({ error: 'knock_id is required' });
  }

  const knock = getKnockById(knock_id);
  if (!knock) {
    return res.status(400).json({ error: 'knock not found' });
  }
  if (knock.disposition !== 'sold') {
    return res.status(400).json({ error: "knock not in 'sold' state" });
  }

  // One sale per knock.
  if (getSaleByKnockId(knock_id)) {
    return res.status(409).json({ error: 'sale already exists for knock' });
  }

  const amount_cents = PACKAGE_CATALOG[pkg].amount_cents; // server-authoritative
  const ts = normalizeTimestamp(sold_at);
  const id = `sale_${randomUUID()}`;
  // Carry sale + rep into the URL so the agreements tracker can attribute the
  // eventual PAYMENT back to this door-knock (commission reconciliation).
  const agreement_url = buildAgreementUrl(pkg, knock.target_id, {
    saleId: id,
    repId: knock.rep_id,
  });

  const saleRow = {
    id,
    knock_id,
    rep_id: knock.rep_id,
    target_id: knock.target_id,
    package: pkg,
    amount_cents,
    agreement_url,
    client_uuid: client_uuid ?? null,
    sold_at: ts,
  };

  try {
    insertSale(saleRow);
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Either a racing replay of client_uuid or a racing sale for this knock.
      if (client_uuid) {
        const dup = getSaleByClientUuid(client_uuid);
        if (dup) return res.status(200).json({ sale: shapeSale(dup) });
      }
      if (getSaleByKnockId(knock_id)) {
        return res.status(409).json({ error: 'sale already exists for knock' });
      }
    }
    throw err;
  }

  return res.status(201).json({ sale: shapeSale(saleRow) });
});

function normalizeTimestamp(input) {
  if (typeof input === 'string') {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
