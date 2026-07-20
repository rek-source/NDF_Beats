import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh isolated DB per run (DB_PATH must be set BEFORE importing anything
// that opens the db — matches the pattern in test/migrate.test.js).
process.env.DB_PATH = path.join(os.tmpdir(), `ndf-onboard-${randomUUID()}.db`);

const { migrate } = await import('../src/db/migrate.js');
const { getDb, closeDb } = await import('../src/db/connection.js');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* ignore */ }
  }
});

test('migrate adds beats.kind and targets.ad_hoc with safe defaults', () => {
  migrate();
  const db = getDb();
  const beatCols = db.prepare('PRAGMA table_info(beats)').all().map((c) => c.name);
  const targetCols = db.prepare('PRAGMA table_info(targets)').all().map((c) => c.name);
  assert.ok(beatCols.includes('kind'), 'beats.kind exists');
  assert.ok(targetCols.includes('ad_hoc'), 'targets.ad_hoc exists');
  // Default kind is 'auto'.
  const def = db.prepare("PRAGMA table_info(beats)").all().find((c) => c.name === 'kind');
  assert.match(String(def.dflt_value), /auto/);
});

test('insertBeat persists kind (defaults to auto)', async () => {
  const repo = await import('../src/db/repo.js');
  const id = `beat_${randomUUID()}`;
  repo.insertBeat({ id, name: 'Custom A', city: 'Modesto', county: 'Stanislaus',
    center_lat: 37.6, center_lng: -121.0, target_count: 0, kind: 'custom' });
  const row = repo.getBeatById(id);
  assert.equal(row.kind, 'custom');
  const id2 = `beat_${randomUUID()}`;
  repo.insertBeat({ id: id2, name: 'Auto A', city: 'Ceres', county: 'Stanislaus',
    center_lat: 37.6, center_lng: -121.0, target_count: 0 });
  assert.equal(repo.getBeatById(id2).kind, 'auto');
});
