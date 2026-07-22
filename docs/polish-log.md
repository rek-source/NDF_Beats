# NDF Beats — overnight polish log

One entry per iteration of the overnight polish loop. Newest first.

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
