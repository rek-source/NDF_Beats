# NDF Beats — New-Hire Onboarding Features Implementation Plan

> **For Claude (Fable):** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Work top to bottom. Each task is TDD: write the failing test, run it red, implement, run it green, commit. Do NOT skip the "run it red" step. Do NOT batch tasks.
>
> **Known project gotcha (from prior sessions):** the Fable model has been flaky on this repo before; if a task stalls or produces malformed edits, stop and report rather than guessing — a human will fall back to Opus 4.8.

**Goal:** Ship three features so a brand-new door-knocker can start tomorrow: (1) managers can create their own named beats and assign them, (2) the knocker can log doors that were never pre-loaded (custom-beat doors and true off-beat walk-ins), and (3) an expanded training curriculum that covers field-day logistics/safety and how to actually use the app.

**Architecture:** Node 20 + Express + better-sqlite3, ES modules, no build step, vanilla-JS iPad-first frontend in `public/`. Features 1 and 2 share ONE mechanism: a "manual door" that creates an ad-hoc `targets` row on the fly (no fabricated signals — score 0, everything `unknown`) and logs a knock (+ optional sale) against it, preserving every existing foreign key so an off-beat sale still flows through the normal agreement/QBO path. A custom beat is just an empty named beat; a walk-in beat is a per-rep auto-created empty beat. Both are protected from the profile-approval rebuild by a new `beats.kind` column.

**Tech Stack:** better-sqlite3, Express Routers, `node --test` (built-in test runner), Leaflet (already vendored in the field app), HMAC PIN→token rep auth (existing), Caddy `X-Auth-User` admin gate (existing).

---

## Conventions (read once, apply everywhere)

- **Money:** integer cents. **Timestamps:** ISO-8601 UTC TEXT. **Booleans:** INTEGER 0/1. **IDs:** `prefix_${randomUUID()}` from `node:crypto`.
- **No fabricated data.** Ad-hoc targets set unknown signals honestly: `score=0`, `owner_occupied_known=0`, `solicit_status='unknown'`, `known_signals='[]'`, `ad_hoc=1`. Never invent value/age/income.
- **Attribution is token-bound.** A rep is `req.repId` from the verified token, NEVER a client body field.
- **Frontend asset paths MUST be relative** (`app.js`, `styles/app.css`), never root-absolute (`/styles/...`). The app is served under the `/beats` Caddy prefix; a root-absolute path escapes the prefix and 404s. `test/static-paths.test.js` enforces this — keep it green.
- **Run the whole suite** with `npm test` from the repo root (`~/competitor-analysis/ndf-scaling/systems/ndf-beats`). Run a single file with `node --test test/<file>.test.js`.
- **Commit** after every green task with a conventional-commit message. This directory IS its own git repo.
- **Migrations are additive + idempotent** (`src/db/migrate.js` `ADDITIVE_COLUMNS` + PRAGMA-guarded). Also update the fresh-DB DDL in `src/db/schema.sql` so a new DB and a migrated DB have identical shape.

---

## Phase A — Schema & migration

### Task A1: Add `beats.kind` and `targets.ad_hoc` columns

**Files:**
- Modify: `src/db/schema.sql` (beats table ~line 57, targets table ~line 28)
- Modify: `src/db/migrate.js:15-31` (`ADDITIVE_COLUMNS`)
- Test: `test/migrate-onboarding.test.js` (create)

**Step 1: Write the failing test**

Create `test/migrate-onboarding.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fresh isolated DB per run (DB_PATH must be set BEFORE importing anything
// that opens the db — matches the pattern in test/migrate.test.js).
process.env.DB_PATH = path.join(os.tmpdir(), `ndf-onboard-${randomUUID()}.db`);

const { migrate } = await import('../src/db/migrate.js');
const { getDb, closeDb } = await import('../src/db/connection.js');

test('migrate adds beats.kind and targets.ad_hoc with safe defaults', () => {
  migrate();
  const db = getDb();
  const beatCols = db.prepare('PRAGMA table_info(beats)').all().map((c) => c.name);
  const targetCols = db.prepare('PRAGMA table_info(targets)').all().map((c) => c.name);
  assert.ok(beatCols.includes('kind'), 'beats.kind exists');
  assert.ok(targetCols.includes('ad_hoc'), 'targets.ad_hoc exists');
  // Default kind is 'auto'.
  const def = db.prepare("PRAGMA table_info(beats)").all().find((c) => c.name === 'kind');
  assert.match(String(def.dflt_value), /auto/);
  closeDb();
});
```

**Step 2: Run it red**

Run: `node --test test/migrate-onboarding.test.js`
Expected: FAIL (`beats.kind exists` assertion throws).

**Step 3: Implement**

In `src/db/schema.sql`, in the `CREATE TABLE ... beats` block, add after `target_count`:
```sql
  target_count  INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'auto'
                  CHECK (kind IN ('auto','custom','walkins')),
```
(Move the trailing comma appropriately; `created_at` stays the last column.)

In the `CREATE TABLE ... targets` block, add after `known_signals`:
```sql
  known_signals   TEXT,
  ad_hoc          INTEGER NOT NULL DEFAULT 0,  -- 1 = rep-entered walk-in door, not ingested/scored
```

In `src/db/migrate.js`, append to `ADDITIVE_COLUMNS`:
```js
  // New-hire onboarding (2026-07-20): custom/walk-in beats + rep-entered doors.
  ['beats', 'kind', "TEXT NOT NULL DEFAULT 'auto'"],
  ['targets', 'ad_hoc', 'INTEGER NOT NULL DEFAULT 0'],
```
(Note: `ALTER TABLE ADD COLUMN` cannot carry a CHECK on some SQLite builds — the column def above deliberately omits the CHECK; the CHECK lives only in the fresh DDL. That mismatch is acceptable and matches the existing `solicit_status` pattern.)

**Step 4: Run it green**

