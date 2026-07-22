// test/admin.test.js  (OWNER: backend)
// Contract tests for the manager/admin portal API (add-rep, assign-beat,
// overview snapshot). Same throwaway-DB strategy as api.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE importing anything that reads config.
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-admin-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');

migrate();
await import('../scripts/seed.js'); // seeds reps + beats against TMP_DB

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
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

// Admin routes are gated by the Caddy-injected X-Auth-User header; tests pass it
// directly (the backend only sees requests that cleared the gate in production).
const ADMIN = { 'x-auth-user': 'ryan@kitchenhomeandbath.com' };

// Every call here carries the admin header by default (the one public read,
// /api/reps/:id/beats, simply ignores it).
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

test('GET /api/admin/overview — reps, beats, unassigned count, data status', async () => {
  const r = await api('GET', '/api/admin/overview');
  assert.equal(r.status, 200);

  assert.ok(Array.isArray(r.json.reps));
  const rep = r.json.reps[0];
  assert.ok(rep.id && rep.name && rep.email);
  assert.ok('role' in rep && 'active' in rep);
  assert.equal(typeof rep.beat_count, 'number');

  assert.ok(Array.isArray(r.json.beats));
  const beat = r.json.beats[0];
  assert.ok(beat.id && beat.name && beat.city && beat.county);
  assert.equal(typeof beat.target_count, 'number');
  assert.ok('rep_id' in beat && 'rep_name' in beat);

  assert.equal(typeof r.json.unassigned_count, 'number');

  // data status panel (no fabricated values — counts only)
  assert.equal(typeof r.json.data.targets, 'number');
  assert.equal(typeof r.json.data.no_soliciting, 'number');
  assert.ok(r.json.data.targets > 0);
});

test('GET /api/admin/profile — default vs learned Ideal-Client weights', async () => {
  const r = await api('GET', '/api/admin/profile');
  assert.equal(r.status, 200);

  // default (prior) weights present and sum to 1
  const dw = r.json.default_weights;
  assert.ok(dw && typeof dw.value === 'number');
  const dsum = Object.values(dw).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(dsum - 1) < 1e-6, `default weights sum ${dsum}`);

  // learned weights present and sum to 1
  const w = r.json.weights;
  assert.ok(w && typeof w.value === 'number');
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `learned weights sum ${sum}`);

  // signals list (ordering for the UI) + learned provenance key present
  assert.ok(Array.isArray(r.json.signals) && r.json.signals.length === 7);
  assert.ok('learned' in r.json); // null when no sales; object once learned
  // the seed includes sales, so the model should have learned something
  assert.ok(r.json.learned && typeof r.json.learned.n_sold === 'number');
  assert.ok(r.json.learned.n_sold > 0);
});

test('POST /api/reps — create rep, validate, dedupe email', async () => {
  const email = `rookie+${randomUUID().slice(0, 8)}@ndf.test`;

  // happy path
  const ok = await api('POST', '/api/admin/reps', { name: 'Rookie Rep', email });
  assert.equal(ok.status, 201);
  assert.ok(ok.json.rep.id.startsWith('rep_'));
  assert.equal(ok.json.rep.name, 'Rookie Rep');
  assert.equal(ok.json.rep.email, email);
  assert.equal(ok.json.rep.role, 'rep'); // default
  assert.equal(ok.json.rep.active, true);

  // it now shows up in the overview
  const ov = await api('GET', '/api/admin/overview');
  assert.ok(ov.json.reps.some((rp) => rp.id === ok.json.rep.id));

  // missing name
  const noName = await api('POST', '/api/admin/reps', { email: `x+${randomUUID()}@ndf.test` });
  assert.equal(noName.status, 400);
  assert.equal(noName.json.error, 'name and email are required');

  // invalid email
  const badEmail = await api('POST', '/api/admin/reps', { name: 'Bad', email: 'not-an-email' });
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.error, 'invalid email');

  // invalid role
  const badRole = await api('POST', '/api/admin/reps', {
    name: 'Wrong', email: `y+${randomUUID()}@ndf.test`, role: 'admin',
  });
  assert.equal(badRole.status, 400);
  assert.equal(badRole.json.error, 'invalid role');

  // duplicate email -> 409
  const dup = await api('POST', '/api/admin/reps', { name: 'Dupe', email });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'email already exists');

  // manager role allowed
  const mgr = await api('POST', '/api/admin/reps', {
    name: 'Manager Mary', email: `mgr+${randomUUID().slice(0, 8)}@ndf.test`, role: 'manager',
  });
  assert.equal(mgr.status, 201);
  assert.equal(mgr.json.rep.role, 'manager');
});

test('POST /api/beats/:beatId/assign — assign + unassign + 404s', async () => {
  const ov = await api('GET', '/api/admin/overview');
  const beat = ov.json.beats[0];
  const otherRep = ov.json.reps[0];

  // assign to a rep
  const assigned = await api('POST', `/api/admin/beats/${beat.id}/assign`, { rep_id: otherRep.id });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.beat.id, beat.id);
  assert.equal(assigned.json.beat.rep_id, otherRep.id);
  assert.equal(assigned.json.beat.rep_name, otherRep.name);

  // it appears in that rep's beats now
  const repBeats = await api('GET', `/api/reps/${otherRep.id}/beats`);
  assert.ok(repBeats.json.beats.some((b) => b.id === beat.id));

  // unassign (rep_id null)
  const unassigned = await api('POST', `/api/admin/beats/${beat.id}/assign`, { rep_id: null });
  assert.equal(unassigned.status, 200);
  assert.equal(unassigned.json.beat.rep_id, null);
  assert.equal(unassigned.json.beat.rep_name, null);

  // beat not found
  const noBeat = await api('POST', '/api/admin/beats/beat_nope/assign', { rep_id: otherRep.id });
  assert.equal(noBeat.status, 404);
  assert.equal(noBeat.json.error, 'beat not found');

  // rep not found
  const noRep = await api('POST', `/api/admin/beats/${beat.id}/assign`, { rep_id: 'rep_nope' });
  assert.equal(noRep.status, 400);
  assert.equal(noRep.json.error, 'rep not found');
});
