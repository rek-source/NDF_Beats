// src/db/migrate.js
// Apply schema.sql (idempotent — all DDL uses IF NOT EXISTS). Run via `npm run seed`
// or directly: `node src/db/migrate.js`.

import fs from 'node:fs';
import { SCHEMA_PATH, DB_PATH } from '../config.js';
import { getDb, closeDb } from './connection.js';

/**
 * Additive column migrations for tables that predate a feature. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each add is guarded by a PRAGMA column check.
 * Every column carries a NOT-NULL-safe default so it applies to populated tables.
 * Order: [table, column, columnDef].
 */
const ADDITIVE_COLUMNS = [
  // Rep identity: PIN -> signed-token login (design 2026-06-15).
  ['reps', 'pin_hash', 'TEXT'],
  ['reps', 'pin_salt', 'TEXT'],
  ['reps', 'pin_set_at', 'TEXT'],
  ['reps', 'pin_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['reps', 'pin_locked_until', 'TEXT'],
  ['reps', 'token_version', 'INTEGER NOT NULL DEFAULT 1'],
];

/** Add a column only if the table doesn't already have it (idempotent). */
function ensureColumn(db, table, column, columnDef) {
  const exists = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
  }
}

/**
 * Apply the DDL in schema.sql, then any additive column migrations. Safe to run
 * repeatedly (schema uses IF NOT EXISTS; ALTERs are guarded by PRAGMA checks).
 * @returns {import('better-sqlite3').Database}
 */
export function migrate() {
  const ddl = fs.readFileSync(SCHEMA_PATH, 'utf8');
  const db = getDb();
  db.exec(ddl);
  for (const [table, column, columnDef] of ADDITIVE_COLUMNS) {
    ensureColumn(db, table, column, columnDef);
  }
  return db;
}

// Run when invoked directly (not when imported by the seed script).
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
  console.log(`[migrate] schema applied -> ${DB_PATH}`);
  closeDb();
}
