// test/door-honesty.test.js  (OWNER: frontend + backend seam)
// Door-sheet honesty display (backlog #2): an UNKNOWN owner-occupancy must not
// render as "No". When the door was admitted via its Census tract rate, the
// sheet shows "unknown — area ~74%", and a nearby completed KHB project reads
// "Near completed KHB project" with the distance. Runs the REAL public/ bundle
// in the fake-dom sandbox against a REAL server.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-honesty-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';
process.env.BEATS_TOKEN_SECRET = 'honesty-test-secret-000000000000000000000000';

const { migrate } = await import('../src/db/migrate.js');
const { closeDb } = await import('../src/db/connection.js');
const repo = await import('../src/db/repo.js');
const { hashPin } = await import('../src/auth/pin.js');
const { createBrowserContext, loadPageScripts } = await import('./helpers/fake-dom.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

migrate();

const REP_ID = 'rep_honesty';
const PIN = '2468';
repo.insertRep({ id: REP_ID, name: 'Honest Rep', email: 'honest@ndf.test', role: 'rep' });
const { hash, salt } = hashPin(PIN);
repo.setRepPin(REP_ID, hash, salt);

repo.insertBeat({
  id: 'beat_hon', name: 'Turlock North', city: 'Turlock', county: 'Stanislaus',
  rep_id: REP_ID, status: 'active', center_lat: 37.5, center_lng: -120.84,
  target_count: 1,
});
// Unknown owner-occupancy, admitted by a 74% owner tract, 120 m from a KHB job.
repo.insertTarget({
  id: 'tgt_hon_1', address: '10 Unknown Way', city: 'Turlock', county: 'Stanislaus',
  zip: '95380', lat: 37.501, lng: -120.841, value_cents: 42000000, home_age: 30,
  owner_occupied: null, owner_occupied_known: 0, tenure_years: null,
  recently_sold: 0, income_band: 5, score: 33, no_soliciting: 0,
  tract_owner_occ_rate: 0.74, khb_project_dist_m: 120,
});
repo.insertBeatTarget({ beat_id: 'beat_hon', target_id: 'tgt_hon_1', seq: 1 });

const { createApp } = await import('../src/server.js');
const { getBeatTargets } = repo;

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

test('beat payload carries a tri-state owner_occupied_known flag', () => {
  // getBeatTargets is the row source; the route maps it. The server seam must
  // expose knownness so the client can tell "unknown" from "verified renter".
  const [row] = getBeatTargets('beat_hon');
  assert.equal(row.owner_occupied_known, 0, 'seeded unknown stays unknown');
});

test('door sheet renders honest owner-occupancy + project proximity', async () => {
  loadPageScripts(ctx, PUBLIC_DIR);
  const repBtn = await waitFor(
    () => doc.querySelectorAll('#loginReps .login__rep').find((b) => b.textContent.includes('Honest Rep')),
    'rep button on login overlay',
  );
  repBtn.click();
  for (const d of PIN) {
    const key = doc.querySelectorAll('.pinpad__key').find((k) => k.textContent.trim() === d);
    key.click();
  }
  const row = await waitFor(
    () => doc.querySelectorAll('.row[data-id="tgt_hon_1"]')[0],
    'door row rendered',
  );
  row.click();
  const factors = await waitFor(
    () => (doc.getElementById('sheetFactors').children.length ? doc.getElementById('sheetFactors') : null),
    'sheet factors rendered',
  );
  const lines = factors.querySelectorAll('li').map((li) => li.textContent);
  const owner = lines.find((s) => s.startsWith('Owner-occupied'));
  assert.ok(owner, 'has an owner-occupied factor');
  assert.match(owner, /unknown/i, 'unknown owner is not shown as "No"');
  assert.match(owner, /74%/, 'shows the area owner-occupancy rate');

  const proximity = lines.find((s) => /KHB project/i.test(s));
  assert.ok(proximity, 'has a KHB project proximity factor');
  assert.match(proximity, /Near completed KHB project/i, 'framed as nearby completed project');
  assert.match(proximity, /120\s*m/, 'shows the distance in meters');
});