Run: `node --test test/migrate-onboarding.test.js`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/db/schema.sql src/db/migrate.js test/migrate-onboarding.test.js
git commit -m "feat(db): add beats.kind and targets.ad_hoc for custom/walk-in beats"
```

---

### Task A2: repo helper — `insertBeat` carries `kind`

**Files:**
- Modify: `src/db/repo.js` `insertBeat` (~line 194)
- Test: extend `test/migrate-onboarding.test.js`

**Step 1: Add a failing test** (append to the same file, before `closeDb()` is called — restructure so each test opens/uses the db):

```js
test('insertBeat persists kind (defaults to auto)', async () => {
  const repo = await import('../src/db/repo.js');
  const id = `beat_${randomUUID()}`;
  repo.insertBeat({ id, name: 'Custom A', city: 'Modesto', county: 'Stanislaus',
    center_lat: 37.6, center_lng: -121.0, target_count: 0, kind: 'custom' });
  const row = repo.getBeatById(id);
  assert.equal(row.kind, 'custom');
  const id2 = `beat_${randomUUID()}`;
  repo.insertBeat({ id: id2, name: 'Auto A', city: 'Ceres', county: 'Stanislaus',
    center_lat: 37.6, center_lng: -121.0, target_count: 0 });
  assert.equal(repo.getBeatById(id2).kind, 'auto');
});
```

**Step 2: Run red** → FAIL (`kind` is `null`/undefined because INSERT omits it).

**Step 3: Implement** — in `insertBeat`, add `kind` to both the column list and VALUES and the `.run({...})` object:

```js
`INSERT INTO beats
   (id, name, city, county, rep_id, status, center_lat, center_lng,
    target_count, kind)
 VALUES
   (@id, @name, @city, @county, @rep_id, @status, @center_lat,
    @center_lng, @target_count, @kind)`,
```
```js
.run({
  id: b.id, name: b.name, city: b.city, county: b.county,
  rep_id: b.rep_id ?? null, status: b.status ?? 'ready',
  center_lat: b.center_lat, center_lng: b.center_lng,
  target_count: b.target_count ?? 0,
  kind: b.kind ?? 'auto',
});
```

**Step 4: Run green** → PASS. **Step 5:** commit `feat(db): insertBeat persists beat kind`.

---

### Task A3: repo helpers — walk-in beat + ad-hoc door insert

**Files:**
- Modify: `src/db/repo.js` (add exports near the Beats section)
- Test: `test/repo-walkins.test.js` (create, isolated DB pattern like A1)

**Step 1: Failing test** `test/repo-walkins.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
process.env.DB_PATH = path.join(os.tmpdir(), `ndf-walkins-${randomUUID()}.db`);
const { migrate } = await import('../src/db/migrate.js');
migrate();
const repo = await import('../src/db/repo.js');

function makeRep() {
  const rep = { id: `rep_${randomUUID()}`, name: 'Knock Tester',
    email: `k${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  return rep;
}

test('ensureWalkinsBeat is idempotent and returns one walkins beat per rep', () => {
  const rep = makeRep();
  const b1 = repo.ensureWalkinsBeat(rep);
  const b2 = repo.ensureWalkinsBeat(rep);
  assert.equal(b1.id, b2.id, 'same beat returned twice');
  assert.equal(b1.kind, 'walkins');
  assert.equal(b1.rep_id, rep.id);
});

test('nextSeqForBeat returns 1 then increments', () => {
  const rep = makeRep();
  const beat = repo.ensureWalkinsBeat(rep);
  assert.equal(repo.nextSeqForBeat(beat.id), 1);
  const t = `target_${randomUUID()}`;
  repo.insertTarget({ id: t, address: '1 A St', city: 'Modesto', county: 'Stanislaus',
    zip: '95350', lat: 37.6, lng: -121.0, ad_hoc: 1, score: 0 });
  repo.insertBeatTarget({ beat_id: beat.id, target_id: t, seq: 1 });
  assert.equal(repo.nextSeqForBeat(beat.id), 2);
});
```

**Step 2: Run red** → FAIL (`ensureWalkinsBeat` undefined).

**Step 3: Implement.** First, `insertTarget` must accept `ad_hoc`. In `src/db/repo.js` `insertTarget`, add `ad_hoc` to the column list, VALUES (`@ad_hoc`), and the `.run` object with `ad_hoc: t.ad_hoc ?? 0`.

Then add these exports to `repo.js` (Beats section):

```js
/** The (single) walk-in beat for a rep, or null. */
export function getWalkinsBeatForRep(repId) {
  return getDb()
    .prepare(`SELECT * FROM beats WHERE rep_id = ? AND kind = 'walkins' ORDER BY created_at ASC LIMIT 1`)
    .get(repId) ?? null;
}

/**
 * Return the rep's walk-in beat, creating it if absent. Idempotent.
 * Center defaults to the Modesto market centroid (a walk-in beat has no fixed
 * geography; the map recenters on the first logged door anyway).
 * @param {{id:string,name:string}} rep
 */
export function ensureWalkinsBeat(rep) {
  const existing = getWalkinsBeatForRep(rep.id);
  if (existing) return existing;
  const id = `beat_${randomUUID()}`;
  insertBeat({
    id, name: 'Walk-ins', city: '—', county: 'Stanislaus',
    rep_id: rep.id, status: 'active',
    center_lat: 37.6391, center_lng: -120.9969, target_count: 0, kind: 'walkins',
  });
  return getBeatById(id);
}

/** Next 1-based walk sequence for a beat (max(seq)+1, or 1 if empty). */
export function nextSeqForBeat(beatId) {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS maxseq FROM beat_targets WHERE beat_id = ?`)
    .get(beatId);
  return (row?.maxseq ?? 0) + 1;
}

