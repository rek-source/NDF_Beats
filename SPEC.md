# NDF Beats — Build Spec (Phase 1, Local-Only)

**Status:** authoritative build contract. Parallel builders MUST stay within their owned files.
**One sentence:** iPad-first door-to-door Care Plan canvassing app — AI-scored "beats" (walkable target lists), per-door logging, live gamified scoreboard, D2D training — running entirely on SQLite + a mock seed, no paid APIs, no deploy.

---

## 0. GUARDRAILS (non-negotiable)

1. **LOCAL BUILD ONLY.** No deploy, no SSH, no edits to Caddy / live DBs / `/hub/`. Everything lives under `systems/ndf-beats/`.
2. **No paid API calls, no real credentials.** Tracerly / Zillow / Census are **stubbed** (`src/adapters/*.stub.js`) and never invoked at runtime. All data comes from the mock seed.
3. **Runnable with three commands:** `npm install && npm run seed && npm start`. Default `PORT=4178`, app served at `http://localhost:4178/`.
4. **Data layer abstracted.** All SQL goes through `src/db/repo.js` (the repository). No route handler or scoring file touches `better-sqlite3` directly. Production can later swap the repo impl to Postgres without changing routes, scoring, or frontend.
5. **No money/legal text invented.** Packages are fixed: **Essential $150 / Preferred $300 / Total Home $690** (annual; monthly-led $15/$30/$69 per mo). "Sold" links to the EXISTING agreement page; we do not re-author agreement copy.

---

## 1. Ownership model

Six owners. **Exactly one owner per file.** If a builder needs a change in a file they don't own, they request it via the interface — they do not edit it.

| Owner | Responsibility |
|-----------|----------------|
| **backend** | Express server, DB connection, repository, REST routes, KPI aggregation SQL, run scripts |
| **scoring** | Pure-JS scoring + geo-clustering + reweight stub (no DB, no HTTP, fully unit-testable) |
| **frontend** | Rep iPad SPA (map + list + door logging + sale → agreement hook + offline queue) |
| **scoreboard** | Scoreboard SPA (6 KPIs leaderboard + manager view) — consumes backend's scoreboard endpoint |
| **training** | D2D training curriculum page (static content from the design) |
| **docs** | README, deploy/run guide, this spec's living notes |

**Shared contracts (frozen here, in SPEC.md):** DB schema, REST JSON shapes, scoring function signatures, brand tokens. Changing a shared contract = edit SPEC.md + announce; never silently diverge.

---

## 2. File tree (ONE owner per file)

