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
 *
 * Attribution contract with the agreements tracker: the page parses
 * pkg/target/sale/rep from this URL, pre-selects the pitched tier, and posts
 * them back as ref_* fields on /signup and /subscribe — that is how a paid
 * membership is reconciled to the door-knock (rep commission + D2D channel
 * revenue truth). Dropping a param here silently breaks that reconciliation.
 * @param {string} pkg - package key
 * @param {string} targetId - target the sale is tied to
 * @param {{saleId?: string, repId?: string}} [attribution] - beats sale + rep ids
 * @returns {string}
 */
export function buildAgreementUrl(pkg, targetId, { saleId, repId } = {}) {
  const params = new URLSearchParams({ pkg, target: targetId });
  if (saleId) params.set('sale', saleId);
  if (repId) params.set('rep', repId);
  return `${AGREEMENT_URL_BASE}?${params.toString()}`;
}

/** Market timezone for scoreboard period windows (SPEC §5.5). */
export const MARKET_TIMEZONE = 'America/Los_Angeles';

// ── Rep identity (PIN -> signed token) ──────────────────────────────────────
// Secret keys the HMAC token. In production it MUST come from the environment
// (/opt/ndf-beats/.env). The dev fallback only exists so local dev / tests
// without a secret still boot — it is PUBLICLY KNOWN (it's in this file), so
// production MUST refuse to boot on it: a missing or misdeployed prod .env
// would otherwise silently downgrade every rep session token to a secret
// anyone can forge tokens with.

/** The insecure local-dev fallback. NEVER valid in production. */
export const DEV_TOKEN_SECRET_FALLBACK = 'ndf-beats-dev-insecure-secret-change-me';

/** Minimum secret length accepted in production (hex from `openssl rand -hex 32` is 64). */
export const MIN_PROD_SECRET_LENGTH = 32;

/**
 * Resolve the HMAC token secret, failing CLOSED in production.
 *
 * Rules (production = env.NODE_ENV === 'production'):
 *   - unset/blank secret        -> throw (refuse to boot)
 *   - the known dev fallback    -> throw (refuse to boot)
 *   - shorter than 32 chars     -> throw (refuse to boot)
 * Outside production the dev fallback is used when no secret is set, so local
 * dev and tests keep working with zero configuration.
 *
 * @param {NodeJS.ProcessEnv} [env] - injectable for tests; defaults to process.env
 * @returns {string} the secret to key rep session tokens with
 * @throws {Error} in production when no acceptable secret is configured
 */
export function resolveTokenSecret(env = process.env) {
  const raw = typeof env.BEATS_TOKEN_SECRET === 'string' ? env.BEATS_TOKEN_SECRET.trim() : '';
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction) {
    if (!raw) {
      throw new Error(
        'FATAL: BEATS_TOKEN_SECRET is not set but NODE_ENV=production. ' +
        'Refusing to boot with the publicly-known dev fallback secret. ' +
        'Set BEATS_TOKEN_SECRET in /opt/ndf-beats/.env (generate one with: openssl rand -hex 32).'
      );
    }
    if (raw === DEV_TOKEN_SECRET_FALLBACK) {
      throw new Error(
        'FATAL: BEATS_TOKEN_SECRET is set to the publicly-known dev fallback while ' +
        'NODE_ENV=production. Generate a real secret with: openssl rand -hex 32.'
      );
    }
    if (raw.length < MIN_PROD_SECRET_LENGTH) {
      throw new Error(
        `FATAL: BEATS_TOKEN_SECRET is too short for production (${raw.length} chars; ` +
        `minimum ${MIN_PROD_SECRET_LENGTH}). Generate one with: openssl rand -hex 32.`
      );
    }
    return raw;
  }

  return raw || DEV_TOKEN_SECRET_FALLBACK;
}

export const BEATS_TOKEN_SECRET = resolveTokenSecret();

/** Session window before a rep must re-enter their PIN (portal-tunable). */
export const BEATS_SESSION_HOURS = Number.parseFloat(process.env.BEATS_SESSION_HOURS ?? '12');

/** Wrong-PIN attempts before a temporary lockout. */
export const BEATS_PIN_MAX_ATTEMPTS = Number.parseInt(process.env.BEATS_PIN_MAX_ATTEMPTS ?? '5', 10);

/** Lockout duration (minutes) after max attempts. */
export const BEATS_PIN_LOCKOUT_MIN = Number.parseInt(process.env.BEATS_PIN_LOCKOUT_MIN ?? '15', 10);
