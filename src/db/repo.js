// src/db/repo.js
// Repository: the ONLY place application queries live (SPEC §4 data-abstraction
// rule). Routes, the KPI service, and the seed script call these functions —
// none of them touch better-sqlite3 directly. Swapping to Postgres later means
// reimplementing this single module against a pg pool, leaving every caller
// untouched.
//
// Conventions:
//  - Money is stored/returned as integer cents; callers format to dollars.
//  - Timestamps are ISO-8601 UTC TEXT.
//  - IDs are caller-supplied (crypto.randomUUID() in the app layer), prefixed
//    by entity ("beat_", "tgt_", "rep_", "knock_", "sale_") for readability.

import { getDb } from './connection.js';

// ---------------------------------------------------------------------------
// Reps
// ---------------------------------------------------------------------------

export function insertRep(rep) {
  getDb()
    .prepare(
      `INSERT INTO reps (id, name, email, role, active)
       VALUES (@id, @name, @email, @role, @active)`,
    )
    .run({
      id: rep.id,
      name: rep.name,
      email: rep.email,
      role: rep.role ?? 'rep',
      active: rep.active ?? 1,
    });
}

export function getRepById(repId) {
  return getDb().prepare(`SELECT * FROM reps WHERE id = ?`).get(repId) ?? null;
}

/** Lookup by email for uniqueness checks (NULL if unseen). Case-insensitive. */
export function getRepByEmail(email) {
  if (!email) return null;
  return (
    getDb()
      .prepare(`SELECT * FROM reps WHERE email = ? COLLATE NOCASE`)
      .get(email) ?? null
  );
}

/** Active reps (role 'rep' or 'manager'), name-ordered. */
export function listActiveReps() {
  return getDb()
    .prepare(`SELECT * FROM reps WHERE active = 1 ORDER BY name ASC`)
    .all();
}

/**
 * All reps with their assigned-beat count (admin overview). One row per rep,
 * including reps with zero beats. Name-ordered.
 * Returns: { id, name, email, role, active, beat_count }.
 */
export function listRepsWithBeatCounts() {
  return getDb()
    .prepare(
      `SELECT
         r.id, r.name, r.email, r.role, r.active,
         (r.pin_hash IS NOT NULL) AS pin_set,
         r.pin_set_at, r.pin_locked_until,
         (SELECT COUNT(*) FROM beats b WHERE b.rep_id = r.id) AS beat_count
       FROM reps r
       ORDER BY r.name ASC`,
    )
    .all();
}

/**
 * Partial-update a rep. Only whitelisted columns are writable; pass any subset
 * of { name, email, role, active }. Returns rows changed (0 if nothing valid).
 */
const REP_EDITABLE = new Set(['name', 'email', 'role', 'active']);
export function updateRep(repId, fields) {
  const cols = Object.keys(fields).filter((k) => REP_EDITABLE.has(k));
  if (!cols.length) return 0;
  const params = { id: repId };
  for (const c of cols) params[c] = fields[c];
  const setClause = cols.map((c) => `${c} = @${c}`).join(', ');
  return getDb().prepare(`UPDATE reps SET ${setClause} WHERE id = @id`).run(params).changes;
}

// ---------------------------------------------------------------------------
// Rep identity (PIN -> signed token). See src/auth/.
// ---------------------------------------------------------------------------

/**
 * Set (or reset) a rep's PIN: store hash+salt, stamp set-time, clear the
 * failed-attempt counter + lockout, and bump token_version so any outstanding
 * tokens for this rep are immediately invalidated. Returns rows changed.
 */
export function setRepPin(repId, hash, salt) {
  return getDb()
    .prepare(
      `UPDATE reps
          SET pin_hash = @hash,
              pin_salt = @salt,
              pin_set_at = @now,
              pin_attempts = 0,
              pin_locked_until = NULL,
              token_version = token_version + 1
        WHERE id = @id`,
    )
    .run({ id: repId, hash, salt, now: new Date().toISOString() }).changes;
}

/** Increment the failed-attempt counter; returns the new count (0 if no rep). */
export function incrementPinAttempts(repId) {
  getDb()
    .prepare(`UPDATE reps SET pin_attempts = pin_attempts + 1 WHERE id = ?`)
    .run(repId);
  const row = getDb().prepare(`SELECT pin_attempts FROM reps WHERE id = ?`).get(repId);
  return row ? row.pin_attempts : 0;
}

/** Clear failed attempts + lockout after a successful login. Rows changed. */
export function clearPinAttempts(repId) {
  return getDb()
    .prepare(`UPDATE reps SET pin_attempts = 0, pin_locked_until = NULL WHERE id = ?`)
    .run(repId).changes;
}

