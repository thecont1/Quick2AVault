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

/** Which thing a field_claim is about (work order 03 §P2). */
export type ClaimSubject = "document" | "transaction" | "entity";
export type ClaimSource = "ai" | "user" | "rule" | "import";
export type ClaimStatus = "proposed" | "confirmed" | "rejected" | "superseded";

export const SCHEMA_VERSION = 6;

/**
 * Markdown retention policy. The ORIGINAL is truth; markdown is a
 * regenerable READING SURFACE — architecturally a cache, not a record.
 *
 * The knob exists now so the decision has a home, but NOTHING evicts yet:
 * deleting markdown before search and re-extraction are proven would strand
 * both. Revisit only after semantic search is tested on a real vault
 * (work order 03 §P5).
 */
export type MarkdownRetention = "keep_all" | "keep_recent" | "keep_none";
export const DEFAULT_MARKDOWN_RETENTION: MarkdownRetention = "keep_all";

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ── Documents: evidence, not truth ─────────────────────────────────────────
-- ARTIFACT DOCTRINE (work order 03 §1): the ORIGINAL is truth — immutable,
-- always retained, always local. MARKDOWN is the reading surface: a
-- deterministic, REGENERABLE transform of the original, and therefore a cache.
-- extraction_json is the reading: a recomputable opinion.
--
-- The provenance columns exist so drift between those three is DETECTABLE.
-- Without converter/converter_version we cannot tell whether a regenerated
-- markdown differs because the document changed or because anydoc did; without
-- markdown_hash we cannot tell whether an extraction still describes the text
-- it was actually read from.
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
  analysed_at        TEXT,
  -- ── provenance (work order 03 §P0) ──
  converter          TEXT,     -- 'anydoc' | 'vision-ocr' | 'plaintext'
  converter_version  TEXT,     -- 'anydoc@0.1.6', 'vision-ocr@macOS26.5.2'
  markdown_hash      TEXT,     -- SHA-256 of the markdown the extraction READ
  extraction_model   TEXT,     -- e.g. 'claude-sonnet-5'
  extracted_at       TEXT      -- distinct from analysed_at: when the OPINION was formed
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
  -- Work order 04 §D.1: matching semantics differ by type. name_variant
  -- matches on normalised-exact or token-sort; email/phone match EXACT and
  -- are high-confidence (an email is decisive, a name spelling is not);
  -- handle is a future-facing bucket (UPI handles, usernames) with the same
  -- exact-match rule as email/phone. Defaulting existing rows to
  -- 'name_variant' is correct: every alias written before this column
  -- existed came from name-matching code paths (token-sort, containment,
  -- user-merge), never from an identifier.
  alias_type TEXT NOT NULL DEFAULT 'name_variant'
             CHECK (alias_type IN ('name_variant','email','phone','handle')),
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

-- ── Statement imports (work order 04 §Track A) ─────────────────────────────
-- One statement document -> N staged lines -> promoted to transactions once
-- reconciled. A staging table rather than writing straight to the ledger
-- because a statement line needs the matcher's judgement first: it might
-- SETTLE an existing invoice-only transaction, or it might be new money the
-- vault never saw a receipt for (a genuine gap). Staging keeps the raw read
-- available for that decision and for re-import idempotency, independent of
-- whatever the line becomes.
CREATE TABLE IF NOT EXISTS statement_lines (
  id                 TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line_no            INTEGER NOT NULL,
  occurred_at        TEXT,
  raw_descriptor     TEXT NOT NULL,
  amount_minor       INTEGER NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('out','in')),
  balance_after_minor INTEGER,
  currency           TEXT NOT NULL DEFAULT 'INR',
  -- Present only when the line states an amount in a currency other than the
  -- statement's own — original amount/currency, kept alongside the converted
  -- amount_minor so both the source figure and the INR figure are on record.
  fx_original_json   TEXT,
  -- UTR/RRN/cheque/UPI ref, when the statement prints one. Read by
  -- reconcileStagedLine (statements.ts) as a STRONG_KEYS-equivalent
  -- reference_id so a matching invoice reference crosses AUTO_LINK instead
  -- of stalling in the review band on descriptor+amount+date alone.
  reference_id       TEXT,
  -- pending: staged, not yet reconciled. linked: attached as settlement
  -- evidence to an existing transaction. created: promoted to its own new
  -- transaction (the gap case — no invoice was ever on file). skipped:
  -- re-import of a line already staged/promoted from an earlier statement.
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','linked','created','skipped')),
  transaction_id     TEXT REFERENCES transactions(id),
  created_at         TEXT NOT NULL,
  -- One statement line is one economic event: overlapping statements from
  -- adjacent months, or a re-drop of the same file, must never create it
  -- twice. account_entity_id anchors the key to WHICH account, so identical
  -- amounts on the same day across two different accounts don't collide.
  account_entity_id  TEXT REFERENCES entities(id),
  idempotency_key    TEXT NOT NULL,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_stmt_lines_doc ON statement_lines(document_id);
