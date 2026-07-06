// src/auth/token.js
// Hand-rolled signed session token (no JWT dependency). Format:
//   base64url(JSON{rep_id, iat, exp, ver}) + "." + base64url(HMAC_SHA256(payload))
// `iat`/`exp` are UNIX seconds. The HMAC is keyed by BEATS_TOKEN_SECRET. The
// token is bound to a rep_id and a token_version; bumping a rep's version (on PIN
// reset) invalidates every outstanding token for that rep — that check lives in
// the middleware against the DB, not here.

import { createHmac, timingSafeEqual } from 'node:crypto';

function sign(payloadB64, secret) {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

/**
 * Issue a token bound to a rep.
 * @param {{rep_id: string, ver: number}} claims
 * @param {{secret: string, sessionHours: number, nowMs?: number}} opts
 * @returns {string}
 */
export function signToken({ rep_id, ver }, { secret, sessionHours, nowMs = Date.now() }) {
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + Math.round(sessionHours * 3600);
  const payloadB64 = Buffer.from(JSON.stringify({ rep_id, iat, exp, ver })).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

/**
 * Verify a token's signature and expiry.
 * @param {string} token
 * @param {{secret: string, nowMs?: number}} opts
 * @returns {{rep_id: string, iat: number, exp: number, ver: number} | null}
 *   the decoded payload when valid (signature OK and not expired), else null.
 *   Version validity (vs the rep's current token_version) is checked elsewhere.
 */
export function verifyToken(token, { secret, nowMs = Date.now() }) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig) return null;

  // Constant-time signature comparison.
  const expectedSig = sign(payloadB64, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.rep_id !== 'string' || typeof payload.exp !== 'number') {
    return null;
  }
  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= payload.exp) return null; // expired
  return payload;
}
