// test/auth-edge.test.js  (OWNER: backend)
// Edge-case coverage for:
//   token.js             — expiry boundary, missing fields, fractional session hours
//   POST /api/auth/login — missing body fields -> 400; numeric pin coercion; logout
//   requireRepToken      — Authorization header prefix variants; inactive rep
//   POST /api/admin/reps/:repId/pin — unknown rep -> 404; 3-digit and 5-digit pins
//   requireAdmin         — GET /api/admin/overview and /api/admin/profile without
//                          X-Auth-User must be 403
//   POST /api/sales      — unauthenticated request -> 401
//   attribution          — sale created with a token is attributed to the token rep

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, createHmac } from 'node:crypto';

// Set env vars BEFORE importing anything that touches config.
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-edge-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'edge-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.BEATS_SESSION_HOURS = '12';
process.env.BEATS_PIN_MAX_ATTEMPTS = '3';
process.env.BEATS_PIN_LOCKOUT_MIN = '15';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { signToken, verifyToken } = await import('../src/auth/token.js');

migrate();
await import('../scripts/seed.js');

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;

const ADMIN = { 'x-auth-user': 'ryan@kitchenhomeandbath.com' };
const SECRET = process.env.BEATS_TOKEN_SECRET;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

async function api(method, p, body, headers = {}) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

// Create a rep with a known PIN and log in; returns {id, token}.
async function repWithToken(pin) {
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'Edge Tester', email: `edge+${id}@ndf.test`, role: 'rep' });
  const { hash, salt } = hashPin(pin);
  repo.setRepPin(id, hash, salt);
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin });
  return { id, token: r.json.token };
}