```
systems/ndf-beats/
├── SPEC.md                         (docs)      — this file
├── README.md                       (docs)      — run/deploy guide, env, troubleshooting
├── package.json                    (backend)   — deps + scripts (seed/start/test)
├── .gitignore                      (backend)   — node_modules, data/*.db
├── .env.example                    (backend)   — PORT, DB_PATH (no secrets)
│
├── src/
│   ├── server.js                   (backend)   — Express bootstrap, static mount, route wiring
│   ├── config.js                   (backend)   — reads env, package catalog constant, agreement URL
│   │
│   ├── db/
│   │   ├── schema.sql              (backend)   — DDL (section 4); applied by migrate.js
│   │   ├── connection.js           (backend)   — better-sqlite3 singleton, pragmas
│   │   ├── migrate.js              (backend)   — apply schema.sql (idempotent)
│   │   └── repo.js                 (backend)   — repository: ALL queries live here (data abstraction)
│   │
│   ├── routes/
│   │   ├── beats.routes.js         (backend)   — GET beats, GET beat+targets
│   │   ├── knocks.routes.js        (backend)   — POST knock
│   │   ├── sales.routes.js         (backend)   — POST sale
│   │   └── scoreboard.routes.js    (backend)   — GET scoreboard
│   │
│   ├── kpi/
│   │   └── scoreboard.service.js   (backend)   — aggregation logic feeding scoreboard route
│   │
│   ├── adapters/                               — STUBS ONLY, never called at runtime in Phase 1
│   │   ├── tracerly.stub.js        (backend)   — getProperty(addr) -> mock owner/property
│   │   ├── zillow.stub.js          (backend)   — getValue(addr) -> mock value
│   │   └── census.stub.js          (backend)   — getBlockGroup(lat,lng) -> mock income/age/occupancy
│   │
│   └── scoring/
│       ├── scoring.js              (scoring)   — scoreTarget(target, profile) -> 0..100
│       ├── beats.js                (scoring)   — clusterBeats(targets, size) -> beats[]
│       ├── reweight.js             (scoring)   — updateWeights(knocks, sales) -> profile  [STUB]
│       └── profile.js              (scoring)   — default Ideal-Client Profile + weights
│
├── scripts/
│   ├── seed.js                     (backend)   — generates ~600 targets, 4 reps, beats, knocks, sales
│   └── seed-data/
│       └── geo-bounds.js           (backend)   — county bounding boxes + city centroids for mock lat/lng
│
├── public/                                     — static SPA assets, no build step (CDN libs)
│   ├── index.html                  (frontend)  — rep iPad app shell
│   ├── app.js                      (frontend)  — map/list/door logging/offline queue
│   ├── offline.js                  (frontend)  — IndexedDB/localStorage queue + sync
│   ├── scoreboard.html             (scoreboard)— leaderboard + manager view shell
│   ├── scoreboard.js               (scoreboard)— fetch + render KPIs, live poll
│   ├── training.html               (training)  — D2D curriculum (content + brand)
│   ├── training.js                 (training)  — quiz interactions only (no backend)
│   └── styles/
│       ├── tokens.css              (frontend)  — KHB brand tokens + HIGH-CONTRAST outdoor variant
│       ├── app.css                 (frontend)  — rep app layout
│       ├── scoreboard.css          (scoreboard)— leaderboard layout
│       └── training.css            (training)  — curriculum layout
│
└── test/
    ├── scoring.test.js             (scoring)   — scoreTarget / clusterBeats unit tests
    └── api.test.js                 (backend)   — route contract tests against seeded DB
```

**Collision rule for `tokens.css`:** owned by **frontend**, but it is a *shared design contract* frozen in §10. scoreboard/training consume it read-only and add ONLY their own layout file. No one else edits `tokens.css`.

---

## 3. Runtime & deps

- Node >= 20. `package.json` scripts:
  - `seed`: `node src/db/migrate.js && node scripts/seed.js`
  - `start`: `node src/server.js`
  - `test`: `node --test test/`
- Deps: `express`, `better-sqlite3`. Dev: none required beyond Node's built-in test runner. **No frontend build tool** — Leaflet loaded via CDN in `index.html`.
- DB file: `data/ndf-beats.db` (gitignored). `DB_PATH` env overrides.

---

## 4. SQLite schema DDL  (`src/db/schema.sql` — frozen contract)

