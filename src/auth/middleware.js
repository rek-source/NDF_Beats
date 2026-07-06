// src/auth/middleware.js
// Token-verify middleware for rep-attributed writes. Reads `Authorization:
// Bearer <token>`, validates signature + expiry (token.js), then confirms the
// token's version still matches the rep's current token_version in the DB (a PIN
// reset bumps the version, invalidating old tokens). On success attaches
// `req.repId`; otherwise 401. Identity comes from the token, never the body.

import { BEATS_TOKEN_SECRET } from '../config.js';
import { verifyToken } from './token.js';
import { getRepById } from '../db/repo.js';

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/** Express middleware: require a valid rep token; sets req.repId. */
export function requireRepToken(req, res, next) {
  const token = bearer(req);
  const payload = token && verifyToken(token, { secret: BEATS_TOKEN_SECRET });
  if (!payload) {
    return res.status(401).json({ error: 'authentication required' });
  }
  const rep = getRepById(payload.rep_id);
  if (!rep || !rep.active || rep.token_version !== payload.ver) {
    return res.status(401).json({ error: 'session expired' });
  }
  req.repId = rep.id;
  req.rep = rep;
  next();
}

/**
 * DEV-ONLY admin shim — makes the gated portal browser-testable on localhost.
 *
 * In production the portal + /api/admin/* sit behind Caddy forward_auth, which
 * injects an authoritative `X-Auth-User`. A headless browser can't clear that
 * gate, so when (and ONLY when) `BEATS_DEV_ADMIN_USER` is set we inject that
 * value as the header so `requireAdmin` lets the request through.
 *
 * Prod-safety contract:
 *   - The env var is NEVER set in /opt/ndf-beats/.env, so prod is unchanged.
 *   - We read process.env at REQUEST time (not import time) so the shim can be
 *     neither latched on nor accidentally compiled in — clearing the env var
 *     re-gates immediately.
 *   - A real Caddy-injected header always wins: we only inject when the request
 *     carries no X-Auth-User, so this can never override the real gate.
 */
export function injectDevAdminUser(req, _res, next) {
  const devUser = process.env.BEATS_DEV_ADMIN_USER;
  if (devUser && String(devUser).trim() && !req.headers['x-auth-user']) {
    req.headers['x-auth-user'] = String(devUser).trim();
  }
  next();
}

/**
 * Gate admin mutations. The perimeter (Caddy forward_auth on /beats/api/admin/*)
 * authenticates the KHB staff user and injects an authoritative `X-Auth-User`
 * header (and strips any client-supplied one). The backend is only reachable
 * through Caddy, so the header's PRESENCE is a sufficient app-level check;
 * absence means the request bypassed the gate -> 403.
 */
export function requireAdmin(req, res, next) {
  const user = req.headers['x-auth-user'];
  if (!user || !String(user).trim()) {
    return res.status(403).json({ error: 'admin authentication required' });
  }
  req.adminUser = String(user).trim();
  next();
}