CREATE INDEX IF NOT EXISTS idx_stmt_lines_status ON statement_lines(status);

-- ── Provenance: user > rule > ai ───────────────────────────────────────────
-- SUBJECT-SCOPED (work order 03 §P2). A claim is about a DOCUMENT, a
-- TRANSACTION, or an ENTITY.
--
-- Editing in the document-centric browser writes DOCUMENT-scope claims, and a
-- resolver propagates them into every linked transaction. The alternative —
-- resolving doc→txn at edit time and writing only transaction claims — fails
-- for orphan documents (nothing to write to) and for future statements (one
-- document, many transactions).
CREATE TABLE IF NOT EXISTS field_claims (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','transaction','entity')),
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('ai','user','rule','import')),
  confidence   REAL,
  status       TEXT NOT NULL DEFAULT 'proposed'
               CHECK (status IN ('proposed','confirmed','rejected','superseded')),
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_claims_subject ON field_claims(subject_type, subject_id, field);
CREATE INDEX IF NOT EXISTS idx_claims_live ON field_claims(subject_type, subject_id, field, status);

-- Every user edit, appended. The ledger must be able to answer "who changed
-- this, from what, and when" without replaying claims.
CREATE TABLE IF NOT EXISTS review_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL,
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  action       TEXT NOT NULL,   -- edit | confirm | reject | resolve
  old_value    TEXT,
  new_value    TEXT,
  source       TEXT NOT NULL DEFAULT 'user',
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON review_audit(subject_type, subject_id);

-- ── Lexical search (work order 03 §P1) ─────────────────────────────────────
-- FTS5 over the reading surface (markdown) and the reading (flattened key
-- extraction fields). doc_id is UNINDEXED: it is a join key, not a search term
-- — indexing it would let a hex id match a query.
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  doc_id UNINDEXED,
  filename,
  markdown,
  extraction_text,
  tokenize = 'unicode61'
);

-- ── Semantic search (work order 04 §Track B) ──────────────────────────────
-- One dense vector per document. The BLOB stores a Float64Array; the
-- dimensionality is model-dependent, so dims is stored alongside to catch a
-- model swap silently producing half-length vectors that score nonsense.
-- text_hash is the markdown_hash of the embedded text: a document that was
-- re-analysed but not re-converted keeps its embedding, and an embedding is
-- only recomputed when the actual text changed.
CREATE TABLE IF NOT EXISTS document_embeddings (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  dims         INTEGER NOT NULL,
  text_hash    TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (document_id, model)
);

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

-- ── Holdings (portfolio line items) ────────────────────────────────────────
-- One row per SECURITY per trade. A contract note settling eighteen scrips
-- produces eighteen rows: the net rupee figure on the transaction is what left
-- the bank, but only these rows say what is actually held.
CREATE TABLE IF NOT EXISTS holdings (
  id                  TEXT PRIMARY KEY,
  transaction_id      TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  document_id         TEXT REFERENCES documents(id),
  instrument_entity_id TEXT NOT NULL REFERENCES entities(id),
  side                TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quantity            REAL,
  price_minor         INTEGER,
  amount_minor        INTEGER,
  isin                TEXT,
  occurred_at         TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_holdings_instrument ON holdings(instrument_entity_id);
CREATE INDEX IF NOT EXISTS idx_holdings_txn ON holdings(transaction_id);
CREATE INDEX IF NOT EXISTS idx_holdings_date ON holdings(occurred_at);

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
  // Migration runs BEFORE the DDL, not after.
  //
  // The DDL declares indexes over columns added in v3 (field_claims.status).
  // `CREATE INDEX IF NOT EXISTS` does not skip a missing COLUMN — it fails
  // with "no such column: status" — so on any pre-v3 vault the DDL cannot
  // execute until the table has been reshaped. On a fresh database every
  // migration step is a no-op (the tables do not exist yet) and the DDL does
  // all the work, so one ordering serves both cases.
  migrate(db);
  db.exec(DDL);
  const stmt = db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES(?,?)");
  stmt.run("schema_version", String(SCHEMA_VERSION));
  return db;
}

