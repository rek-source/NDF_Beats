# NDF Beats — Production Deploy Guide

**Status: INSTRUCTIONS ONLY. Do not run any of this from the build loop.**
Phase 1 is a local-only SQLite app. Promoting it to production (Postgres, real
data keys, a gated `/beats` route, and a hub card) is a deliberate, human-driven
step performed by Ryan + an operator. Nothing in this repository deploys, SSHes,
or mutates a live server.

This document is the runbook for that later promotion. Read it end to end before
touching anything. Each section ends with a verification step; do not proceed
until the prior step verifies.

---

## 0. Pre-flight checklist

- [ ] Phase 1 acceptance is green locally: `npm install && npm run seed && npm start` works and `npm test` passes.
- [ ] An adversarial code review has cleared the build (target ≥ 9/10).
- [ ] You have the production secrets out-of-band (never commit them):
      `DATABASE_URL`, `TRACERLY_API_KEY`, `ZILLOW_API_KEY` (or chosen value
      feed), `CENSUS_API_KEY`.
- [ ] You know which box serves the route. Two patterns exist at KHB:
      - **App backend** (Node + DB): the **Pillar Deals pattern** — a long-running
        Node process behind a reverse proxy, managed by **pm2**, with **Postgres**.
      - **Static `/gbb/*` pages**: served by **Caddy on the Sandbox box**
        (`45.56.83.16:2222`), file-served from `/var/www/khbvr.com/`.
      NDF Beats is an app (it has a backend + DB), so it follows the **app**
      pattern with Caddy reverse-proxying a route to the Node process.
- [ ] You have an off-hours window and a rollback plan (below).

> SSH reminder: KHB boxes listen on **port 2222**, not 22. Always
> `cp` a timestamped backup of any config you edit before editing, and never
> reload a service whose config fails validation.

---

## 1. Swap the data layer: SQLite → Postgres

The whole point of the repository abstraction (`src/db/repo.js` is the **only**
file with SQL; routes/scoring/seed never touch the driver) is that this swap is
contained. Routes, KPI service, scoring, and the frontend do **not** change.

### 1.1 What changes

| Layer | Phase 1 (local) | Production |
|-------|-----------------|------------|
| Driver | `better-sqlite3` (sync) | `pg` (async pool) |
| Connection | `src/db/connection.js` (file path + WAL pragmas) | a `pg.Pool` from `DATABASE_URL` |
| Repository | `src/db/repo.js` synchronous methods | same method names, now `async` returning Promises |
| Schema | `src/db/schema.sql` (SQLite DDL) | `src/db/schema.pg.sql` (Postgres DDL) |
| Migrate | `src/db/migrate.js` runs the `.sql` | runs the Postgres DDL via `pg` |

### 1.2 Recommended approach — a second repo implementation

Do **not** rewrite the SQLite repo in place. Add a parallel Postgres repo and
select it by env so you can fall back instantly:

1. Add `pg` to `dependencies`.
2. Create `src/db/connection.pg.js` exporting a configured `pg.Pool` built from
   `process.env.DATABASE_URL` (with `ssl` as the host requires).
3. Create `src/db/repo.pg.js` with the **same method signatures** as
   `repo.js` but `async` (each returns a Promise). Port each query:
   - SQLite `?` placeholders → Postgres `$1, $2, …`.
   - `INSERT … ON CONFLICT(client_uuid) DO NOTHING` then `SELECT` for
     idempotency works in both; in Postgres prefer
     `INSERT … ON CONFLICT (client_uuid) DO UPDATE SET … RETURNING *` or a
     guarded `SELECT`-then-`INSERT` in a transaction.
   - `strftime('%Y-%m-%dT%H:%M:%fZ','now')` defaults → Postgres
     `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` or
     store `timestamptz` and format on read. Keep the **stored representation as
     ISO-8601 UTC TEXT** to match the frozen schema and the KPI date math.
   - `INTEGER` money/booleans/scores carry over unchanged (use `integer`,
     `smallint`/`boolean`).
   - `TEXT PRIMARY KEY` UUIDs carry over unchanged (still generated in the app via
     `crypto.randomUUID()` — do **not** switch to a DB-side `uuid` default, that
     would break the portable contract).
