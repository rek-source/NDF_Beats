// src/config.js
// Central configuration: env-derived runtime settings + frozen business constants.
// No secrets live here (Phase 1 is local-only, mock-seeded).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Repo root is one level up from src/.
export const ROOT_DIR = path.resolve(__dirname, '..');

// Load .env (if present) WITHOUT overriding variables already in the real
// environment — so tests that preset DB_PATH/PORT/secret stay isolated, while
// production reads BEATS_TOKEN_SECRET et al. from /opt/ndf-beats/.env. Node's
// loadEnvFile follows the same "real env wins" rule as --env-file.
try {
  const envPath = path.join(ROOT_DIR, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
} catch {
  /* no .env or unreadable — the app runs on defaults */
}

/** HTTP port (SPEC §3: default 4178). */
export const PORT = Number.parseInt(process.env.PORT ?? '4178', 10);

/**
 * SQLite database file path (SPEC §3: data/ndf-beats.db, DB_PATH override).
 * Relative DB_PATH values resolve from the repo root so the path is stable
 * regardless of the process CWD.
 */
export const DB_PATH = (() => {
  const raw = process.env.DB_PATH ?? path.join('data', 'ndf-beats.db');
  return path.isAbsolute(raw) ? raw : path.join(ROOT_DIR, raw);
})();

/** Path to the DDL applied by migrate.js. */
export const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

/** Static asset root served by Express (SPEC §2: public/). */
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/**
 * Package catalog (SPEC §4) — fixed by policy, NOT a DB table.
 * Money is integer cents. The server is authoritative on price; clients may
 * only choose the package key, never the amount.
 */
export const PACKAGE_CATALOG = Object.freeze({
  // amount_cents = annual contract value (monthly-led pricing: $15/$30/$69 per mo).
  essential: Object.freeze({ key: 'essential', label: 'Essential', amount_cents: 15000 }),
  preferred: Object.freeze({ key: 'preferred', label: 'Preferred', amount_cents: 30000 }),
  total_home: Object.freeze({ key: 'total_home', label: 'Total Home', amount_cents: 69000 }),
});

/** Valid package keys, for validation. */
export const PACKAGE_KEYS = Object.freeze(Object.keys(PACKAGE_CATALOG));

/**
 * Agreement page base (SPEC §4). The backend never fetches this; it only builds
 * the link the rep app opens for e-sign + first-visit booking.
 */
export const AGREEMENT_URL_BASE = '/gbb/ndf/agreements/home-care-membership.html';

/** Disposition vocabulary (SPEC §4 knocks.disposition CHECK). */
export const DISPOSITIONS = Object.freeze([
  'not_home',
  'refused',
  'callback',
  'not_interested',
  'sold',
]);

/**
 * Build the agreement URL opened on a completed sale.
 * @param {string} pkg - package key
 * @param {string} targetId - target the sale is tied to
 * @returns {string}
 */
export function buildAgreementUrl(pkg, targetId) {
  const params = new URLSearchParams({ pkg, target: targetId });
  return `${AGREEMENT_URL_BASE}?${params.toString()}`;
}

/** Market timezone for scoreboard period windows (SPEC §5.5). */
export const MARKET_TIMEZONE = 'America/Los_Angeles';

// ── Rep identity (PIN -> signed token) ──────────────────────────────────────
// Secret keys the HMAC token. In production it MUST come from .env; the fallback
// only exists so local dev / tests without a secret still boot (tokens then
// aren't portable across restarts, which is fine for dev).
export const BEATS_TOKEN_SECRET =
  process.env.BEATS_TOKEN_SECRET ?? 'ndf-beats-dev-insecure-secret-change-me';

/** Session window before a rep must re-enter their PIN (portal-tunable). */
export const BEATS_SESSION_HOURS = Number.parseFloat(process.env.BEATS_SESSION_HOURS ?? '12');

/** Wrong-PIN attempts before a temporary lockout. */
export const BEATS_PIN_MAX_ATTEMPTS = Number.parseInt(process.env.BEATS_PIN_MAX_ATTEMPTS ?? '5', 10);

/** Lockout duration (minutes) after max attempts. */
export const BEATS_PIN_LOCKOUT_MIN = Number.parseInt(process.env.BEATS_PIN_LOCKOUT_MIN ?? '15', 10);
