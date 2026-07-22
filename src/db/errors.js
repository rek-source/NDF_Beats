// src/db/errors.js — shared classification of better-sqlite3 errors.

/**
 * True when `err` is a SQLite constraint violation (UNIQUE / PRIMARY KEY / etc.).
 * Used by the write routes: a concurrent replay of the same client_uuid can race
 * past the early idempotency check and hit the DB's UNIQUE index; catching that
 * lets us resolve it to a 200/409 instead of a 500. better-sqlite3 codes are
 * strings like 'SQLITE_CONSTRAINT_UNIQUE'.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isUniqueViolation(err) {
  return Boolean(
    err &&
    typeof err.code === 'string' &&
    err.code.startsWith('SQLITE_CONSTRAINT'),
  );
}
