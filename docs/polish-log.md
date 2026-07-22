# NDF Beats — overnight polish log

One entry per iteration of the overnight polish loop. Newest first.

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
