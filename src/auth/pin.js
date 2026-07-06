// src/auth/pin.js
// PIN hashing for rep login. A 4-digit PIN is inherently low-entropy, so the
// real defence is server-side lockout (see repo/middleware) — this module only
// makes stored PINs non-reversible and salted. Uses Node's built-in scrypt; no
// new dependency.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const KEYLEN = 32;

/**
 * Hash a PIN with a fresh random salt.
 * @param {string|number} pin
 * @returns {{ hash: string, salt: string }} hex-encoded
 */
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(pin), salt, KEYLEN).toString('hex');
  return { hash, salt };
}

/**
 * Constant-time verify of a PIN against a stored hash+salt.
 * @returns {boolean}
 */
export function verifyPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(pin), salt, KEYLEN);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