/** Set a lockout window (ISO timestamp); also resets the attempt counter. */
export function setPinLockout(repId, untilIso) {
  return getDb()
    .prepare(`UPDATE reps SET pin_locked_until = @until, pin_attempts = 0 WHERE id = @id`)
    .run({ id: repId, until: untilIso }).changes;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export function insertTarget(t) {
  getDb()
    .prepare(
      `INSERT INTO targets
         (id, address, city, county, zip, lat, lng, value_cents, home_age,
          owner_occupied, tenure_years, recently_sold, income_band, score,
          no_soliciting)
       VALUES
         (@id, @address, @city, @county, @zip, @lat, @lng, @value_cents,
          @home_age, @owner_occupied, @tenure_years, @recently_sold,
          @income_band, @score, @no_soliciting)`,
    )
    .run(t);
}

export function getTargetById(targetId) {
  return getDb().prepare(`SELECT * FROM targets WHERE id = ?`).get(targetId) ?? null;
}

/** All targets, highest score first (used by the seed to build beats). */
export function listTargetsByScoreDesc() {
  return getDb().prepare(`SELECT * FROM targets ORDER BY score DESC`).all();
}

// ---------------------------------------------------------------------------
// Beats + membership
// ---------------------------------------------------------------------------

export function insertBeat(b) {
  getDb()
    .prepare(
      `INSERT INTO beats
         (id, name, city, county, rep_id, status, center_lat, center_lng,
          target_count)
       VALUES
         (@id, @name, @city, @county, @rep_id, @status, @center_lat,
          @center_lng, @target_count)`,
    )
    .run({
      id: b.id,
      name: b.name,
      city: b.city,
      county: b.county,
      rep_id: b.rep_id ?? null,
      status: b.status ?? 'ready',
      center_lat: b.center_lat,
      center_lng: b.center_lng,
      target_count: b.target_count ?? 0,
    });
}

export function insertBeatTarget(row) {
  getDb()
    .prepare(
      `INSERT INTO beat_targets (beat_id, target_id, seq)
       VALUES (@beat_id, @target_id, @seq)`,
    )
    .run(row);
}

export function getBeatById(beatId) {
  return getDb().prepare(`SELECT * FROM beats WHERE id = ?`).get(beatId) ?? null;
}

/**
 * Beats assigned to a rep, with knocked/remaining progress derived from the
 * count of DISTINCT targets that have at least one knock in each beat.
 */
export function listBeatsForRep(repId) {
  return getDb()
    .prepare(
      `SELECT
         b.*,
         (SELECT COUNT(DISTINCT k.target_id)
            FROM knocks k
           WHERE k.beat_id = b.id) AS knocked_count
       FROM beats b
       WHERE b.rep_id = ?
       ORDER BY b.created_at ASC, b.name ASC`,
    )
    .all(repId);
}

/**
 * Ordered targets in a beat (the walk sequence), each annotated with its most
 * recent knock disposition (NULL if never knocked).
 */
export function getBeatTargets(beatId) {
  return getDb()
    .prepare(
      `SELECT
         bt.seq,
         t.id, t.address, t.city, t.zip, t.lat, t.lng,
         t.value_cents, t.home_age, t.owner_occupied, t.tenure_years,
         t.score, t.no_soliciting,
         (SELECT k.disposition
            FROM knocks k
           WHERE k.beat_id = bt.beat_id AND k.target_id = t.id
           ORDER BY k.knocked_at DESC, k.id DESC
           LIMIT 1) AS last_disposition
       FROM beat_targets bt
       JOIN targets t ON t.id = bt.target_id
       WHERE bt.beat_id = ?
       ORDER BY bt.seq ASC`,
    )
    .all(beatId);
}

/**
 * Every beat with its assigned rep's name (NULL when unassigned) for the admin
 * overview. Unassigned beats sort first so they're easy to triage.
 * Returns: { id, name, city, county, status, target_count, rep_id, rep_name }.
 */
export function listAllBeats() {
  return getDb()
    .prepare(
      `SELECT
         b.id, b.name, b.city, b.county, b.status, b.target_count, b.rep_id,
         r.name AS rep_name
       FROM beats b
       LEFT JOIN reps r ON r.id = b.rep_id
       ORDER BY (b.rep_id IS NULL) DESC, b.city ASC, b.name ASC`,
    )
    .all();
}

/**
 * Assign (or unassign, repId=null) a beat to a rep. Returns rows changed.
 * Unassigning a beat that is mid-route ('active') also resets it to 'ready' so a
 * beat can never read as ACTIVE with no rep on it (manager-portal data integrity).
 */
export function assignBeatToRep(beatId, repId) {
  const rep = repId ?? null;
  const sql = rep
    ? `UPDATE beats SET rep_id = @rep_id WHERE id = @beat_id`
    : `UPDATE beats SET rep_id = NULL,
             status = CASE WHEN status = 'active' THEN 'ready' ELSE status END
        WHERE id = @beat_id`;
  return getDb().prepare(sql).run({ beat_id: beatId, rep_id: rep }).changes;
}

/**
 * Real (no fabricated values) data-coverage snapshot for the admin panel:
 * total scored targets, owner-occupied / no-soliciting counts, and a per-county
 * breakdown. Counts only — never invents demographics.
 */
export function targetsDataStatus() {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS targets,
         COALESCE(SUM(owner_occupied), 0) AS owner_occupied,
         COALESCE(SUM(no_soliciting), 0)  AS no_soliciting
       FROM targets`,
    )
    .get();
  const byCounty = db
    .prepare(
      `SELECT county, COUNT(*) AS cnt
       FROM targets GROUP BY county ORDER BY cnt DESC`,
    )
    .all();
  return {
    targets: totals.targets,
    owner_occupied: totals.owner_occupied,
    no_soliciting: totals.no_soliciting,
    counties: byCounty.map((c) => ({ county: c.county, count: c.cnt })),
  };
}

// ---------------------------------------------------------------------------
// Knocks
// ---------------------------------------------------------------------------

export function getKnockById(knockId) {
  return getDb().prepare(`SELECT * FROM knocks WHERE id = ?`).get(knockId) ?? null;
}

/** Lookup by idempotency key from the offline queue (NULL if not seen). */
export function getKnockByClientUuid(clientUuid) {
  if (!clientUuid) return null;
  return (
    getDb().prepare(`SELECT * FROM knocks WHERE client_uuid = ?`).get(clientUuid) ??
    null
  );
}

/**
 * All knocks joined to their target's scoring signals + disposition, for Phase-2
 * adaptive reweighting (scoring/reweight.js). One row per knock.
 * Returns: { id, disposition, target_id, value_cents, home_age, owner_occupied,
 *            tenure_years, recently_sold, income_band }.
 */
export function listKnocksWithSignals() {
  return getDb()
    .prepare(
      `SELECT
         k.id, k.disposition, k.target_id,
         t.value_cents, t.home_age, t.owner_occupied,
         t.tenure_years, t.recently_sold, t.income_band
       FROM knocks k
       JOIN targets t ON t.id = k.target_id`,
    )
    .all();
}

export function insertKnock(k) {
  getDb()
    .prepare(
      `INSERT INTO knocks
         (id, beat_id, target_id, rep_id, disposition, answered, note,
          client_uuid, knocked_at)
       VALUES
         (@id, @beat_id, @target_id, @rep_id, @disposition, @answered, @note,
          @client_uuid, @knocked_at)`,
    )
    .run({
      id: k.id,
      beat_id: k.beat_id,
      target_id: k.target_id,
      rep_id: k.rep_id,
      disposition: k.disposition,
      answered: k.answered,
      note: k.note ?? null,
      client_uuid: k.client_uuid ?? null,
      knocked_at: k.knocked_at,
    });
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export function getSaleByClientUuid(clientUuid) {
  if (!clientUuid) return null;
  return (
    getDb().prepare(`SELECT * FROM sales WHERE client_uuid = ?`).get(clientUuid) ??
    null
  );
}

export function getSaleByKnockId(knockId) {
  return getDb().prepare(`SELECT * FROM sales WHERE knock_id = ?`).get(knockId) ?? null;
}

export function insertSale(s) {
  getDb()
    .prepare(
      `INSERT INTO sales
         (id, knock_id, rep_id, target_id, package, amount_cents,
          agreement_url, client_uuid, sold_at)
       VALUES
         (@id, @knock_id, @rep_id, @target_id, @package, @amount_cents,
          @agreement_url, @client_uuid, @sold_at)`,
    )
    .run({
      id: s.id,
      knock_id: s.knock_id,
      rep_id: s.rep_id,
      target_id: s.target_id,
      package: s.package,
      amount_cents: s.amount_cents,
      agreement_url: s.agreement_url ?? null,
      client_uuid: s.client_uuid ?? null,
      sold_at: s.sold_at,
    });
}

// ---------------------------------------------------------------------------
// KPI aggregation (SPEC §5.5). Computed in SQL over a [fromUtc, toUtc) window.
// The scoreboard service builds the window in America/Los_Angeles and passes
// UTC bounds in. These functions return raw rows; the service shapes the JSON.
// ---------------------------------------------------------------------------

/**
 * Per-rep knock counts in [fromUtc, toUtc). One row per active rep, even with
 * zero knocks (LEFT JOIN), so the leaderboard always lists everyone.
 * Returns: { rep_id, name, role, doors_knocked, doors_answered, yeses, nos }.
 */
export function aggregateKnocksByRep(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT
         r.id   AS rep_id,
         r.name AS name,
         r.role AS role,
         COUNT(k.id)                                              AS doors_knocked,
         COALESCE(SUM(CASE WHEN k.answered = 1 THEN 1 ELSE 0 END), 0) AS doors_answered,
         COALESCE(SUM(CASE WHEN k.disposition = 'sold' THEN 1 ELSE 0 END), 0) AS yeses,
         COALESCE(SUM(CASE WHEN k.disposition IN ('refused','not_interested')
                           THEN 1 ELSE 0 END), 0)                AS nos
       FROM reps r
       LEFT JOIN knocks k
         ON k.rep_id = r.id
        AND k.knocked_at >= @fromUtc
        AND k.knocked_at <  @toUtc
       WHERE r.active = 1
       GROUP BY r.id, r.name, r.role
       ORDER BY r.name ASC`,
    )
    .all({ fromUtc, toUtc });
}

