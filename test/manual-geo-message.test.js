// test/manual-geo-message.test.js  (OWNER: frontend)
// "📍 Use my location" feedback (Jam 2026-07-21): on the live box the
// Permissions-Policy header had geolocation disabled and the app said only
// "No location — address alone is fine." — six clicks, no clue why. A blocked
// permission (code 1) must say so explicitly; other failures keep the soft
// fallback line. Runs the REAL bundle in the fake-dom sandbox.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-geomsg-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'geomsg-test-secret-0000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

migrate();

const REP_ID = 'rep_geomsg_test';
const PIN = '9753';
repo.insertRep({ id: REP_ID, name: 'Geo Rep', email: 'geomsg@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);
repo.insertBeat({
  id: 'beat_geomsg', name: 'Walk-ins', city: '—', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.6391, center_lng: -120.9969,
  target_count: 0, kind: 'walkins',
});

const { createApp } = await import('../src/server.js');

let server;
let baseUrl;
let ctx;
let doc;

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
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  ctx = createBrowserContext({ html, baseUrl });
  doc = ctx.document;
  loadPageScripts(ctx, PUBLIC_DIR);

  const repBtn = await waitFor(
    () => doc.querySelectorAll('#loginReps .login__rep').find((b) => b.textContent.includes('Geo Rep')),
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

function geoMsg() { return doc.getElementById('manualGeoMsg').textContent; }

test('permission-denied (code 1) says location is BLOCKED and how to react', () => {
  ctx.navigator.geolocation = {
    getCurrentPosition: (ok, err) => err({ code: 1, message: 'denied' }),
  };
  doc.getElementById('manualGeo').click();
  assert.match(geoMsg(), /blocked/i, 'names the real problem');
  assert.match(geoMsg(), /address/i, 'still offers the address fallback');
});

test('other geolocation failures keep the soft fallback line', () => {
  ctx.navigator.geolocation = {
    getCurrentPosition: (ok, err) => err({ code: 2, message: 'unavailable' }),
  };
  doc.getElementById('manualGeo').click();
  assert.match(geoMsg(), /No location — address alone is fine\./);
});

test('success still reports location captured', () => {
  ctx.navigator.geolocation = {
    getCurrentPosition: (ok) => ok({ coords: { latitude: 37.5, longitude: -120.9 } }),
  };
  doc.getElementById('manualGeo').click();
  assert.match(geoMsg(), /location captured/);
});
