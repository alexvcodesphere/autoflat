-- Wohnungsbot — SQLite-Schema (§6)
-- Alle Zeitstempel UTC (datetime('now')). Formatierung nach Europe/Berlin
-- passiert ausschließlich in der UI (§16).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verwaltung (
  id                INTEGER PRIMARY KEY,
  name_canonical    TEXT NOT NULL UNIQUE,
  name_variants     TEXT NOT NULL DEFAULT '[]',
  firm_type         TEXT NOT NULL DEFAULT 'unknown'
                    CHECK(firm_type IN ('verwaltung','makler','gesellschaft',
                                        'genossenschaft','privat','unknown')),
  domain            TEXT,
  impressum_url     TEXT,
  vermietung_url    TEXT,
  email_vermietung  TEXT,
  email_general     TEXT,
  contact_persons   TEXT NOT NULL DEFAULT '[]',
  confidence        TEXT NOT NULL DEFAULT 'none'
                    CHECK(confidence IN ('verified','high','medium','low','none')),
  portal_only       INTEGER NOT NULL DEFAULT 0,
  bounce_count      INTEGER NOT NULL DEFAULT 0,
  source            TEXT,
  last_verified_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS listing_event (
  id                INTEGER PRIMARY KEY,
  external_id       TEXT NOT NULL,
  source            TEXT NOT NULL,
  url               TEXT,
  verwaltung_id     INTEGER REFERENCES verwaltung(id),
  branch            TEXT NOT NULL,
  branch_confidence TEXT,
  payload           TEXT NOT NULL,
  fraud_risk        TEXT,
  fraud_signals     TEXT NOT NULL DEFAULT '[]',
  draft_subject     TEXT,
  draft_body        TEXT,
  used_hook         INTEGER NOT NULL DEFAULT 0,
  recipient         TEXT,
  send_mode         TEXT,
  state             TEXT NOT NULL DEFAULT 'captured'
                    CHECK(state IN ('captured','drafted','queued','cancelled','manual',
                                    'sent','bounced','nudged','handoff','dead')),
  send_after        TEXT,
  gmail_thread_id   TEXT,
  cost_usd          REAL NOT NULL DEFAULT 0,
  sent_at           TEXT,
  replied_at        TEXT,
  outcome           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(external_id, source)
);

-- Firmen, die noch recherchiert werden müssen. Speist den Cowork-Batch (§17)
-- und wird sowohl vom Places-Seeding als auch von Cache-Misses befüllt.
CREATE TABLE IF NOT EXISTS seed_company (
  id             INTEGER PRIMARY KEY,
  name_raw       TEXT NOT NULL,
  name_canonical TEXT NOT NULL UNIQUE,
  address        TEXT,
  website_hint   TEXT,
  rating_count   INTEGER,
  origin         TEXT NOT NULL,
  priority       INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','in_progress','done','skipped')),
  attempts       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verw_canon    ON verwaltung(name_canonical);
CREATE INDEX IF NOT EXISTS idx_seed_prio     ON seed_company(priority, id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_listing_state ON listing_event(state);
CREATE INDEX IF NOT EXISTS idx_listing_send  ON listing_event(send_after) WHERE state='queued';
