// test/manual-autocomplete.test.js  (OWNER: frontend)
// Address autocomplete in "＋ Log a door" (Jam follow-up 2026-07-21): typing a
// few characters suggests real nearby addresses (Photon/OSM, biased to the
// beat), picking one fills the field AND pins the door at the suggestion's
// exact coordinates — no server-side geocode needed, no full-address typing.
// Placeholder city '—' / zip '00000' must never render in the door list.
// Runs the REAL public/ bundle in the fake-dom sandbox against a REAL server.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-autoc-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'autoc-test-secret-00000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

migrate();

const REP_ID = 'rep_autoc_test';
const PIN = '8642';
repo.insertRep({ id: REP_ID, name: 'Autoc Rep', email: 'autoc@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);
repo.insertBeat({
  id: 'beat_autoc', name: 'Walk-ins', city: '—', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.6391, center_lng: -120.9969,
  target_count: 0, kind: 'walkins',
});

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;
let ctx;
let doc;

// Intercept the geo providers at the sandbox-fetch layer: Photon serves the
// canned suggestions; Census/Nominatim calls are COUNTED (a picked suggestion
// must make server-side geocoding unnecessary — the count stays 0).
let photonCalls = [];
let geocodeCalls = 0;

const PHOTON_BODY = {
  features: [
    {
      geometry: { coordinates: [-120.8355, 37.4941] },
      properties: { housenumber: '1332', street: 'Merritt Street', city: 'Turlock',
        postcode: '95380', state: 'California', countrycode: 'US' },
    },
    {
      geometry: { coordinates: [-121.0011, 37.6402] },
      properties: { housenumber: '1332', street: 'Merced Avenue', city: 'Modesto',
        postcode: '95354', state: 'California', countrycode: 'US' },
    },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 6000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) {
    last = fn();
    if (last) return last;
    await sleep(20);
  }
  throw new Error(`timeout waiting for: ${what}`);
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Server-side geocode calls (would only fire if the client did NOT send
  // coordinates) — count them via the node-global fetch.
  const realGlobalFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('geocoding.geo.census.gov') || u.includes('nominatim.openstreetmap.org')) {
      geocodeCalls++;
      return Promise.resolve(new Response(JSON.stringify({ result: { addressMatches: [] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realGlobalFetch(url, opts);
  };
  test.after(() => { globalThis.fetch = realGlobalFetch; });

  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  ctx = createBrowserContext({ html, baseUrl });
  doc = ctx.document;

  // Client-side Photon interception (sandbox fetch = what app.js calls).
  const realSandboxFetch = ctx.sandbox.fetch;
  ctx.sandbox.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('photon.komoot.io')) {
      photonCalls.push(u);
      return Promise.resolve(new Response(JSON.stringify(PHOTON_BODY),
        { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    return realSandboxFetch(url, opts);
  };

  loadPageScripts(ctx, PUBLIC_DIR);
  const repBtn = await waitFor(
    () => doc.querySelectorAll('#loginReps .login__rep').find((b) => b.textContent.includes('Autoc Rep')),
    'rep button',
  );
  repBtn.click();
  for (const d of PIN) {
    doc.querySelectorAll('.pinpad__key').find((k) => k.textContent.trim() === d).click();
  }
  await waitFor(() => doc.getElementById('beatName').textContent === 'Walk-ins', 'beat loaded');
  doc.getElementById('logDoorBtn').click();
  await waitFor(() => doc.getElementById('manualScrim').classList.contains('open'), 'manual sheet open');
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

test('typing in the address field suggests nearby addresses', async () => {
  const input = doc.getElementById('manualAddr');
  input.value = '1332 merr';
  input.dispatchEvent('input');

  const items = await waitFor(
    () => { const s = doc.querySelectorAll('.manual-suggest__item'); return s.length >= 2 ? s : null; },
    'suggestions rendered',
  );
  assert.ok(photonCalls.length >= 1, 'photon consulted');
  assert.ok(photonCalls[0].includes(encodeURIComponent('1332 merr')), 'typed text sent as query');
  assert.ok(photonCalls[0].includes('lat='), 'query is location-biased');
  assert.match(items[0].textContent, /1332 Merritt Street/, 'street suggestion shown');
  assert.match(items[0].textContent, /Turlock/, 'city shown');
});

test('picking a suggestion fills the field and pins the door at its exact coords', async () => {
  const pick = doc.querySelectorAll('.manual-suggest__item')
    .find((b) => b.textContent.includes('Merritt'));
  pick.click();

  const input = doc.getElementById('manualAddr');
  assert.match(input.value, /1332 Merritt Street/, 'address filled from suggestion');
  assert.ok(!doc.querySelectorAll('.manual-suggest__item').length, 'suggestions dismissed');

  geocodeCalls = 0;
  doc.querySelectorAll('#manualDispGrid .dispbtn')
    .find((b) => b.textContent.trim() === 'Not home').click();

  const row = await waitFor(
    () => getDb().prepare("SELECT * FROM targets WHERE address LIKE '%Merritt%'").get(),
    'ad-hoc target persisted',
  );
  assert.equal(row.lat, 37.4941, 'suggestion latitude used');
  assert.equal(row.lng, -120.8355, 'suggestion longitude used');
  assert.equal(row.city, 'Turlock', 'real city from suggestion');
  assert.equal(row.zip, '95380', 'real zip from suggestion');
  assert.equal(geocodeCalls, 0, 'no server-side geocode needed');
});

test('door list rows never show the — / 00000 placeholders', async () => {
  const rows = await waitFor(
    () => { const r = doc.querySelectorAll('#listScroll .row'); return r.length >= 1 ? r : null; },
    'door list rendered',
  );
  const merritt = rows.find((r) => r.textContent.includes('Merritt'));
  assert.ok(merritt, 'walk-in door row rendered');
  assert.match(merritt.textContent, /Turlock 95380/, 'real city+zip rendered');

  // A door logged with NO suggestion (server fills city '—', zip '00000')
  // must render without the junk placeholders.
  doc.getElementById('logDoorBtn').click();
  const input = doc.getElementById('manualAddr');
  input.value = '77 Nowhere Ln';
  doc.querySelectorAll('#manualDispGrid .dispbtn')
    .find((b) => b.textContent.trim() === 'Not home').click();
  const bare = await waitFor(
    () => doc.querySelectorAll('#listScroll .row').find((r) => r.textContent.includes('Nowhere')),
    'bare walk-in row rendered',
  );
  assert.ok(!bare.textContent.includes('00000'), 'zip placeholder hidden');
  assert.ok(!/—\s*00000|—\s*$/.test(bare.querySelector('.a2').textContent.trim()), 'city placeholder hidden');
});
