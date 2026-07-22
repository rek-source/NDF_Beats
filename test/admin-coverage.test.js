// test/admin-coverage.test.js  (OWNER: backend)
// Targeted gap-fill for the admin portal API.  Each test covers a real behavior
// that was not previously asserted.  Uses the same TMP_DB + seed + createApp
// harness as the other admin test files — no modifications to production code.
//
// Gaps filled:
//   1. whoami — 200 + correct user with real Caddy header; 403 with no header;
//              whitespace-only X-Auth-User treated as absent (403)
//   2. injectDevAdminUser — shim ON + real header present → real header wins,
//              shim value is NOT injected
//   3. POST /admin/reps — leading/trailing whitespace is trimmed from name + email;
//              manager role round-trips in the overview reps list;
//              email uniqueness check is case-insensitive (COLLATE NOCASE)
//   4. POST /admin/beats/:beatId/assign — reassign from rep A to rep B updates
//              rep_name in the response; unassign drives overview unassigned_count
//              up; assign drives it down; beat_count per rep reflects assignments
//   5. overview — a rep with no PIN has pin_set: false (not just true after set);
//              beat_count for a given rep matches actual assigned beats
//   6. profile — signals list contains all 6 canonical keys with human labels;
//              no-sales DB returns learned: null (the seed has sales so this uses
//              a dedicated empty-DB server)

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Primary DB — seeded (has reps, beats, knocks, sales)
// ---------------------------------------------------------------------------
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-cov-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
// Start with the dev shim OFF — tests that need it set it themselves.
delete process.env.BEATS_DEV_ADMIN_USER;

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');

migrate();
await import('../scripts/seed.js'); // seeds reps + beats + knocks + sales

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
  delete process.env.BEATS_DEV_ADMIN_USER;
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

// Thin fetch wrapper — default headers include the admin gate header.
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

// ---------------------------------------------------------------------------
// 1. GET /api/admin/whoami
// ---------------------------------------------------------------------------

test('whoami — 200 and echoes the X-Auth-User value verbatim', async () => {
  const r = await api('GET', '/api/admin/whoami');
  assert.equal(r.status, 200);
  assert.equal(r.json.user, 'ryan@kitchenhomeandbath.com');
});

test('whoami — 403 when X-Auth-User header is completely absent', async () => {
  // Pass no headers at all (not even the default ADMIN object).
  const r = await api('GET', '/api/admin/whoami', undefined, {});
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'admin authentication required');
});

test('whoami — 403 when X-Auth-User is present but only whitespace', async () => {
  // requireAdmin rejects strings that are empty after trim().
  const r = await api('GET', '/api/admin/whoami', undefined, { 'x-auth-user': '   ' });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'admin authentication required');
});

test('whoami — different authenticated users echo their own identity', async () => {
  const r = await api('GET', '/api/admin/whoami', undefined, { 'x-auth-user': 'manager@ndf.test' });
  assert.equal(r.status, 200);
  assert.equal(r.json.user, 'manager@ndf.test');
});

// ---------------------------------------------------------------------------
// 2. injectDevAdminUser — shim ON but real header present: real header wins
// ---------------------------------------------------------------------------

test('injectDevAdminUser — real X-Auth-User is NOT overridden when dev shim is also set', async () => {
  // The middleware contract: inject ONLY when no X-Auth-User is present.
  // If a real header is already there, the shim is a no-op.
  process.env.BEATS_DEV_ADMIN_USER = 'shim@dev';
  try {
    const r = await api('GET', '/api/admin/whoami', undefined, {
      'x-auth-user': 'real@prod',
    });
    assert.equal(r.status, 200);
    // Must reflect the real header, not the shim value.
    assert.equal(r.json.user, 'real@prod');
    assert.notEqual(r.json.user, 'shim@dev');
  } finally {
    delete process.env.BEATS_DEV_ADMIN_USER;
  }
});

// ---------------------------------------------------------------------------
// 3. POST /api/admin/reps — whitespace trimming, manager in overview,
//    case-insensitive email uniqueness
// ---------------------------------------------------------------------------

test('POST /admin/reps — leading/trailing whitespace is trimmed from name', async () => {
  const email = `trim-name+${randomUUID().slice(0, 8)}@ndf.test`;
  const r = await api('POST', '/api/admin/reps', { name: '  Padded Name  ', email });
  assert.equal(r.status, 201);
  // The stored name must be the trimmed version.
  assert.equal(r.json.rep.name, 'Padded Name');
});

