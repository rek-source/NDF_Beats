// test/migrate.test.js  (OWNER: backend)
// Phase 1 — rep-identity migration. The additive migration must give `reps` the
// PIN/token columns and be safe to run repeatedly (idempotent) on both a fresh
// schema and an already-migrated DB.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-migrate-${randomUUID()}.db`);
process.env.DB_PATH = TMP_DB;
process.env.PORT = '0';

const { migrate } = await import('../src/db/migrate.js');
const { getDb, closeDb } = await import('../src/db/connection.js');

test.after(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch { /* ignore */ }
  }
});

const REQUIRED = [
  'pin_hash',
  'pin_salt',
  'pin_set_at',
  'pin_attempts',
  'pin_locked_until',
  'token_version',
];

function repColumns() {
  return getDb().prepare(`PRAGMA table_info(reps)`).all().map((c) => c.name);
}

test('migration adds the rep-identity columns to reps', () => {
  migrate();
  const cols = repColumns();
  for (const c of REQUIRED) {
    assert.ok(cols.includes(c), `reps should have column ${c}`);
  }
});

test('re-running migrate is idempotent (no duplicate-column error)', () => {
  assert.doesNotThrow(() => {
    migrate();
    migrate();
  });
  const cols = repColumns();
  for (const c of REQUIRED) {
    assert.ok(cols.includes(c), `reps still has column ${c} after re-run`);
  }
});

test('pin_attempts defaults to 0 and token_version to 1 for new reps', () => {
  const db = getDb();
  const id = `rep_${randomUUID()}`;
  db.prepare(
    `INSERT INTO reps (id, name, email) VALUES (?, ?, ?)`,
  ).run(id, 'Migration Probe', `probe+${id}@ndf.test`);
  const row = db.prepare(`SELECT pin_attempts, token_version FROM reps WHERE id = ?`).get(id);
  assert.equal(row.pin_attempts, 0);
  assert.equal(row.token_version, 1);
});