/** Bump a beat's stored target_count by n (walk-in door added). Rows changed. */
export function bumpBeatTargetCount(beatId, n = 1) {
  return getDb().prepare(`UPDATE beats SET target_count = target_count + ? WHERE id = ?`)
    .run(n, beatId).changes;
}
```

Ensure `randomUUID` is imported at the top of `repo.js` (`import { randomUUID } from 'node:crypto';`). If it is not already imported, add it.

**Step 4: Run green** → PASS. **Step 5:** commit `feat(db): walk-in beat + ad-hoc door repo helpers`.

---

### Task A4: Backfill a walk-in beat for every existing rep on migrate

**Files:**
- Modify: `src/db/migrate.js` (inside `migrate()`, after the additive columns + data fix, before `return db`)
- Test: `test/migrate-onboarding.test.js` (add a case)

**Step 1: Failing test** (append):

```js
test('migrate backfills a walkins beat for existing reps', async () => {
  const repo = await import('../src/db/repo.js');
  const rep = { id: `rep_${randomUUID()}`, name: 'Legacy Rep',
    email: `legacy${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  // No walkins beat yet.
  assert.equal(repo.getWalkinsBeatForRep(rep.id), null);
  migrate(); // re-run migration
  const wb = repo.getWalkinsBeatForRep(rep.id);
  assert.ok(wb, 'walk-in beat created by backfill');
  assert.equal(wb.kind, 'walkins');
});
```

**Step 2: Run red** → FAIL (no backfill yet).

**Step 3: Implement.** In `src/db/migrate.js`, import the helper and add the backfill. Because `migrate.js` currently imports only from `config.js`/`connection.js`, do the backfill with inline SQL to avoid a circular import with `repo.js`:

```js
// Backfill: every rep gets exactly one walk-in beat (onboarding 2026-07-20).
const repsNeeding = db
  .prepare(`SELECT r.id FROM reps r
            WHERE NOT EXISTS (SELECT 1 FROM beats b
                              WHERE b.rep_id = r.id AND b.kind = 'walkins')`)
  .all();
const insertWalkins = db.prepare(
  `INSERT INTO beats (id, name, city, county, rep_id, status, center_lat, center_lng, target_count, kind)
   VALUES (@id, 'Walk-ins', '—', 'Stanislaus', @rep_id, 'active', 37.6391, -120.9969, 0, 'walkins')`,
);
for (const r of repsNeeding) {
  insertWalkins.run({ id: `beat_${randomUUID()}`, rep_id: r.id });
}
```
Add `import { randomUUID } from 'node:crypto';` at the top of `migrate.js`.

**Step 4: Run green** → PASS. **Step 5:** commit `feat(db): backfill walk-in beat per rep on migrate`.

---

## Phase B — Feature 2 backend (manual door / walk-in logging)

### Task B1: `POST /api/knocks/manual`

**Files:**
- Modify: `src/routes/knocks.routes.js`
- Test: `test/knocks-manual.test.js` (create — model it on `test/api.test.js` / `test/field-flow-e2e.test.js` for how they boot the app + mint a rep token)

**Behavior contract:**
- Auth: mounted under the existing `app.use('/api/knocks', requireRepToken)` — so `req.repId` is set.
- Body: `{ beat_id?, address, city?, county?, lat?, lng?, disposition, note?, package?, client_uuid, knocked_at? }`.
- Beat resolution: if `beat_id` present and exists → use it; else use/create the rep's walk-in beat via `ensureWalkinsBeat`.
- Idempotency: if `client_uuid` already recorded a knock, return `200` with that knock (+ its target/sale) — do NOT create a second ad-hoc target.
- Creates an ad-hoc target (honest unknown signals), a `beat_targets` row (`seq = nextSeqForBeat`), the knock, and bumps `target_count`. If `disposition === 'sold'` and `package` is valid, also create the sale (server-authoritative amount + agreement URL) and return it. All inside `transaction()`.
- Validation: `disposition` in `DISPOSITIONS`; `address` non-empty string; `lat`/`lng` numbers if present; `package` in `PACKAGE_KEYS` when disposition is `sold`.
- `county` must be one of the 3 allowed (targets CHECK). Default to the beat's county when absent.

**Step 1: Failing test** `test/knocks-manual.test.js` (skeleton — fill helper from api.test.js):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
process.env.DB_PATH = path.join(os.tmpdir(), `ndf-manual-${randomUUID()}.db`);
process.env.BEATS_TOKEN_SECRET = 'test-secret-'.padEnd(40, 'x');

const { migrate } = await import('../src/db/migrate.js');
migrate();
const repo = await import('../src/db/repo.js');
const { createApp } = await import('../src/server.js'); // confirm the export name in server.js
const { signRepToken } = await import('../src/auth/token.js'); // confirm helper name

const app = createApp();
// Boot on an ephemeral port; use fetch. (Copy the exact listen/fetch helper
// already used in test/api.test.js rather than reinventing it.)

test('manual knock creates an ad-hoc target and logs the knock into the walk-in beat', async () => {
  const rep = { id: `rep_${randomUUID()}`, name: 'Walkin Rep',
    email: `w${randomUUID()}@ndf.example`, role: 'rep', active: 1 };
  repo.insertRep(rep);
  const token = signRepToken(rep); // match real signature
  // POST /api/knocks/manual with Authorization/x-rep-token header per requireRepToken.
  // Assert 201, response has knock + target; target.ad_hoc === true; a walk-in beat now exists.
});

test('manual knock with disposition=sold returns a sale + agreement_url', async () => {
  // ... assert response.sale.agreement_url contains the target id and rep id.
});

test('manual knock is idempotent on client_uuid', async () => {
  // POST same client_uuid twice → same knock id, only ONE target created.
});
```

> **Executor note:** open `test/api.test.js` and `test/field-flow-e2e.test.js` FIRST and copy their exact app-boot, token-minting, and fetch helpers (`createApp` export name, `requireRepToken` header name, `signRepToken` signature). Do not assume — mirror what those passing tests already do.

**Step 2: Run red** → FAIL (404, route not defined).

**Step 3: Implement** in `src/routes/knocks.routes.js`. Add imports and the route:

```js
import { PACKAGE_CATALOG, PACKAGE_KEYS, DISPOSITIONS, buildAgreementUrl } from '../config.js';
import {
  ensureWalkinsBeat, getBeatById, nextSeqForBeat, insertTarget, insertBeatTarget,
  bumpBeatTargetCount, insertKnock, insertSale, getKnockByClientUuid, getKnockById,
  getSaleByKnockId, getRepById, transaction,
} from '../db/repo.js';

const ALLOWED_COUNTIES = new Set(['Stanislaus', 'San Joaquin', 'Merced']);

knocksRouter.post('/knocks/manual', (req, res) => {
  const b = req.body ?? {};
  const rep = getRepById(req.repId);
  if (!rep) return res.status(400).json({ error: 'rep not found' });

  // Idempotency: replaying a client_uuid returns the existing knock (+ sale).
  if (b.client_uuid) {
    const existing = getKnockByClientUuid(b.client_uuid);
    if (existing) {
      const sale = getSaleByKnockId(existing.id);
      return res.status(200).json({ knock: shapeKnock(existing), reused: true, sale: sale ? shapeManualSale(sale) : null });
    }
  }

  const address = typeof b.address === 'string' ? b.address.trim() : '';
  if (!address) return res.status(400).json({ error: 'address is required' });
  if (!DISPOSITIONS.includes(b.disposition)) return res.status(400).json({ error: 'invalid disposition' });
  if (b.disposition === 'sold' && !PACKAGE_KEYS.includes(b.package)) {
    return res.status(400).json({ error: 'a valid package is required for a sold door' });
  }

  // Resolve the target beat: explicit beat, else the rep's walk-in beat.
  let beat = b.beat_id ? getBeatById(b.beat_id) : null;
  if (!beat) beat = ensureWalkinsBeat(rep);

  const county = ALLOWED_COUNTIES.has(b.county) ? b.county : beat.county;
  const safeCounty = ALLOWED_COUNTIES.has(county) ? county : 'Stanislaus';
  const lat = Number.isFinite(b.lat) ? b.lat : beat.center_lat;
  const lng = Number.isFinite(b.lng) ? b.lng : beat.center_lng;
  const ts = normalizeTimestamp(b.knocked_at);

  const out = transaction(() => {
    const targetId = `target_${randomUUID()}`;
    insertTarget({
      id: targetId, address, city: (b.city || beat.city || '—'),
      county: safeCounty, zip: (b.zip || '00000'),
      lat, lng, ad_hoc: 1, score: 0,
      owner_occupied: 0, owner_occupied_known: 0,
      solicit_status: 'unknown', known_signals: '[]',
    });
    insertBeatTarget({ beat_id: beat.id, target_id: targetId, seq: nextSeqForBeat(beat.id) });
    bumpBeatTargetCount(beat.id, 1);

    const knockId = `knock_${randomUUID()}`;
    insertKnock({
      id: knockId, beat_id: beat.id, target_id: targetId, rep_id: rep.id,
      disposition: b.disposition, answered: b.disposition === 'not_home' ? 0 : 1,
      note: typeof b.note === 'string' ? b.note : null,
      client_uuid: b.client_uuid ?? null, knocked_at: ts,
    });

    let sale = null;
    if (b.disposition === 'sold') {
      const saleId = `sale_${randomUUID()}`;
      const amount_cents = PACKAGE_CATALOG[b.package].amount_cents;
      const agreement_url = buildAgreementUrl(b.package, targetId, { saleId, repId: rep.id });
      insertSale({
        id: saleId, knock_id: knockId, rep_id: rep.id, target_id: targetId,
        package: b.package, amount_cents, agreement_url,
        client_uuid: b.sold_client_uuid ?? null, sold_at: ts,
      });
      sale = getSaleByKnockId(knockId);
    }
    return { knock: getKnockById(knockId), target_id: targetId, sale };
  });

  res.status(201).json({
    knock: shapeKnock(out.knock),
    target: { id: out.target_id, address, city: (b.city || beat.city || '—'),
              lat, lng, score: 0, ad_hoc: true, beat_id: beat.id },
    beat: { id: beat.id, name: beat.name, kind: beat.kind },
    sale: out.sale ? shapeManualSale(out.sale) : null,
  });
});

function shapeManualSale(s) {
  return { id: s.id, package: s.package, amount_usd: Math.round(s.amount_cents) / 100,
    amount_cents: s.amount_cents, agreement_url: s.agreement_url, sold_at: s.sold_at };
}
```

**Step 4: Run green** → `node --test test/knocks-manual.test.js` PASS. Then `npm test` — everything green. **Step 5:** commit `feat(api): POST /api/knocks/manual for walk-in / off-beat doors`.

---

## Phase C — Feature 1 backend (manager creates a beat)

### Task C1: City-centroid lookup in config

**Files:**
- Modify: `src/config.js`
- Test: `test/city-centers.test.js` (create)

**Step 1: Failing test:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { resolveBeatCenter, COUNTY_CENTERS } = await import('../src/config.js');

test('resolveBeatCenter prefers explicit pin', () => {
  const c = resolveBeatCenter({ lat: 37.5, lng: -121.1, city: 'Modesto', county: 'Stanislaus' });
  assert.deepEqual(c, { lat: 37.5, lng: -121.1 });
});
test('resolveBeatCenter falls back to city then county', () => {
  const byCity = resolveBeatCenter({ city: 'Turlock', county: 'Stanislaus' });
  assert.ok(Number.isFinite(byCity.lat) && Number.isFinite(byCity.lng));
  const byCounty = resolveBeatCenter({ city: 'Nowhere', county: 'Merced' });
  assert.deepEqual(byCounty, COUNTY_CENTERS['Merced']);
});
```

**Step 2: Run red** → FAIL.

**Step 3: Implement** in `src/config.js`:

```js
/** Approx city centroids for the NDF service area (manager custom beats). */
export const CITY_CENTERS = Object.freeze({
  Modesto: { lat: 37.6391, lng: -120.9969 },
  Ceres: { lat: 37.5949, lng: -120.9577 },
  Turlock: { lat: 37.4947, lng: -120.8466 },
  Riverbank: { lat: 37.7361, lng: -120.9355 },
  Oakdale: { lat: 37.7665, lng: -120.8471 },
  Patterson: { lat: 37.4716, lng: -121.1297 },
  Manteca: { lat: 37.7974, lng: -121.2161 },
  Ripon: { lat: 37.7413, lng: -121.1241 },
  Stockton: { lat: 37.9577, lng: -121.2908 },
  Lodi: { lat: 38.1341, lng: -121.2722 },
  Tracy: { lat: 37.7397, lng: -121.4252 },
  Merced: { lat: 37.3022, lng: -120.4830 },
  Atwater: { lat: 37.3477, lng: -120.6091 },
  Livingston: { lat: 37.3869, lng: -120.7238 },
});

/** County centroids — final fallback when city is unknown. */
export const COUNTY_CENTERS = Object.freeze({
  Stanislaus: { lat: 37.5591, lng: -120.9977 },
  'San Joaquin': { lat: 37.9349, lng: -121.2713 },
  Merced: { lat: 37.1899, lng: -120.7120 },
});

/** Resolve a beat center: explicit pin > city centroid > county centroid. */
export function resolveBeatCenter({ lat, lng, city, county }) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (city && CITY_CENTERS[city]) return { ...CITY_CENTERS[city] };
  if (county && COUNTY_CENTERS[county]) return { ...COUNTY_CENTERS[county] };
  return { lat: 37.5591, lng: -120.9977 }; // Stanislaus fallback
}
```

**Step 4: Run green** → PASS. **Step 5:** commit `feat(config): city/county centroid lookup for custom beats`.

### Task C2: `POST /api/admin/beats`

**Files:**
- Modify: `src/routes/admin.routes.js`
- Test: `test/admin-create-beat.test.js` (create — copy admin-boot/dev-admin header pattern from `test/admin.test.js` + `test/dev-admin.test.js`)

**Contract:** admin-gated (already under `adminRouter.use('/admin', injectDevAdminUser, requireAdmin)`). Body `{ name, city, county, lat?, lng?, rep_id? }`. Validate name/city non-empty; county in the 3-set; if `rep_id` present it must exist. Create beat `kind='custom'`, `status='ready'`, `target_count=0`, center via `resolveBeatCenter`. If `rep_id` given, `assignBeatToRep`. Return `201 { beat }`.

**Step 1: Failing test** (assert 201 + beat.kind==='custom'; assert 400 on bad county; assert assignment when rep_id passed).

**Step 2: Run red** → FAIL (404).

**Step 3: Implement** — add near the other admin mutations:

```js
import { resolveBeatCenter } from '../config.js';
const BEAT_COUNTIES = new Set(['Stanislaus', 'San Joaquin', 'Merced']);

adminRouter.post('/admin/beats', (req, res) => {
  const body = req.body ?? {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const city = typeof body.city === 'string' ? body.city.trim() : '';
  const county = body.county;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!city) return res.status(400).json({ error: 'city is required' });
  if (!BEAT_COUNTIES.has(county)) return res.status(400).json({ error: 'invalid county' });

  let rep = null;
  if (body.rep_id) {
    rep = getRepById(body.rep_id);
    if (!rep) return res.status(400).json({ error: 'rep not found' });
  }

  const center = resolveBeatCenter({ lat: body.lat, lng: body.lng, city, county });
  const beatId = `beat_${randomUUID()}`;
  insertBeat({
    id: beatId, name, city, county, rep_id: rep ? rep.id : null,
    status: 'ready', center_lat: center.lat, center_lng: center.lng,
    target_count: 0, kind: 'custom',
  });

  res.status(201).json({
    beat: { id: beatId, name, city, county, status: 'ready', target_count: 0,
      kind: 'custom', rep_id: rep ? rep.id : null, rep_name: rep ? rep.name : null },
  });
});
```

Confirm `insertBeat` and `getRepById` are already imported in `admin.routes.js` (they are, per the import block at the top). Add `resolveBeatCenter` to the `config.js` import.

**Step 4: Run green** → PASS + `npm test` green. **Step 5:** commit `feat(api): POST /api/admin/beats — manager creates a custom beat`.

### Task C3: Protect custom + walk-in beats from the profile-approval rebuild

**Files:**
- Modify: `src/routes/admin.routes.js` (the `POST /admin/profile/approve` rebuild loop, ~line 216-222)
- Test: `test/admin-create-beat.test.js` (add a case) OR extend the existing profile-approve test

**Problem:** the approve handler deletes every un-knocked beat with no knock history (`deleteBeatIfUnknocked`) before rebuilding auto-beats. An empty custom beat or an empty walk-in beat would be wrongly deleted. Guard by `kind`.

**Step 1: Failing test:** create a `kind='custom'` beat with 0 knocks and a walk-in beat, POST `/admin/profile/approve` with `{force:true}`, assert both beats still exist afterward.

**Step 2: Run red** → FAIL (custom/walk-in beat deleted).

**Step 3: Implement** — the rebuild loop iterates `listBeatsWithKnockCounts()`. Skip non-auto beats:

```js
for (const b of listBeatsWithKnockCounts()) {
  if (b.kind !== 'auto') { beatsKept += 1; continue; } // custom + walk-in beats are manager/rep-owned
  if (b.knock_count > 0) { beatsKept += 1; continue; }
  beatsDeleted += deleteBeatIfUnknocked(b.id);
}
```

For `b.kind` to be present, ensure `listBeatsWithKnockCounts()` selects `kind`. Open `repo.js` `listBeatsWithKnockCounts` (~line 607) and add `b.kind` to its SELECT list if missing (`SELECT b.id, b.kind, ...` or `b.*`).

**Step 4: Run green** → PASS + `npm test`. **Step 5:** commit `fix(api): profile-approval rebuild preserves custom + walk-in beats`.

### Task C4: Auto-create the walk-in beat when a rep is added

**Files:**
- Modify: `src/routes/admin.routes.js` `POST /admin/reps` (after `insertRep`)
- Test: extend `test/admin.test.js` or `test/admin-create-beat.test.js`

**Step 1: Failing test:** POST `/admin/reps`, then assert `getWalkinsBeatForRep(newRepId)` is non-null.

**Step 2: Run red** → FAIL.

**Step 3: Implement** — import `ensureWalkinsBeat`; after the successful `insertRep(rep)` call, add `ensureWalkinsBeat(rep);`.

**Step 4: Run green** → PASS. **Step 5:** commit `feat(api): new rep gets a walk-in beat automatically`.

---

## Phase D — Feature 1 frontend (manager "Create a Beat" card)

### Task D1: Create-Beat card in the manager portal

**Files:**
- Modify: `public/admin.html` (add a card next to "Add a Rep", ~line 90-113)
- Modify: `public/admin.js` (form handler + repopulate rep dropdown from overview data)
- Modify: `public/styles/admin.css` only if new classes need styling (reuse `.ad-card`, `.ad-form`, `.ad-input`, `.ad-btn`)
- Test: `test/admin-create-beat-ui.test.js` (create — mirror the DOM-parse assertions used in `test/admin.test.js` / `test/admin-lifecycle-ui.test.js` which read `public/admin.html` as text and check for ids)

**Step 1: Failing test** — assert `public/admin.html` contains a `beat-form`, inputs `beat-name`, `beat-city`, a `beat-county` select with the 3 counties, a `beat-rep` select, and a submit `beat-submit`; assert `public/admin.js` references `/admin/beats`.

**Step 2: Run red** → FAIL.

**Step 3: Implement.** In `admin.html`, add after the Add-a-Rep `<section>`:

```html
<section class="ad-card ad-addbeat">
  <h2 class="ad-card__title">Create a Beat</h2>
  <p class="ad-card__hint">A named area to work. No pre-loaded homes — the rep logs each door as they knock it.</p>
  <form class="ad-form" id="beat-form" autocomplete="off">
    <label class="ad-label" for="beat-name">Beat name</label>
    <input class="ad-input" id="beat-name" name="name" type="text" placeholder="Sylvan Ave — nice area" required />
    <label class="ad-label" for="beat-city">City</label>
    <input class="ad-input" id="beat-city" name="city" type="text" placeholder="Modesto" required />
    <label class="ad-label" for="beat-county">County</label>
    <select class="ad-input" id="beat-county" name="county">
      <option value="Stanislaus">Stanislaus</option>
      <option value="San Joaquin">San Joaquin</option>
      <option value="Merced">Merced</option>
    </select>
    <label class="ad-label" for="beat-rep">Assign to</label>
    <select class="ad-input" id="beat-rep" name="rep_id"><option value="">— Unassigned —</option></select>
    <button class="ad-btn" id="beat-submit" type="submit">Create Beat</button>
    <p class="ad-form__msg" id="beat-msg" aria-live="polite"></p>
  </form>
</section>
```

In `admin.js`: (a) when rendering the overview, populate `#beat-rep` with `<option value=rep.id>rep.name</option>` for each rep (reuse the same `reps` array already fetched for the team list); (b) add a submit handler that POSTs JSON to `/api/admin/beats` with the admin fetch wrapper already used for `POST /admin/reps` (copy that wrapper — same headers/credentials), shows the result in `#beat-msg`, and calls the existing overview-refresh function on success so the new beat appears in the beats table. Follow the EXACT pattern of the existing `#rep-form` handler in `admin.js`.

**Step 4: Run green** → PASS. **Step 5:** commit `feat(admin-ui): Create-a-Beat card`.

> **Executor visual check:** after this task, run the app locally (`npm run seed` once if needed, then `npm start`), open `http://localhost:4178/admin.html` with `BEATS_DEV_ADMIN_USER=ryan@kitchenhomeandbath.com` set so the dev admin shim authorizes you, create a beat, and confirm it shows in the beats table assigned to the chosen rep.

---

## Phase E — Feature 2 frontend (log a door / walk-in)

### Task E1: "Log a door" manual sheet in the field app

**Files:**
- Modify: `public/app.html` (or `public/index.html` — confirm which the field app loads) to add a `＋ Log a door` toolbar button + a manual-entry sheet
- Modify: `public/app.js` (open/submit manual sheet; enqueue to `/api/knocks/manual`; on sold open agreement; append returned target to the map/list)
- Modify: `public/styles/app.css` (reuse existing sheet/pin classes; minimal new CSS)
- Test: `test/manual-door-ui.test.js` (create — assert `index.html` markup ids + `app.js` references `/knocks/manual` and `navigator.geolocation`)

**Design:**
- Toolbar button `#logDoorBtn` (`＋ Log a door`) is ALWAYS visible (so it works in an empty custom beat or walk-in beat where there are no pins to tap).
- Tapping it opens `#manualSheet`: an **Address** text input `#manualAddr`, a **Use my location** button `#manualGeo` (calls `navigator.geolocation.getCurrentPosition`, stores lat/lng in module state, shows a "📍 location captured" confirmation; failure is non-fatal — address alone is enough), the same disposition buttons, a note field, and the sold→package sub-phase (reuse the existing `phasePkg`/`pkgGrid` machinery).
- Submit builds `{ beat_id: state.beat.id, address, lat, lng, disposition, note, package?, client_uuid: uuid(), knocked_at }` and enqueues `OfflineQueue.enqueue('manual', API + '/knocks/manual', body)`.
- On success: if `resp.sale?.agreement_url`, `window.open(...)` it (same as `recordSale`). Append `resp.target` to `state.targets`/`state.targetById`, drop a map marker, add a list row, `recomputeKpis()`. This makes walk-ins show up like normal doors.
- `beat_id` is always the currently open beat. When the rep opens his **Walk-ins** beat (it appears in the beat picker because it has `rep_id` set), doors log there. When he's in a custom beat, they log there. One control, both cases.

**Step 1: Failing test** — assert the field app HTML has `logDoorBtn`, `manualSheet`, `manualAddr`, `manualGeo`; assert `app.js` contains `'/knocks/manual'` and `navigator.geolocation`.

**Step 2: Run red** → FAIL.

**Step 3: Implement** the markup + JS following the existing `openSheet`/`logKnock`/`recordSale` patterns in `app.js`. Keep all asset paths relative. Reuse `applyLocalDisposition`-style optimistic updates. Add a `renderManualTargetIntoBeat(target)` helper that pushes the target into state and calls `renderMap`/`renderList` (or the narrower `refreshRow`/marker-add helpers).

**Step 4: Run green** → `node --test test/manual-door-ui.test.js` + `npm test` green. **Step 5:** commit `feat(field-ui): log a door / walk-in from the field app`.

> **Executor visual check:** `npm start`, open the field app, log in as a seeded rep (see `scripts/seed.js` for a rep email + set a PIN via the admin portal or `POST /admin/reps/:id/pin`), open the **Walk-ins** beat, tap **＋ Log a door**, enter an address, mark **Not interested**, confirm it appears as a pin + list row and KPIs increment. Then log one as **Sold → Preferred** and confirm the agreement tab opens with `?pkg=preferred&target=...&rep=...`.

---

## Phase F — Feature 3 (expanded training & onboarding)

The existing curriculum (`public/training.html`, modules 01–07) covers selling well. Add what a real new hire needs on day one: field logistics/safety and how to use the app (including the two new features). Keep the server-graded quiz honest (answer key stays server-side in `src/training/questions.js`).

### Task F1: Module 08 — "Your First Day: Field Ops & Safety"

**Files:**
- Modify: `public/training.html` (add `<section class="module" id="m8">` after module 07's content but the quiz module should remain LAST — place m8 and m9 BEFORE the certification module, and renumber the quiz module or keep the quiz as `id="m7"` visually last; simplest: insert m8/m9 between current module 06 (Role-Play) and module 07 (Quiz), and update the quiz module number label to "09"/"10" and the TOC).
- Modify: `public/training.html` TOC nav (`#tocNav`, ~line 25).
- Test: extend `test/training.test.js` — assert the new module ids/headings exist in `training.html`.

**Content (write as real, non-placeholder copy except pay, which is an OWNER slot):**
- **What to bring every day:** charged iPad/phone (the Beats app), printed handouts (`/beats/handout.html`), business cards, water + electrolytes, hat/sunscreen, closed-toe shoes, a charged power bank, your ID.
- **Dress code:** clean NDF shirt, neat appearance — you're a licensed contractor's representative at someone's home.
- **Hours & territory:** knock the assigned beat; typical window (OWNER: confirm hours). Central Valley heat is real — hydrate, take shade breaks, watch for heat exhaustion.
- **Safety at the door:** stand slightly back from the door, to the side; never enter a home; if a dog is loose or a situation feels off, disengage and log the door and move on; two clear "no"s ends it; obey every "No Soliciting" sign (also covered in compliance).
- **Logistics:** where to park, where to start a beat, who to call (manager number — OWNER slot), what to do if the app is offline (it queues — keep knocking).
- **Pay & expectations:** OWNER slot — insert commission/base structure. Mark clearly as `<!-- OWNER: confirm pay structure -->` so Ryan fills it.
- **End of day:** make sure all knocks synced (the app shows pending count), report numbers.

**Steps:** F1.1 write failing test asserting `id="m8"` + heading text present → red → add the section + TOC entry → green → commit `feat(training): module 08 field ops & safety`.

### Task F2: Module 09 — "Using the Beats App"

**Files:** same files as F1.

**Content — a click-by-click of the actual app, including the NEW features:**
- **Log in:** enter your 4-digit PIN (your manager sets it). Sessions last the workday; you may re-enter your PIN after a day rollover.
- **Pick your beat:** the app lists beats assigned to you. Your **Walk-ins** beat is always there for off-beat knocking.
- **Read a door:** each pin shows a score and its last disposition; the list mirrors the map. "NO SOLICIT" doors are flagged — skip them.
- **Log a knock:** tap a door → pick a disposition (Not home / Refused / Callback / Not interested / Sold) → add a note if useful.
- **Log a walk-in / off-beat door (NEW):** stopped in a nice neighborhood that isn't in a beat? Tap **＋ Log a door**, type the address, tap **Use my location** to drop the pin, pick the disposition. It's saved just like a normal door and counts on your board.
- **Record a sale:** pick **Sold** → choose the plan (anchor on **Preferred $30/mo**) → the app opens the membership agreement for e-sign and first-visit booking. Say the **3-business-day right to cancel** out loud before they sign. Never discount labor.
- **Offline:** if you lose signal the app keeps working and queues everything; it syncs when you're back online. Watch the pending badge before you leave.
- **Your numbers:** the scoreboard shows knocks / answered / sold.

**Steps:** F2.1 failing test asserting `id="m9"` + the phrase "Log a walk-in" present → red → implement → green → commit `feat(training): module 09 using the beats app`.

### Task F3: Onboarding roadmap checklist at the top of training

**Files:** `public/training.html` (a short ordered checklist near the top, before module 01), `test/training.test.js`.

**Content:** "Your first week: 1) Read modules 01–09. 2) Pass the certification quiz (80%+). 3) Ride-along with a manager (module 06 checklist). 4) Run your first solo beat. 5) Log every door — even the no-answers." Steps: failing test asserts the checklist text exists → implement → commit `feat(training): first-week onboarding roadmap`.

### Task F4: Expand the certification quiz to cover safety + app usage

**Files:**
- Modify: `src/training/questions.js` — bump `CURRICULUM_VERSION` to `'2026-07b'`; append 4 questions to `QUESTION_BANK` (server-side answer key, client never sees it).
- Test: `test/training.test.js` — assert the new `CURRICULUM_VERSION` and that the bank length grew; assert every question still has an integer `answer` in range and 4 `choices`.

**New questions (append; keep the existing frozen shape — `id`, `topic`, `q`, `choices`, `answer`):**

```js
{
  id: 'q_walkin_log',
  topic: 'Using the app — walk-ins',
  q: 'You stop in a nice neighborhood that was not in any beat and knock a few doors. How do you record them?',
  choices: [
    'Write them on paper and hope you remember',
    'Tap "＋ Log a door", type the address, use your location, and log the disposition',
    'Skip logging — only pre-loaded doors count',
    'Text the addresses to your manager',
  ],
  answer: 1,
},
{
  id: 'q_offline',
  topic: 'Using the app — offline',
  q: 'You lose cell signal mid-beat. What should you do?',
  choices: [
    'Stop knocking until signal returns',
    'Keep knocking and logging — the app queues everything and syncs when you are back online',
    'Restart the app to force a connection',
    'Log the doors twice to be safe',
  ],
  answer: 1,
},
{
  id: 'q_dog_safety',
  topic: 'Field safety',
  q: 'A loose, aggressive dog is in the yard of your next door. The right move is:',
  choices: [
    'Knock quickly before it reaches you',
    'Do not engage — skip the door, log it, and move on',
    'Try to calm the dog',
    'Wait in the yard for the owner',
  ],
  answer: 1,
},
{
  id: 'q_end_of_day',
  topic: 'Using the app — sync',
  q: 'Before you finish for the day you should:',
  choices: [
    'Close the app immediately',
    'Confirm there are no pending/unsynced knocks (the app shows a pending count), then report your numbers',
    'Delete the day’s knocks',
    'Nothing — it all handles itself',
  ],
  answer: 1,
},
```

**Steps:** F4.1 failing test → red → implement → green → run `npm test` (the training route + grading tests must still pass) → commit `feat(training): quiz covers safety, offline, and walk-in logging`.

> **Note on `QUIZ_SIZE`:** it's 10 drawn from the bank; leave it at 10. Bumping the version means prior certs read against the old version — that's fine (the new hire certifies against `2026-07b`).

---

## Phase G — Full verification & deploy

### Task G1: Green suite + honesty/static guards

Run: `npm test`
Expected: ALL green, including `test/static-paths.test.js` (relative paths), `test/handout-proof.test.js`, and the `test/scoring.test.js` honesty tests. If `static-paths` fails, you used a root-absolute asset path in new HTML — fix to relative.

Commit any final fixups. Then use `superpowers:verification-before-completion` before claiming done.

### Task G2: Deploy to the sandbox

The field app + portal run on the Sandbox box as pm2 process `ndf-beats` at `/opt/ndf-beats` (served under `khbvr.com/beats/`, gated by Caddy). SSH is gated by the rule `Bash(ssh -p 2222 …root@45.56.83.16:*)`.

**Deploy steps (run from the repo root):**

1. **Copy changed source to the box.** Static + server files. Prefer a targeted copy of the dirs that changed:
   ```bash
   ssh -p 2222 root@45.56.83.16 'mkdir -p /opt/ndf-beats'
   # backend
   for f in src/config.js src/db/schema.sql src/db/migrate.js src/db/repo.js \
            src/routes/knocks.routes.js src/routes/admin.routes.js src/training/questions.js; do
     ssh -p 2222 root@45.56.83.16 "cat > /opt/ndf-beats/$f" < "$f"
   done
   # frontend
   for f in public/admin.html public/admin.js public/app.js public/index.html \
            public/training.html public/styles/admin.css public/styles/app.css; do
     ssh -p 2222 root@45.56.83.16 "cat > /opt/ndf-beats/$f" < "$f"
   done
   ```
   (Adjust the frontend file list to exactly the files you changed; confirm the field app's HTML filename — `index.html` vs `app.html` — before copying.)

2. **Run the additive migration on the box** (adds `beats.kind`, `targets.ad_hoc`, backfills walk-in beats for existing reps):
   ```bash
   ssh -p 2222 root@45.56.83.16 'cd /opt/ndf-beats && node src/db/migrate.js'
   ```
   Expected: `[migrate] schema applied -> ...`.

3. **Restart the service:**
   ```bash
   ssh -p 2222 root@45.56.83.16 'pm2 restart ndf-beats && pm2 status ndf-beats'
   ```

4. **Smoke test live** (portal is gated — expect the login redirect if unauthenticated; that itself confirms it's up):
   ```bash
   ssh -p 2222 root@45.56.83.16 'curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:PORT/api/admin/overview'
   ```
   Replace `PORT` with the box's configured port (check `/opt/ndf-beats/.env`; memory says 3030). A `401/403` from the app layer or a `200` behind the dev shim both mean the process booted.

5. **Manual live check:** open `https://khbvr.com/beats/admin.html`, create a test beat assigned to the new hire, then on `https://khbvr.com/beats/` (field app) log in as the hire, open Walk-ins, and log one door. Delete the test beat if desired (only works while it has no knocks).

**Do NOT deploy without asking Ryan first** — deploying is outward-facing. Present the green test summary and wait for his go-ahead before running Phase G2.

---

## Post-implementation

- Update the memory file `ndf_beats_system.md` with: custom beats (`POST /api/admin/beats`, `kind` column), walk-in/off-beat logging (`POST /api/knocks/manual`, per-rep Walk-ins beat, `ad_hoc` targets), and training modules 08–09 + curriculum `2026-07b`.
- The `$` amounts in schema.sql comments (`9900/24900/49900`) are stale vs the live `15000/30000/69000` catalog — out of scope here, note for a later cleanup.
```
