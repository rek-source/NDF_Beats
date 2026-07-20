// test/admin-create-beat.test.js  (OWNER: backend)
// POST /api/admin/beats — a manager creates a named custom beat (kind='custom',
// empty, optionally assigned to a rep). Same throwaway-DB + X-Auth-User gate
// pattern as admin.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE importing anything that reads config.
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-admin-beat-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
migrate();
const repo = await import('../src/db/repo.js');
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

const ADMIN = { 'x-auth-user': 'ryan@kitchenhomeandbath.com' };

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

function makeRep() {
  const rep = { id: `rep_${randomUUID()}`, name: 'Beat Assignee',
    email: `assignee${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  return rep;
}

test('POST /api/admin/beats creates an empty custom beat', async () => {
  const r = await api('POST', '/api/admin/beats', {
    name: 'Sylvan Ave — nice area', city: 'Modesto', county: 'Stanislaus',
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.beat.kind, 'custom');
  assert.equal(r.json.beat.status, 'ready');
  assert.equal(r.json.beat.target_count, 0);
  assert.equal(r.json.beat.rep_id, null);
  const row = repo.getBeatById(r.json.beat.id);
  assert.equal(row.kind, 'custom');
  assert.ok(Number.isFinite(row.center_lat) && Number.isFinite(row.center_lng));
});

test('POST /api/admin/beats rejects a bad county', async () => {
  const r = await api('POST', '/api/admin/beats', {
    name: 'Bad County Beat', city: 'Fresno', county: 'Fresno',
  });
  assert.equal(r.status, 400);
});

test('POST /api/admin/beats assigns the beat when rep_id is passed', async () => {
  const rep = makeRep();
  const r = await api('POST', '/api/admin/beats', {
    name: 'Assigned Beat', city: 'Turlock', county: 'Stanislaus', rep_id: rep.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.beat.rep_id, rep.id);
  assert.equal(r.json.beat.rep_name, rep.name);
  assert.equal(repo.getBeatById(r.json.beat.id).rep_id, rep.id);

  const missing = await api('POST', '/api/admin/beats', {
    name: 'Ghost Rep Beat', city: 'Modesto', county: 'Stanislaus', rep_id: 'rep_nope',
  });
  assert.equal(missing.status, 400);
});

test('profile-approval rebuild preserves empty custom + walk-in beats', async () => {
  const rep = makeRep();
  const created = await api('POST', '/api/admin/beats', {
    name: 'Keep Me Custom', city: 'Modesto', county: 'Stanislaus',
  });
  assert.equal(created.status, 201);
  const customId = created.json.beat.id;
  const walkins = repo.ensureWalkinsBeat(rep);

  const approve = await api('POST', '/api/admin/profile/approve', { force: true });
  assert.equal(approve.status, 201);

  assert.ok(repo.getBeatById(customId), 'custom beat survives the rebuild');
  assert.ok(repo.getBeatById(walkins.id), 'walk-in beat survives the rebuild');
});
