// test/auth-lib.test.js  (OWNER: backend)
// Phase 2 — pure auth primitives: PIN hashing (scrypt, salted) and the
// hand-rolled HMAC token. No DB, no HTTP — just the crypto contracts.

import test from 'node:test';
import assert from 'node:assert/strict';

const { hashPin, verifyPin } = await import('../src/auth/pin.js');
const { signToken, verifyToken } = await import('../src/auth/token.js');

const SECRET = 'test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// ── PIN hashing ─────────────────────────────────────────────────────────────

test('hashPin -> verifyPin round-trips for the correct PIN', () => {
  const { hash, salt } = hashPin('1234');
  assert.ok(hash && salt, 'returns hash + salt');
  assert.equal(verifyPin('1234', hash, salt), true);
});

test('verifyPin rejects the wrong PIN', () => {
  const { hash, salt } = hashPin('1234');
  assert.equal(verifyPin('9999', hash, salt), false);
});

test('the same PIN hashed twice uses different salts (no rainbow reuse)', () => {
  const a = hashPin('1234');
  const b = hashPin('1234');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

// ── Token sign/verify ───────────────────────────────────────────────────────

test('signToken -> verifyToken returns the bound rep_id and version', () => {
  const now = 1_700_000_000_000;
  const token = signToken({ rep_id: 'rep_abc', ver: 1 }, { secret: SECRET, sessionHours: 12, nowMs: now });
  const payload = verifyToken(token, { secret: SECRET, nowMs: now });
  assert.ok(payload, 'valid token verifies');
  assert.equal(payload.rep_id, 'rep_abc');
  assert.equal(payload.ver, 1);
  assert.equal(payload.exp, payload.iat + 12 * 3600);
});

test('verifyToken rejects a tampered payload', () => {
  const now = 1_700_000_000_000;
  const token = signToken({ rep_id: 'rep_abc', ver: 1 }, { secret: SECRET, sessionHours: 12, nowMs: now });
  // Swap the payload segment for a different rep_id, keep the original signature.
  const sig = token.split('.')[1];
  const forged = Buffer.from(JSON.stringify({ rep_id: 'rep_evil', iat: 1, exp: 9_999_999_999, ver: 1 }))
    .toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, { secret: SECRET, nowMs: now }), null);
});

test('verifyToken rejects an expired token', () => {
  const iatMs = 1_700_000_000_000;
  const token = signToken({ rep_id: 'rep_abc', ver: 1 }, { secret: SECRET, sessionHours: 1, nowMs: iatMs });
  const later = iatMs + 2 * 3600 * 1000; // 2h later, window was 1h
  assert.equal(verifyToken(token, { secret: SECRET, nowMs: later }), null);
});

test('verifyToken rejects a token signed with a different secret', () => {
  const now = 1_700_000_000_000;
  const token = signToken({ rep_id: 'rep_abc', ver: 1 }, { secret: SECRET, sessionHours: 12, nowMs: now });
  assert.equal(verifyToken(token, { secret: 'a-different-secret', nowMs: now }), null);
});

test('verifyToken rejects malformed input', () => {
  assert.equal(verifyToken('', { secret: SECRET }), null);
  assert.equal(verifyToken('garbage', { secret: SECRET }), null);
  assert.equal(verifyToken('a.b.c', { secret: SECRET }), null);
});