// Helper: build a signed token directly with a custom payload object (bypass signToken
// so we can omit specific fields). Used by pure token.js tests.
function craftToken(payloadObj) {
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

// ---------------------------------------------------------------------------
// token.js — boundary + missing-field edge cases (pure, no HTTP)
// ---------------------------------------------------------------------------

test('token.js: token expires exactly at the boundary second (nowSec === exp)', () => {
  const iat = 1_700_000_000;
  const nowMs = iat * 1000;
  const token = signToken({ rep_id: 'rep_x', ver: 1 }, { secret: SECRET, sessionHours: 1, nowMs });
  // exp = iat + 3600; at exactly exp => expired (nowSec >= payload.exp)
  const atExpiry = (iat + 3600) * 1000;
  assert.equal(verifyToken(token, { secret: SECRET, nowMs: atExpiry }), null, 'at exact expiry second should be null');
  // one millisecond before expiry is still valid
  const justBefore = atExpiry - 1;
  const payload = verifyToken(token, { secret: SECRET, nowMs: justBefore });
  assert.ok(payload, 'one ms before expiry should still be valid');
  assert.equal(payload.rep_id, 'rep_x');
});

test('token.js: token with a future iat is still valid (exp governs, not iat)', () => {
  const futureIat = Math.floor(Date.now() / 1000) + 3600; // issued 1h from now
  const futureMs = futureIat * 1000;
  // sign at futureMs, verify at current time — token should be valid because nowMs < exp
  const token = signToken({ rep_id: 'rep_future', ver: 1 }, { secret: SECRET, sessionHours: 24, nowMs: futureMs });
  const payload = verifyToken(token, { secret: SECRET, nowMs: Date.now() });
  assert.ok(payload, 'token with future iat but valid exp should verify');
  assert.equal(payload.rep_id, 'rep_future');
});

test('token.js: payload missing ver field passes verifyToken (version check is in middleware)', () => {
  // verifyToken only checks rep_id (string) and exp (number); ver is not required here.
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const token = craftToken({ rep_id: 'rep_no_ver', iat, exp }); // no `ver`
  const result = verifyToken(token, { secret: SECRET, nowMs });
  assert.ok(result, 'payload without ver should still pass verifyToken');
  assert.equal(result.rep_id, 'rep_no_ver');
  assert.equal(result.ver, undefined);
});

test('token.js: payload missing rep_id returns null', () => {
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const token = craftToken({ iat, exp, ver: 1 }); // no rep_id
  assert.equal(verifyToken(token, { secret: SECRET, nowMs }), null);
});

test('token.js: payload with rep_id as non-string returns null', () => {
  const nowMs = Date.now();
  const iat = Math.floor(nowMs / 1000);
  const exp = iat + 3600;
  const token = craftToken({ rep_id: 42, iat, exp, ver: 1 }); // rep_id is a number
  assert.equal(verifyToken(token, { secret: SECRET, nowMs }), null);
});

test('token.js: fractional session hours produce correct exp', () => {
  const nowMs = 1_700_000_000_000;
  const token = signToken({ rep_id: 'rep_half', ver: 1 }, { secret: SECRET, sessionHours: 0.5, nowMs });
  const payload = verifyToken(token, { secret: SECRET, nowMs });
  assert.ok(payload, 'half-hour session token verifies within window');
  assert.equal(payload.exp - payload.iat, 1800, 'exp - iat should be 1800 seconds');
});

// ---------------------------------------------------------------------------
// POST /api/auth/login — missing field -> 400 and numeric pin coercion
// ---------------------------------------------------------------------------

test('login: omitting rep_id returns 400', async () => {
  const r = await api('POST', '/api/auth/login', { pin: '1234' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
});

test('login: omitting pin key entirely returns 400', async () => {
  const r = await api('POST', '/api/auth/login', { rep_id: 'rep_ghost' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
});

test('login: empty string pin returns 400', async () => {
  const r = await api('POST', '/api/auth/login', { rep_id: 'rep_ghost', pin: '' });
  assert.equal(r.status, 400);
  assert.ok(r.json.error);
});

test('login: numeric pin is coerced to string and accepted', async () => {
  // The route does `body.pin == null ? '' : String(body.pin)` so JSON number 1234 should work.
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'Numeric PIN Rep', email: `numpin+${id}@ndf.test`, role: 'rep' });
  const { hash, salt } = hashPin('1234');
  repo.setRepPin(id, hash, salt);
  // Send the pin as a JSON number, not a string.
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin: 1234 });
  assert.equal(r.status, 200, 'numeric pin 1234 should be coerced and accepted');
  assert.ok(r.json.token, 'token should be issued');
});

test('login: null pin in body returns 400 (null coerces to empty string via ?? "")', async () => {
  const r = await api('POST', '/api/auth/login', { rep_id: 'rep_ghost', pin: null });
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// POST /api/auth/logout
// ---------------------------------------------------------------------------

test('logout returns {ok: true} without any Authorization header', async () => {
  const r = await api('POST', '/api/auth/logout');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('logout returns {ok: true} even when a valid Authorization header is present', async () => {
  const { token } = await repWithToken('5678');
  const r = await api('POST', '/api/auth/logout', null, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

// ---------------------------------------------------------------------------
// requireRepToken — Authorization header prefix variants + inactive rep
// ---------------------------------------------------------------------------

async function beatTargetForKnock() {
  const sb = await api('GET', '/api/scoreboard?period=month');
  const repId = sb.json.leaderboard[0].rep_id;
  const beats = await api('GET', `/api/reps/${repId}/beats`);
  const beat = beats.json.beats[0];
  const detail = await api('GET', `/api/beats/${beat.id}`);
  return { beatId: beat.id, targetId: detail.json.targets[0].id };
}

test('requireRepToken: Authorization header with no "Bearer" prefix -> 401', async () => {
  const { token } = await repWithToken('2222');
  const { beatId, targetId } = await beatTargetForKnock();
  // Send the raw token without "Bearer " prefix — the header value IS the token string.
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: token });
  assert.equal(r.status, 401);
});

test('requireRepToken: lowercase "bearer " prefix is accepted (case-insensitive)', async () => {
  const { token } = await repWithToken('3333');
  const { beatId, targetId } = await beatTargetForKnock();
  // The bearer() helper uses /^Bearer\s+(.+)$/i so lowercase is fine.
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `bearer ${token}` });
  assert.equal(r.status, 201, 'lowercase bearer should be accepted');
});

test('requireRepToken: "BEARER " (all-caps) prefix is accepted', async () => {
  const { token } = await repWithToken('4444');
  const { beatId, targetId } = await beatTargetForKnock();
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `BEARER ${token}` });
  assert.equal(r.status, 201, 'all-caps BEARER should be accepted');
});

test('requireRepToken: inactive rep with a valid token gets 401', async () => {
  const { id, token } = await repWithToken('6666');
  const { beatId, targetId } = await beatTargetForKnock();
  // Deactivate the rep directly in the DB.
  getDb().prepare(`UPDATE reps SET active = 0 WHERE id = ?`).run(id);
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 401, 'inactive rep should be rejected even with a valid token');
  assert.ok(r.json.error);
});

// ---------------------------------------------------------------------------
// POST /api/admin/reps/:repId/pin — unknown rep -> 404; digit-boundary pins
// ---------------------------------------------------------------------------

test('admin pin: unknown repId -> 404', async () => {
  const r = await api('POST', '/api/admin/reps/rep_does_not_exist/pin', { pin: '1234' }, ADMIN);
  assert.equal(r.status, 404);
  assert.ok(r.json.error);
});

test('admin pin: 3-digit pin is rejected (too short)', async () => {
  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  const repId = ov.json.reps[0].id;
  const r = await api('POST', `/api/admin/reps/${repId}/pin`, { pin: '123' }, ADMIN);
  assert.equal(r.status, 400, '3-digit pin must be rejected');
});

test('admin pin: 5-digit pin is rejected (too long)', async () => {
  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  const repId = ov.json.reps[0].id;
  const r = await api('POST', `/api/admin/reps/${repId}/pin`, { pin: '12345' }, ADMIN);
  assert.equal(r.status, 400, '5-digit pin must be rejected');
});

// ---------------------------------------------------------------------------
// requireAdmin — GET /api/admin/overview and /api/admin/profile without
// X-Auth-User header must return 403
// ---------------------------------------------------------------------------

test('requireAdmin: GET /api/admin/overview without X-Auth-User returns 403', async () => {
  const r = await api('GET', '/api/admin/overview');
  assert.equal(r.status, 403);
  assert.ok(r.json.error);
});

test('requireAdmin: GET /api/admin/profile without X-Auth-User returns 403', async () => {
  const r = await api('GET', '/api/admin/profile');
  assert.equal(r.status, 403);
  assert.ok(r.json.error);
});

test('requireAdmin: GET /api/admin/overview WITH X-Auth-User returns 200', async () => {
  const r = await api('GET', '/api/admin/overview', null, ADMIN);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.reps));
  assert.ok(Array.isArray(r.json.beats));
});

