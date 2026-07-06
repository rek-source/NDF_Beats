// test/api.test.js  (OWNER: backend)
// Route contract tests (SPEC §5) against a freshly seeded throwaway DB.
// Uses Node's built-in test runner + http; no external test deps.
//
// Strategy: point DB_PATH at a temp file, run migrate + seed in-process, start
// the app on an ephemeral port, exercise every endpoint, assert the frozen
// shapes. Run with: `node --test test/`.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE importing anything that reads config.
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-test-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');

// Seed in-process (the seed script self-runs on import, so call its pieces).
// We import the seed module for its side-effect-free run by invoking node, but
// simplest: shell out is avoided — instead replicate via dynamic import of the
// seed which runs on import. To keep it deterministic we import after env set.
migrate();
await import('../scripts/seed.js'); // runs the seed against TMP_DB

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;
let authToken; // a valid rep token for protected writes (knocks/sales)

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  // Writes are token-bound now: provision a rep with a PIN and log in once.
  const id = `rep_${randomUUID()}`;
  repo.insertRep({ id, name: 'API Test Rep', email: `apitest+${id}@ndf.test`, role: 'rep' });
  const { hash, salt } = hashPin('1234');
  repo.setRepPin(id, hash, salt);
  const login = await api('POST', '/api/auth/login', { rep_id: id, pin: '1234' });
  authToken = login.json.token;
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

/** POST a protected write (knock/sale) with the test rep's bearer token. */
function authed(method, p, body) {
  return api(method, p, body, { authorization: `Bearer ${authToken}` });
}

// Helper: grab a rep with assigned beats and an active beat with targets.
async function pickWorkingBeat() {
  const sb = await api('GET', '/api/scoreboard?period=month');
  const repId = sb.json.leaderboard.find((r) => r.doors_knocked > 0)?.rep_id
    ?? sb.json.leaderboard[0].rep_id;
  const beats = await api('GET', `/api/reps/${repId}/beats`);
  const beat = beats.json.beats[0];
  const detail = await api('GET', `/api/beats/${beat.id}`);
  return { repId, beat, targets: detail.json.targets };
}

test('GET /api/health ok', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('5.1 list beats for rep — shape + 404', async () => {
  const sb = await api('GET', '/api/scoreboard?period=month');
  const repId = sb.json.leaderboard[0].rep_id;
  const r = await api('GET', `/api/reps/${repId}/beats`);
  assert.equal(r.status, 200);
  assert.ok(r.json.rep.id && r.json.rep.name);
  assert.ok(Array.isArray(r.json.beats));
  const b = r.json.beats[0];
  assert.ok(b.id && b.name && b.city && b.county);
  assert.ok(typeof b.target_count === 'number');
  assert.ok(typeof b.center.lat === 'number' && typeof b.center.lng === 'number');
  assert.ok(typeof b.progress.knocked === 'number' && typeof b.progress.remaining === 'number');

  const missing = await api('GET', '/api/reps/rep_does_not_exist/beats');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'rep not found');
});

test('5.2 get beat with ordered targets — shape + 404', async () => {
  const { beat, targets } = await pickWorkingBeat();
  assert.ok(targets.length > 0);
  const seqs = targets.map((t) => t.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b)); // ordered by seq
  const t = targets[0];
  assert.equal(t.seq, 1);
  assert.ok(typeof t.value_usd === 'number');
  assert.equal(typeof t.owner_occupied, 'boolean');
  assert.equal(typeof t.no_soliciting, 'boolean');
  assert.ok('last_disposition' in t);

  const missing = await api('GET', '/api/beats/beat_nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'beat not found');
});

test('5.3 POST knock — derive answered, validate, idempotent', async () => {
  const { repId, beat, targets } = await pickWorkingBeat();
  const target = targets[0];

  // invalid disposition
  const bad = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: target.id, rep_id: repId, disposition: 'banana',
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'invalid disposition');

  // not_home => answered false
  const cu = randomUUID();
  const nh = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: target.id, rep_id: repId,
    disposition: 'not_home', client_uuid: cu,
  });
  assert.equal(nh.status, 201);
  assert.equal(nh.json.knock.answered, false);

  // replay same client_uuid => 200 + same knock id
  const replay = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: target.id, rep_id: repId,
    disposition: 'not_home', client_uuid: cu,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.knock.id, nh.json.knock.id);

  // callback => answered true
  const cb = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: targets[1].id, rep_id: repId,
    disposition: 'callback', client_uuid: randomUUID(),
  });
  assert.equal(cb.json.knock.answered, true);
});

