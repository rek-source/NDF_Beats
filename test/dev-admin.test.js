// test/dev-admin.test.js  (OWNER: backend)
// Prod-safe dev-only admin injection. The manager portal + /api/admin/* are gated
// in production by Caddy forward_auth, which injects an authoritative X-Auth-User.
// A headless browser can't clear that gate locally, so we allow a DEV-ONLY shim:
// when (and ONLY when) env BEATS_DEV_ADMIN_USER is set, the backend injects that
// user as X-Auth-User so admin.html is browser-testable on localhost.
//
// SAFETY CONTRACT (these tests are the guardrail):
//   * The env var is NEVER set in /opt/ndf-beats/.env, so prod is unchanged.
//   * Without the env var, requireAdmin STILL 403s when no Caddy header present.
//   * The injection is read at REQUEST time from process.env (not frozen at
//     import), so it cannot be latched on; clearing the env immediately re-gates.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-devadmin-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
// Start clean: the dev shim must be OFF unless a test opts in.
delete process.env.BEATS_DEV_ADMIN_USER;

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');

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
  delete process.env.BEATS_DEV_ADMIN_USER;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

async function api(method, p, headers = {}) {
  const res = await fetch(baseUrl + p, { method, headers });
  let json = null;
  try { json = await res.json(); } catch { /* non-json */ }
  return { status: res.status, json };
}

test('without BEATS_DEV_ADMIN_USER, admin API still 403s when no Caddy header', async () => {
  delete process.env.BEATS_DEV_ADMIN_USER;
  const r = await api('GET', '/api/admin/overview');
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'admin authentication required');
});

test('with BEATS_DEV_ADMIN_USER set, the admin API becomes reachable locally', async () => {
  process.env.BEATS_DEV_ADMIN_USER = 'dev@khb';
  try {
    const r = await api('GET', '/api/admin/overview');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.reps));
  } finally {
    delete process.env.BEATS_DEV_ADMIN_USER;
  }
});

test('the injected dev user is the one requireAdmin uses (whoami echoes it)', async () => {
  process.env.BEATS_DEV_ADMIN_USER = 'dev@khb';
  try {
    const r = await api('GET', '/api/admin/whoami');
    assert.equal(r.status, 200);
    assert.equal(r.json.user, 'dev@khb');
  } finally {
    delete process.env.BEATS_DEV_ADMIN_USER;
  }
});

test('a real Caddy-injected X-Auth-User still wins and works with the shim OFF', async () => {
  delete process.env.BEATS_DEV_ADMIN_USER;
  const r = await api('GET', '/api/admin/whoami', { 'x-auth-user': 'ryan@kitchenhomeandbath.com' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user, 'ryan@kitchenhomeandbath.com');
});

test('clearing the env var immediately re-gates (injection is request-time, not latched)', async () => {
  process.env.BEATS_DEV_ADMIN_USER = 'dev@khb';
  const on = await api('GET', '/api/admin/overview');
  assert.equal(on.status, 200);

  delete process.env.BEATS_DEV_ADMIN_USER;
  const off = await api('GET', '/api/admin/overview');
  assert.equal(off.status, 403);
});