4. **Make the repo selectable.** In whatever module currently imports the repo
   (server + seed), import via a tiny factory that reads an env flag, e.g.
   `DB_DRIVER=postgres|sqlite` (default `sqlite`). The factory returns the right
   repo. This is the only wiring change outside `src/db/`.
5. **Async ripple:** `better-sqlite3` is synchronous; `pg` is not. Route handlers
   and the KPI service must `await` repo calls. If Phase 1 handlers already
   `await` the repo methods (recommended even when the impl is sync), the swap is
   transparent. If they call synchronously, mark them `async` and add `await` at
   the repo boundary only — no logic changes.

### 1.3 Port the schema

Create `src/db/schema.pg.sql` from `src/db/schema.sql`:

- `PRAGMA …` lines → drop them (Postgres has WAL/FKs on by default; FKs are
  enforced automatically).
- `INTEGER PRIMARY KEY` is not used here (IDs are TEXT) — good, nothing to change.
- `CHECK (… IN (…))` constraints port verbatim.
- `CREATE INDEX IF NOT EXISTS` ports verbatim.
- `INTEGER NOT NULL DEFAULT 1` booleans → keep as `smallint`/`integer 0|1` to
  match the frozen schema, **or** migrate to `boolean` and update the repo's
  read/write mapping consistently. Pick one and keep it identical to what the
  repo expects.
- Consider a `migrations/` directory with numbered, idempotent files if you want
  forward-only migrations later; for the first cut, a single `schema.pg.sql`
  applied by a Postgres-aware `migrate` is fine.

### 1.4 Provision and migrate

```bash
# On the DB host (managed Postgres or the app box). Example only — adapt creds.
createdb ndf_beats
export DATABASE_URL='postgres://ndf_beats:***@DB_HOST:5432/ndf_beats?sslmode=require'

# Apply schema via your Postgres-aware migrate (psql or node):
psql "$DATABASE_URL" -f src/db/schema.pg.sql
```

**Production does NOT run the mock seed.** `scripts/seed.js` generates fake
targets — it must never touch the production database. The first real data comes
from the batch pre-score job in §2. (If you want a smoke check, seed a *separate*
throwaway database, not production.)

### 1.5 Verify the swap

```bash
DB_DRIVER=postgres DATABASE_URL=... npm start
# Then exercise every endpoint and compare shapes to SPEC.md §5:
curl -s 'http://localhost:4178/api/scoreboard?period=today'
```

Acceptance: all five endpoints return the exact `SPEC.md` §5 shapes, knock/sale
idempotency holds (replay a `client_uuid` → no duplicate), and sale price is
server-authoritative. `npm test` should pass against Postgres too (point the test
harness at a throwaway Postgres DB via `DATABASE_URL`).

---

## 2. Wire real data: Tracerly / Zillow / Census (batch pre-score)

In Phase 1 the adapters at `src/adapters/*.stub.js` return mock data and are
**never called at runtime**. In production they become real, but stay **batch**,
not per-door — the design mandates pre-scoring to control per-lookup cost, and no
external call happens on the canvassing hot path.

### 2.1 Replace the stubs with real adapters (same interface)

Implement real modules with the **same function signatures** the stubs expose so
the pre-score job is unchanged:

- `tracerly.js` — `getProperty(address)` → owner, property attributes, tenure,
  recently-sold. Tracerly is the primary source (key already held).
- `zillow.js` — `getValue(address)` → estimated value. ⚠️ Zillow's official API
  is restricted; if access isn't available, **fall back to Tracerly's value
  field or a compliant value feed**. Keep the function name; change only the
  source behind it.
- `census.js` — `getBlockGroup(lat, lng)` → ACS income decile, median home age,
  owner-occupancy by block group (free Census/ACS API).

Each adapter:
- Reads its key from env (`TRACERLY_API_KEY`, `ZILLOW_API_KEY`,
  `CENSUS_API_KEY`) — **never hard-code or commit keys**.
- Adds timeouts, retries with backoff, and per-provider rate limiting.
- Caches responses (the property data is slow-moving) to avoid re-billing.
- Logs cost-bearing calls so spend is auditable.

### 2.2 Build the batch pre-score job

Add `scripts/prescore.js` (production counterpart to the mock `seed.js`) that:

1. Pulls candidate addresses for the service area (Stanislaus / San Joaquin /
   Merced) from your address source.
