# NDF Beats — overnight polish log

One entry per iteration of the overnight polish loop. Newest first.

---

## 2026-07-22 — Door-sheet data-coverage hint (resolves the deferred #2 decision)

**Backlog item 2, last clause — Ryan approved the design** (simple wording,
inline, mobile-optimized). A sub-35 Ideal-Client score is *correct* — it's scaled
by how many signals we actually know — but reps read a low number as "broken".
The sheet now shows an inline **"N of 7 signals"** hint next to the score
(wraps under it on a phone; muted so it reads as context, not an alarm), with a
tooltip: "This score uses the N property signals we actually know for this
door. A low number here means limited data — not a bad door."

Honest by construction: the count comes from each target's `known_signals`
(the same record the scorer uses), via a new `knownSignalCount()` in
`beats.routes.js` that sends `signals_known` (null for legacy rows) +
`signals_total` (= `SIGNAL_KEYS.length`). The hint is **hidden** when every
signal is known (score is fully informed) or when coverage is unknown — never
invented. Verified on the live DB: the 356 active project-beat doors carry 2/7
coverage (so the hint shows there), while 590 legacy rows have null (hint hides).

New `test/door-coverage.test.js` runs the real bundle: a 2/7 door shows
"2 of 7", a 7/7 door hides the hint. Bumped `app.js r10→r11`, `app.css r8→r9`.

- Files: `src/routes/beats.routes.js`, `public/index.html`, `public/app.js`,
  `public/styles/app.css`, `test/door-coverage.test.js`.
- Suite: 339 → 341 tests, all green.
- Commit: `43f7bab`
- **Needs deploy?** Yes — backend + frontend (part of the deploy batch below).

---

## 2026-07-22 — Cover the non-retryable Overpass error (final iteration; loop stopped)

**Backlog item 5 (final).** Closing the last cheap `addresses.js` gap: a
non-retryable Overpass error (e.g. HTTP 400 — not in the 429/504 retry set) must
`throw` immediately so an ingest run fails **loudly** rather than silently
returning zero doors and building an empty beat. Added a case to
`test/addresses-city.test.js`: fetch returns 400 → `getCandidateAddresses`
rejects with `/Overpass HTTP 400/` (no backoff/sleep, so the test is fast).

`addresses.js` coverage: line **93.36% → 96.21%**, branch **81% → 85%**. The only
remaining gap (112-119) is the 429/504 retry+backoff loop, which sleeps
2–8 s per attempt — too slow/flaky for the suite without a fake-timer seam;
intentionally left.

- Files: `test/addresses-city.test.js`.
- Suite: 338 → 339 tests, all green.
- Commit: `304f68e`
- **Needs deploy?** No — tests only.

### Loop stopped here (Ryan: "stop after this next loop")
19 iterations over the night. Summary for the morning:

- **Backlog #1–4 (features, need deploy):** stale pricing aligned; door-sheet
  honesty display (also fixed a **latent bug** — the honesty fields never
  reached the client); manager-portal beat rename UI; KHB proximity band in the
  profile card; per-field Create-a-Beat validation.
- **#6 (need deploy):** scoreboard + training touch targets to the 64px iPad
  floor; layout CSS audited — already brand-token-consistent.
- **#5 + #7:** coverage sweep took every substantive source file to ~90–100%
  (census, addresses, assessor, profile, sales/knocks routes, migration ALTER,
  server error handler) and single-sourced three duplicated write-route helpers
  (`isUniqueViolation`, `normalizeTimestamp`, `shapeSale`). Suite 275 → 339.
- **Deploy batch:** all frontend changes have their `?v=` cache-busts bumped;
  backend refactors are behavior-preserving. See each entry's "Needs deploy" line.
- **Needs Ryan (decision):** the optional sub-35 "data coverage" hint on the door
  sheet — needs a UX wording/placement call (see the door-honesty entry).
- **Intentionally-left gaps:** CLI boot shims, the Overpass retry/backoff loop,
  and the write-route unique-constraint race-recovery paths — all need a
  fault-injection / fake-timer seam; not worth contriving.

Master is green (339/339) and clean. `git log` since `d299854` has every change.

---

## 2026-07-22 — Cover the app-level error handler (no HTML stack traces to reps)

