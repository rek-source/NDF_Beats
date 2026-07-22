-- NDF Beats schema (SPEC §4, frozen contract).
-- Money: integer cents. Timestamps: ISO-8601 TEXT (UTC). Booleans: INTEGER 0/1.
-- IDs: TEXT UUIDv4 generated in the app layer (portable to Postgres).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Canvassing reps
-- Rep-identity columns (pin_*, token_version) back the PIN -> signed-token login
-- (see src/auth/). On existing DBs they are added by the additive migration in
-- migrate.js; this fresh-DB definition keeps the two shapes identical.
CREATE TABLE IF NOT EXISTS reps (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT UNIQUE NOT NULL,
  role             TEXT NOT NULL DEFAULT 'rep' CHECK (role IN ('rep','manager')),
  active           INTEGER NOT NULL DEFAULT 1,
  pin_hash         TEXT,
  pin_salt         TEXT,
  pin_set_at       TEXT,
  pin_attempts     INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  token_version    INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  -- Data honesty + compliance (finding #1/#4): which signals were REAL at
  -- ingest, whether owner-occupancy is verified, and the tri-state solicit
  -- status ('unknown' is never coerced to 'clear').
  owner_occupied_known INTEGER NOT NULL DEFAULT 0,  -- 1 = verified datum, 0 = unknown/fabricated
  solicit_status  TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (solicit_status IN ('unknown','clear','do_not_solicit')),
  known_signals   TEXT,                      -- JSON array of known signal keys (NULL = legacy row)
  khb_project_dist_m   REAL,                 -- meters to nearest completed KHB project (NULL = not computed)
  tract_owner_occ_rate REAL,                 -- Census-tract owner-occupancy rate 0..1 (NULL = unknown)
  ad_hoc          INTEGER NOT NULL DEFAULT 0,  -- 1 = rep-entered walk-in door, not ingested/scored
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
  kind          TEXT NOT NULL DEFAULT 'auto'
                  CHECK (kind IN ('auto','custom','walkins')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_beats_rep ON beats(rep_id);

-- Ordered membership of targets within a beat (the walk sequence)
CREATE TABLE IF NOT EXISTS beat_targets (
  beat_id     TEXT NOT NULL REFERENCES beats(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES targets(id),
  seq         INTEGER NOT NULL,              -- 1-based walk order
  explore     INTEGER NOT NULL DEFAULT 0,    -- 1 = exploration-budget pick (learning, not score)
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
  amount_cents  INTEGER NOT NULL,            -- 9900 / 24900 / 49900
  agreement_url TEXT,                         -- link opened for e-sign
  client_uuid   TEXT UNIQUE,                 -- idempotency key from offline queue
  sold_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_rep_time ON sales(rep_id, sold_at);

-- Versioned Ideal-Client Profiles (finding #12): the learned profile is
-- PERSISTED on manager approval — not display-only. Exactly one row active.
CREATE TABLE IF NOT EXISTS icp_profiles (
  id            TEXT PRIMARY KEY,
  version       INTEGER NOT NULL,
  label         TEXT NOT NULL,
  profile_json  TEXT NOT NULL,               -- full profile (bands + weights)
  learned_json  TEXT,                        -- provenance (n_sold, alpha, lift)
  approved_by   TEXT,                        -- manager (X-Auth-User) who approved
  active        INTEGER NOT NULL DEFAULT 0,  -- 0/1; at most one active
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_icp_active ON icp_profiles(active);

-- Server-side training certifications (finding #10): completions are recorded
-- against the AUTHED rep, never self-typed client-side.
CREATE TABLE IF NOT EXISTS training_certs (
  id                 TEXT PRIMARY KEY,
  rep_id             TEXT NOT NULL REFERENCES reps(id),
  score              INTEGER NOT NULL,        -- correct answers
  total              INTEGER NOT NULL,        -- questions asked
  passed             INTEGER NOT NULL,        -- 0/1
  curriculum_version TEXT NOT NULL,
  attempt_no         INTEGER NOT NULL,
  completed_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_training_rep ON training_certs(rep_id, completed_at);

-- Open quiz attempts: the served question set is stored server-side so grading
-- never trusts (or reveals) the answer key client-side.
CREATE TABLE IF NOT EXISTS training_attempts (
  id           TEXT PRIMARY KEY,
  rep_id       TEXT NOT NULL REFERENCES reps(id),
  question_ids TEXT NOT NULL,                -- JSON array of served question ids
  curriculum_version TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  graded_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_training_attempts_rep ON training_attempts(rep_id, created_at);
