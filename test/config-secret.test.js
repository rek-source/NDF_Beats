// test/config-secret.test.js  (OWNER: backend)
// Fail-closed guard on the rep-session HMAC key (security finding, round 3):
// a missing/misdeployed production .env must REFUSE TO BOOT rather than
// silently fall back to the publicly-known dev secret, which would let anyone
// forge rep session tokens.
//
// Two layers:
//   1. Unit tests on resolveTokenSecret(env) — the pure decision function.
//   2. Subprocess boot tests — prove the real module (and therefore the real
//      server, which imports config at startup) actually dies in production
//      with no secret, and boots fine in dev.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Keep this import from tripping the guard itself.
process.env.BEATS_TOKEN_SECRET ??= 'unit-test-secret-000000000000000000000000';

const {
  resolveTokenSecret,
  DEV_TOKEN_SECRET_FALLBACK,
  MIN_PROD_SECRET_LENGTH,
} = await import('../src/config.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STRONG = 'a'.repeat(64); // like `openssl rand -hex 32`

// ── 1. unit: resolveTokenSecret ─────────────────────────────────────────────

test('production + unset secret -> throws (fail closed)', () => {
  assert.throws(
    () => resolveTokenSecret({ NODE_ENV: 'production' }),
    /BEATS_TOKEN_SECRET is not set/,
  );
});

test('production + blank/whitespace secret -> throws', () => {
  for (const v of ['', '   ', '\t\n']) {
    assert.throws(
      () => resolveTokenSecret({ NODE_ENV: 'production', BEATS_TOKEN_SECRET: v }),
      /not set/,
      `value ${JSON.stringify(v)} must be rejected`,
    );
  }
});

test('production + the known dev fallback -> throws', () => {
  assert.throws(
    () => resolveTokenSecret({
      NODE_ENV: 'production',
      BEATS_TOKEN_SECRET: DEV_TOKEN_SECRET_FALLBACK,
    }),
    /dev fallback/,
  );
});

test('production + short secret -> throws with min length in message', () => {
  assert.throws(
    () => resolveTokenSecret({ NODE_ENV: 'production', BEATS_TOKEN_SECRET: 'short-secret' }),
    new RegExp(`minimum ${MIN_PROD_SECRET_LENGTH}`),
  );
});

test('production + strong secret -> returned trimmed', () => {
  assert.equal(
    resolveTokenSecret({ NODE_ENV: 'production', BEATS_TOKEN_SECRET: `  ${STRONG}  ` }),
    STRONG,
  );
});

test('dev/test with no secret -> dev fallback (local zero-config still boots)', () => {
  assert.equal(resolveTokenSecret({}), DEV_TOKEN_SECRET_FALLBACK);
  assert.equal(resolveTokenSecret({ NODE_ENV: 'development' }), DEV_TOKEN_SECRET_FALLBACK);
  assert.equal(resolveTokenSecret({ NODE_ENV: 'test' }), DEV_TOKEN_SECRET_FALLBACK);
});

test('dev with an explicit secret -> uses it (no silent replacement)', () => {
  assert.equal(resolveTokenSecret({ BEATS_TOKEN_SECRET: 'my-local-secret' }), 'my-local-secret');
});

// ── 2. subprocess: the real module boots / dies ─────────────────────────────
// BEATS_TOKEN_SECRET is passed as '' explicitly: a present-but-empty real env
// var wins over any developer .env in the repo root (loadEnvFile / --env-file
// semantics), so these runs are deterministic on any machine.

function bootConfig(extraEnv) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./src/config.js');"],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, BEATS_TOKEN_SECRET: '', NODE_ENV: '', ...extraEnv },
    },
  );
}

test('boot: NODE_ENV=production with no secret -> process refuses to start', () => {
  const r = bootConfig({ NODE_ENV: 'production' });
  assert.notEqual(r.status, 0, 'config import must fail in production without a secret');
  assert.match(r.stderr, /BEATS_TOKEN_SECRET is not set/);
  assert.match(r.stderr, /openssl rand -hex 32/, 'error must tell the operator how to fix it');
});

test('boot: NODE_ENV=production with the dev fallback -> refuses to start', () => {
  const r = bootConfig({ NODE_ENV: 'production', BEATS_TOKEN_SECRET: DEV_TOKEN_SECRET_FALLBACK });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /dev fallback/);
});

test('boot: NODE_ENV=production with a strong secret -> boots clean', () => {
  const r = bootConfig({ NODE_ENV: 'production', BEATS_TOKEN_SECRET: STRONG });
  assert.equal(r.status, 0, r.stderr);
});

test('boot: dev (no NODE_ENV) with no secret -> boots on the dev fallback', () => {
  const r = bootConfig({});
  assert.equal(r.status, 0, r.stderr);
});