/**
 * Team-wide knock totals in [fromUtc, toUtc).
 * Returns a single row: { doors_knocked, doors_answered, yeses, nos }.
 */
export function aggregateTeamKnocks(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT
         COUNT(id)                                              AS doors_knocked,
         COALESCE(SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END), 0) AS doors_answered,
         COALESCE(SUM(CASE WHEN disposition = 'sold' THEN 1 ELSE 0 END), 0) AS yeses,
         COALESCE(SUM(CASE WHEN disposition IN ('refused','not_interested')
                           THEN 1 ELSE 0 END), 0)              AS nos
       FROM knocks
       WHERE knocked_at >= @fromUtc AND knocked_at < @toUtc`,
    )
    .get({ fromUtc, toUtc });
}

/**
 * Team sale stats in [fromUtc, toUtc).
 * Returns: { sale_count, sum_cents } (sum_cents 0 when no sales).
 */
export function aggregateTeamSales(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT
         COUNT(id)                       AS sale_count,
         COALESCE(SUM(amount_cents), 0)  AS sum_cents
       FROM sales
       WHERE sold_at >= @fromUtc AND sold_at < @toUtc`,
    )
    .get({ fromUtc, toUtc });
}

/**
 * Per-rep sale stats in [fromUtc, toUtc).
 * Returns rows: { rep_id, sale_count, sum_cents }.
 */
