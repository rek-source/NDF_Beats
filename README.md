# NDF Beats

iPad-first, door-to-door **Care Plan** canvassing app for NDF reps. Reps work
AI-scored **beats** (walkable target lists), log every door, and a live gamified
**scoreboard** ranks performance. Includes a D2D **training** module.

**Phase 1 (this build) runs entirely locally** on SQLite + a deterministic mock
seed. No paid APIs, no deploy, no real credentials. Tracerly / Zillow / Census
are stubbed and never invoked at runtime.

- Care Plan packages (fixed by policy): **Essential $99 / Preferred $249 / Total Home $499** (annual).
- Service area: **Stanislaus · San Joaquin · Merced** (California Central Valley).

> Build contract: see [`SPEC.md`](./SPEC.md). It is authoritative for schema,
> REST shapes, scoring signatures, and brand tokens. This README explains how to
> run the system; [`DEPLOY.md`](./DEPLOY.md) explains how it will later be
> promoted to production (instructions only — nothing in this repo deploys).

---

## Requirements

- **Node >= 20** (uses the built-in `node:test` runner and `crypto.randomUUID()`).
- npm (ships with Node).
- A C toolchain for `better-sqlite3`'s native build. Prebuilt binaries cover most
  platforms; if `npm install` has to compile from source you need:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).
  - **Debian/Ubuntu:** `sudo apt-get install -y build-essential python3`.
  - **Windows:** the "Desktop development with C++" workload.

No frontend build step. Leaflet and Google Fonts load from CDNs in the browser;
the only runtime network traffic is those browser-side CDN asset loads.

---

## Quick start

```bash
npm install      # install express + better-sqlite3
npm run seed     # create data/ndf-beats.db, apply schema, load the mock seed
npm start        # serve the app on http://localhost:4178/
```

Then open:

| Page | URL |
|------|-----|
| Rep iPad app | <http://localhost:4178/> |
| Scoreboard | <http://localhost:4178/scoreboard.html> |
| Training | <http://localhost:4178/training.html> |

`npm run seed` is **destructive-on-rerun by design** (it rebuilds a deterministic
dataset). Re-run it any time you want a clean, known state.

### What the three commands do

- `npm install` — installs the only two runtime deps (`express`, `better-sqlite3`).
- `npm run seed` — `node src/db/migrate.js && node scripts/seed.js`:
  1. `migrate.js` applies `src/db/schema.sql` (idempotent DDL).
  2. `seed.js` generates a **deterministic** dataset (seeded PRNG, so reruns are
     stable): ~600 scored targets across the three counties, 4 reps (3 reps + 1
     manager), 6–8 geo-clustered beats, and a partial day of knocks/sales spread
     across today / this week / this month so all scoreboard periods return data.
- `npm start` — `node src/server.js` boots Express, mounts `public/` as static,
  and wires the `/api` routes. Default `PORT=4178`.

---

## Configuration

Copy the example env file if you want to override defaults (the app runs fine
with no `.env` at all):

