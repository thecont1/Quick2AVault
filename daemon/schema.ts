/**
 * Canonical v2 schema (plan §3) — transactions sit ABOVE documents.
 *
 * Uses node:sqlite (DatabaseSync), available unflagged on Node 22.5+/25.
 * No native dependency, no better-sqlite3 build step.
 *
 * Design rules encoded here:
 *  - Amounts are INTEGER minor units + currency. Never floats.
 *  - `entities` is one table, four kinds; matching is kind-scoped (§3.1).
 *  - Transfers have 2 legs and NULL counterparty; spends have 1 leg + counterparty.
 *  - Hero totals derive from `transactions`, excluding status='scheduled'
 *    (carried over from the v1.1.1 double-count lesson) and direction='transfer'.
 */
import { DatabaseSync } from "node:sqlite";

export type Kind = "person" | "organisation" | "account" | "instrument";
export type Direction = "out" | "in" | "transfer";
export type TxnStatus = "evidenced" | "awaiting_settlement" | "no_invoice" | "scheduled";

export const SCHEMA_VERSION = 2;

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Documents: evidence, not truth ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id                 TEXT PRIMARY KEY,
  sha256             TEXT NOT NULL UNIQUE,
  original_filename  TEXT NOT NULL,
  ext                TEXT,
  byte_size          INTEGER,
  raw_path           TEXT NOT NULL,
  markdown_path      TEXT,
  markdown_chars     INTEGER,
  doc_type           TEXT,
  source             TEXT NOT NULL DEFAULT 'folder',
  extraction_json    TEXT,
  extraction_version INTEGER,
  received_at        TEXT NOT NULL,
  converted_at       TEXT,
  analysed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_received ON documents(received_at);

-- ── Entities: ONE table, FOUR kinds. Merges are kind-scoped (anti-pollution) ─
CREATE TABLE IF NOT EXISTS entities (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('person','organisation','account','instrument')),
  subtype               TEXT,
  display_name          TEXT NOT NULL,
  identifiers_json      TEXT,
  institution_entity_id TEXT REFERENCES entities(id),
  is_member             INTEGER NOT NULL DEFAULT 0,
  confidence            REAL,
  status                TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed')),
  created_at            TEXT NOT NULL
);
-- Same display_name may legitimately exist across kinds (the Swiggy rule),
-- but never twice WITHIN a kind.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_kind_name
  ON entities(kind, lower(display_name));

CREATE TABLE IF NOT EXISTS entity_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  alias      TEXT NOT NULL,
  normalised TEXT NOT NULL,
  source     TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_kind_norm ON entity_aliases(kind, normalised);

CREATE TABLE IF NOT EXISTS document_parties (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','counterparty','issuer','source_of_funds')),
  PRIMARY KEY (document_id, entity_id, role)
);