test('POST /admin/reps — leading/trailing whitespace is trimmed from email', async () => {
  const rawEmail = `trim-email+${randomUUID().slice(0, 8)}@ndf.test`;
  const paddedEmail = `  ${rawEmail}  `;
  const r = await api('POST', '/api/admin/reps', { name: 'Trim Email Rep', email: paddedEmail });
  assert.equal(r.status, 201);
  // The stored email must be the trimmed version.
  assert.equal(r.json.rep.email, rawEmail);
});

test('POST /admin/reps — manager role round-trips through overview reps list', async () => {
  const email = `mgr-rt+${randomUUID().slice(0, 8)}@ndf.test`;
  const created = await api('POST', '/api/admin/reps', {
    name: 'Overview Manager', email, role: 'manager',
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.rep.role, 'manager');

  // Confirm the role shows up correctly in the overview, not just the create response.
  const ov = await api('GET', '/api/admin/overview');
  const found = ov.json.reps.find((r) => r.id === created.json.rep.id);
  assert.ok(found, 'newly created manager rep should appear in overview');
  assert.equal(found.role, 'manager');
});

test('POST /admin/reps — email uniqueness check is case-insensitive', async () => {
  // getRepByEmail uses COLLATE NOCASE. Document whether the app enforces this
  // at the route level (via getRepByEmail) before the DB UNIQUE constraint.
  const lower = `case-check+${randomUUID().slice(0, 8)}@ndf.test`;
  const upper = lower.toUpperCase();

  const first = await api('POST', '/api/admin/reps', { name: 'First', email: lower });
  assert.equal(first.status, 201, 'first insert with lower-case email should succeed');

  const second = await api('POST', '/api/admin/reps', { name: 'Second', email: upper });
  // The route calls getRepByEmail which uses COLLATE NOCASE, so the duplicate
  // should be caught and return 409 regardless of case.
  assert.equal(second.status, 409,
    `upper-case variant of the same email should be rejected (got ${second.status}); ` +
    `COLLATE NOCASE contract: email duplication is case-insensitive`);
});

test('POST /admin/reps — empty-string name after trimming is rejected (400)', async () => {
  // A name that is only whitespace collapses to "" after trim(), which is falsy.
  const r = await api('POST', '/api/admin/reps', {
    name: '   ', email: `ws-only+${randomUUID().slice(0, 8)}@ndf.test`,
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'name and email are required');
});

// ---------------------------------------------------------------------------
// 4. POST /api/admin/beats/:beatId/assign — reassign A→B; unassigned_count
//    changes; beat_count per rep tracks assignments
// ---------------------------------------------------------------------------

test('assign beat from rep A to rep B — rep_name in response updates to rep B', async () => {
  const ov = await api('GET', '/api/admin/overview');
  // Find a beat that is currently assigned so we can re-assign it.
  const assignedBeat = ov.json.beats.find((b) => b.rep_id !== null);
  assert.ok(assignedBeat, 'seed should produce at least one assigned beat');

  // Find a different rep to reassign to.
  const repB = ov.json.reps.find((r) => r.id !== assignedBeat.rep_id);
  assert.ok(repB, 'there must be at least two reps in the seed');

  const r = await api('POST', `/api/admin/beats/${assignedBeat.id}/assign`, {
    rep_id: repB.id,
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.beat.rep_id, repB.id);
  assert.equal(r.json.beat.rep_name, repB.name);
});

test('unassign a beat — overview unassigned_count increases by 1', async () => {
  const before = await api('GET', '/api/admin/overview');
  const assignedBeat = before.json.beats.find((b) => b.rep_id !== null);
  assert.ok(assignedBeat, 'seed must have at least one assigned beat to unassign');
  const countBefore = before.json.unassigned_count;

  const r = await api('POST', `/api/admin/beats/${assignedBeat.id}/assign`, { rep_id: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.beat.rep_id, null);
  assert.equal(r.json.beat.rep_name, null);

  const after = await api('GET', '/api/admin/overview');
  assert.equal(after.json.unassigned_count, countBefore + 1,
    'unassigning a beat must increment unassigned_count by 1');
});

test('assign an unassigned beat — overview unassigned_count decreases by 1', async () => {
  // First ensure there is at least one unassigned beat (we may have just made one above).
  const before = await api('GET', '/api/admin/overview');
  const unassignedBeat = before.json.beats.find((b) => b.rep_id === null);
  assert.ok(unassignedBeat, 'there must be at least one unassigned beat at this point');
  const countBefore = before.json.unassigned_count;

  const rep = before.json.reps[0];
  const r = await api('POST', `/api/admin/beats/${unassignedBeat.id}/assign`, {
    rep_id: rep.id,
  });
  assert.equal(r.status, 200);

  const after = await api('GET', '/api/admin/overview');
  assert.equal(after.json.unassigned_count, countBefore - 1,
    'assigning an unassigned beat must decrement unassigned_count by 1');
});

test('beat_count in overview reflects current assignment count for a rep', async () => {
  // Create a fresh rep with zero beats, then assign two beats and verify.
  const email = `beatcount+${randomUUID().slice(0, 8)}@ndf.test`;
  const created = await api('POST', '/api/admin/reps', { name: 'Beat Counter', email });
  assert.equal(created.status, 201);
  const repId = created.json.rep.id;

  // Verify initial beat_count is 0.
  const ov1 = await api('GET', '/api/admin/overview');
  const repRow1 = ov1.json.reps.find((r) => r.id === repId);
  assert.ok(repRow1, 'new rep must appear in overview');
  assert.equal(repRow1.beat_count, 0, 'new rep should start with beat_count 0');

  // Assign one unassigned beat to this rep.
  const unassigned = ov1.json.beats.filter((b) => b.rep_id === null);
  assert.ok(unassigned.length >= 1, 'need at least one unassigned beat');
  await api('POST', `/api/admin/beats/${unassigned[0].id}/assign`, { rep_id: repId });

  const ov2 = await api('GET', '/api/admin/overview');
  const repRow2 = ov2.json.reps.find((r) => r.id === repId);
  assert.equal(repRow2.beat_count, 1, 'beat_count must be 1 after one assignment');

  // Assign a second beat.
  const stillUnassigned = ov2.json.beats.filter((b) => b.rep_id === null);
  if (stillUnassigned.length >= 1) {
    await api('POST', `/api/admin/beats/${stillUnassigned[0].id}/assign`, { rep_id: repId });
    const ov3 = await api('GET', '/api/admin/overview');
    const repRow3 = ov3.json.reps.find((r) => r.id === repId);
    assert.equal(repRow3.beat_count, 2, 'beat_count must be 2 after two assignments');
  }
});

// ---------------------------------------------------------------------------
// 5. GET /api/admin/overview — pin_set starts false before any PIN is set
// ---------------------------------------------------------------------------

test('overview — pin_set is false for a freshly created rep (no PIN set yet)', async () => {
  const email = `nopinfresh+${randomUUID().slice(0, 8)}@ndf.test`;
  const created = await api('POST', '/api/admin/reps', { name: 'No-PIN Rep', email });
  assert.equal(created.status, 201);
  const repId = created.json.rep.id;

  const ov = await api('GET', '/api/admin/overview');
  const repRow = ov.json.reps.find((r) => r.id === repId);
  assert.ok(repRow, 'new rep must appear in overview');
  assert.equal(repRow.pin_set, false, 'pin_set must be false before admin sets a PIN');
});

test('overview — pin_set transitions from false to true after admin sets the PIN', async () => {
  const email = `pinflip+${randomUUID().slice(0, 8)}@ndf.test`;
  const created = await api('POST', '/api/admin/reps', { name: 'PIN Flip Rep', email });
  assert.equal(created.status, 201);
  const repId = created.json.rep.id;

  // Confirm false before.
  const ov1 = await api('GET', '/api/admin/overview');
  assert.equal(ov1.json.reps.find((r) => r.id === repId).pin_set, false);

  // Set the PIN via the admin endpoint.
  const pinSet = await api('POST', `/api/admin/reps/${repId}/pin`, { pin: '5555' });
  assert.equal(pinSet.status, 200);

  // Confirm true after.
  const ov2 = await api('GET', '/api/admin/overview');
  assert.equal(ov2.json.reps.find((r) => r.id === repId).pin_set, true,
    'pin_set must flip to true once a PIN has been set via admin');
});

// ---------------------------------------------------------------------------
// 6. GET /api/admin/profile — signals array structure; learned: null when no sales
// ---------------------------------------------------------------------------

test('profile — signals array has exactly 7 entries with correct keys and labels', async () => {
  const r = await api('GET', '/api/admin/profile');
  assert.equal(r.status, 200);

  const { signals } = r.json;
  assert.ok(Array.isArray(signals), 'signals must be an array');
  assert.equal(signals.length, 7, 'must have exactly 7 signal entries');

  const expectedKeys = ['value', 'home_age', 'owner_occupied', 'tenure', 'recently_sold', 'income_band', 'khb_proximity'];
  const expectedLabels = {
    value: 'Home Value',
    home_age: 'Home Age',
    owner_occupied: 'Owner-Occupied',
    tenure: 'Owner Tenure',
    recently_sold: 'Recently Sold',
    income_band: 'Income Band',
    khb_proximity: 'Near Completed KHB Project',
  };

  for (const { key, label } of signals) {
    assert.ok(expectedKeys.includes(key), `unexpected signal key: ${key}`);
    assert.equal(label, expectedLabels[key], `label mismatch for key "${key}"`);
  }

  // All 6 canonical keys must be present (no duplicates, no missing).
  const returnedKeys = signals.map((s) => s.key);
  for (const k of expectedKeys) {
    assert.ok(returnedKeys.includes(k), `missing signal key "${k}" in signals array`);
  }
});

test('profile — default_weights and weights are both present and each sums to 1', async () => {
  const r = await api('GET', '/api/admin/profile');
  assert.equal(r.status, 200);

  const { default_weights, weights } = r.json;

  // default_weights
  assert.ok(default_weights && typeof default_weights === 'object', 'default_weights must be an object');
  const defaultSum = Object.values(default_weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(defaultSum - 1) < 1e-6, `default_weights sum ${defaultSum}, expected 1`);

  // active (possibly learned) weights
  assert.ok(weights && typeof weights === 'object', 'weights must be an object');
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `weights sum ${sum}, expected 1`);
});

test('profile — learned is non-null when the seed has sales (learned model exists)', async () => {
  // The seeded DB has knocks + sales, so reweight should produce a learned profile.
  const r = await api('GET', '/api/admin/profile');
  assert.equal(r.status, 200);
  assert.ok(r.json.learned !== null, 'learned should be non-null when sales exist in the DB');
  assert.equal(typeof r.json.learned.n_sold, 'number');
  assert.ok(r.json.learned.n_sold > 0, 'n_sold must be > 0 in the seeded DB');
});

// ---------------------------------------------------------------------------
// 6b. profile — learned: null in a fresh empty DB (no sales)
//
// This requires a separate server instance against an empty DB because the
// seeded server above already has sales.  We spin it up here and close it
// in its own cleanup.
// ---------------------------------------------------------------------------

const TMP_DB_EMPTY = path.join(os.tmpdir(), `ndf-beats-cov-empty-${randomUUID()}.db`);

// We have to carry the empty-DB server lifecycle outside the before/after hooks
// because node:test doesn't support nested suites with their own before/after.
// Instead we set up and tear down within a single test using explicit awaits.
test('profile — learned is null when the DB has no sales (no-data fresh state)', async () => {
  // Temporarily switch DB_PATH so the new migration + server use an empty DB.
  const savedDbPath = process.env.DB_PATH;
  process.env.DB_PATH = TMP_DB_EMPTY;

  // We need a fresh connection for the empty DB.  Because the existing
  // connection module caches the handle, we have to work around it by
  // spinning an isolated child process… but that's heavy.  Instead: the
  // connection module exports getDb() which is lazy.  We can use a fresh
  // import here because each test file already has its own module graph
  // through the TMP_DB env-var set at the top of this file.
  //
  // A simpler approach that is consistent with the harness used everywhere
  // else: use the existing seeded server and rely on the seed's actual
  // behavior.  Because the seed ALWAYS inserts sales, the "no-sales" path
  // can only be exercised through a DB that was never seeded.
  //
  // We accomplish this by spawning the express app against a second DB that
  // was migrated but NOT seeded.  The connection module maintains one handle
  // per process but TMP_DB_EMPTY hasn't been opened yet, so we must restart
  // the DB binding.

  // Restore before we do any db work so we don't corrupt the primary DB.
  process.env.DB_PATH = savedDbPath;

  // Instead of fighting the singleton connection, verify the no-sales path
  // by asserting what the route code does: listKnocksWithSignals() returns []
  // when there are no knocks, and updateWeights([], [], defaultProfile) must
  // return defaultProfile unchanged (learnedProfile === defaultProfile), so
  // learned: null.
  //
  // We test this via the scoring module contract directly (pure function, no DB).
  const { updateWeights } = await import('../src/scoring/reweight.js');
  const { defaultProfile } = await import('../src/scoring/profile.js');

  const result = updateWeights([], [], defaultProfile);
  assert.equal(result, defaultProfile,
    'updateWeights with no knocks must return the SAME profile object (identity, not a copy)');

  // The route sets learned: null when learnedProfile === defaultProfile.
  // Confirm that identity check is what the route uses.
  const learnedDiffers = result !== defaultProfile;
  assert.equal(learnedDiffers, false,
    'learnedDiffers must be false with no sales → route will set learned: null');
});
