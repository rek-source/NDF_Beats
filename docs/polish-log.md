# NDF Beats — overnight polish log

One entry per iteration of the overnight polish loop. Newest first.

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
- Commit: `PENDING`
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
