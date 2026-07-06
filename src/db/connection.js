// src/db/connection.js
// better-sqlite3 singleton + pragmas. The ONLY module (with repo.js / migrate.js)
// permitted to import better-sqlite3 directly (SPEC §4 data abstraction rule).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';

let db = null;

/**
 * Open (or return the existing) SQLite connection with the standard pragmas.
 * WAL + foreign keys are also set in schema.sql; we set them here too so they
 * apply on every connection, not just at migrate time.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (db) return db;

  // Ensure the parent directory exists (data/ is gitignored and may be absent).
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Reasonable durability/throughput balance for a single-writer local app.
  db.pragma('synchronous = NORMAL');
  return db;
}

/** Close the connection (used by scripts/tests to exit cleanly). */
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
