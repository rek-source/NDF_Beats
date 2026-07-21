// test/beat-switcher.test.js  (OWNER: frontend)
// In-app beat switching (Jam 2026-07-21): the rep must be able to move between
// their beats WITHOUT logging out. The topbar beat block is a button that
// reopens the beat picker (fresh list), the picker is dismissible when a beat
// is already loaded, and walk-in beats don't render their placeholder '—' city.
// Runs the REAL public/ bundle in the fake-dom sandbox against a REAL server.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-switch-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'switch-test-secret-0000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

migrate();

const REP_ID = 'rep_switch_test';
const PIN = '1357';
repo.insertRep({ id: REP_ID, name: 'Switch Rep', email: 'switch@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);

// Beat 1: active, with one door — auto-loads at login.
repo.insertBeat({
  id: 'beat_sw_active', name: 'Turlock East', city: 'Turlock', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.49, center_lng: -120.84,
  target_count: 1,
});
repo.insertTarget({
  id: 'tgt_sw_1', address: '100 Active Ave', city: 'Turlock', county: 'Stanislaus',
  zip: '95380', lat: 37.491, lng: -120.841, value_cents: 40000000, home_age: 25,
  owner_occupied: 1, tenure_years: 5, recently_sold: 0, income_band: 5,
  score: 80, no_soliciting: 0,
});
repo.insertBeatTarget({ beat_id: 'beat_sw_active', target_id: 'tgt_sw_1', seq: 1 });

// Beat 2: the rep's walk-in beat, status ready, placeholder '—' city — the
// beat Ryan could not reach without logging out.
repo.insertBeat({
  id: 'beat_sw_walkins', name: 'Walk-ins', city: '—', county: 'Stanislaus',
  rep_id: REP_ID, status: 'ready', center_lat: 37.6391, center_lng: -120.9969,
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
});

test.after(() => {
  if (server) server.close();
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

// Real beat rows only — the picker's "keep working" close button shares the
// .beat-pick class for styling but is not a beat.
function beatRows() {
  return doc.querySelectorAll('.beat-pick')
    .filter((b) => b.id !== 'beatPickClose');
}

test('beat switching without logout', async (t) => {
  await t.test('login auto-loads the active beat', async () => {
    loadPageScripts(ctx, PUBLIC_DIR);
    const repBtn = await waitFor(
      () => doc.querySelectorAll('#loginReps .login__rep')
        .find((b) => b.textContent.includes('Switch Rep')),
      'rep button on login overlay',
    );
    repBtn.click();
    for (const d of PIN) {
      const key = doc.querySelectorAll('.pinpad__key').find((k) => k.textContent.trim() === d);
      assert.ok(key, `pin key ${d}`);
      key.click();
    }
    await waitFor(() => doc.getElementById('beatName').textContent === 'Turlock East',
      'active beat loaded');
  });

  await t.test('topbar beat block is a button that reopens the beat picker', async () => {
    const switcher = doc.getElementById('beatSwitch');
    assert.ok(switcher, 'beat switcher button exists');
    assert.equal(switcher.tagName.toLowerCase(), 'button', 'switchable = a real button');
    switcher.click();

    await waitFor(() => beatRows().length === 2, 'picker lists both beats');
    const labels = beatRows().map((b) => b.textContent);
    assert.ok(labels.some((s) => s.includes('Turlock East')), 'active beat listed');
    assert.ok(labels.some((s) => s.includes('Walk-ins')), 'walk-ins beat listed');
  });

  await t.test('walk-in beats do not render the placeholder — city', async () => {
    const walkins = beatRows().find((b) => b.textContent.includes('Walk-ins'));
    assert.ok(!walkins.textContent.includes('—'), 'no em-dash placeholder in picker row');
  });

  await t.test('picker is dismissible — keep working the current beat', async () => {
    const closeBtn = doc.getElementById('beatPickClose');
    assert.ok(closeBtn, 'picker has a close/keep-working button');
    closeBtn.click();
    await waitFor(() => doc.getElementById('curtain').classList.contains('hidden'),
      'curtain hidden again');
    assert.equal(doc.getElementById('beatName').textContent, 'Turlock East',
      'still on the current beat');
  });

  await t.test('picking the other beat loads it in place', async () => {
    doc.getElementById('beatSwitch').click();
    await waitFor(() => beatRows().length === 2, 'picker reopened');
    beatRows().find((b) => b.textContent.includes('Walk-ins')).click();
    await waitFor(() => doc.getElementById('beatName').textContent === 'Walk-ins',
      'walk-ins beat loaded');
    assert.ok(!doc.getElementById('beatSub').textContent.includes('—'),
      'topbar sub line has no placeholder city');
  });
});
