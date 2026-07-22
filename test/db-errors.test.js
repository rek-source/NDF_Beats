// test/db-errors.test.js  (OWNER: backend)
// isUniqueViolation was copy-pasted identically in sales.routes.js and
// knocks.routes.js, and only reachable through a hard-to-trigger write race, so
// it sat uncovered in both. Extracted to src/db/errors.js and unit-tested here:
// it classifies a better-sqlite3 UNIQUE-constraint error so the routes can
// convert a racing idempotency replay into a 200/409 instead of a 500.

import test from 'node:test';
import assert from 'node:assert/strict';
const { isUniqueViolation } = await import('../src/db/errors.js');

test('true for any SQLITE_CONSTRAINT* code', () => {
  assert.equal(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' }), true);
  assert.equal(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }), true);
  assert.equal(isUniqueViolation({ code: 'SQLITE_CONSTRAINT' }), true);
});

test('false for other sqlite errors', () => {
  assert.equal(isUniqueViolation({ code: 'SQLITE_BUSY' }), false);
  assert.equal(isUniqueViolation({ code: 'SQLITE_IOERR' }), false);
});

test('false when there is no usable code', () => {
  assert.equal(isUniqueViolation({}), false);          // no code
  assert.equal(isUniqueViolation({ code: 123 }), false); // non-string code
  assert.ok(!isUniqueViolation(null));
  assert.ok(!isUniqueViolation(undefined));
});