```bash
cp .env.example .env
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `4178` | HTTP port for the local server. |
| `DB_PATH` | `data/ndf-beats.db` | SQLite database file location. |
| `TRACERFY_API_TOKEN` | _(unset)_ | **Ingestion only.** Token for the paid Tracerfy property API (~$0.20/lookup). Unset = free stub fallback. |
| `CENSUS_API_KEY` | _(unset)_ | **Ingestion only.** Free US Census ACS key for real demographics. Unset = keyless geocode + neutral income band. |
| `MAX_LOOKUPS` | `25` | **Ingestion only.** Hard cap on paid Tracerfy lookups per run (CLI `--max` overrides). |

The **running server reads only `PORT` / `DB_PATH`** and needs no secrets. The
two API keys above are used **only** by the optional real-data ingestion
(`scripts/ingest.js`, see below). The legacy `src/adapters/*.stub.js` modules are
deterministic mocks used by `npm run seed` and as the free ingestion fallback.

---

## Real data ingestion (optional)

`npm run seed` loads a deterministic mock dataset. To populate the DB with
**real targets** for the service area (Stanislaus / San Joaquin / Merced, CA),
use the ingestion script instead. It combines one paid API with two free sources
under a strict cost cap:

| Source | Cost | Role |
|--------|------|------|
| **OpenStreetMap Overpass** (`src/adapters/addresses.js`) | FREE | Which doors exist — candidate addresses + lat/lng/zip per city. |
| **US Census** (`src/adapters/census.js`) | FREE | Per-tract income band + demographics (keyless geocode; ACS needs `CENSUS_API_KEY`). |
| **Tracerfy** (`src/adapters/tracerfy.js`) | PAID ~$0.20/lookup | Enriches a **capped** subset with owner / value / age / last-sale / contacts (DNC → `no_soliciting`). |

Ingestion fetches candidate addresses (Overpass), enriches a capped subset
(Tracerfy), adds Census demographics, runs the **existing** scoring +
beat-clustering, and writes reps/targets/beats via `repo.js`. The API routes,
frontend, and scoreboard are untouched.

```bash
# Recommended first real run — Modesto, at most 25 paid lookups (≈ $5.00 max):
node scripts/ingest.js --cities=Modesto --max=25
# (equivalently: npm run ingest -- --cities=Modesto --max=25)

# Multiple cities, tiny cap, more candidate doors per city:
node scripts/ingest.js --cities=Modesto,Turlock --max=10 --per-city=800
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--cities=` | `Modesto` | Comma-separated cities (must be in the service area). |
| `--max=` | `25` (or `MAX_LOOKUPS`) | **Hard cap on paid Tracerfy lookups. Never exceeded.** |
| `--per-city=` | `800` | Candidate addresses to pull per city from Overpass (free). |

### Cost control (important)

- **`--max` / `MAX_LOOKUPS` is a hard ceiling, default 25.** Every paid (live,
  uncached) Tracerfy call is counted; the moment the cap is hit, the run stops
  paying and finishes the remaining doors for free (stub fallback) so the dataset
  is still complete. Estimated spend ≈ `lookups × $0.20`, printed at the end.
- **Responses are cached** to `data/cache/tracerfy/` keyed by address. Re-running
  ingestion is **free and idempotent** — a previously looked-up address is served
  from cache and never re-charged.
- **No token = no spend.** With `TRACERFY_API_TOKEN` unset, Tracerfy is skipped
  entirely and ingestion runs on Overpass + Census (+ the deterministic stub) for
  **$0** — still producing real addresses, real geography, and real scores.
- Cities outside the service area, an empty Overpass result, or a failed paid
  call never cause unexpected charges (the run aborts or falls back, logging why).

> Overpass and Census are free public services — be polite. The script paces
> Overpass calls and backs off on rate limits.

---

## How it works (architecture)

```
Browser (iPad-first SPA, Leaflet via CDN)
  rep app  /            scoreboard /scoreboard.html       training /training.html
        |                         |                                |
        |  fetch /api/*           |  GET /api/scoreboard           |  (no backend calls)
        v                         v                                v
Express server (src/server.js)
  routes/  beats · knocks · sales · scoreboard
        |
        v
Repository (src/db/repo.js)   <-- the ONLY place SQL lives
        |
        v
better-sqlite3 (src/db/connection.js)  ->  data/ndf-beats.db  (WAL, FKs on)

Pure scoring (src/scoring/*)  scoreTarget · clusterBeats · updateWeights(stub)
  - used by the seed to score + cluster targets; no DB, no HTTP
Adapters (src/adapters/*.stub.js)  STUBS — not invoked at runtime in Phase 1
```

**Data-layer abstraction is a hard contract:** every query goes through
`src/db/repo.js`. No route, scoring file, or seed script touches
`better-sqlite3` directly. That is what makes the later SQLite → Postgres swap a
single-file change (see `DEPLOY.md`).

### REST API (base path `/api`)

All shapes are frozen in `SPEC.md` §5. Money is returned to the frontend as
dollars under `_usd` keys; the database stores integer cents.

| Method & path | Purpose |
|---------------|---------|
| `GET /api/reps/:repId/beats` | List a rep's beats with per-beat progress. |
| `GET /api/beats/:beatId` | A beat plus its ordered (sequenced) targets. |
| `POST /api/knocks` | Log a door outcome. Idempotent on `client_uuid`. |
| `POST /api/sales` | Record a sale against a `sold` knock; returns the agreement URL. |
| `GET /api/scoreboard?period=today\|week\|month` | The 6 team + per-rep KPIs. |

Notes on behavior worth knowing while testing:

- **Idempotency:** knocks and sales carry a client-generated `client_uuid`.
  Replaying the same `client_uuid` returns the existing row instead of creating a
  duplicate — this is what makes the offline queue safe to flush repeatedly.
- **Server-authoritative pricing:** `POST /api/sales` ignores any client price.
  The amount is derived from the package catalog in `src/config.js`
  (`essential` 9900 / `preferred` 24900 / `total_home` 49900 cents).
- **Sold is two steps:** a `sold` disposition on `POST /api/knocks` does *not*
  auto-create a sale. The client follows with `POST /api/sales` referencing the
  returned knock id, then opens `sale.agreement_url`.
- **KPI period windows** are computed in **America/Los_Angeles** (NDF's market)
  and converted to UTC for the SQL range: `today` = local midnight→now,
  `week` = Monday 00:00 local, `month` = the 1st at 00:00 local.

### Try the API from the shell

After `npm run seed && npm start`, in another terminal:

```bash
# Scoreboard (always non-empty after seeding)
curl -s 'http://localhost:4178/api/scoreboard?period=today'

# Grab the first rep id, then list that rep's beats
curl -s 'http://localhost:4178/api/scoreboard?period=week' \
  | grep -o '"rep_id":"[^"]*"' | head -1
# -> use that id below
curl -s 'http://localhost:4178/api/reps/<REP_ID>/beats'

# A beat with its ordered targets
curl -s 'http://localhost:4178/api/beats/<BEAT_ID>'

# Log a knock (idempotent on client_uuid)
curl -s -X POST 'http://localhost:4178/api/knocks' \
  -H 'content-type: application/json' \
  -d '{"beat_id":"<BEAT_ID>","target_id":"<TARGET_ID>","rep_id":"<REP_ID>","disposition":"callback","client_uuid":"demo-uuid-1"}'
```

---

## The rep iPad app

- **Landscape, iPad-first.** Left ~60% Leaflet map, right ~40% ordered address
  list. Header shows rep + beat + today's mini-KPIs and links to Scoreboard and
  Training.
- **Status-colored pins:** unknocked (ink outline), not_home (muted), callback
  (bronze), refused/not_interested (red), sold (green).
- **Door sheet** with five big, glove-friendly buttons (min 64px touch targets):
  **Not home / Refused / Callback / Not interested / Sold**.
  - Non-sold → `POST /api/knocks`, sheet closes, pin recolors, list advances.
  - **Sold** → knock(`sold`) → package picker (Essential / Preferred / Total
    Home) → `POST /api/sales` → opens the existing Care Plan agreement page in a
    new tab for e-sign + first-visit booking.
- Defaults to the **high-contrast outdoor theme** (`data-theme="hc"`) for
  sunlight readability.

### Offline behavior (Phase 1 = best-effort)

Every knock and sale is written to a local queue (localStorage/IndexedDB) with a
`client_uuid` **before** the network call. A sync loop flushes the queue when the
device is back online; server-side idempotency on `client_uuid` makes replays
safe. A visible badge shows the pending count (e.g. "3 pending").

**Limitations:** Phase 1 offline is queue-and-replay only. There is **no service
worker** and **no offline map tiles** — Leaflet tiles require connectivity. True
offline maps are a later concern.

To exercise it: load a beat → set the browser/devtools network to **Offline** →
log a few doors (badge climbs) → set back to **Online** → the queue flushes and
the badge clears.

---

## Tests

```bash
npm test        # node --test test/
```

Covers:

- **Scoring units** (`test/scoring.test.js`) — `scoreTarget` is deterministic and
  clamped 0..100; `clusterBeats` produces correctly sized, sequenced,
  `no_soliciting`-free beats.
- **API contract** (`test/api.test.js`) — each route returns the exact shape from
  `SPEC.md` §5 against a seeded DB, including knock/sale idempotency and the
  server-authoritative sale price.

> The API tests run against a seeded database. If they report "no data," run
> `npm run seed` first (or the test harness seeds a temp DB via `DB_PATH` — see
> the test file header).

---

## Project layout

```
systems/ndf-beats/
├── SPEC.md                 # authoritative build contract (schema, API, scoring, brand)
├── README.md               # this file — how to run it
├── DEPLOY.md               # how to promote to production later (instructions only)
├── package.json            # deps + scripts (seed / start / test)
├── .env.example            # PORT, DB_PATH (no secrets)
├── src/
│   ├── server.js           # Express bootstrap + route wiring + static mount
│   ├── config.js           # env, package catalog, agreement URL base
│   ├── db/                 # schema.sql · connection.js · migrate.js · repo.js (all SQL)
│   ├── routes/             # beats · knocks · sales · scoreboard
│   ├── kpi/                # scoreboard.service.js (KPI aggregation)
│   ├── adapters/           # tracerly/zillow/census STUBS (never called in Phase 1)
│   └── scoring/            # scoring.js · beats.js · reweight.js (stub) · profile.js
├── scripts/                # seed.js + seed-data/geo-bounds.js
├── public/                 # rep app, scoreboard, training (static, CDN libs)
│   └── styles/             # tokens.css (brand) + per-page layout css
├── test/                   # scoring + api tests
└── data/                   # ndf-beats.db (gitignored, created by seed)
```

---

## Troubleshooting

**`npm install` fails building `better-sqlite3`.**
A prebuilt binary wasn't available and the source build needs a C toolchain.
Install the platform toolchain listed under [Requirements](#requirements), then
`rm -rf node_modules package-lock.json && npm install`.

**`Error: Cannot open database` / empty pages.**
You haven't seeded yet, or `DB_PATH` points somewhere unwritable. Run
`npm run seed`. Confirm `data/ndf-beats.db` exists and the process can write to
`data/`.

**Port 4178 already in use.**
Run on another port: `PORT=8080 npm start` (or set `PORT` in `.env`).

**Scoreboard is empty.**
Re-run `npm run seed`. The seed deliberately spreads knocks/sales across today,
this week, and this month so every period returns data; an un-seeded or stale DB
shows nothing.

**Map tiles don't load / fonts look wrong.**
Leaflet tiles and Google Fonts come from CDNs — you need internet for the
browser to fetch them. The server and API work fully offline; only the
browser-side map and web fonts require connectivity.

**Re-seeding doesn't change anything.**
That's expected — the seed is deterministic (seeded PRNG). To start over,
delete the DB first: `rm -f data/ndf-beats.db*` then `npm run seed`.

**Want a totally clean checkout state.**
`git clean -fdx data` removes the gitignored DB and WAL/SHM sidecar files.

---

## Phase 1 boundaries (guardrails)

- **Local only.** Nothing here deploys, SSHes, or edits Caddy / live DBs / the hub.
- **No paid API calls, no real credentials.** All data is the mock seed; adapters
  are stubs.
- **No invented money/legal text.** Packages are fixed (Essential $99 / Preferred
  $249 / Total Home $499). "Sold" links to the existing Care Plan agreement page;
  this app does not re-author agreement copy.

Production promotion (Postgres, real keys, Caddy `/beats` route, hub card) is
documented in [`DEPLOY.md`](./DEPLOY.md) as **instructions** — it is performed
deliberately by a human, not by this build.