**Backlog item 5 (continued).** `server.js`'s centralized error handler is the
last line of defense — any throwing middleware/route must return the JSON
envelope `{error:'internal server error'}`, never leak an HTML stack trace to
the rep app. It was uncovered. Because `express.json()` is the **first**
middleware, a malformed JSON body throws a parse error that propagates straight
to the handler — a deterministic trigger needing no route or auth.

New `test/server-error-handler.test.js` (own throwaway DB + server) POSTs an
invalid JSON body to `/api/knocks` and asserts a **500** with an
`application/json` content-type and the exact `{error:'internal server error'}`
envelope.

`server.js` coverage: line **84.29% → 88.57%**. The remaining lines (63-70) are
the `import.meta.url === argv[1]` CLI boot block (`getDb()` + `listen`) — runs
only when the file is the entry script, not on import; not worth a test (same
category as migrate's CLI shim).

- Files: `test/server-error-handler.test.js`.
- Suite: 337 → 338 tests, all green.
- Commit: `7773fd0`
- **Needs deploy?** No — tests only.

### Note — coverage sweep wrapping up
- Every substantive source file is now ~90–100% covered. The only remaining gaps
  are non-behavioral or fault-injection-only: CLI boot shims (`server.js` 63-70,
  `migrate.js` 90-93), network retry/backoff (`addresses.js` overpass loop), the
  write-route unique-constraint **race-recovery** paths, and corrupt-persisted-
  profile fallbacks. Each needs a concurrency/fault seam; not worth contriving.
  Future iterations should lean toward JSDoc accuracy / dead-code (backlog #7)
  or a fresh feature-polish item rather than chasing these.

---

## 2026-07-22 — Cover the additive-migration ALTER path (prod-upgrade mechanism)

**Backlog item 5 (continued).** `ensureColumn` → `ALTER TABLE ADD COLUMN` is how
a migration upgrades a **live** DB in place — the exact thing that runs against
prod on deploy. But on a fresh schema every column already exists (schema.sql),
so that ALTER branch never fired in the existing migrate tests (they only proved
idempotency on an already-current DB). It was uncovered — the riskiest kind of
untested code for a live app.

New `test/migrate-additive.test.js` simulates a **pre-migration `reps`** (an old
table shaped before the PIN/token columns) with a legacy row, runs `migrate()`,
and asserts: all six identity columns get added, the existing row survives, and
NOT-NULL-DEFAULT columns backfill (`pin_attempts=0`, `token_version=1`) while
nullable ones stay null — then re-running migrate is idempotent (no
duplicate-column error).

`migrate.js` coverage: line **93.55% → 95.70%**, branch **75% → 87.5%**. The
last uncovered lines (90-93) are the `import.meta.url === argv[1]` CLI shim — it
only runs when the file is executed directly, not on import; not worth a test.

- Files: `test/migrate-additive.test.js`.
- Suite: 335 → 337 tests, all green.
- Commit: `d584d4d`
- **Needs deploy?** No — tests only.

---

## 2026-07-22 — Cover the assessor parcel lookup (never-throws enrichment)

**Backlog item 5 (continued).** `lookupParcel` is the free county-assessor
enrichment (extra home value + age at ingest). Like `getDemographics` it must
**never throw** — ingestion continues without the extra fields when a county has
no free endpoint or the ArcGIS service is down. Existing tests covered
`parseAssessorFeature`; `lookupParcel` itself (assessor.js's biggest gap) was
untested. New `test/assessor-lookup.test.js` (fetch stubbed):

- `freeAssessorCounties()` lists exactly the free-endpoint counties;
- an unsupported county (Stanislaus) returns null **without any fetch**;
- a valid ArcGIS feature parses to `value_cents` (land + improvement) + age;
- HTTP 500, an ArcGIS `error` payload, and empty `features` each degrade to null.

`assessor.js` coverage: line **80.56% → 100%**, branch **80% → 94.74%**, funcs
**80% → 100%**. Tests only.

- Files: `test/assessor-lookup.test.js`.
- Suite: 331 → 335 tests, all green.
- Commit: `f3ebc4f`
- **Needs deploy?** No — tests only.

---

## 2026-07-22 — Cover the per-city address pull (addresses.js)

**Backlog item 5 (continued).** `addresses.js` was the weakest source file
(76.78% line / 44% funcs): only `getAddressesNearPoint` (the radius pull) had a
test, so `countyForCity`, `getCandidateAddresses` (the per-city pull), and
`buildQuery` were all uncovered. New `test/addresses-city.test.js` (fetch
stubbed, never hits Overpass):

- `countyForCity` resolves every in-area city to its county and rejects
  out-of-area / undefined → null;
- `getCandidateAddresses('San Francisco')` **rejects** before any fetch
  (service-area guard);
- a mocked Overpass response drives the happy path: the query scopes to
  California + the named city, and elements normalize/dedupe (duplicate door
  dropped, street-less junk dropped, fallback city applied, missing ZIP stays
  null for ingestion to backfill).

`addresses.js` coverage: line **76.78% → 93.36%**, funcs **44% → 77.78%**,
branch **76% → 81%**. Tests only.

- Files: `test/addresses-city.test.js`.
- Suite: 328 → 331 tests, all green.
- Commit: `b0c7c7c`
- **Needs deploy?** No — tests only.

### Note
- The last addresses.js gap (109-123) is the `overpass()` 429/504 retry+backoff
  loop — network timing behavior; a deterministic test needs a fetch mock that
  returns a rate-limit status then succeeds. Deferred (same family as the route
  race-recovery seam).

---

## 2026-07-22 — Cover validateProfile's four rejection branches

**Backlog item 5 (continued).** `validateProfile` is the fail-loud guard on the
ICP scoring weights — a malformed profile must throw at startup / on approval
rather than silently produce garbage scores. But every existing caller passes it
a **valid** profile, so all four rejection branches were uncovered (profile.js
was at 42.86% branch). New `test/profile-validate.test.js` pins each throw:
non-object profile, missing/non-object `weights`, a weight that isn't a
non-negative number (NaN / negative / missing / non-number), and weights that
don't sum to 1 — plus the success chaining return.

`profile.js` coverage: line **94.15% → 100%**, branch **42.86% → 100%**, funcs
100%. Tests only, no source change.

- Files: `test/profile-validate.test.js`.
- Suite: 323 → 328 tests, all green.
- Commit: `86c033f`
- **Needs deploy?** No — tests only.

---

## 2026-07-22 — Dedupe the sale serializer (shapeSale) across sale entry points

**Backlog item 7 (dedupe) + item 5 (coverage).** The `/api` sale response shape
was written twice — `shapeSale` in `sales.routes.js` and an identical
`shapeManualSale` in `knocks.routes.js` (the manual walk-in-sale path). Two sale
entry points serializing independently is exactly how a field silently drifts
(e.g. one gains `amount_usd` rounding and the other doesn't).

Extracted the single shape to `src/routes/serializers.js` and used it in both
routes (removing `shapeSale` from sales and `shapeManualSale` from knocks; both
call sites now call the shared `shapeSale`). New `test/serializers.test.js` pins
the contract: exposes `id/package/amount_cents/agreement_url/sold_at` plus a
derived `amount_usd` (= cents / 100), and does **not** leak internal columns
(`knock_id`, `rep_id`, `target_id`, `client_uuid`). Output is byte-identical to
both originals, so the manual-knock and sales flows are unchanged.

- Files: `src/routes/serializers.js` (new), `src/routes/sales.routes.js`,
  `src/routes/knocks.routes.js`, `test/serializers.test.js` (new).
- Suite: 321 → 323 tests, all green.
- Commit: `14391b5`
- **Needs deploy?** Yes — backend refactor (behavior-preserving); Ryan batches it.

---

## 2026-07-22 — Dedupe normalizeTimestamp into a shared, tested util

**Backlog item 7 (dedupe) + item 5 (coverage).** Same pattern as the previous
iteration: `normalizeTimestamp` was copy-pasted **byte-for-byte** in
`sales.routes.js` and `knocks.routes.js` (the latter used by both the beat and
manual-knock handlers). Its fallback branch — a bad/non-string client timestamp
degrading to server time — was thinly exercised and never asserted directly.

Extracted to `src/util/time.js` (new `src/util/` home for cross-cutting
helpers), imported in both routes, deleted the copies. New
`test/util-time.test.js` asserts the contract: a parseable client ISO string is
honored (normalized to UTC ISO), and anything unusable (unparseable string,
non-string, empty) falls back to a valid server-time ISO — so a knock/sale
always records a real timestamp even from a device with a broken clock.

- Files: `src/util/time.js` (new), `src/routes/sales.routes.js`,
  `src/routes/knocks.routes.js`, `test/util-time.test.js` (new).
- Suite: 319 → 321 tests, all green.
- Commit: `fc3d6fa`
- **Needs deploy?** Yes — backend refactor (behavior-preserving); Ryan batches it.

---

## 2026-07-22 — Dedupe isUniqueViolation into a shared, tested util

**Backlog item 7 (dedupe) + item 5 (coverage).** `isUniqueViolation` was
copy-pasted **byte-for-byte** in both `sales.routes.js` and `knocks.routes.js`,
and only reachable through a hard-to-trigger write race — so it sat uncovered in
both files (the recurring "race-recovery" note in the last two entries).

Extracted it to `src/db/errors.js` (one definition), imported it in both routes,
and deleted the two local copies. Now it's directly unit-testable without a
concurrency seam: new `test/db-errors.test.js` covers the whole classifier —
any `SQLITE_CONSTRAINT*` code → true, other sqlite codes → false, and
missing/non-string code or null/undefined → false. Wrapped the return in
`Boolean(...)` so it's always a strict boolean (the old versions returned the
falsy `err` itself); the call sites only use it in a boolean `if`, so behavior
is unchanged.

- Files: `src/db/errors.js` (new), `src/routes/sales.routes.js`,
  `src/routes/knocks.routes.js`, `test/db-errors.test.js` (new).
- Suite: 316 → 319 tests, all green.
- Commit: `6019950`
- **Needs deploy?** Yes — backend (route refactor; behavior-preserving). Ryan
  batches it; no rush since behavior is identical.

---

## 2026-07-22 — Cover the knocks-route missing-fields validation branch

**Backlog item 5 (continued).** `POST /api/knocks` returns 400
`"beat_id and target_id are required"` when either id is absent — but that
branch (knocks.routes.js:57-59) had no test; only the invalid-disposition and
not-found branches were asserted. Added both cases (missing `beat_id`, missing
`target_id`) to the existing 5.3 knock test, each sending a valid disposition so
it clears the disposition gate and actually reaches the required-fields check.
`knocks.routes.js` branch coverage **81.82% → 83.33%**, line **92.66% →
93.58%**. Behavior-only, no source change.

- Files: `test/api.test.js`.
- Suite: 316 tests (assertions added to an existing test), all green.
- Commit: `729dba1`
- **Needs deploy?** No — tests only.

### Note
- The last knocks.routes.js gap (83-89, 212-218) is the same unique-constraint
  **race-recovery** path flagged for `sales.routes.js` — both share the
  `isUniqueViolation` re-check idiom and both need a fault-injection seam to test
  deterministically. A single future pass could add that seam and cover both.

---

## 2026-07-22 — Cover census.js error/fallback branches (never-throw contract)

**Backlog item 5 (continued).** `getDemographics` promises to *always resolve* —
ingestion must keep running when the keyless geocoder or ACS endpoint misbehaves
— but every degradation path was untested (census.js was the codebase's weakest
file). New `test/census-fallback.test.js` mocks `fetch` per branch and pins the
never-throw contract:

- geocoder HTTP 500 → neutral demographics, `tract_geoid: null`;
- empty geocoder result → `geocodeTract` returns null → neutral;
- ACS returns non-JSON (a redirect/HTML key error) → ACS parse throws, caught →
  neutral, but the geocoded `tract_geoid` survives;
- ACS header-only (no data row) → neutral;
- ACS null-income sentinel (`-666666666`) → neutral even though a row exists;
- `hasCensusKey()` reflects the configured key.

`census.js` coverage: line **89.35% → 100%**, branch **40% → 83.33%**, funcs
**83% → 100%**. The happy path stays covered by `census-acs.test.js`. Tests only.

- Files: `test/census-fallback.test.js`.
- Suite: 310 → 316 tests, all green.
- Commit: `2c82e46`
- **Needs deploy?** No — tests only.

---

## 2026-07-22 — Unit-cover incomeToBand (scoring input) + brand-token audit

**Backlog item 6 (brand tokens) → item 5 (coverage).** Started on backlog #6's
"consistency with brand tokens" and audited every layout CSS file for raw hex
that should be a token. Finding: the layout CSS is **already token-consistent** —
`app.css` / `scoreboard.css` have zero raw hex; `training.css`'s hex are all
`var(--token, #hex)` fallbacks (token wins, `tokens.css` loads first); and
`admin.css`'s three raw-hex spots are *intentional and documented* (a
surface-local `--muted` AA lift, and HC-theme-only mid-greys for the weight
bars). Nothing to change without inventing churn — recorded and moved on.

Pivoted to the next real coverage gap (#5): `census.js` had the codebase's worst
branch coverage (28.57%). `incomeToBand` — a scoring input feeding
`signals.income_band` — was exported but had **no direct test**; the "neutral on
bad input → 5" guard and the top-band (`return 10`) branch were uncovered. New
`test/income-band.test.js` pins the full decile map: bad/missing → 5, each
threshold (upper-bound inclusive) → bands 1–9, above-all → 10, plus a mid-band
case. `census.js` branch coverage **28.57% → 40.00%**, line 48 now covered.

- Files: `test/income-band.test.js`.
- Suite: 306 → 310 tests, all green.
- Commit: `ad3d325`
- **Needs deploy?** No — tests only.

### Note (next iteration)
- `census.js`'s remaining uncovered lines (92-160) are the keyless-geocoder and
  ACS HTTP paths (error branches, missing-field fallbacks). They need `fetch`
  mocking per branch — the existing `census-acs.test.js` mocks one happy path.
  A focused fetch-mock pass could lift them.

---

## 2026-07-22 — Training quiz touch targets to the 64px iPad floor

**Backlog item 6 (training).** The certification quiz is taken on an iPad, but
its two interactive control types sat below the 64px touch floor the rep app,
scoreboard, and now this page share: each answer row (`.quiz-q .choice`) was
only ~39px tall for a single-line option, and the action buttons (`.btn` —
"Grade my quiz", "Reset", "Print certificate") were ~45px.

Raised `.quiz-q .choice` to `min-height: 64px` (the whole row is the tap area)
and `.btn` to `min-height: 64px` with `display: inline-flex` + centering so the
floor is a real hit area for both `<button>` and `<a class="btn">`.
Colors/typography untouched — `tokens.css` frozen, layout file only. Added a
`training.css?v=t1` cache-bust (was untokenized), still a relative path.

New `test/training-touch-targets.test.js` mirrors the scoreboard/admin CSS-scan
convention. Watched fail (2) → pass.

- Files: `public/styles/training.css`, `public/training.html`,
  `test/training-touch-targets.test.js`.
- Suite: 304 → 306 tests, all green.
- Commit: `14c7103`
- **Needs deploy?** Yes — frontend (training.css + new cache-bust).

---

## 2026-07-22 — Scoreboard touch targets to the 64px iPad floor

**Backlog item 6.** The scoreboard's tappable header controls sat below the
64px touch floor the rep app (`app.css`) already honors for field surfaces: the
view tabs and period toggles (`.sb-tab` / `.sb-period`) were `min-height: 40px`,
and the refresh button (`.sb-live__refresh`) was a 32×32px square. On an iPad
(and even on a wall display someone walks up to), those are easy to miss.

Raised `.sb-tab` / `.sb-period` to `min-height: 64px` and made the refresh a
`min-width/min-height: 64px` square, each `display: inline-flex` + centered so
the min-size is a real hit area, not just a tall box. Colors/typography
untouched — `tokens.css` stays frozen; only the layout file changed.

New `test/scoreboard-touch-targets.test.js` mirrors the `admin-touch-targets`
CSS-scan convention (parses the rule body, asserts `min-height`/`min-width`
≥ 64px). Watched fail (3) → pass. The scoreboard assets had **no** cache-bust
token; added `scoreboard.css?v=s1` per rule 5 (still a relative path —
`static-paths.test.js` stays green).

- Files: `public/styles/scoreboard.css`, `public/scoreboard.html`,
  `test/scoreboard-touch-targets.test.js`.
- Suite: 301 → 304 tests, all green.
- Commit: `07b66de`
- **Needs deploy?** Yes — frontend (scoreboard.css + new cache-bust).

---

## 2026-07-22 — Cover the sales-route validation branches

**Backlog item 5.** Ran `node --test --experimental-test-coverage` to find the
weakest source file: `sales.routes.js` at 80% line / 74% branch — the lowest in
`src/routes`. Two validation branches had no test:

- `POST /api/sales` with **no `knock_id`** → 400 `"knock_id is required"` (was
  only ever reached via the happy path, never asserted).
- `POST /api/sales` with a **`knock_id` that doesn't exist** → 400
  `"knock not found"`.

Added both to `api.test.js` (each sends a valid package so it clears the package
gate and actually exercises the knock_id branch). `sales.routes.js` branch
coverage rose **73.68% → 84.21%**, line **80.34% → 83.76%**. Behavior-only
tests — no source change.

- Files: `test/api.test.js`.
- Suite: 299 → 301 tests, all green.
- Commit: `9de40d1`
- **Needs deploy?** No — tests only.

### Note (next iteration)
- The remaining `sales.routes.js` gap (lines 87-98, 111-117) is the
  unique-constraint **race-recovery** path (`isUniqueViolation` → re-check
  client_uuid / knock). Deterministically triggering it needs a concurrency or
  fault injection seam that doesn't exist yet; left for a focused pass rather
  than a brittle timing test.

---

## 2026-07-22 — Clearer Create-a-Beat validation errors

**Backlog item 4 (second half).** The Create-a-Beat card lumped both required
fields into one message ("Beat name and city are required.") with no indication
of *which* field was wrong, and server errors printed as a bare message line
with no field context.

Now each field is validated separately: the first offending input (name, then
city) is marked `is-invalid` + `aria-invalid="true"`, focused, and given a
distinct message ("Beat name is required." / "City is required."). Server-side
rejections are re-mapped to the field they mention (`/name/i` → name input,
`/city/i` → city input) so the inline red edge matches the text. Marks clear as
the manager edits (form `input` listener) and at the start of a fresh submit.
CSS `.ad-input.is-invalid` is a red edge that survives focus.

New `test/admin-create-beat-validation-ui.test.js` (file-scan wiring guard):
distinct per-field messages, `aria-invalid` set + cleared, `.is-invalid` in JS
and CSS. Watched fail (3) → pass. Bumped `admin.js?v=a9 → a10`,
`admin.css?v=a6 → a7`. Backlog #4 is now fully done.

- Files: `public/admin.js`, `public/styles/admin.css`, `public/admin.html`,
  `test/admin-create-beat-validation-ui.test.js`.
- Suite: 296 → 299 tests, all green.
- Commit: `3067a33`
- **Needs deploy?** Yes — frontend (admin.js/css + cache-busts).

---

## 2026-07-21 — Surface the KHB proximity distance band in the profile card

**Backlog item 4 (first half).** The ICP profile card already renders the
`khb_proximity` *weight* (0.22, labeled "Near Completed KHB Project") — but not
the *radius* that defines "near." A manager could see the signal matters without
knowing a door within 150 m is a full match while one past 500 m scores 0.

Added the band to `GET /api/admin/profile` (`khb_proximity: { full_credit_m,
falloff_m }`, straight from the active profile) and a `.ad-w__note` caption under
that signal's bars: "Full credit within 150 m of a completed KHB project; fades
to 0 by 500 m." The 500 = `full_credit_m + falloff_m` derivation matches the
scoring formula in `src/scoring/scoring.js` exactly (verified before wording it),
honoring the honesty rule.

Tests: extended the `/admin/profile` route test in `admin.test.js` with a
band-shape assertion; new `test/admin-profile-khb-ui.test.js` wiring guard for
the client reading the band + rendering the note. Watched fail (3) → pass.
Bumped `admin.js?v=a8 → a9`, `admin.css?v=a5 → a6`.

- Files: `src/routes/admin.routes.js`, `public/admin.js`,
  `public/styles/admin.css`, `public/admin.html`, `test/admin.test.js`,
  `test/admin-profile-khb-ui.test.js`.
- Suite: 294 → 296 tests, all green.
- Commit: `5cfa9e5`
- **Needs deploy?** Yes — backend (route) + frontend (admin.js/css + cache-busts).

### Note (next iteration)
- Backlog #4 second half — "make the Create-a-Beat card show validation errors
  clearly" — is still open. The card currently only guards name/city client-side
  and surfaces server errors as a flat string; worth a dedicated pass.

---

## 2026-07-21 — Manager-portal beat rename UI

**Backlog item 3.** Auto-generated beat names ("Turlock · near El Capitan Dr N",
six near-identical) are illegible in the field. The rename **backend**
(`POST /admin/beats/:id/rename`, `updateBeatName()`) and its route tests already
existed — but there was no way to reach it from the manager portal. Added the
UI: each beat row now has a **Rename** button beside the map link; clicking it
swaps the name cell for an inline `input + Save/Cancel` editor (mirrors the
existing rep inline-editor `openRepEditor`), POSTs to the existing endpoint,
reloads the overview, and shows a confirmation banner. Empty names are blocked
client-side; a no-op rename just closes; server errors surface inline. Escape
cancels.

CSS: `.ad-beat__rename` is its own pill rule at the **44px touch floor** (kept
separate from the shared `.ad-pin__unlock, .ad-rep__edit, .ad-rep__toggle`
selector so the touch-floor grep guard in `admin-lifecycle-ui.test.js` still
matches — a first pass that folded it in broke that test, caught before commit).

New `test/admin-beat-rename-ui.test.js` (file-scan wiring guard, the admin-UI
test convention): asserts the rename button + `data-beat-id`, the inline form,
the `/rename` POST, and the CSS. Watched it fail (3/3) then pass. Bumped
`admin.js?v=a7 → a8` and `admin.css?v=a4 → a5`.

- Files: `public/admin.js`, `public/styles/admin.css`, `public/admin.html`,
  `test/admin-beat-rename-ui.test.js`.
- Suite: 291 → 294 tests, all green.
- Commit: `f168041`
- **Needs deploy?** Yes — frontend (admin.js/css + cache-busts).

---

## 2026-07-21 — Door-sheet honesty display (owner-occupancy + KHB proximity)

**Backlog item 2.** Two problems, one latent and serious:

1. **The honesty fields never reached the client.** `getBeatTargets()` (repo.js)
   did not `SELECT t.tract_owner_occ_rate` or `t.khb_project_dist_m`, so the
   `/api/beats/:id` route's `?? null` always resolved to `null`. The door sheet
   *looked* like it displayed these, but couldn't. Added both columns to the
   SELECT.
2. **Unknown owner-occupancy rendered as a flat "No".** The sheet showed
   `t.owner_occupied ? 'Yes' : 'No'`, and the route collapsed the tri-state with
   `owner_occupied === 1`. A door admitted on its Census tract rate (unknown
   owner) was mislabeled "No". Added an additive `owner_occupied_known` boolean
   to the payload (from `ownerOccupancyKnown()`), and the sheet now shows
   `unknown — area ~74%` when knownness is false, folding the tract rate into
   that line. KHB proximity relabeled `Distance to KHB project: 120 m` →
   `Near completed KHB project: 120 m away`.

`owner_occupied` stays a boolean in the payload (api.test.js relies on it);
`owner_occupied_known` is purely additive. New `test/door-honesty.test.js` runs
the real bundle in the fake-dom sandbox: seeds an unknown-owner door in a 74%
tract 120 m from a KHB job, logs in, opens the sheet, asserts the honest text.
Watched it fail ("Owner-occupied: No") then pass. Bumped `app.js?v=r9 → r10`.

- Files: `src/db/repo.js`, `src/routes/beats.routes.js`, `public/app.js`,
  `public/index.html`, `test/door-honesty.test.js`.
- Suite: 277 → 291 tests, all green.
- Commit: `916182b`
- **Needs deploy?** Yes — backend (repo/route) + frontend (app.js + cache-bust).

### Needs Ryan
- Optional "data coverage" hint on sub-35 scores (backlog #2 last clause) is not
  yet done — it needs a UX decision on wording/placement so reps read a low but
  *correct* coverage-scaled score as trustworthy rather than broken. Deferred.

---

## 2026-07-21 — Align stale pricing docs with src/config.js

**Backlog item 1.** README.md, SPEC.md, and `src/db/schema.sql` still quoted the
retired **$99 / $249 / $499** ($9900 / $24900 / $49900 cents) package prices.
The canonical catalog in `src/config.js` is monthly-led **$150 / $300 / $690**
(15000 / 30000 / 69000 cents annual). Updated every doc/comment reference,
including the SPEC `/api/sales` example payload (`amount_usd` 249 → 300,
`amount_cents` 24900 → 30000).

Added `test/pricing-docs.test.js` (TDD, watched it fail then pass): derives the
canonical dollar amounts from `PACKAGE_CATALOG` and asserts the docs contain no
stale pricing string and do surface the live amounts — so this can't silently
regress.

- Suite: 275 → 277 tests, all green.
- Commit: `399fe8a`
- **Needs deploy?** No — docs + a test only; no runtime/DB/frontend change.
