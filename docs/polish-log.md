# NDF Beats — overnight polish log

One entry per iteration of the overnight polish loop. Newest first.

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
