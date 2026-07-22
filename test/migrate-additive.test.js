// test/migrate-additive.test.js  (OWNER: backend)
// The additive migration (ensureColumn -> ALTER TABLE ADD COLUMN) is the
// mechanism that upgrades a LIVE production DB in place. On a fresh schema every
// column already exists (schema.sql), so that ALTER branch never runs in the
// other migrate tests. Here we simulate a pre-migration `reps` table (missing
// the PIN/token columns) and assert migrate() adds them without data loss —
// exactly what happens to prod on deploy.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DB = path.join(os.tmpdir(), `ndf-beats-migadd-${randomUUID()}.db`);
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

test('migrate ALTERs an old table to add missing columns, preserving rows', () => {
  const db = getDb();
  // A legacy `reps` shaped before the PIN/token identity columns existed.
  db.exec('CREATE TABLE reps (id TEXT PRIMARY KEY, name TEXT, email TEXT, role TEXT)');
  db.prepare('INSERT INTO reps (id, name, email, role) VALUES (?,?,?,?)')
    .run('rep_legacy', 'Legacy Rep', 'legacy@ndf.test', 'rep');

  migrate(); // schema.sql leaves the existing table; ensureColumn ADDs the rest

  const cols = db.prepare('PRAGMA table_info(reps)').all().map((c) => c.name);
  for (const added of ['pin_hash', 'pin_salt', 'pin_set_at', 'pin_attempts', 'pin_locked_until', 'token_version']) {
    assert.ok(cols.includes(added), `migrate added reps.${added}`);
  }

  // Existing row survived the ALTER, and NOT-NULL-DEFAULT columns backfilled.
  const row = db.prepare('SELECT * FROM reps WHERE id = ?').get('rep_legacy');
  assert.equal(row.name, 'Legacy Rep', 'legacy data preserved');
  assert.equal(row.pin_attempts, 0, 'default backfilled on the existing row');
  assert.equal(row.token_version, 1, 'default backfilled on the existing row');
  assert.equal(row.pin_hash, null, 'nullable new column is null until a PIN is set');
});

test('re-running migrate after the ALTER is idempotent', () => {
  assert.doesNotThrow(() => migrate(), 'second migrate must not duplicate-column error');
});
