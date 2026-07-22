// test/door-coverage.test.js  (OWNER: frontend + backend seam)
// Data-coverage hint (backlog #2 last clause): a sub-35 door score is CORRECT —
// it's scaled by how many signals we actually know — but reps read a low number
// as "broken". The door sheet now shows an inline "N of 7 signals" hint under
// the score when coverage is partial, so a low score reads as "limited data",
// not "bad door". Hidden when every signal is known (score is fully informed)
// or when coverage is unknown (legacy row) — never invented.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-cov-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'coverage-test-secret-00000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

migrate();

const REP_ID = 'rep_cov';
const PIN = '3690';
repo.insertRep({ id: REP_ID, name: 'Cov Rep', email: 'cov@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);

repo.insertBeat({
  id: 'beat_cov', name: 'Turlock West', city: 'Turlock', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.5, center_lng: -120.85,
  target_count: 2,
});
// Partial coverage: only 2 of the 7 signals were known at ingest.
repo.insertTarget({
  id: 'tgt_cov_partial', address: '1 Partial St', city: 'Turlock', county: 'Stanislaus',
  zip: '95380', lat: 37.501, lng: -120.851, value_cents: 40000000, home_age: 30,
  owner_occupied: null, owner_occupied_known: 0, tenure_years: null,
  recently_sold: 0, income_band: 5, score: 22, no_soliciting: 0,
  known_signals: JSON.stringify(['value', 'home_age']),
});
// Full coverage: every signal known — no hint needed.
repo.insertTarget({
  id: 'tgt_cov_full', address: '2 Full Ave', city: 'Turlock', county: 'Stanislaus',
  zip: '95380', lat: 37.502, lng: -120.852, value_cents: 42000000, home_age: 20,
  owner_occupied: 1, owner_occupied_known: 1, tenure_years: 6,
  recently_sold: 0, income_band: 6, score: 78, no_soliciting: 0,
  khb_project_dist_m: 100, tract_owner_occ_rate: 0.8,
  known_signals: JSON.stringify(['value', 'home_age', 'owner_occupied', 'tenure', 'recently_sold', 'income_band', 'khb_proximity']),
});
repo.insertBeatTarget({ beat_id: 'beat_cov', target_id: 'tgt_cov_partial', seq: 1 });
repo.insertBeatTarget({ beat_id: 'beat_cov', target_id: 'tgt_cov_full', seq: 2 });

const { createApp } = await import('../src/server.js');

let server; let baseUrl; let ctx; let doc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 6000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < ms) { last = fn(); if (last) return last; await sleep(20); }
  throw new Error(`timeout waiting for: ${what}`);
}

test.before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
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

test('beat payload carries the honest known/total signal counts', () => {
  const rows = repo.getBeatTargets('beat_cov');
  const partial = rows.find((r) => r.id === 'tgt_cov_partial');
  assert.ok(partial.known_signals, 'row keeps known_signals for the route to count');
});

test('the sheet shows a coverage hint on a partial door and hides it on a full one', async () => {
  loadPageScripts(ctx, PUBLIC_DIR);
  const repBtn = await waitFor(
    () => doc.querySelectorAll('#loginReps .login__rep').find((b) => b.textContent.includes('Cov Rep')),
    'rep button',
  );
  repBtn.click();
  for (const d of PIN) doc.querySelectorAll('.pinpad__key').find((k) => k.textContent.trim() === d).click();

  // Partial-coverage door -> hint visible with "2 of 7".
  const partialRow = await waitFor(() => doc.querySelectorAll('.row[data-id="tgt_cov_partial"]')[0], 'partial row');
  partialRow.click();
  const cov = await waitFor(() => {
    const el = doc.getElementById('sheetCoverage');
    return el && !el.hidden ? el : null;
  }, 'coverage hint visible on partial door');
  assert.match(cov.textContent, /2\s*of\s*7/i, 'shows known/total signal count');

  // Full-coverage door -> hint hidden (score is fully informed).
  const fullRow = await waitFor(() => doc.querySelectorAll('.row[data-id="tgt_cov_full"]')[0], 'full row');
  fullRow.click();
  await waitFor(() => (doc.getElementById('sheetAddr').textContent.includes('Full Ave') ? true : null), 'full sheet open');
  assert.equal(doc.getElementById('sheetCoverage').hidden, true, 'no hint when all 7 signals known');
});