-- ── Transactions: the centre of gravity ────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                     TEXT PRIMARY KEY,
  occurred_at            TEXT NOT NULL,
  posted_at              TEXT,
  fy_key                 TEXT NOT NULL,
  amount_minor           INTEGER NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'INR',
  home_amount_minor      INTEGER,
  fx_rate                REAL,
  fx_date                TEXT,
  direction              TEXT NOT NULL CHECK (direction IN ('out','in','transfer')),
  counterparty_entity_id TEXT REFERENCES entities(id),
  payment_rail           TEXT,
  category_id            TEXT,
  impact_bucket          TEXT,
  purpose_text           TEXT,
  instrument_entity_id   TEXT REFERENCES entities(id),
  quantity               REAL,
  price_minor            INTEGER,
  status                 TEXT NOT NULL DEFAULT 'evidenced',
  confidence             REAL,
  -- Refunds/reversals point at the transaction they undo. Without this a
  -- negative flow is an orphan that silently deflates spending.
  reverses_transaction_id TEXT REFERENCES transactions(id),
  created_at             TEXT NOT NULL,
  -- Transfers move money between accounts I own: no counterparty, by definition.
  CHECK (direction <> 'transfer' OR counterparty_entity_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_txn_fy ON transactions(fy_key);
CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_txn_direction ON transactions(direction);

CREATE TABLE IF NOT EXISTS transaction_legs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id    TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  account_entity_id TEXT NOT NULL REFERENCES entities(id),
  leg               TEXT NOT NULL CHECK (leg IN ('debit','credit')),
  amount_minor      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legs_txn ON transaction_legs(transaction_id);

-- Many documents, one rupee.
CREATE TABLE IF NOT EXISTS transaction_documents (
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  evidence_role  TEXT NOT NULL,
  match_score    REAL,
  linked_by      TEXT NOT NULL DEFAULT 'ai',
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (transaction_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_txndocs_doc ON transaction_documents(document_id);

-- ── Provenance: user > rule > ai ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS field_claims (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('ai','user','rule','import')),
  confidence   REAL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON field_claims(subject_type, subject_id, field);

-- ── Durable job queue (replaces the in-memory queue) ───────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  TEXT REFERENCES documents(id) ON DELETE CASCADE,
  phase        TEXT NOT NULL CHECK (phase IN ('convert','analyse','reconcile')),
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, phase);

-- ── Intake + source idempotency ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intake_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('added','duplicate','irrelevant','failed')),
  filename    TEXT NOT NULL,
  sha256      TEXT,
  document_id TEXT,
  source      TEXT NOT NULL DEFAULT 'folder',
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_events(created_at);

CREATE TABLE IF NOT EXISTS source_events (
  source      TEXT NOT NULL,
  external_id TEXT NOT NULL,
  document_id TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (source, external_id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── Learning (plan §5) ─────────────────────────────────────────────────────
-- Rules the user taught the vault by answering a question or correcting a
-- guess. They are applied BEFORE the AI's own answer (field_claims precedence
-- is user > rule > ai), so a lesson learned once is never re-asked.
CREATE TABLE IF NOT EXISTS learned_rules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,      -- descriptor_to_entity | vendor_to_account
                                   -- | doctype_to_category | load_vs_spend
  match_key    TEXT NOT NULL,      -- normalised trigger (e.g. a descriptor)
  match_kind   TEXT,               -- entity kind the rule resolves within
  value        TEXT NOT NULL,      -- what to apply
  source       TEXT NOT NULL DEFAULT 'user',
  confidence   REAL NOT NULL DEFAULT 1.0,
  times_applied INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  last_applied_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_key ON learned_rules(kind, match_key, COALESCE(match_kind,''));

-- Questions the curiosity engine asked, and what the user said. Ignored
-- questions back off; answered ones raise the budget slightly.
CREATE TABLE IF NOT EXISTS training_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question    TEXT NOT NULL,
  context     TEXT,               -- JSON: document_id, entity_id, candidates
  trigger     TEXT NOT NULL,      -- unseen_entity | load_vs_spend | ...
  options     TEXT,               -- JSON array of offered answers
  answer      TEXT,
  answered_at TEXT,
  dismissed   INTEGER NOT NULL DEFAULT 0,
  rule_id     INTEGER REFERENCES learned_rules(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_open
  ON training_reviews(answered_at, dismissed);
`;

export function openDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(DDL);
  const stmt = db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)");
  stmt.run("schema_version", String(SCHEMA_VERSION));
  return db;
}

/**
 * Indian financial year: 1 Apr – 31 Mar. Derived from occurred_at and STORED,
 * so it must be recomputed whenever occurred_at changes (see recomputeDerived).
 */
export function fyKey(isoDate: string, startMonth = 4): string {
  const d = new Date(isoDate);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const start = m >= startMonth ? y : y - 1;
  return `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Normalise a name for kind-scoped alias matching. */
export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pvt|private|ltd|limited|inc|llp|co|company)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Normalise a card/UPI statement descriptor to a comparable merchant token.
 * "SWIGGY*BLR 080" -> "swiggy"
 */
export function normaliseDescriptor(s: string): string {
  return normaliseName(
    s.replace(/[*#].*$/, " ").replace(/\b\d{3,}\b/g, " ").replace(/\b(blr|del|mum|ind|pos|upi)\b/gi, " "),
  );
}