test('5.4 POST sale — sold-state gate, server price, 409 dup', async () => {
  const { repId, beat, targets } = await pickWorkingBeat();
  const target = targets[2];

  // knock that is NOT sold
  const nk = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: target.id, rep_id: repId,
    disposition: 'callback', client_uuid: randomUUID(),
  });
  const notSold = await authed('POST', '/api/sales', {
    knock_id: nk.json.knock.id, package: 'preferred', client_uuid: randomUUID(),
  });
  assert.equal(notSold.status, 400);
  assert.equal(notSold.json.error, "knock not in 'sold' state");

  // sold knock
  const sk = await authed('POST', '/api/knocks', {
    beat_id: beat.id, target_id: targets[3].id, rep_id: repId,
    disposition: 'sold', client_uuid: randomUUID(),
  });
  const saleCu = randomUUID();
  const sale = await authed('POST', '/api/sales', {
    knock_id: sk.json.knock.id, package: 'preferred', client_uuid: saleCu,
  });
  assert.equal(sale.status, 201);
  assert.equal(sale.json.sale.amount_cents, 30000); // server-authoritative
  assert.equal(sale.json.sale.amount_usd, 300);
  assert.match(sale.json.sale.agreement_url, /home-care-membership\.html\?/);
  assert.match(sale.json.sale.agreement_url, /pkg=preferred/);
  // Attribution contract: the agreement URL must carry target + sale + rep so
  // the tracker can reconcile the eventual payment back to this door-knock.
  {
    const qs = new URLSearchParams(sale.json.sale.agreement_url.split('?')[1]);
    assert.equal(qs.get('target'), targets[3].id);
    assert.equal(qs.get('sale'), sale.json.sale.id);
    // rep is token-bound (the authed rep who logged the knock), never body-supplied;
    // the API response deliberately hides rep_id, so assert presence + shape.
    assert.match(qs.get('rep') ?? '', /^rep_[0-9a-f-]+$/);
  }

  // idempotent replay
  const replay = await authed('POST', '/api/sales', {
    knock_id: sk.json.knock.id, package: 'preferred', client_uuid: saleCu,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.sale.id, sale.json.sale.id);

  // second distinct sale on same knock => 409
  const dup = await authed('POST', '/api/sales', {
    knock_id: sk.json.knock.id, package: 'essential', client_uuid: randomUUID(),
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error, 'sale already exists for knock');

  // invalid package
  const badPkg = await authed('POST', '/api/sales', {
    knock_id: sk.json.knock.id, package: 'platinum', client_uuid: randomUUID(),
  });
  assert.equal(badPkg.status, 400);
});

test('5.5 scoreboard — 6 KPIs, all periods non-empty, sorted', async () => {
  for (const period of ['today', 'week', 'month']) {
    const r = await api('GET', `/api/scoreboard?period=${period}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.period, period);
    assert.ok(r.json.generated_at);
    const team = r.json.team;
    for (const k of ['doors_knocked', 'doors_answered', 'answer_rate', 'yeses', 'nos', 'avg_sale_usd']) {
      assert.equal(typeof team[k], 'number', `${period} team.${k}`);
    }
    assert.ok('top_package' in team);
    assert.ok(team.doors_knocked > 0, `${period} should have knocks`);

    // answer_rate consistency
    const expected = team.doors_knocked
      ? Math.round((team.doors_answered / team.doors_knocked) * 1000) / 1000 : 0;
    assert.equal(team.answer_rate, expected);

    // leaderboard sorted by yeses desc, then answer_rate desc; ranks 1..n
    const lb = r.json.leaderboard;
    assert.ok(lb.length >= 3);
    for (let i = 1; i < lb.length; i++) {
      const a = lb[i - 1], b = lb[i];
      const ok = a.yeses > b.yeses
        || (a.yeses === b.yeses && a.answer_rate >= b.answer_rate);
      assert.ok(ok, `${period} leaderboard order at ${i}`);
      assert.equal(b.rank, i + 1);
    }
  }

  // default period is today
  const def = await api('GET', '/api/scoreboard');
  assert.equal(def.json.period, 'today');
});

test('unknown /api route returns json 404', async () => {
  const r = await api('GET', '/api/nope');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'not found');
});
