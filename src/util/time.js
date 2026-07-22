// src/util/time.js — shared time helpers for the write routes.

/**
 * Accept a client-supplied ISO timestamp; fall back to server time.
 *
 * A knock/sale carries an optional client timestamp (offline queue replay), but
 * an offline device's clock — or a malformed value — must never produce a bad
 * or missing record time. A parseable string is normalized to UTC ISO; anything
 * else (non-string, unparseable, empty) resolves to the server's current time.
 * @param {unknown} input
 * @returns {string} an ISO-8601 UTC timestamp
 */
export function normalizeTimestamp(input) {
  if (typeof input === 'string') {
    const d = new Date(input);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}