export function aggregateSalesByRep(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT
         rep_id,
         COUNT(id)                       AS sale_count,
         COALESCE(SUM(amount_cents), 0)  AS sum_cents
       FROM sales
       WHERE sold_at >= @fromUtc AND sold_at < @toUtc
       GROUP BY rep_id`,
    )
    .all({ fromUtc, toUtc });
}

/**
 * Package frequency in [fromUtc, toUtc), team-wide.
 * Returns rows: { package, cnt, amount_cents } ordered by cnt desc.
 * The service applies the tie-break (highest amount) and per-rep filtering.
 */
export function packageCountsTeam(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT package, COUNT(id) AS cnt, MAX(amount_cents) AS amount_cents
       FROM sales
       WHERE sold_at >= @fromUtc AND sold_at < @toUtc
       GROUP BY package`,
    )
    .all({ fromUtc, toUtc });
}

/**
 * Package frequency per rep in [fromUtc, toUtc).
 * Returns rows: { rep_id, package, cnt, amount_cents }.
 */
export function packageCountsByRep(fromUtc, toUtc) {
  return getDb()
    .prepare(
      `SELECT rep_id, package, COUNT(id) AS cnt, MAX(amount_cents) AS amount_cents
       FROM sales
       WHERE sold_at >= @fromUtc AND sold_at < @toUtc
       GROUP BY rep_id, package`,
    )
    .all({ fromUtc, toUtc });
}

// ---------------------------------------------------------------------------
// Transaction helper (used by the seed for fast bulk inserts).
// ---------------------------------------------------------------------------

/**
 * Run `fn` inside a single SQLite transaction.
 * @param {() => void} fn
 */
export function transaction(fn) {
  return getDb().transaction(fn)();
}

/**
 * Delete all application rows (FK-safe order) so the seed can rebuild from a
 * clean slate deterministically. Lives in the repo so the seed never issues raw
 * SQL itself (keeps the data abstraction honest).
 */
export function resetAll() {
  const db = getDb();
  for (const t of ['sales', 'knocks', 'beat_targets', 'beats', 'targets', 'reps']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

/** Row counts per table (for the seed summary). */
export function tableCounts() {
  const db = getDb();
  const out = {};
  for (const t of ['reps', 'targets', 'beats', 'beat_targets', 'knocks', 'sales']) {
    out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
  }
  return out;
}
