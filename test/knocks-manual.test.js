// test/knocks-manual.test.js  (OWNER: backend)
// POST /api/knocks/manual — walk-in / off-beat door logging. A manual knock
// creates an honest ad-hoc target (score 0, unknown signals), appends it to the
// resolved beat (explicit beat_id or the rep's walk-in beat), logs the knock,
// and optionally the sale — all token-attributed, all idempotent on client_uuid.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE importing anything that reads config.
const TMP_DB = path.join(os.tmpdir(), `ndf-manual-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'test-secret-'.padEnd(40, 'x');

const { migrate } = await import('../src/db/migrate.js');
migrate();
const repo = await import('../src/db/repo.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createApp } = await import('../src/server.js');

let server;
let baseUrl;
let authToken;
let rep;

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  // Writes are token-bound: provision a rep with a PIN and log in once
  // (exact pattern from test/api.test.js).
  rep = { id: `rep_${randomUUID()}`, name: 'Walkin Rep',
    email: `w${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  const { hash, salt } = hashPin('1234');
  repo.setRepPin(rep.id, hash, salt);
  const login = await api('POST', '/api/auth/login', { rep_id: rep.id, pin: '1234' });
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

function authed(method, p, body) {
  return api(method, p, body, { authorization: `Bearer ${authToken}` });
}

// The manual route geocodes typed addresses via the free Census geocoder.
// Tests must never hit the network: intercept census URLs (default: no match,
// so the route falls back to the beat center) and pass everything else — our
// own in-process server — through untouched.
const realFetch = globalThis.fetch;
let censusHandler = () => censusResponse({ result: { addressMatches: [] } });
let censusCalls = [];
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.includes('geocoding.geo.census.gov')) {
    censusCalls.push(u);
    return Promise.resolve(censusHandler(u));
  }
  if (u.includes('nominatim.openstreetmap.org')) {
    // Fallback provider: count it as a geocoder consult, return "no result".
    censusCalls.push(u);
    return Promise.resolve(censusResponse([]));
  }
  return realFetch(url, opts);
};
test.after(() => { globalThis.fetch = realFetch; });

function censusResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

function censusMatch(lat, lng) {
  return censusResponse({
    result: { addressMatches: [{ coordinates: { x: lng, y: lat }, matchedAddress: 'MATCHED' }] },
  });
}

function countTargets() {
  return getDb().prepare('SELECT COUNT(*) AS c FROM targets').get().c;
}

