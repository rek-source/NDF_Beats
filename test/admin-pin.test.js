// test/admin-pin.test.js  (OWNER: backend)
// Phase 5 — admin PIN management + admin-mutation gating. Admin writes live
// under the central-gated /api/admin/* prefix and require the Caddy-injected
// X-Auth-User header; without it they 403. Setting a PIN hashes it, resets the
// attempt counter, and bumps token_version (invalidating outstanding tokens).

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-adminpin-${randomUUID()}.db`);
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

async function firstRepId() {
  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  return ov.json.reps[0].id;
}

test('admin mutations without X-Auth-User are forbidden (403)', async () => {
  const id = await firstRepId();
  const noHdr = await api('POST', `/api/admin/reps/${id}/pin`, { pin: '4242' });
  assert.equal(noHdr.status, 403);

  const createNoHdr = await api('POST', '/api/admin/reps', {
    name: 'Ungated', email: `ungated+${randomUUID()}@ndf.test`,
  });
  assert.equal(createNoHdr.status, 403);
});

test('admin can set a rep PIN, which then logs in', async () => {
  const id = await firstRepId();
  const set = await api('POST', `/api/admin/reps/${id}/pin`, { pin: '4242' }, ADMIN);
  assert.equal(set.status, 200);
  assert.equal(set.json.ok, true);

  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '4242' });
  assert.equal(login.status, 200);
  assert.ok(login.json.token);
});

test('setting a PIN rejects non-4-digit input', async () => {
  const id = await firstRepId();
  for (const bad of ['12', '123456', 'abcd', '12a4', '']) {
    const r = await api('POST', `/api/admin/reps/${id}/pin`, { pin: bad }, ADMIN);
    assert.equal(r.status, 400, `pin "${bad}" should be rejected`);
  }
});

test('resetting a PIN bumps token_version (old token invalidated)', async () => {
  const id = await firstRepId();
  await api('POST', `/api/admin/reps/${id}/pin`, { pin: '4242' }, ADMIN);
  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '4242' });
  const oldToken = login.json.token;

  // reset to a new PIN
  await api('POST', `/api/admin/reps/${id}/pin`, { pin: '8686' }, ADMIN);

  // old token no longer authorizes a write
  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  const beat = ov.json.beats[0];
  const detail = await api('GET', `/api/beats/${beat.id}`);
  const knock = await api('POST', '/api/knocks', {
    beat_id: beat.id, target_id: detail.json.targets[0].id,
    disposition: 'not_home', client_uuid: randomUUID(),
  }, { authorization: `Bearer ${oldToken}` });
  assert.equal(knock.status, 401);
});

test('admin overview reports pin_set status per rep', async () => {
  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  const rep = ov.json.reps[0];
  assert.equal(typeof rep.pin_set, 'boolean');
  // we just set rep[0]'s PIN above, so it should read true now
  const target = ov.json.reps.find((r) => r.id === rep.id);
  assert.equal(target.pin_set, true);
});

test('admin create-rep and assign-beat work under the gated prefix', async () => {
  const email = `gated+${randomUUID().slice(0, 8)}@ndf.test`;
  const created = await api('POST', '/api/admin/reps', { name: 'Gated Rep', email }, ADMIN);
  assert.equal(created.status, 201);
  assert.ok(created.json.rep.id.startsWith('rep_'));

  const ov = await api('GET', '/api/admin/overview', null, ADMIN);
  const beat = ov.json.beats[0];
  const assigned = await api('POST', `/api/admin/beats/${beat.id}/assign`,
    { rep_id: created.json.rep.id }, ADMIN);
  assert.equal(assigned.status, 200);
  assert.equal(assigned.json.beat.rep_id, created.json.rep.id);
});