2. For each, calls the **real** adapters in batch (respecting rate limits +
   cache), assembling the `targets` signal set:
   `{ value_cents, home_age, owner_occupied, tenure_years, recently_sold, income_band }`.
3. Scores each via the **unchanged** `src/scoring/scoreTarget(target, profile)`
   using `defaultProfile` (or the current learned profile once Phase 2 ships).
4. Honors the `no_soliciting` flag.
5. Clusters the top-scored targets into beats via the **unchanged**
   `src/scoring/clusterBeats(topTargets, 50)` and writes `beats` + `beat_targets`.
6. Writes everything through the **repository** (`repo`), exactly as the seed
   does — no raw SQL in the job.

Run it on a schedule (e.g. weekly/monthly cron) — **not** per door, **not** at
request time. The runtime app still never calls a paid API.

### 2.3 "Sold" agreement integration

The agreement URL base lives in `src/config.js`
(`/gbb/ndf/agreements/home-care-membership.html`). In production, confirm that
path is the live, branded Care Plan agreement page and that the `?pkg=&target=`
query params it receives drive pre-fill + e-sign + first-visit booking. This app
only **links** to that page; it does not re-author agreement copy. Do not invent
or modify agreement/legal text here.

### 2.4 Verify

- Pre-score job populates `targets`/`beats`/`beat_targets` from real data.
- The runtime app makes **zero** external paid calls (grep logs / monitor egress
  during a canvassing session).
- A live "Sold" opens the real agreement page with correct `pkg` + `target`.

---

## 3. Run the Node app in production (Pillar Deals pattern)

NDF Beats runs as a long-lived Node process behind the reverse proxy, managed by
**pm2** (the established KHB pattern — pm2, not systemd, for these apps).

### 3.1 Place the code and install

```bash
# On the app box (SSH on port 2222). Example paths — match your conventions.
ssh -p 2222 root@<APP_BOX>
mkdir -p /opt/ndf-beats && cd /opt/ndf-beats
# rsync/scp the systems/ndf-beats/ tree here (excluding node_modules, data/).
npm ci --omit=dev          # production deps only (express, better-sqlite3, pg)
```

### 3.2 Production environment

Create `/opt/ndf-beats/.env` (mode `600`, never committed):

```ini
PORT=4178
DB_DRIVER=postgres
DATABASE_URL=postgres://ndf_beats:***@DB_HOST:5432/ndf_beats?sslmode=require
TRACERLY_API_KEY=***
ZILLOW_API_KEY=***            # or the chosen value-feed key
CENSUS_API_KEY=***
NODE_ENV=production
```

### 3.3 Start under pm2

```bash
pm2 start src/server.js --name ndf-beats --time
pm2 save                      # persist across reboots
pm2 startup                   # (one-time) install the boot hook it prints
```

Health check: `curl -s http://127.0.0.1:4178/api/scoreboard?period=today`
returns 200 with the §5.5 shape. `pm2 logs ndf-beats` is clean.

> The app binds to `PORT` on localhost; only the reverse proxy is public-facing.

---

## 4. Caddy `/beats` route (reverse proxy + SSO gate)

The Sandbox box runs Caddy and is the public edge for `khbvr.com` paths. Add a
gated route that reverse-proxies to the Node process. **This is the only Caddy
change; treat it carefully.**

> Whether `/beats` proxies cross-box or the Node app runs on the same box as
> Caddy depends on current topology — confirm before wiring. The block below
> assumes the app is reachable from Caddy at `APP_HOST:4178`.

### 4.1 Back up first, always

```bash
ssh -p 2222 root@45.56.83.16
cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d-%H%M%S)
```

### 4.2 Add the route + gate

Add a reverse-proxy handler for `/beats` and `/beats/*`, and **gate it behind KHB
SSO** the same way other sensitive paths are gated — append the new paths to the
existing `@needsAuthGbb { path … }` matcher (forward_auth → the auth service →
302 to `/auth/login`). Conceptually:

```caddyfile
# inside the khbvr.com site block

# gate: add /beats to the SSO-protected matcher
@needsAuthGbb {
    path /gbb/ndf/playbook /gbb/ndf/playbook/* /beats /beats/*   # ...existing paths + /beats
}

# route: proxy the app (strip the /beats prefix so the app sees /, /api/*, etc.)
handle_path /beats/* {
    reverse_proxy APP_HOST:4178
}
handle /beats {
    redir /beats/ 301
}
```

