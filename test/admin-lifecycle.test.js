// test/admin-lifecycle.test.js  (OWNER: backend)
// Rep lifecycle (edit name/email/role, deactivate/reactivate), PIN unlock, and
// the active-beat-unassign auto-reset. Same TMP_DB + seed + listening-server
// harness as admin.test.js. All admin routes are gated by X-Auth-User.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-lifecycle-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
migrate();
await import('../scripts/seed.js');
const { createApp } = await import('../src/server.js');

let server;
let baseUrl;
const ADMIN = { 'x-auth-user': 'ryan@kitchenhomeandbath.com' };

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ } }
});

async function api(method, p, body, headers = ADMIN) {
  const res = await fetch(baseUrl + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

async function newRep(overrides = {}) {
  const email = `life+${randomUUID().slice(0, 8)}@ndf.test`;
  const r = await api('POST', '/api/admin/reps', { name: 'Life Rep', email, ...overrides });
  return r.json.rep;
}

// ---- PATCH /api/admin/reps/:repId — edit ----
test('PATCH edits a rep name', async () => {
  const rep = await newRep();
  const r = await api('PATCH', `/api/admin/reps/${rep.id}`, { name: '  Renamed Rep  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.rep.name, 'Renamed Rep'); // trimmed
  const ov = await api('GET', '/api/admin/overview');
  assert.equal(ov.json.reps.find((x) => x.id === rep.id).name, 'Renamed Rep');
});

test('PATCH edits email + role together', async () => {
  const rep = await newRep();
  const email = `moved+${randomUUID().slice(0, 8)}@ndf.test`;
  const r = await api('PATCH', `/api/admin/reps/${rep.id}`, { email, role: 'manager' });
  assert.equal(r.status, 200);
  assert.equal(r.json.rep.email, email);
  assert.equal(r.json.rep.role, 'manager');
});

test('PATCH keeping the same email (case-variant) is allowed (excludes self)', async () => {
  const rep = await newRep();
  const r = await api('PATCH', `/api/admin/reps/${rep.id}`, { email: rep.email.toUpperCase(), name: 'Same Email' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.rep.name, 'Same Email');
});

test("PATCH rejects taking another rep's email (409)", async () => {
  const a = await newRep();
  const b = await newRep();
  const r = await api('PATCH', `/api/admin/reps/${b.id}`, { email: a.email });
  assert.equal(r.status, 409);
});

test('PATCH validates email shape and role and empty name', async () => {
  const rep = await newRep();
  assert.equal((await api('PATCH', `/api/admin/reps/${rep.id}`, { email: 'nope' })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/reps/${rep.id}`, { role: 'root' })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/reps/${rep.id}`, { name: '   ' })).status, 400);
});

test('PATCH with no editable fields is a 400', async () => {
  const rep = await newRep();
  assert.equal((await api('PATCH', `/api/admin/reps/${rep.id}`, {})).status, 400);
});

test('PATCH on an unknown rep is a 404', async () => {
  assert.equal((await api('PATCH', '/api/admin/reps/rep_nope', { name: 'X' })).status, 404);
});

// ---- deactivate / reactivate ----
test('deactivating a rep removes them from active flows and blocks login', async () => {
  const rep = await newRep();
  await api('POST', `/api/admin/reps/${rep.id}/pin`, { pin: '1357' });
  // logs in while active
  const okLogin = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '1357' });
  assert.equal(okLogin.status, 200);

  // deactivate
  const d = await api('PATCH', `/api/admin/reps/${rep.id}`, { active: false });
  assert.equal(d.status, 200);
  assert.equal(d.json.rep.active, false);

  // inactive rep can no longer log in
  const blocked = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '1357' });
  assert.notEqual(blocked.status, 200);

  // still visible in the admin overview (so a manager can reactivate)
  const ov = await api('GET', '/api/admin/overview');
  const row = ov.json.reps.find((x) => x.id === rep.id);
  assert.equal(row.active, false);

  // reactivate -> can log in again
  const re = await api('PATCH', `/api/admin/reps/${rep.id}`, { active: true });
  assert.equal(re.json.rep.active, true);
  const okAgain = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '1357' });
  assert.equal(okAgain.status, 200);
});

// ---- PIN unlock ----
test('overview exposes pin_set_at and locked status', async () => {
  const rep = await newRep();
  await api('POST', `/api/admin/reps/${rep.id}/pin`, { pin: '2468' });
  const ov = await api('GET', '/api/admin/overview');
  const row = ov.json.reps.find((x) => x.id === rep.id);
  assert.equal(typeof row.pin_set_at, 'string');
  assert.equal(row.locked, false);
});

test('POST /unlock clears a lockout so the rep can sign in again', async () => {
  const rep = await newRep();
  await api('POST', `/api/admin/reps/${rep.id}/pin`, { pin: '9753' });
  // trip the lockout: 5 wrong attempts
  for (let i = 0; i < 5; i++) await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '0000' });
  const locked = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '9753' });
  assert.equal(locked.status, 423); // locked out even with the right PIN

  const ovLocked = await api('GET', '/api/admin/overview');
  assert.equal(ovLocked.json.reps.find((x) => x.id === rep.id).locked, true);

  const unlock = await api('POST', `/api/admin/reps/${rep.id}/unlock`);
  assert.equal(unlock.status, 200);

  const ok = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '9753' });
  assert.equal(ok.status, 200); // unlocked, right PIN works immediately
});

test('unlock on unknown rep is 404', async () => {
  assert.equal((await api('POST', '/api/admin/reps/rep_nope/unlock')).status, 404);
});

// ---- active-beat unassign auto-resets status to ready ----
test('unassigning an ACTIVE beat resets its status to ready', async () => {
  const ov = await api('GET', '/api/admin/overview');
  const activeBeat = ov.json.beats.find((b) => b.status === 'active' && b.rep_id);
  assert.ok(activeBeat, 'seed should contain at least one active, assigned beat');

  const un = await api('POST', `/api/admin/beats/${activeBeat.id}/assign`, { rep_id: null });
  assert.equal(un.status, 200);

  const after = (await api('GET', '/api/admin/overview')).json.beats.find((b) => b.id === activeBeat.id);
  assert.equal(after.rep_id, null);
  assert.equal(after.status, 'ready', 'an unassigned beat must never stay active');
});

// ---- beat renaming ----
test('POST /admin/beats/:beatId/rename updates a beat name', async () => {
  const ov = await api('GET', '/api/admin/overview');
  const beat = ov.json.beats[0];
  const originalName = beat.name;
  assert.ok(originalName);

  const rename = await api('POST', `/api/admin/beats/${beat.id}/rename`, { name: '  New Beat Name  ' });
  assert.equal(rename.status, 200);
  assert.equal(rename.json.beat.name, 'New Beat Name'); // trimmed

  const ovAfter = await api('GET', '/api/admin/overview');
  const renamed = ovAfter.json.beats.find((b) => b.id === beat.id);
  assert.equal(renamed.name, 'New Beat Name');
});

test('POST /admin/beats/:beatId/rename rejects empty names', async () => {
  const ov = await api('GET', '/api/admin/overview');
  const beat = ov.json.beats[0];
  const r = await api('POST', `/api/admin/beats/${beat.id}/rename`, { name: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'beat name cannot be empty');
});

test('POST /admin/beats/:beatId/rename on unknown beat is 404', async () => {
  const r = await api('POST', '/api/admin/beats/beat_nope/rename', { name: 'X' });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'beat not found');
});