All money stored as **integer cents**. All timestamps stored as **ISO-8601 TEXT (UTC)**. Booleans as `INTEGER 0/1`. IDs are `TEXT` UUIDv4 (portable to Postgres; generated in app layer via `crypto.randomUUID()`).

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Canvassing reps
CREATE TABLE IF NOT EXISTS reps (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('rep','manager')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Scored homes (pre-scored from stubbed data; never live-looked-up in Phase 1)
CREATE TABLE IF NOT EXISTS targets (
  id              TEXT PRIMARY KEY,
  address         TEXT NOT NULL,
  city            TEXT NOT NULL,
  county          TEXT NOT NULL CHECK (county IN ('Stanislaus','San Joaquin','Merced')),
  zip             TEXT NOT NULL,
  lat             REAL NOT NULL,
  lng             REAL NOT NULL,
  value_cents     INTEGER NOT NULL,          -- estimated home value
  home_age        INTEGER NOT NULL,          -- years since built
  owner_occupied  INTEGER NOT NULL DEFAULT 1,-- 0/1
  tenure_years    INTEGER NOT NULL,          -- years current owner has held
  recently_sold   INTEGER NOT NULL DEFAULT 0,-- 0/1 sold in last ~18mo
  income_band     INTEGER NOT NULL,          -- ACS block-group income decile 1..10 (stub)
  score           INTEGER NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  no_soliciting   INTEGER NOT NULL DEFAULT 0,-- 0/1 flag, beats skip these
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_targets_geo   ON targets(lat,lng);
CREATE INDEX IF NOT EXISTS idx_targets_score ON targets(score DESC);

-- Walkable clusters of ~40-60 targets, sequenced
CREATE TABLE IF NOT EXISTS beats (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,               -- e.g. "Modesto NW - Beat 3"
  city          TEXT NOT NULL,
  county        TEXT NOT NULL,
  rep_id        TEXT REFERENCES reps(id),    -- nullable = unassigned
  status        TEXT NOT NULL DEFAULT 'ready'
                  CHECK (status IN ('ready','active','complete')),
  center_lat    REAL NOT NULL,
  center_lng    REAL NOT NULL,
  target_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_beats_rep ON beats(rep_id);

-- Ordered membership of targets within a beat (the walk sequence)
CREATE TABLE IF NOT EXISTS beat_targets (
  beat_id     TEXT NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES targets(id),
  seq         INTEGER NOT NULL,              -- 1-based walk order
  PRIMARY KEY (beat_id, target_id)
);
CREATE INDEX IF NOT EXISTS idx_beat_targets_seq ON beat_targets(beat_id, seq);

-- One row per door event (a knock outcome)
CREATE TABLE IF NOT EXISTS knocks (
  id            TEXT PRIMARY KEY,
  beat_id       TEXT NOT NULL REFERENCES beats(id),
  target_id     TEXT NOT NULL REFERENCES targets(id),
  rep_id        TEXT NOT NULL REFERENCES reps(id),
  disposition   TEXT NOT NULL CHECK (disposition IN
                  ('not_home','refused','callback','not_interested','sold')),
  answered      INTEGER NOT NULL DEFAULT 0,  -- 0/1; derived: not_home=0 else 1
  note          TEXT,
  client_uuid   TEXT UNIQUE,                 -- idempotency key from offline queue
  knocked_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_knocks_rep_time ON knocks(rep_id, knocked_at);
CREATE INDEX IF NOT EXISTS idx_knocks_disp     ON knocks(disposition);

-- A sale, always tied to the knock that produced it
CREATE TABLE IF NOT EXISTS sales (
  id            TEXT PRIMARY KEY,
  knock_id      TEXT NOT NULL UNIQUE REFERENCES knocks(id),
  rep_id        TEXT NOT NULL REFERENCES reps(id),
  target_id     TEXT NOT NULL REFERENCES targets(id),
  package       TEXT NOT NULL CHECK (package IN ('essential','preferred','total_home')),
  amount_cents  INTEGER NOT NULL,            -- 15000 / 30000 / 69000
  agreement_url TEXT,                         -- link opened for e-sign
  client_uuid   TEXT UNIQUE,                 -- idempotency key from offline queue
  sold_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_rep_time ON sales(rep_id, sold_at);
```

**Package catalog (`src/config.js` constant, not a table — fixed by policy):**
```
essential   -> { label: "Essential",  amount_cents: 15000 }
preferred   -> { label: "Preferred",  amount_cents: 30000 }
total_home  -> { label: "Total Home", amount_cents: 69000 }
```
Agreement URL base (config): `/gbb/ndf/agreements/home-care-membership.html` (link target only; not fetched by backend).

---

## 5. REST API contracts (frozen)

Base path `/api`. JSON in/out. Errors: `{ "error": "message" }` with appropriate 4xx/5xx. Money in responses is returned as **dollars (number, 2dp)** under `_usd` keys for the frontend; raw cents retained where noted.

### 5.1 List beats for a rep
```
GET /api/reps/:repId/beats
200 ->
{
  "rep": { "id": "...", "name": "Maria Delgado" },
  "beats": [
    {
      "id": "beat_...", "name": "Modesto NW - Beat 3",
      "city": "Modesto", "county": "Stanislaus",
      "status": "active", "target_count": 52,
      "center": { "lat": 37.66, "lng": -121.03 },
      "progress": { "knocked": 18, "remaining": 34 }
    }
  ]
}
404 -> { "error": "rep not found" }
```

### 5.2 Get a beat with ordered targets
```
GET /api/beats/:beatId
200 ->
{
  "beat": {
    "id": "beat_...", "name": "Modesto NW - Beat 3",
    "city": "Modesto", "county": "Stanislaus", "status": "active",
    "center": { "lat": 37.66, "lng": -121.03 }
  },
  "targets": [
    {
      "seq": 1,
      "id": "tgt_...", "address": "1423 Maple Ave", "city": "Modesto", "zip": "95350",
      "lat": 37.661, "lng": -121.031,
      "value_usd": 412000, "home_age": 34, "owner_occupied": true,
      "tenure_years": 9, "score": 87, "no_soliciting": false,
      "last_disposition": "callback"   // null if never knocked
    }
  ]
}
404 -> { "error": "beat not found" }
```

### 5.3 Log a knock (disposition)
```
POST /api/knocks
body ->
{
  "beat_id": "beat_...", "target_id": "tgt_...", "rep_id": "rep_...",
  "disposition": "not_home|refused|callback|not_interested|sold",
  "note": "optional string",
  "client_uuid": "client-generated UUID for idempotency",
  "knocked_at": "2026-06-15T17:22:03.000Z"   // optional; server time if omitted
}
201 ->
{
  "knock": {
    "id": "knock_...", "disposition": "callback", "answered": true,
    "knocked_at": "..."
  }
}
// Idempotent: replaying same client_uuid returns 200 with the existing knock.
400 -> { "error": "invalid disposition" }
```
`answered` is derived server-side: `disposition === 'not_home' ? 0 : 1`.
A `sold` disposition does NOT auto-create a sale — the client follows with POST /api/sales referencing the returned knock id.

### 5.4 Record a sale
```
POST /api/sales
body ->
{
  "knock_id": "knock_...",            // must exist and be disposition 'sold'
  "package": "essential|preferred|total_home",
  "client_uuid": "client-generated UUID",
  "sold_at": "2026-06-15T17:25:00.000Z"  // optional
}
201 ->
{
  "sale": {
    "id": "sale_...", "package": "preferred",
    "amount_usd": 300, "amount_cents": 30000,
    "agreement_url": "/gbb/ndf/agreements/home-care-membership.html?pkg=preferred&target=tgt_...",
    "sold_at": "..."
  }
}
// amount_cents is derived from the package catalog (server-authoritative; client cannot set price).
// agreement_url is built server-side from config base + pkg + target query params.
400 -> { "error": "knock not in 'sold' state" }
409 -> { "error": "sale already exists for knock" }
```

### 5.5 Scoreboard (the 6 KPIs)
```
GET /api/scoreboard?period=today|week|month   (default today)
200 ->
{
  "period": "today",
  "generated_at": "2026-06-15T18:00:00.000Z",
  "team": {
    "doors_knocked": 412,
    "doors_answered": 168,
    "answer_rate": 0.408,            // doors_answered / doors_knocked (0..1)
    "yeses": 22,                     // count of disposition='sold'
    "nos": 61,                       // refused + not_interested
    "avg_sale_usd": 263.18,          // mean sales.amount over period (0 if none)
    "top_package": "preferred"       // most frequent package; null if no sales
  },
  "leaderboard": [
    {
      "rep_id": "rep_...", "name": "Maria Delgado", "rank": 1,
      "doors_knocked": 121, "doors_answered": 55, "answer_rate": 0.455,
      "yeses": 9, "nos": 14, "avg_sale_usd": 281.00, "top_package": "preferred"
    }
    // ... one row per active rep, sorted by yeses desc then answer_rate desc
  ]
}
```
KPI definitions (authoritative, computed in `src/kpi/scoreboard.service.js`):
- **doors_knocked** = count(knocks) in period
- **doors_answered** = count(knocks where answered=1); **answer_rate** = answered/knocked (0 if knocked=0)
- **yeses** = count(knocks where disposition='sold')
- **nos** = count(knocks where disposition IN ('refused','not_interested')) [callback & not_home are neither yes nor no]
- **avg_sale_usd** = avg(sales.amount_cents)/100 in period (0 if no sales)
- **top_package** = package with max count in period (ties -> highest amount; null if none)
- Period windows are computed in **America/Los_Angeles** (NDF's market) and converted to UTC for the SQL range. today = local midnight→now; week = Monday 00:00 local; month = 1st 00:00 local.

---

## 6. Scoring contract (`src/scoring/*`, pure JS, no DB/HTTP)

### 6.1 `scoring.js`
```js
/**
 * @param {Object} target  - { value_cents, home_age, owner_occupied(0|1),
 *                             tenure_years, recently_sold(0|1), income_band(1..10) }
 * @param {Object} profile - Ideal-Client Profile (see profile.js): bands + weights
 * @returns {number} integer 0..100
 */
export function scoreTarget(target, profile)
```
Heuristic: each signal yields a 0..1 sub-score, multiplied by its weight; weights sum to 1; result * 100, rounded, clamped 0..100. Signals: value-in-band, home-age sweet spot (older home = more maintenance need), owner-occupied (strong +), tenure (longer = stickier), recently-sold (new owners buy), income band. Deterministic, no randomness.

### 6.2 `beats.js`
```js
/**
 * Geo-cluster scored targets into walkable beats of ~size doors, sequenced.
 * @param {Array} targets - target rows incl. {id,lat,lng,score,no_soliciting}
 * @param {number} size    - desired doors per beat (default 50, range 40..60)
 * @returns {Array} beats: [{ name, city, county, center:{lat,lng},
 *                            targets:[{target_id, seq}], target_count }]
 */
export function clusterBeats(targets, size = 50)
```
Approach: drop `no_soliciting`; grid/greedy-nearest cluster by lat/lng into groups of `size` (40–60), prefer higher-score homes first; within a beat, sequence by nearest-neighbor walk from the cluster's NW-most point. Pure + deterministic given input order.

### 6.3 `reweight.js` (STUB — Phase 2 interface)
```js
/**
 * STUB. Phase 2: learn which signals convert and return an updated profile.
 * Phase 1: returns the input profile unchanged (no learning) + logs a notice.
 * @param {Array} knocks - knock rows w/ target signals + disposition
 * @param {Array} sales  - sale rows
 * @param {Object} profile - current profile
 * @returns {Object} profile (unchanged in Phase 1)
 */
export function updateWeights(knocks, sales, profile)
```
Must export the real signature now so Phase 2 swaps the body without touching callers.

### 6.4 `profile.js`
Exports `defaultProfile` — the editable Ideal-Client Profile: value band [min,max], home-age sweet spot, weights object (sums to 1), income-band target. Single source the seed + scoring import.

---

## 7. Frontend contract — Rep iPad SPA (`public/index.html`, `app.js`, `offline.js`)

- **iPad-first**, landscape, single page. Leaflet via CDN (`unpkg.com/leaflet`). No bundler.
- **Layout:** left ~60% Leaflet map, right ~40% ordered address list (scrollable). Header: rep name + beat name + today's mini-KPIs (knocked / answered / sold) + link to Scoreboard and Training.
- **Pins status-colored** (use brand high-contrast palette §10): unknocked=ink outline, not_home=muted, callback=bronze, refused/not_interested=red-700, sold=green-700. Tapping a pin or a list row opens the **door sheet**.
- **Door sheet** (big, glove-friendly, min 64px touch targets): address + score + score factors; five big disposition buttons in fixed order: **Not home / Refused / Callback / Not interested / Sold**.
  - Non-sold tap → POST `/api/knocks` (queued if offline), sheet closes, pin recolors, list auto-advances to next `seq`.
  - **Sold** tap → POST knock(disposition=sold) → show **package picker** (Essential $150 / Preferred $300 / Total Home $690) → POST `/api/sales` → on success open `sale.agreement_url` (the existing Care Plan agreement page) in a new tab/window for e-sign + first-visit booking.
- **Offline tolerance (`offline.js`):** every knock/sale is written to a local queue (localStorage or IndexedDB) with a `client_uuid` BEFORE network attempt; a sync loop flushes the queue when online; server idempotency on `client_uuid` makes replays safe. Visible queue badge ("3 pending"). **Note in README:** Phase 1 offline is best-effort queue+replay; no service worker / no true offline map tiles.
- Data flow: on load → GET rep's beats → pick active beat → GET beat+targets → render. All writes go through the queue module.
- Reads brand from `styles/tokens.css` + `styles/app.css`. Defaults to the HIGH-CONTRAST variant (outdoor sunlight).

---

## 8. Scoreboard page contract (`public/scoreboard.html`, `scoreboard.js`, `scoreboard.css`)

- Consumes ONLY `GET /api/scoreboard?period=`. Period toggle: Today / Week / Month.
- **Gamified leaderboard:** ranked rep cards (rank medal, name, the 6 KPIs as big numerals, answer-rate as a bar, sold count emphasized). Live poll every 20s; subtle count-up animation on change; top rep highlighted in bronze.
- **Manager view** (toggle/tab): team rollup tile (all 6 team KPIs) + a conversion funnel (knocked → answered → sold) + per-rep table. (Beat approval / coverage % are noted as Phase-2 placeholders — render disabled tiles, do not fake data.)
- Reads `tokens.css` (read-only) + own `scoreboard.css`. High-contrast variant available; scoreboard may use the standard ivory variant (indoor screen) — switchable via a `data-theme` attr on `<html>`.

---

## 9. Training page contract (`public/training.html`, `training.js`, `training.css`)

Static KHB-branded curriculum (content sourced from the design doc §"Training module"). Sections, in order:
1. **Why Care Plans** — value framing + **strict no-discount** language (priority/included services, never % off / member rate — per NDF policy).
2. **The 5-step door approach** — approach, pattern interrupt, value pitch, trial close, book.
3. **Pitch script** — the three packages ($150 / $300 / $690) framed by value, not price.
4. **Objection handling** — price / "I'll DIY" / "ask my spouse" / "not interested," with scripted responses.
5. **CA compliance** — solicitation rules + **3-day right-to-cancel** notice requirement (informational; do not reproduce legal text from agreements — link to the agreement page).
6. **Role-play scenarios** + **ride-along checklist**.
7. **Certification quiz** — multiple-choice, `training.js` scores client-side (no backend), pass = 80%.

No backend calls. Reads `tokens.css` (read-only) + own `training.css`.

---

## 10. Brand contract — `public/styles/tokens.css` (frozen; owned by frontend)

KHB family tokens (sharp corners, Fraunces/Inter) PLUS a high-contrast outdoor variant. Builders import this file; do not redefine tokens elsewhere.

```css
:root {
  /* KHB standard (indoor) */
  --bg:#FAF8F5; --ink:#1A1A1A; --ink-dark:#161412;
  --bronze:#8C6A4A; --bronze-dark:#A88560;
  --hairline:#E5DFD5; --muted:#6B6760; --ivory:#F0EBE3;
  --ok:#2F7D4F; --warn:#B45309; --bad:#B91C1C;   /* status pins */
  --radius:0;                                     /* sharp corners everywhere */
  --font-display:'Fraunces',Georgia,serif;
  --font-body:'Inter',system-ui,sans-serif;
}
/* HIGH-CONTRAST outdoor variant for iPad in sunlight */
:root[data-theme="hc"] {
  --bg:#FFFFFF; --ink:#000000; --ink-dark:#000000;
  --bronze:#6B4A2A; --bronze-dark:#4A3320;       /* darker = AAA contrast */
  --hairline:#000000; --muted:#333333; --ivory:#F2F2F2;
  --ok:#0A6B2F; --warn:#8A4B00; --bad:#A30000;
}
```
Rules: border-radius 0 everywhere; 1px hairline borders, no soft shadows; em-dash "—" bronze list bullets; links = ink text + bronze underline (3px offset); load Fraunces + Inter via Google Fonts CDN; **WCAG AA minimum, AAA targeted in `hc` variant** (the rep app defaults to `data-theme="hc"`). Touch targets >= 64px in the rep app.

---

## 11. Mock seed contract (`scripts/seed.js` + `seed-data/geo-bounds.js`)

Runs offline, deterministic (seeded PRNG so reruns are stable). Produces a non-empty scoreboard.

- **~600 targets** across **Stanislaus / San Joaquin / Merced**, distributed over real cities with plausible lat/lng inside county bounding boxes / city centroids (`geo-bounds.js`): Modesto, Turlock, Ceres, Oakdale (Stanislaus); Stockton, Manteca, Tracy, Lodi (San Joaquin); Merced, Atwater, Los Banos (Merced).
  - `value_cents`: log-normal-ish $250k–$750k (Central Valley realistic), integer cents.
  - `home_age`: 5–70 yrs. `owner_occupied`: ~75% true. `tenure_years`: 0–30. `recently_sold`: ~12% true. `income_band`: 1–10 weighted mid. `no_soliciting`: ~4% true.
  - `score`: computed by importing `scoring.scoreTarget(target, defaultProfile)` — seed does NOT hardcode scores.
- **4 reps**: 3 `role='rep'`, 1 `role='manager'`. Stable names/emails (e.g. maria@, deshawn@, priya@, manager carlos@).
- **Beats**: generate via `scoring.clusterBeats(topTargets, 50)` from the highest-scored targets; create ~6–8 beats, assign ~2 each to the 3 reps, leave 1–2 `ready`/unassigned. Populate `beat_targets` with seq.
- **Sample knocks/sales**: simulate a partial day for the assigned beats — for each rep walk part of a beat producing a realistic disposition mix (~40% not_home, ~15% refused, ~10% callback, ~20% not_interested, ~15% sold). Each `sold` knock gets a `sales` row with a weighted package mix (Essential 40% / Preferred 40% / Total Home 20%) so `avg_sale_usd` and `top_package` are non-trivial. Spread `knocked_at`/`sold_at` across today, earlier this week, and earlier this month so all three scoreboard periods return data.
- Seed must use the repo layer (`repo.js`) for inserts — not raw SQL — to keep the data abstraction honest.

---

## 12. Definition of done

- `npm install && npm run seed && npm start` works on a clean checkout; app at `http://localhost:4178/`.
- All 5 REST endpoints return the exact shapes in §5 against seeded data; scoreboard non-empty for today/week/month.
- Rep app: load beat, log all five dispositions, complete a Sold flow that opens the agreement URL; offline queue badge works (toggle network off → log → back on → flush).
- `node --test test/` passes (scoring units + API contract).
- Zero direct `better-sqlite3` references outside `src/db/`. Zero adapter stub calls at runtime. No network calls to any external host except CDN asset loads in the browser.

---

## 13. Builder coordination summary

- **backend** owns the running system: server, DB, repo, routes, KPI, adapters (stubs), seed scripts, `package.json`.
- **scoring** owns four pure files; exports the three frozen signatures in §6; no DB/HTTP.
- **frontend** owns the rep app + `tokens.css` (the frozen brand contract) + `app.css`.
- **scoreboard** owns the scoreboard page; consumes §5.5 only; read-only on `tokens.css`.
- **training** owns the curriculum page; static; read-only on `tokens.css`.
- **docs** owns README + this spec.
- Frozen interfaces (do not diverge without editing SPEC.md): §4 schema, §5 REST shapes, §6 scoring signatures, §10 brand tokens.