`handle_path` strips the `/beats` prefix so the app's own routes (`/`,
`/scoreboard.html`, `/training.html`, `/api/*`) resolve. If you instead keep the
prefix, the app must be configured with a base path — prefer `handle_path` to
avoid app changes.

### 4.3 Validate before reload (mandatory)

```bash
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# Only if validate PASSES:
systemctl reload caddy
# If validate FAILS: restore the backup and do NOT reload.
cp /etc/caddy/Caddyfile.bak.<timestamp> /etc/caddy/Caddyfile
```

### 4.4 Verify

- `https://khbvr.com/beats/` redirects to SSO login when unauthenticated.
- After login, the rep app loads; `https://khbvr.com/beats/api/scoreboard?period=today`
  returns the live KPI shape.
- Scoreboard and Training pages load under `/beats/`.

---

## 5. Hub card on `/hub/`

Add a card linking to `/beats/` on the internal hub. The hub is a separate
surface — do not edit it from any build loop; this is a deliberate manual edit.

1. Locate the live hub source (the `/hub/` page) and back it up before editing.
2. Add a card matching the existing hub card markup/brand: title **NDF Beats**,
   one-line description ("Door-to-door Care Plan canvassing — beats, door logging,
   live scoreboard"), and link target `/beats/`.
3. Keep KHB brand tokens (sharp corners, hairline borders, Fraunces/Inter,
   bronze accents) consistent with sibling cards — reuse the existing card
   component rather than inventing new styles.
4. Deploy the hub change through whatever mechanism the hub already uses (do not
   improvise a new deploy path).

Verify: the new card appears on `/hub/`, brand-consistent, and clicks through to
the gated `/beats/` app.

---

## 6. Adaptive re-weighting (Phase 2 — out of scope here)

`src/scoring/reweight.js` ships now as a **stub** with the real signature
(`updateWeights(knocks, sales, profile) → profile`). Phase 1 returns the profile
unchanged. Phase 2 — once enough real `knocks`/`sales` exist — implements the
learning body so the signals that actually convert get re-weighted, then has the
pre-score job (§2.2) feed the learned profile into `scoreTarget` instead of
`defaultProfile`. No caller changes when the body is filled in. **Do not build
this during the Phase 1 promotion.**

---

## 7. Rollback

- **App:** `pm2 stop ndf-beats` (or `pm2 restart` to a prior release dir). Keep
  the previous release directory so you can repoint `pm2` instantly.
- **Caddy:** restore the timestamped Caddyfile backup and `systemctl reload caddy`
  (or `caddy stop`/`start`). Removing the `/beats` block returns the edge to its
  prior state.
- **Hub:** restore the hub backup.
- **Database:** the SQLite → Postgres swap is additive (new DB + new repo impl);
  set `DB_DRIVER=sqlite` to fall back to the file DB during the swap window.
  Never run destructive migrations against production without a backup
  (`pg_dump` first).

---

## Guardrails recap

- This file is **instructions only**. Performing these steps is a deliberate
  human action outside any autonomous build loop.
- Never commit secrets. Keys live in the production `.env` (mode `600`) or a
  secrets manager — never in the repo.
- The runtime app makes **no** paid external calls; all property/value/demographic
  data enters via the **batch** pre-score job.
- Money and legal text stay fixed: Essential $99 / Preferred $249 / Total Home
  $499; "Sold" links to the existing Care Plan agreement — never re-authored here.
- Back up before every config edit; validate before every reload; have a rollback
  ready before you start.

---

## Security note — Tracerfy API token (2026-07-06, finding #11)

- The Tracerfy token was found in a **plaintext, group-readable `.env`** in the
  dev tree. Local perms are now `600`; verify the **prod** `/opt/ndf-beats/.env`
  is also `chmod 600` and owned by the service user.
- **[OWNER ACTION] Rotate the Tracerfy API token** in the Tracerfy dashboard and
  update both `.env` files — treat the old token as exposed: it was **committed
  to git history** (baseline commit). `.env` is now untracked + gitignored, but
  the old token remains in history until rotated (rotation, not history rewrite,
  is the fix).
- Never commit `.env`; the repo's `.gitignore` must keep excluding it.
