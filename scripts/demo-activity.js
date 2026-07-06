// scripts/demo-activity.js
// DEMO-ONLY canvassing activity so the scoreboard + per-rep KPI boards show
// realistic numbers before real door-knocking begins. Writes ONLY to the
// knocks + sales tables over the EXISTING reps/targets/beats — it never touches
// targets, so real ingested data is untouched and this is fully reversible:
//
//   clear at launch:  node -e 'const D=require("better-sqlite3");const db=new D("data/ndf-beats.db");db.prepare("DELETE FROM sales").run();db.prepare("DELETE FROM knocks").run();console.log("demo activity cleared")'
//
// Deterministic (no randomness) so re-runs reproduce the same board. Clears any
// prior knocks/sales first for idempotency.

import { randomUUID } from 'node:crypto';
import { migrate } from '../src/db/migrate.js';
import { PACKAGE_CATALOG, buildAgreementUrl } from '../src/config.js';
import {
  getDb,
} from '../src/db/connection.js';
import {
  listActiveReps,
  listBeatsForRep,
  getBeatTargets,
  insertKnock,
  insertSale,
  transaction,
} from '../src/db/repo.js';

migrate();

// Per-rep "skill" so boards differ: [knocksPerBeat, answerBias, closeBias].
// Index-driven, fully deterministic.
const DISPO_CYCLE = [
  'not_home', 'callback', 'not_home', 'not_interested', 'sold',
  'not_home', 'refused', 'callback', 'sold', 'not_home',
  'not_interested', 'callback', 'sold', 'not_home', 'refused',
  'callback', 'sold', 'not_home',
];
const PKG_CYCLE = ['essential', 'preferred', 'total_home', 'preferred', 'essential'];

// Stamp a knock date that lands inside today / this-week / this-month windows
// so every period on the scoreboard is populated. i = global knock index.
function knockedAt(i) {
  const now = new Date();
  const bucket = i % 6;
  const d = new Date(now.getTime());
  if (bucket < 3) {
    // today: a few hours back
    d.setUTCHours(d.getUTCHours() - (1 + bucket));
  } else if (bucket < 5) {
    // earlier this week: 2-3 days back
    d.setUTCDate(d.getUTCDate() - (2 + (bucket - 3)));
  } else {
    // earlier this month: ~10 days back
    d.setUTCDate(d.getUTCDate() - 10);
  }
  return d.toISOString();
}

function run() {
  const db = getDb();
  // wipe prior demo activity (FK-safe: sales before knocks)
  db.prepare('DELETE FROM sales').run();
  db.prepare('DELETE FROM knocks').run();

  const reps = listActiveReps().filter((r) => r.role === 'rep');
  let gi = 0;
  let knockN = 0;
  let saleN = 0;

  transaction(() => {
    reps.forEach((rep, repIdx) => {
      const beats = listBeatsForRep(rep.id);
      // Vary volume per rep so the leaderboard isn't flat.
      const perBeat = 16 - repIdx * 2; // 16, 14, 12, ...
      beats.forEach((beat) => {
        const targets = getBeatTargets(beat.id);
        const n = Math.min(perBeat, targets.length);
        for (let t = 0; t < n; t++) {
          const target = targets[t];
          // Outcome correlates with the target's Ideal-Client score (realistic:
          // better-fit doors convert better) so Phase-2 reweighting has a real
          // signal to learn from. Deterministic pseudo-spread, no randomness.
          const score = Number(target.score) || 0;
          const r = (score * 3 + t * 7 + repIdx * 13) % 100;
          let disposition;
          if (score >= 55 && r < 38) disposition = 'sold';
          else if (r < 45) disposition = 'not_home';
          else if (r < 62) disposition = 'callback';
          else if (r < 80) disposition = 'not_interested';
          else disposition = 'refused';
          const answered = disposition === 'not_home' ? 0 : 1;
          const knockId = `knock_${randomUUID()}`;
          insertKnock({
            id: knockId,
            beat_id: beat.id,
            target_id: target.id,
            rep_id: rep.id,
            disposition,
            answered,
            note: null,
            client_uuid: null,
            knocked_at: knockedAt(gi),
          });
          knockN++;

          if (disposition === 'sold') {
            const pkgKey = PKG_CYCLE[saleN % PKG_CYCLE.length];
            const pkg = PACKAGE_CATALOG[pkgKey];
            insertSale({
              id: `sale_${randomUUID()}`,
              knock_id: knockId,
              rep_id: rep.id,
              target_id: target.id,
              package: pkgKey,
              amount_cents: pkg.amount_cents,
              agreement_url: buildAgreementUrl(pkgKey, target.id),
              client_uuid: null,
              sold_at: knockedAt(gi),
            });
            saleN++;
          }
          gi++;
        }
      });
    });
  });

  console.log(`[demo-activity] reps=${reps.length} knocks=${knockN} sales=${saleN}`);
  console.log('[demo-activity] DEMO ONLY — clear with: DELETE FROM sales; DELETE FROM knocks;');
}

run();