/** Column names of an existing table. Empty when the table does not exist. */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } catch {
    return new Set();
  }
}

/**
 * In-place migration for vaults created before this schema version.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so every
 * column added after v2 must be applied here or a real vault silently keeps
 * the old shape and every new write fails at runtime rather than at deploy.
 *
 * Idempotent by construction: each step checks the live shape first.
 */
export function migrate(db: DatabaseSync): void {
  // ── v2 → v3: document provenance columns ──
  const docCols = columnsOf(db, "documents");
  const addDocCol = (name: string, decl: string) => {
    if (docCols.size && !docCols.has(name)) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${decl}`);
    }
  };
  addDocCol("converter", "TEXT");
  addDocCol("converter_version", "TEXT");
  addDocCol("markdown_hash", "TEXT");
  addDocCol("extraction_model", "TEXT");
  addDocCol("extracted_at", "TEXT");

  // ── v2 → v3: field_claims gains `status` and CHECK constraints ──
  //
  // SQLite cannot ALTER a CHECK constraint onto an existing column, so this is
  // the documented rebuild-table pattern: create the new shape, copy, swap.
  // Existing rows were all transaction-scope by construction (ledger.ts and
  // the /v1/link routes were the only writers), and they are treated as
  // 'confirmed' only when they came from the user — an AI claim that was never
  // reviewed must stay 'proposed' or the resolver would refuse to overwrite it.
  const claimCols = columnsOf(db, "field_claims");
  if (claimCols.size && !claimCols.has("status")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE field_claims_new (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_type TEXT NOT NULL CHECK (subject_type IN ('document','transaction','entity')),
          subject_id   TEXT NOT NULL,
          field        TEXT NOT NULL,
          value        TEXT,
          source       TEXT NOT NULL CHECK (source IN ('ai','user','rule','import')),
          confidence   REAL,
          status       TEXT NOT NULL DEFAULT 'proposed'
                       CHECK (status IN ('proposed','confirmed','rejected','superseded')),
          created_at   TEXT NOT NULL
        );
        INSERT INTO field_claims_new (id, subject_type, subject_id, field, value, source, confidence, status, created_at)
          SELECT id,
                 CASE WHEN subject_type IN ('document','transaction','entity')
                      THEN subject_type ELSE 'transaction' END,
                 subject_id, field, value, source, confidence,
                 CASE WHEN source = 'user' THEN 'confirmed' ELSE 'proposed' END,
                 created_at
            FROM field_claims;
        DROP TABLE field_claims;
        ALTER TABLE field_claims_new RENAME TO field_claims;
        CREATE INDEX IF NOT EXISTS idx_claims_subject ON field_claims(subject_type, subject_id, field);
        CREATE INDEX IF NOT EXISTS idx_claims_live ON field_claims(subject_type, subject_id, field, status);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // ── v3 → v4: entity_aliases gains `alias_type` (work order 04 §D.1) ──
  //
  // Same rebuild pattern as field_claims above: SQLite's ALTER TABLE ADD
  // COLUMN does not reliably enforce a CHECK constraint added after the
  // fact, so the column is declared on a fresh table and rows are copied in.
  // Every existing row predates typed aliases and came from a name-matching
  // code path (token-sort, containment, user-merge) — never an identifier —
  // so 'name_variant' is the correct backfill, not a guess.
  const aliasCols = columnsOf(db, "entity_aliases");
  if (aliasCols.size && !aliasCols.has("alias_type")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE entity_aliases_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          alias      TEXT NOT NULL,
          normalised TEXT NOT NULL,
          alias_type TEXT NOT NULL DEFAULT 'name_variant'
                     CHECK (alias_type IN ('name_variant','email','phone','handle')),
          source     TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO entity_aliases_new (id, entity_id, kind, alias, normalised, alias_type, source, created_at)
          SELECT id, entity_id, kind, alias, normalised, 'name_variant', source, created_at
            FROM entity_aliases;
        DROP TABLE entity_aliases;
        ALTER TABLE entity_aliases_new RENAME TO entity_aliases;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_kind_norm ON entity_aliases(kind, normalised);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
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
