// test/field-flow-e2e.test.js  (OWNER: frontend + backend)
// END-TO-END field flow (round-3 finding): the rep-facing conversion path —
// PIN login -> beat load -> knock -> sold -> package pick -> agreement-URL
// handoff -> offline queue replay — previously rested on unit tests and the
// static-path guard only. This test runs the REAL public/ bundle (offline.js,
// auth.js, app.js — the exact files index.html ships) inside a browser-shaped
// vm sandbox (test/helpers/fake-dom.js) against a REAL server on a seeded
// throwaway DB, and asserts server-side truth after every UI action.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Isolate the DB BEFORE importing anything that reads config.
const TMP_DB = path.join(os.tmpdir(), `ndf-beats-e2e-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'e2e-test-secret-00000000000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb, getDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { AGREEMENT_URL_BASE } = await import('../src/config.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// ── fixture: one rep with a PIN, one active beat, four ordered doors ────────
migrate();

const REP_ID = 'rep_e2e_field';
const REP_NAME = 'E2E Field Rep';
const PIN = '2468';
const BEAT_ID = 'beat_e2e_field';

repo.insertRep({ id: REP_ID, name: REP_NAME, email: 'e2e-field@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);

const TARGETS = [1, 2, 3, 4].map((n) => ({
  id: `tgt_e2e_${n}`,
  address: `${n}00 Field Test Ln`,
  city: 'Modesto',
  county: 'Stanislaus',
  zip: '95355',
  lat: 37.66 + n * 0.001,
  lng: -121.03,
  value_cents: 45000000,
  home_age: 30,
  owner_occupied: 1,
  tenure_years: 8,
  recently_sold: 0,
  income_band: 3,
  score: 90 - n,
  no_soliciting: 0,
}));
for (const t of TARGETS) repo.insertTarget(t);
repo.insertBeat({
  id: BEAT_ID, name: 'E2E Beat', city: 'Modesto', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.66, center_lng: -121.03,
  target_count: TARGETS.length,
});
TARGETS.forEach((t, i) => repo.insertBeatTarget({ beat_id: BEAT_ID, target_id: t.id, seq: i + 1 }));

const { createApp } = await import('../src/server.js');

// ── harness plumbing ────────────────────────────────────────────────────────
let server;
let baseUrl;
let ctx;   // browser context
let doc;   // ctx.document

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

function clickByText(selector, text) {
  const el = doc.querySelectorAll(selector).find((e) => e.textContent.trim() === text);
  assert.ok(el, `no ${selector} with text ${JSON.stringify(text)}`);
  el.click();
  return el;
}

function knocksFor(targetId) {
  return getDb()
    .prepare('SELECT * FROM knocks WHERE target_id = ? ORDER BY knocked_at')
    .all(targetId);
}

function salesFor(targetId) {
  return getDb().prepare('SELECT * FROM sales WHERE target_id = ?').all(targetId);
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
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

// ── the flow (one test, ordered subtests — each step depends on the last) ───

test('field flow e2e: login -> knock -> sale -> agreement handoff -> offline replay', async (t) => {
  await t.test('index.html loads its real scripts and boots to the PIN login', async () => {
    const loaded = loadPageScripts(ctx, PUBLIC_DIR);
    assert.deepEqual(
      loaded.map((s) => s.split('?')[0]),
      ['offline.js', 'auth.js', 'app.js'],
      'index.html must ship exactly the three app scripts, offline-queue first',
    );
    assert.ok(ctx.sandbox.OfflineQueue, 'offline.js must define window.OfflineQueue');
    assert.ok(ctx.sandbox.BeatsAuth, 'auth.js must define window.BeatsAuth');

    // No session -> the login overlay opens and lists the roster.
    const overlay = await waitFor(() => doc.getElementById('loginScreen'), 'login overlay');
    assert.ok(overlay.classList.contains('open'));
    await waitFor(
      () => doc.querySelectorAll('#loginReps .login__rep').length > 0,
      'rep roster buttons',
    );
  });

  await t.test('rep signs in with their PIN and the assigned beat renders', async () => {
    clickByText('#loginReps .login__rep', REP_NAME);
    for (const digit of PIN) clickByText('.pinpad__key', digit);

    // submitPin fires ~120ms after the 4th digit; then token -> beats -> targets.
    await waitFor(() => !doc.getElementById('app').hidden, 'app visible after login');
    await waitFor(
      () => doc.getElementById('listScroll').querySelectorAll('.row').length === TARGETS.length,
      'door list rendered',
    );

    assert.ok(!doc.getElementById('loginScreen').classList.contains('open'), 'login overlay closed');
    assert.equal(doc.getElementById('repName').textContent, REP_NAME);
    assert.equal(doc.getElementById('beatName').textContent, 'E2E Beat');
    assert.equal(doc.getElementById('listCount').textContent, `0 of ${TARGETS.length}`);
    assert.equal(doc.getElementById('connLabel').textContent, 'Online');

    // The session is a server-signed token, not a client-invented identity.
    assert.ok(ctx.sandbox.BeatsAuth.isValid(), 'BeatsAuth session valid');
    assert.equal(ctx.sandbox.BeatsAuth.getRep().id, REP_ID);
  });

  await t.test('knock #1 (callback + note) reaches the server and the UI advances', async () => {
    doc.getElementById('listScroll').querySelectorAll('.row')[0].click();
    assert.ok(doc.getElementById('scrim').classList.contains('open'), 'door sheet open');
    assert.equal(doc.getElementById('sheetAddr').textContent, TARGETS[0].address);

    doc.getElementById('sheetNote').value = 'gate code 1234, big friendly dog';
    clickByText('#phaseDisp .dispbtn', 'Callback');

    // Server-side truth: one knock, attributed to the TOKEN's rep, note intact.
    await waitFor(() => knocksFor(TARGETS[0].id).length === 1, 'knock #1 delivered');
    const k = knocksFor(TARGETS[0].id)[0];
    assert.equal(k.disposition, 'callback');
    assert.equal(k.answered, 1);
    assert.equal(k.rep_id, REP_ID, 'server attributes the knock to the authenticated rep');
    assert.equal(k.note, 'gate code 1234, big friendly dog');
    assert.equal(k.beat_id, BEAT_ID);

    // Offline-first UX: the sheet auto-advances to the next un-knocked door.
    await waitFor(
      () => doc.getElementById('sheetAddr').textContent === TARGETS[1].address,
      'sheet advanced to door #2',
    );
    assert.equal(doc.getElementById('kpiKnocked').textContent, '1');
    assert.equal(doc.getElementById('kpiAnswered').textContent, '1');
  });

  await t.test('sold flow: package picker -> server-priced sale -> agreement URL opens', async () => {
    clickByText('#phaseDisp .dispbtn', 'Sold — pick package');

    // The picker appears only after the sold knock round-trips (needs knock_id).
    await waitFor(
      () => !doc.getElementById('phasePkg').hidden
        && doc.getElementById('pkgGrid').querySelectorAll('.pkgbtn').length === 3,
      'package picker with 3 packages',
    );
    const names = doc.querySelectorAll('#pkgGrid .pkg-name').map((e) => e.textContent);
    assert.deepEqual(names, ['Essential', 'Preferred', 'Total Home']);

    doc.querySelectorAll('#pkgGrid .pkgbtn')
      .find((b) => b.querySelector('.pkg-name').textContent === 'Preferred')
      .click();

    // The handoff: the rep app opens the REAL branded agreement page URL.
    await waitFor(() => ctx.opened.length === 1, 'agreement window.open handoff');
    const url = ctx.opened[0];
    assert.ok(url.startsWith(`${AGREEMENT_URL_BASE}?`), `agreement URL base: ${url}`);
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(params.get('pkg'), 'preferred');
    assert.equal(params.get('target'), TARGETS[1].id);

    // Server-side truth: price is server-authoritative ($30/mo -> 30000¢ ACV).
    const sales = salesFor(TARGETS[1].id);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].package, 'preferred');
    assert.equal(sales[0].amount_cents, 30000);
    assert.equal(sales[0].rep_id, REP_ID);
    assert.equal(sales[0].agreement_url, url, 'opened URL === server-issued agreement_url');

    // The handoff target actually exists in the monorepo (built artifact).
    const agreementFile = path.join(
      __dirname, '..', '..', '..', 'gbb-ndf-agreements', 'home-care-membership.html',
    );
    assert.ok(fs.existsSync(agreementFile), `agreement page artifact missing: ${agreementFile}`);

    // UI advances to door #3 and the Sold KPI ticks.
    await waitFor(
      () => doc.getElementById('sheetAddr').textContent === TARGETS[2].address,
      'sheet advanced to door #3 after sale',
    );
    assert.equal(doc.getElementById('kpiSold').textContent, '1');
  });

  await t.test('offline: a knock queues locally, UI stays live, nothing hits the server', async () => {
    ctx.navigator.onLine = false;
    ctx.fireWindow('offline');
    await waitFor(
      () => doc.getElementById('connLabel').textContent === 'Offline',
      'offline badge',
    );

    clickByText('#phaseDisp .dispbtn', 'Not home');

    assert.equal(ctx.sandbox.OfflineQueue.pendingCount(), 1, 'knock is queued, not lost');
    assert.equal(knocksFor(TARGETS[2].id).length, 0, 'server has NOT seen the offline knock');
    assert.equal(doc.getElementById('pending').textContent, '1 pending');

    // Optimistic local state: the door shows its disposition and KPIs tick.
    const chip = doc.querySelector(`.row[data-id="${TARGETS[2].id}"] .dispchip`);
    assert.ok(chip, 'offline knock still marks the door row');
    assert.equal(chip.textContent, 'Not home');
    assert.equal(doc.getElementById('kpiKnocked').textContent, '3');
  });

  await t.test('reconnect: the queue replays with the auth token and drains to zero', async () => {
    ctx.navigator.onLine = true;
    ctx.fireWindow('online');

    await waitFor(() => ctx.sandbox.OfflineQueue.pendingCount() === 0, 'queue drained');
    await waitFor(() => knocksFor(TARGETS[2].id).length === 1, 'queued knock delivered');

    const k = knocksFor(TARGETS[2].id)[0];
    assert.equal(k.disposition, 'not_home');
    assert.equal(k.answered, 0);
    assert.equal(k.rep_id, REP_ID, 'replayed knock still attributed via bearer token');
    assert.equal(doc.getElementById('pending').textContent, '0 pending');
    assert.equal(doc.getElementById('connLabel').textContent, 'Online');
  });

  await t.test('day totals agree end-to-end (UI list/KPIs vs scoreboard API)', async () => {
    assert.equal(doc.getElementById('listCount').textContent, `3 of ${TARGETS.length}`);

    const res = await fetch(`${baseUrl}/api/scoreboard?period=today`);
    const sb = await res.json();
    const me = sb.leaderboard.find((r) => r.rep_id === REP_ID);
    assert.ok(me, 'rep appears on the scoreboard');
    assert.equal(me.doors_knocked, 3);
    assert.equal(me.doors_answered, 2);
    assert.equal(me.yeses, 1);
    assert.equal(me.avg_sale_usd, 300);
  });
});