test('requireAdmin: GET /api/admin/profile WITH X-Auth-User returns 200', async () => {
  const r = await api('GET', '/api/admin/profile', null, ADMIN);
  assert.equal(r.status, 200);
  assert.ok('weights' in r.json);
  assert.ok('default_weights' in r.json);
  assert.ok(Array.isArray(r.json.signals));
});

// ---------------------------------------------------------------------------
// POST /api/sales — unauthenticated request returns 401 (requireRepToken gate)
// ---------------------------------------------------------------------------

test('POST /api/sales without any token returns 401', async () => {
  const r = await api('POST', '/api/sales', {
    knock_id: 'knock_fake', package: 'preferred', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 401);
});

test('POST /api/sales with a garbage token returns 401', async () => {
  const r = await api('POST', '/api/sales', {
    knock_id: 'knock_fake', package: 'preferred', client_uuid: randomUUID(),
  }, { authorization: 'Bearer garbage.token.here' });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------------------
// Attribution: sale created with a valid token is attributed to the token rep
// ---------------------------------------------------------------------------

test('sale created with a valid token is attributed to the token rep', async () => {
  const { id, token } = await repWithToken('7777');
  const { beatId, targetId } = await beatTargetForKnock();

  // Create a 'sold' knock as this rep.
  const knock = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'sold', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${token}` });
  assert.equal(knock.status, 201, 'sold knock should be created');
  const knockId = knock.json.knock.id;

  // Create the sale.
  const sale = await api('POST', '/api/sales', {
    knock_id: knockId, package: 'essential', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${token}` });
  assert.equal(sale.status, 201, 'sale should be created');
  assert.equal(sale.json.sale.amount_cents, 15000, 'server-authoritative price for essential');

  // Verify the stored knock is attributed to the logged-in rep (not any spoofed value).
  const storedKnock = repo.getKnockById(knockId);
  assert.equal(storedKnock.rep_id, id, 'knock and thus sale should be attributed to the token rep');
});
