// test/auth.test.js  (OWNER: backend)
// Phase 3 — auth endpoints + token middleware. Throwaway seeded DB, real HTTP.
//   POST /api/auth/login : right -> token, wrong -> 401 (+attempt), lockout -> 423,
//                          no-PIN -> 409, unknown rep -> 401.
//   token middleware     : valid -> req.repId; missing/bad/expired/version-bumped -> 401.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-auth-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'unit-test-secret-000000000000000000000000';
process.env.BEATS_SESSION_HOURS = '12';
process.env.BEATS_PIN_MAX_ATTEMPTS = '3';
process.env.BEATS_PIN_LOCKOUT_MIN = '15';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');

migrate();
await import('../scripts/seed.js');

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;

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

// Give a fresh rep a known PIN directly through the repo (Phase 5 covers the
// admin endpoint that normally does this).
function repWithPin(pin) {
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'PIN Tester', email: `pin+${id}@ndf.test`, role: 'rep' });
  const { hash, salt } = hashPin(pin);
  repo.setRepPin(id, hash, salt);
  return id;
}

test('login with the correct PIN returns a token + rep + exp', async () => {
  const id = repWithPin('1234');
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin: '1234' });
  assert.equal(r.status, 200);
  assert.ok(r.json.token, 'token issued');
  assert.equal(r.json.rep.id, id);
  assert.ok(r.json.rep.name);
  assert.equal(typeof r.json.exp, 'number');
});

test('login with no PIN set returns 409', async () => {
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'No PIN', email: `nopin+${id}@ndf.test`, role: 'rep' });
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin: '1234' });
  assert.equal(r.status, 409);
});

test('login for an unknown rep returns 401', async () => {
  const r = await api('POST', '/api/auth/login', { rep_id: 'rep_ghost', pin: '1234' });
  assert.equal(r.status, 401);
});

test('a wrong PIN returns 401 and reports remaining attempts', async () => {
  const id = repWithPin('1234');
  const r = await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' });
  assert.equal(r.status, 401);
  assert.equal(r.json.attempts_remaining, 2); // max 3, one used
});

test('too many wrong PINs locks the rep with 423', async () => {
  const id = repWithPin('1234');
  await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' }); // 1
  await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' }); // 2
  const third = await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' }); // 3 -> lock
  assert.equal(third.status, 423);
  // even the correct PIN is refused while locked
  const locked = await api('POST', '/api/auth/login', { rep_id: id, pin: '1234' });
  assert.equal(locked.status, 423);
});

test('a correct PIN clears the failed-attempt counter', async () => {
  const id = repWithPin('1234');
  await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' }); // 1 fail
  const ok = await api('POST', '/api/auth/login', { rep_id: id, pin: '1234' });
  assert.equal(ok.status, 200);
  // counter reset -> a subsequent single wrong attempt still shows 2 remaining
  const wrong = await api('POST', '/api/auth/login', { rep_id: id, pin: '0000' });
  assert.equal(wrong.json.attempts_remaining, 2);
});

// ── token middleware via a protected write (knocks) ─────────────────────────

async function aBeatTargetRep() {
  const sb = await api('GET', '/api/scoreboard?period=month');
  const repId = sb.json.leaderboard[0].rep_id;
  const beats = await api('GET', `/api/reps/${repId}/beats`);
  const beat = beats.json.beats[0];
  const detail = await api('GET', `/api/beats/${beat.id}`);
  return { repId, beatId: beat.id, targetId: detail.json.targets[0].id };
}

test('a protected write with no token returns 401', async () => {
  const { beatId, targetId, repId } = await aBeatTargetRep();
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId, rep_id: repId,
    disposition: 'not_home', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 401);
});

test('a valid token authorizes a protected write', async () => {
  const { beatId, targetId } = await aBeatTargetRep();
  // login as a rep that owns nothing in particular — attribution is by token
  const id = repWithPin('4321');
  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '4321' });
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${login.json.token}` });
  assert.equal(r.status, 201);
});

test('a knock is attributed to the token rep, ignoring a spoofed body rep_id', async () => {
  const { beatId, targetId } = await aBeatTargetRep();
  const id = repWithPin('1111');
  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '1111' });
  const knock = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    rep_id: 'rep_someone_else', // spoof attempt — must be ignored
    disposition: 'refused', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${login.json.token}` });
  assert.equal(knock.status, 201);
  const stored = repo.getKnockById(knock.json.knock.id);
  assert.equal(stored.rep_id, id, 'attributed to the logged-in rep, not the body');
});

test('a tampered/garbage token is rejected with 401', async () => {
  const { beatId, targetId } = await aBeatTargetRep();
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: 'Bearer not.a.real.token' });
  assert.equal(r.status, 401);
});

test('bumping token_version invalidates an already-issued token', async () => {
  const { beatId, targetId } = await aBeatTargetRep();
  const id = repWithPin('5678');
  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '5678' });
  const token = login.json.token;
  // resetting the PIN bumps token_version
  repo.setRepPin(id, ...Object.values(hashPin('5678')));
  const r = await api('POST', '/api/knocks', {
    beat_id: beatId, target_id: targetId,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${token}` });
  assert.equal(r.status, 401);
});