test('manual knock creates an ad-hoc target and logs the knock into the walk-in beat', async () => {
  const r = await authed('POST', '/api/knocks/manual', {
    address: '742 Evergreen Ter', city: 'Modesto',
    disposition: 'not_interested', note: 'walk-in door',
    client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.knock.id, 'knock returned');
  assert.equal(r.json.knock.answered, true);
  assert.equal(r.json.target.ad_hoc, true);
  assert.equal(r.json.target.score, 0);
  assert.equal(r.json.beat.kind, 'walkins');

  // A walk-in beat now exists for the rep, and the target row is honest.
  const wb = repo.getWalkinsBeatForRep(rep.id);
  assert.ok(wb, 'walk-in beat exists');
  assert.equal(r.json.beat.id, wb.id);
  const t = repo.getTargetById(r.json.target.id);
  assert.equal(t.ad_hoc, 1);
  assert.equal(t.score, 0);
  assert.equal(t.owner_occupied_known, 0);
  assert.equal(t.solicit_status, 'unknown');
  assert.equal(t.known_signals, '[]');
  // Attribution is token-bound.
  const k = getDb().prepare('SELECT * FROM knocks WHERE id = ?').get(r.json.knock.id);
  assert.equal(k.rep_id, rep.id);
  assert.equal(k.beat_id, wb.id);
});

test('manual knock with disposition=sold returns a sale + agreement_url', async () => {
  const r = await authed('POST', '/api/knocks/manual', {
    address: '19 Closer Ct', city: 'Modesto',
    disposition: 'sold', package: 'preferred',
    client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  assert.ok(r.json.sale, 'sale returned');
  assert.equal(r.json.sale.amount_cents, 30000); // server-authoritative price
  const qs = new URLSearchParams(r.json.sale.agreement_url.split('?')[1]);
  assert.equal(qs.get('pkg'), 'preferred');
  assert.equal(qs.get('target'), r.json.target.id);
  assert.equal(qs.get('rep'), rep.id);
  assert.equal(qs.get('sale'), r.json.sale.id);
});

test('manual knock is idempotent on client_uuid', async () => {
  const cu = randomUUID();
  const body = {
    address: '5 Replay Rd', city: 'Modesto',
    disposition: 'not_home', client_uuid: cu,
  };
  const first = await authed('POST', '/api/knocks/manual', body);
  assert.equal(first.status, 201);
  const before = countTargets();
  const replay = await authed('POST', '/api/knocks/manual', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.knock.id, first.json.knock.id);
  assert.equal(countTargets(), before, 'no second ad-hoc target created');
});

test('manual knock validation: address, disposition, sold package', async () => {
  const noAddr = await authed('POST', '/api/knocks/manual', {
    disposition: 'not_home', client_uuid: randomUUID(),
  });
  assert.equal(noAddr.status, 400);
  const badDisp = await authed('POST', '/api/knocks/manual', {
    address: '1 Bad St', disposition: 'banana', client_uuid: randomUUID(),
  });
  assert.equal(badDisp.status, 400);
  const soldNoPkg = await authed('POST', '/api/knocks/manual', {
    address: '1 Sold St', disposition: 'sold', client_uuid: randomUUID(),
  });
  assert.equal(soldNoPkg.status, 400);
});

test('manual knock with explicit beat_id logs into that beat', async () => {
  const beatId = `beat_${randomUUID()}`;
  repo.insertBeat({ id: beatId, name: 'Custom Area', city: 'Modesto', county: 'Stanislaus',
    rep_id: rep.id, status: 'active', center_lat: 37.64, center_lng: -121.0,
    target_count: 0, kind: 'custom' });
  const r = await authed('POST', '/api/knocks/manual', {
    beat_id: beatId, address: '8 Custom Way',
    disposition: 'callback', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.beat.id, beatId);
  assert.equal(r.json.beat.kind, 'custom');
  assert.equal(repo.getBeatById(beatId).target_count, 1, 'target_count bumped');
});

// ---------------------------------------------------------------------------
// Pin accuracy (Jam 2026-07-21): a walk-in door with no device GPS must be
// geocoded from its typed address — not stacked on the beat center.
// ---------------------------------------------------------------------------

test('manual knock with no coords geocodes the typed address', async () => {
  censusCalls = [];
  censusHandler = () => censusMatch(37.4947, -120.8466);
  const r = await authed('POST', '/api/knocks/manual', {
    address: '1332 Merritt St', city: 'Turlock',
    disposition: 'not_home', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.target.lat, 37.4947);
  assert.equal(r.json.target.lng, -120.8466);
  const t = repo.getTargetById(r.json.target.id);
  assert.equal(t.lat, 37.4947);
  assert.equal(t.lng, -120.8466);
  assert.equal(censusCalls.length, 1, 'one geocoder call');
  assert.ok(censusCalls[0].includes(encodeURIComponent('1332 Merritt St')), 'sends the address');
  assert.ok(censusCalls[0].includes('Turlock'), 'includes the city for context');
  censusHandler = () => censusResponse({ result: { addressMatches: [] } });
});

test('manual knock falls back to the beat center when geocoding finds nothing', async () => {
  censusCalls = [];
  const r = await authed('POST', '/api/knocks/manual', {
    address: 'unmatchable nonsense', disposition: 'not_home', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  const wb = repo.getWalkinsBeatForRep(rep.id);
  assert.equal(r.json.target.lat, wb.center_lat);
  assert.equal(r.json.target.lng, wb.center_lng);
  assert.ok(censusCalls.length >= 1, 'geocoder was consulted (census + nominatim fallback)');
});

test('manual knock with device GPS coords skips geocoding entirely', async () => {
  censusCalls = [];
  const r = await authed('POST', '/api/knocks/manual', {
    address: '9 Gps Way', city: 'Modesto', lat: 37.61, lng: -120.95,
    disposition: 'callback', client_uuid: randomUUID(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.target.lat, 37.61);
  assert.equal(r.json.target.lng, -120.95);
  assert.equal(censusCalls.length, 0, 'device GPS wins — no geocoder call');
});
