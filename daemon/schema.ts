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
export type ClaimSubject = "document" | "transaction" | "entity" | "document_party";
export type ClaimSource = "ai" | "user" | "rule" | "import";
export type ClaimStatus = "proposed" | "confirmed" | "rejected" | "superseded";

export const SCHEMA_VERSION = 14;

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
  extracted_at       TEXT,     -- distinct from analysed_at: when the OPINION was formed
  -- ── work order 07 §G: encrypted document password ──
  -- User-provided password for encrypted PDFs. Stored in plaintext because
  -- the daemon needs to pass it to the converter; the vault.db is already
  -- the crown jewels, so encrypting this column with a key that also lives
  -- in the daemon would be theatre. Null = no password / not encrypted.
  password            TEXT,
  -- ── WO09/WO10 P4.5: document lifecycle for the Glaze manage footer ──
  -- 'active'  → in the vault, shown in Review and counted in the ledger.
  -- 'removed' → soft-removed ("Remove from active"): the ORIGINAL FILE and
  --             all extracted claims are preserved on disk and in the db, but
  --             the document is hidden from Review and its transactions are
  --             excluded. Reversible by reprocess/restore.
  -- 'deleted' → permanently deleted: raw bytes and markdown removed from disk,
  --             the row tombstoned so the sha256 dedupe guard still holds.
  -- Kept as a column (not a table) because every list/detail query must be
  -- able to filter on it cheaply; NOT NULL DEFAULT keeps pre-v13 rows active.
  lifecycle           TEXT NOT NULL DEFAULT 'active'
                        CHECK (lifecycle IN ('active','removed','deleted'))
);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_received ON documents(received_at);
CREATE INDEX IF NOT EXISTS idx_documents_lifecycle ON documents(lifecycle);

-- ── Entities: ONE table, FOUR kinds. Merges are kind-scoped (anti-pollution) ─
CREATE TABLE IF NOT EXISTS entities (
  id                    TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL CHECK (kind IN ('person','organisation','account','instrument')),
  subtype               TEXT,
  display_name          TEXT NOT NULL,
  identifiers_json      TEXT,
  institution_entity_id TEXT REFERENCES entities(id),
  is_member             INTEGER NOT NULL DEFAULT 0,
  -- Work order 05 §B.2: owner and member are distinct ideas. is_member means
  -- "shares this vault"; is_owner means "this is me" and is EXCLUSIVE —
  -- exactly one person may hold it. (Pre-v7 vaults conflated the two in
  -- is_member; the migration promotes the first member to owner.)
  is_owner              INTEGER NOT NULL DEFAULT 0,
  confidence            REAL,
  status                TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','confirmed')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT
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
  -- Work order 05 §B.2: an alias is evidence with a lifecycle. 'proposed'
  -- came from a single extraction and has never been confirmed (it drives
  -- the unresolved-alias count in People); 'confirmed' was stated by the
  -- user, taught by a confirmed rule, or carried on a document as a typed
  -- identifier; 'rejected' was explicitly disowned and must never match
  -- again — the row is kept because the string is still evidence.
  status     TEXT NOT NULL DEFAULT 'confirmed'
             CHECK (status IN ('proposed','confirmed','rejected')),
  confidence REAL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alias_kind_norm ON entity_aliases(kind, normalised);

CREATE TABLE IF NOT EXISTS document_parties (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('owner','counterparty','issuer','source_of_funds')),
  confidence  REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  provenance  TEXT NOT NULL DEFAULT 'ai-derived'
              CHECK (provenance IN ('ai-derived','user-confirmed','rule-derived')),
  PRIMARY KEY (document_id, entity_id, role),
  UNIQUE (document_id, entity_id)
);

-- ── Transactions: the centre of gravity ────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id                     TEXT PRIMARY KEY,
  occurred_at            TEXT NOT NULL,
  posted_at              TEXT,
  fy_key                 TEXT NOT NULL,
  amount_minor           INTEGER NOT NULL,
  -- Work order 05 §A.2: NULL means the source document did not state a
  -- currency. That is a REVIEW state, not an invitation to assume INR —
  -- the client renders it as "currency uncertain" and aggregates skip it
  -- until a claim or a conversion resolves it.
  currency               TEXT,
  home_amount_minor      INTEGER,
  fx_rate                REAL,
  fx_date                TEXT,
  fx_source              TEXT,
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
  evidence_role  TEXT NOT NULL CHECK (evidence_role IN (
                   'merchant_invoice', 'payment_receipt', 'bank_slip',
                   'card_confirmation', 'statement_line', 'refund_note',
                   'contract_note')),
  match_score    REAL,
  linked_by      TEXT NOT NULL DEFAULT 'ai',
  linked_at      TEXT NOT NULL,
  PRIMARY KEY (transaction_id, document_id)
);
CREATE INDEX IF NOT EXISTS idx_txndocs_doc ON transaction_documents(document_id);
-- Work order 07 §A2: evidence identity at the correct granularity. A document
-- may only be the evidence of ONE transaction for a given evidence_role — this
-- prevents a retry, restart, or manual reprocess from creating a second
-- economic event for the same document. Statement lines have their own
-- idempotency via statement_lines; this covers single-event documents and
-- contract notes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_txndoc_evidence_key
  ON transaction_documents(document_id, evidence_role);

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
  subject_type TEXT NOT NULL CHECK (subject_type IN ('document','transaction','entity','document_party')),
  subject_id   TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('ai','user','rule','import')),
  confidence   REAL,
  provenance_ref TEXT,
  edited_at    TEXT,
  edited_by    TEXT,
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

-- ── Intake + source idempotency (work order 06 §5) ──────────────────────────
-- One row per incoming artifact, recording the full intake provenance: where
-- it came from, what bytes arrived, what disposition triage gave it, and where
-- the safe copy lives. 'kind' is the disposition: 'accepted' (was 'added' in
-- pre-v8 vaults), 'irrelevant', 'duplicate', or 'failed'. 'added' is kept in
-- the CHECK so old rows remain valid; new writes use 'accepted'.
CREATE TABLE IF NOT EXISTS intake_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  kind               TEXT NOT NULL CHECK (kind IN ('added','accepted','duplicate','irrelevant','failed')),
  filename           TEXT NOT NULL,
  sha256             TEXT,
  document_id        TEXT,
  source             TEXT NOT NULL DEFAULT 'folder',
  detail             TEXT,
  created_at         TEXT NOT NULL,
  -- ── work order 06 §5 provenance columns ──
  source_reference   TEXT,
  original_filename  TEXT,
  received_path      TEXT,
  consume_source     INTEGER NOT NULL DEFAULT 0,
  mime_type          TEXT,
  byte_size          INTEGER,
  reason_code        TEXT,
  reason             TEXT,
  confidence         TEXT,
  matched_document_id TEXT,
  canonical_path     TEXT,
  -- received → stable → hashed → triaged → archived → queued → processing → complete | failed | password_needed
  processing_state   TEXT NOT NULL DEFAULT 'received'
                     CHECK (processing_state IN ('received','stable','hashed','triaged','archived','queued','processing','complete','failed','password_needed')),
  signals_json       TEXT,
  triage_review      INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT,
  -- ── work order 07 §B3: stall detection ──
  -- stage_started_at: when the current processing_state was entered.
  -- heartbeat_at: last time the worker touched this row (a stalled process
  --   must not be mistaken for successful analysis).
  -- finished_at: when the row reached a terminal state (complete/failed).
  -- last_error: the most recent error message for a failed or stalled item.
  -- retry_count: how many times processing has been retried.
  -- next_retry_at: when the next retry should be attempted (backoff).
  stage_started_at   TEXT,
  heartbeat_at       TEXT,
  finished_at        TEXT,
  last_error         TEXT,
  retry_count        INTEGER NOT NULL DEFAULT 0,
  next_retry_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_events(created_at);
CREATE INDEX IF NOT EXISTS idx_intake_kind ON intake_events(kind);
CREATE INDEX IF NOT EXISTS idx_intake_sha ON intake_events(sha256);
CREATE INDEX IF NOT EXISTS idx_intake_doc ON intake_events(document_id);

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
  dedupe_key  TEXT,
  novelty_score REAL,
  predicted_rule TEXT,
  why TEXT,
  backoff_until TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_open
  ON training_reviews(answered_at, dismissed);
CREATE UNIQUE INDEX IF NOT EXISTS idx_training_dedupe ON training_reviews(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- WO09/WO10 canonical event stream. Kept separate from legacy intake_events
-- so existing clients can retain their old phase names during migration.
CREATE TABLE IF NOT EXISTS document_pipeline (
  document_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('received','stable','hashed','triaged','converting','analysing','complete','failed','duplicate','irrelevant','password_needed')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_document ON pipeline_events(document_id, id);

CREATE TABLE IF NOT EXISTS rate_cache (
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate_date TEXT NOT NULL,
  rate REAL NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(base_currency, quote_currency, rate_date, source)
);

CREATE TABLE IF NOT EXISTS value_registry (
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  normalised TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(field, normalised)
);
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
  // Mark the transaction_documents evidence_role CHECK as satisfied for fresh
  // databases (DDL already enforces it) so subsequent opens skip the rebuild.
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('td_evidence_role_checked','1')").run();
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

  // ── v6 → v7 (work order 05) ──────────────────────────────────────────────

  // entities gains is_owner / updated_at. Owner was conflated with member:
  // promote the FIRST member (the one zero-setup auto-promoted) to owner.
  const entCols = columnsOf(db, "entities");
  if (entCols.size && !entCols.has("is_owner")) {
    db.exec("ALTER TABLE entities ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE entities ADD COLUMN updated_at TEXT");
    db.exec(`
      UPDATE entities SET is_owner=1
       WHERE kind='person' AND is_member=1
         AND id = (SELECT id FROM entities WHERE kind='person' AND is_member=1
                   ORDER BY created_at LIMIT 1)`);
  }

  // transactions: currency becomes nullable (a missing source currency is a
  // review state, never a silent INR) and gains fx_source. SQLite cannot
  // drop NOT NULL in place — rebuild, same pattern as field_claims above.
  const txnCols = columnsOf(db, "transactions");
  if (txnCols.size && !txnCols.has("fx_source")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE transactions_new (
          id                     TEXT PRIMARY KEY,
          occurred_at            TEXT NOT NULL,
          posted_at              TEXT,
          fy_key                 TEXT NOT NULL,
          amount_minor           INTEGER NOT NULL,
          currency               TEXT,
          home_amount_minor      INTEGER,
          fx_rate                REAL,
          fx_date                TEXT,
          fx_source              TEXT,
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
          reverses_transaction_id TEXT REFERENCES transactions(id),
          created_at             TEXT NOT NULL,
          CHECK (direction <> 'transfer' OR counterparty_entity_id IS NULL)
        );
        INSERT INTO transactions_new
          SELECT id, occurred_at, posted_at, fy_key, amount_minor, currency,
                 home_amount_minor, fx_rate, fx_date, NULL, direction,
                 counterparty_entity_id, payment_rail, category_id, impact_bucket,
                 purpose_text, instrument_entity_id, quantity, price_minor,
                 status, confidence, reverses_transaction_id, created_at
            FROM transactions;
        DROP TABLE transactions;
        ALTER TABLE transactions_new RENAME TO transactions;
        CREATE INDEX IF NOT EXISTS idx_txn_fy ON transactions(fy_key);
        CREATE INDEX IF NOT EXISTS idx_txn_occurred ON transactions(occurred_at);
        CREATE INDEX IF NOT EXISTS idx_txn_direction ON transactions(direction);
      `);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  // entity_aliases gains status/confidence/last_seen_at, and the alias_type
  // backfill that v4 could not do: rows written before typed aliases existed
  // were all stamped 'name_variant', including obvious emails and phone
  // numbers (a real vault had an email and a 10-digit mobile as name_variant).
  // Re-classifying them here is what makes identifier matching reach the
  // history, not just new documents.
  //
  // The classifier below is a FROZEN SNAPSHOT of identity.ts's
  // classifyIdentifier. Migrations must not drift with live code — a future
  // tweak to identifier rules must not silently rewrite old vaults — so the
  // regexes are deliberately duplicated here rather than imported.
  const aliasCols2 = columnsOf(db, "entity_aliases");
  if (aliasCols2.size && !aliasCols2.has("status")) {
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
          status     TEXT NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('proposed','confirmed','rejected')),
          confidence REAL,
          created_at TEXT NOT NULL,
          last_seen_at TEXT
        );
        INSERT INTO entity_aliases_new
          (id, entity_id, kind, alias, normalised, alias_type, source, status, confidence, created_at, last_seen_at)
          SELECT id, entity_id, kind, alias, normalised, alias_type, source,
                 'confirmed', NULL, created_at, NULL
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

  // alias_type re-classification runs OUTSIDE the rebuild guard: a vault that
  // already took the rebuild in an earlier beta still needs its rows typed.
  // Idempotent — only name_variant rows that classify as something else move.
  if (columnsOf(db, "entity_aliases").has("alias_type")) {
    const rows = db
      .prepare("SELECT id, alias FROM entity_aliases WHERE alias_type='name_variant'")
      .all() as { id: number; alias: string }[];
    const upd = db.prepare("UPDATE entity_aliases SET alias_type=? WHERE id=?");
    for (const r of rows) {
      const v = r.alias.trim();
      let type: string | null = null;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) type = "email";
      else if (/^(\+?91|0)?\d{10}$/.test(v.replace(/[\s-]/g, ""))) type = "phone";
      else if (/^[^\s@]+@[^\s@.]+$/.test(v)) type = "handle";
      if (type) upd.run(type, r.id);
    }
  }

  // ── v7 → v8: intake_events gains work order 06 provenance columns ──
  // The table already exists for every v2+ vault; we ADD columns in place
  // rather than rebuild, because intake_events is append-only history and a
  // rebuild would risk losing rows. Each new column defaults safely so old
  // rows remain readable. The CHECK on `kind` cannot be altered in place, so
  // we widen it via the documented rebuild-table pattern ONLY when the old
  // CHECK is missing 'accepted' — detected by trying a probe insert rolled
  // back immediately. Most vaults skip the rebuild entirely.
  const intakeCols = columnsOf(db, "intake_events");
  const addIntakeCol = (name: string, decl: string) => {
    if (intakeCols.size && !intakeCols.has(name)) {
      db.exec(`ALTER TABLE intake_events ADD COLUMN ${name} ${decl}`);
    }
  };
  addIntakeCol("source_reference", "TEXT");
  addIntakeCol("original_filename", "TEXT");
  addIntakeCol("received_path", "TEXT");
  addIntakeCol("consume_source", "INTEGER NOT NULL DEFAULT 0");
  addIntakeCol("mime_type", "TEXT");
  addIntakeCol("byte_size", "INTEGER");
  addIntakeCol("reason_code", "TEXT");
  addIntakeCol("reason", "TEXT");
  addIntakeCol("confidence", "TEXT");
  addIntakeCol("matched_document_id", "TEXT");
  addIntakeCol("canonical_path", "TEXT");
  addIntakeCol("processing_state", "TEXT NOT NULL DEFAULT 'received'");
  addIntakeCol("signals_json", "TEXT");
  addIntakeCol("triage_review", "INTEGER NOT NULL DEFAULT 0");
  addIntakeCol("updated_at", "TEXT");

  // Widen the `kind` CHECK to accept 'accepted' (work order 06 disposition
  // vocabulary). Pre-v8 vaults only allow 'added','duplicate','irrelevant',
  // 'failed'. Detected with a rolled-back probe so we never persist junk.
  if (intakeCols.size) {
    let needsRebuild = false;
    try {
      db.exec("BEGIN");
      try {
        db.prepare("INSERT INTO intake_events (kind, filename, source, created_at) VALUES ('accepted','probe','probe','probe')").run();
        needsRebuild = false;
      } catch {
        needsRebuild = true;
      } finally {
        db.exec("ROLLBACK");
      }
    } catch {
      // BEGIN failed for some reason — skip rebuild, DDL CREATE TABLE IF NOT
      // EXISTS will be a no-op and the existing CHECK stays. New 'accepted'
      // writes would then fail at runtime, which is loud and recoverable.
      needsRebuild = false;
    }
    if (needsRebuild) {
      db.exec("BEGIN");
      try {
        db.exec(`
          CREATE TABLE intake_events_new (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            kind               TEXT NOT NULL CHECK (kind IN ('added','accepted','duplicate','irrelevant','failed')),
            filename           TEXT NOT NULL,
            sha256             TEXT,
            document_id        TEXT,
            source             TEXT NOT NULL DEFAULT 'folder',
            detail             TEXT,
            created_at         TEXT NOT NULL,
            source_reference   TEXT,
            original_filename  TEXT,
            received_path      TEXT,
            mime_type          TEXT,
            byte_size          INTEGER,
            reason_code        TEXT,
            reason             TEXT,
            confidence         TEXT,
            matched_document_id TEXT,
            canonical_path     TEXT,
            processing_state   TEXT NOT NULL DEFAULT 'received'
                               CHECK (processing_state IN ('received','stable','hashed','triaged','archived','queued','processing','complete','failed')),
            signals_json       TEXT,
            triage_review      INTEGER NOT NULL DEFAULT 0,
            updated_at         TEXT
          );
          INSERT INTO intake_events_new
            (id, kind, filename, sha256, document_id, source, detail, created_at,
             source_reference, original_filename, received_path, mime_type, byte_size,
             reason_code, reason, confidence, matched_document_id, canonical_path,
             processing_state, signals_json, triage_review, updated_at)
          SELECT
            id, kind, filename, sha256, document_id, source, detail, created_at,
            NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL,
            'received', NULL, 0, NULL
          FROM intake_events;
          DROP TABLE intake_events;
          ALTER TABLE intake_events_new RENAME TO intake_events;
          CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_events(created_at);
          CREATE INDEX IF NOT EXISTS idx_intake_kind ON intake_events(kind);
          CREATE INDEX IF NOT EXISTS idx_intake_sha ON intake_events(sha256);
          CREATE INDEX IF NOT EXISTS idx_intake_doc ON intake_events(document_id);
        `);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  // ── v8 → v9: idempotent evidence key (work order 07 §A2) ──────────────────
  // A unique index on (document_id, evidence_role) prevents a retry, restart,
  // or manual reprocess from creating a second transaction for the same
  // document. Pre-v9 vaults may have duplicate evidence rows from the bug this
  // fixes; the migration deduplicates them before creating the unique index,
  // keeping the FIRST transaction for each (document_id, evidence_role) and
  // deleting the later duplicates (their legs and holdings cascade).
  //
  // The dedup is conservative: it only removes rows where a SECOND transaction
  // exists for the same (document_id, evidence_role), leaving the original
  // intact. User corrections on the duplicate transactions are lost — but
  // those transactions were economic errors (double-counted money) and their
  // claims should not survive.
  if (columnsOf(db, "transaction_documents").size) {
    // Deduplicate before adding the unique index. A pre-v9 vault that hit the
    // re-analysis bug has rows like:
    //   (txn_a, doc_1, 'contract_note') and (txn_b, doc_1, 'contract_note')
    // Keep the FIRST (lowest linked_at / earliest created), delete the rest.
    db.exec(`
      DELETE FROM transaction_documents
       WHERE rowid IN (
         SELECT td.rowid
           FROM transaction_documents td
           JOIN (
             SELECT document_id, evidence_role, MIN(rowid) AS keep_rowid
               FROM transaction_documents
           GROUP BY document_id, evidence_role
           HAVING COUNT(*) > 1
           ) d
             ON td.document_id = d.document_id
            AND td.evidence_role = d.evidence_role
          WHERE td.rowid <> d.keep_rowid
       );
    `);
    // Now safe to create the unique index.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_txndoc_evidence_key
        ON transaction_documents(document_id, evidence_role)
    `);
  }

  // ── v8 → v9: intake stall-detection columns (work order 07 §B3) ──────────
  // Add the columns in place; intake_events is append-only history and a
  // rebuild would risk losing rows. Each new column defaults safely so old
  // rows remain readable.
  const intakeColsV9 = columnsOf(db, "intake_events");
  const addIntakeColV9 = (name: string, decl: string) => {
    if (intakeColsV9.size && !intakeColsV9.has(name)) {
      db.exec(`ALTER TABLE intake_events ADD COLUMN ${name} ${decl}`);
    }
  };
  addIntakeColV9("stage_started_at", "TEXT");
  addIntakeColV9("heartbeat_at", "TEXT");
  addIntakeColV9("finished_at", "TEXT");
  addIntakeColV9("last_error", "TEXT");
  addIntakeColV9("retry_count", "INTEGER NOT NULL DEFAULT 0");
  addIntakeColV9("next_retry_at", "TEXT");

  // ── v9 → v10: password_needed state for encrypted PDFs ───────────────────
  // Widen the processing_state CHECK to accept 'password_needed'. A document
  // that fails conversion because it's encrypted sits in this state until the
  // user provides a password. Detected with a rolled-back probe.
  // Also add a `password` column to documents for user-provided passwords.
  const docColsV10 = columnsOf(db, "documents");
  if (docColsV10.size && !docColsV10.has("password")) {
    db.exec("ALTER TABLE documents ADD COLUMN password TEXT");
  }

  const intakeColsV10 = columnsOf(db, "intake_events");
  if (intakeColsV10.size) {
    let needsRebuildV10 = false;
    try {
      db.exec("BEGIN");
      try {
        db.prepare(
          "INSERT INTO intake_events (kind, filename, source, created_at, processing_state) VALUES ('failed','probe','probe','probe','password_needed')",
        ).run();
        needsRebuildV10 = false;
      } catch {
        needsRebuildV10 = true;
      } finally {
        db.exec("ROLLBACK");
      }
    } catch {
      needsRebuildV10 = false;
    }
    if (needsRebuildV10) {
      db.exec("BEGIN");
      try {
        // Rebuild with the widened CHECK. Copy all existing columns and data.
        db.exec(`
          CREATE TABLE intake_events_new (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            kind               TEXT NOT NULL CHECK (kind IN ('added','accepted','duplicate','irrelevant','failed')),
            filename           TEXT NOT NULL,
            sha256             TEXT,
            document_id        TEXT,
            source             TEXT NOT NULL DEFAULT 'folder',
            detail             TEXT,
            created_at         TEXT NOT NULL,
            source_reference   TEXT,
            original_filename  TEXT,
            received_path      TEXT,
            mime_type          TEXT,
            byte_size          INTEGER,
            reason_code        TEXT,
            reason             TEXT,
            confidence         TEXT,
            matched_document_id TEXT,
            canonical_path     TEXT,
            processing_state   TEXT NOT NULL DEFAULT 'received'
                               CHECK (processing_state IN ('received','stable','hashed','triaged','archived','queued','processing','complete','failed','password_needed')),
            signals_json       TEXT,
            triage_review      INTEGER NOT NULL DEFAULT 0,
            updated_at         TEXT,
            stage_started_at   TEXT,
            heartbeat_at       TEXT,
            finished_at        TEXT,
            last_error         TEXT,
            retry_count        INTEGER NOT NULL DEFAULT 0,
            next_retry_at      TEXT
          );
          INSERT INTO intake_events_new
            SELECT * FROM intake_events;
          DROP TABLE intake_events;
          ALTER TABLE intake_events_new RENAME TO intake_events;
          CREATE INDEX IF NOT EXISTS idx_intake_created ON intake_events(created_at);
          CREATE INDEX IF NOT EXISTS idx_intake_kind ON intake_events(kind);
          CREATE INDEX IF NOT EXISTS idx_intake_sha ON intake_events(sha256);
          CREATE INDEX IF NOT EXISTS idx_intake_doc ON intake_events(document_id);
        `);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  // ── v10 → v11: WO09 provenance + role-safe document parties ────────────
  // SQLite cannot widen the field_claims subject CHECK in place. Rebuild it
  // once, preserving every historical claim and giving pre-WO09 claims the
  // conservative ai-derived provenance defaults.
  const claimColsV11 = columnsOf(db, "field_claims");
  if (claimColsV11.size && !claimColsV11.has("provenance_ref")) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE field_claims_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subject_type TEXT NOT NULL CHECK (subject_type IN ('document','transaction','entity','document_party')),
          subject_id TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
          source TEXT NOT NULL CHECK (source IN ('ai','user','rule','import')),
          confidence REAL, provenance_ref TEXT, edited_at TEXT, edited_by TEXT,
          status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','confirmed','rejected','superseded')),
          created_at TEXT NOT NULL
        );
        INSERT INTO field_claims_new (id,subject_type,subject_id,field,value,source,confidence,status,created_at)
          SELECT id, CASE WHEN subject_type IN ('document','transaction','entity') THEN subject_type ELSE 'document' END,
                 subject_id,field,value,source,confidence,status,created_at FROM field_claims;
        DROP TABLE field_claims;
        ALTER TABLE field_claims_new RENAME TO field_claims;
        CREATE INDEX IF NOT EXISTS idx_claims_subject ON field_claims(subject_type, subject_id, field);
        CREATE INDEX IF NOT EXISTS idx_claims_live ON field_claims(subject_type, subject_id, field, status);
      `);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  const partyColsV11 = columnsOf(db, "document_parties");
  if (partyColsV11.size && !partyColsV11.has("provenance")) {
    db.exec("BEGIN");
    try {
      // Historical databases can contain one entity in more than one role.
      // Preserve the oldest role rather than inventing an assignment that a
      // user never made; later edits can deliberately re-role it.
      db.exec(`
        CREATE TABLE document_parties_new (
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('owner','counterparty','issuer','source_of_funds')),
          confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence>=0 AND confidence<=1),
          provenance TEXT NOT NULL DEFAULT 'ai-derived' CHECK(provenance IN ('ai-derived','user-confirmed','rule-derived')),
          PRIMARY KEY(document_id,entity_id,role), UNIQUE(document_id,entity_id)
        );
        INSERT INTO document_parties_new(document_id,entity_id,role)
          SELECT document_id,entity_id,MIN(role) FROM document_parties GROUP BY document_id,entity_id;
        DROP TABLE document_parties;
        ALTER TABLE document_parties_new RENAME TO document_parties;
      `);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  // ── v11 → v12: learning metadata and durable canonical pipeline tables ─
  const reviewCols = columnsOf(db, "training_reviews");
  for (const [name, decl] of [["dedupe_key", "TEXT"], ["novelty_score", "REAL"], ["predicted_rule", "TEXT"], ["why", "TEXT"], ["backoff_until", "TEXT"]] as const) {
    if (reviewCols.size && !reviewCols.has(name)) db.exec(`ALTER TABLE training_reviews ADD COLUMN ${name} ${decl}`);
  }
  if (reviewCols.size) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_training_dedupe ON training_reviews(dedupe_key) WHERE dedupe_key IS NOT NULL");

  // ── v12 → v13: document lifecycle (WO09/WO10 P4.5 manage footer) ─────────
  // Adds a soft-delete/remove state so the Glaze detail footer's "Remove from
  // active" and "Delete permanently" have durable backing. Pre-v13 rows are
  // 'active'. SQLite cannot add a CHECK constraint to an existing column via
  // ALTER, so the added column carries the default and the CHECK is enforced
  // on fresh databases by the DDL above; the value set is guarded in code.
  const docColsV13 = columnsOf(db, "documents");
  if (docColsV13.size && !docColsV13.has("lifecycle")) {
    db.exec("ALTER TABLE documents ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'");
    db.exec("CREATE INDEX IF NOT EXISTS idx_documents_lifecycle ON documents(lifecycle)");
  }

  // ── v13 → v14: evidence_role CHECK constraint on transaction_documents ──
  // SQLite cannot ALTER a CHECK constraint onto an existing column. We use
  // an app_settings flag to track whether the rebuild has been done.
  // The app_settings table is created by the DDL (which runs AFTER migrate),
  // so we must guard against its absence.
  let needsRebuildV14 = false;
  try {
    const flagRow = db.prepare("SELECT value FROM app_settings WHERE key='td_evidence_role_checked'").get() as { value?: string } | undefined;
    if (!flagRow) needsRebuildV14 = true;
  } catch {
    // app_settings table doesn't exist yet (fresh DB pre-DDL) — table will
    // be created fresh by DDL with the CHECK, no rebuild needed.
    needsRebuildV14 = false;
  }
  const tdCols = columnsOf(db, "transaction_documents");
  if (needsRebuildV14 && tdCols.size > 0) {
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE transaction_documents_new (
          transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
          document_id    TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          evidence_role  TEXT NOT NULL CHECK (evidence_role IN (
            'merchant_invoice', 'payment_receipt', 'bank_slip',
            'card_confirmation', 'statement_line', 'refund_note', 'contract_note'
          )),
          match_score    REAL,
          linked_by      TEXT NOT NULL DEFAULT 'ai',
          linked_at      TEXT NOT NULL,
          PRIMARY KEY (transaction_id, document_id)
        )
      `);
      db.exec(`
        INSERT INTO transaction_documents_new
          (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
        SELECT
          transaction_id, document_id,
          CASE
            WHEN evidence_role IN ('merchant_invoice','payment_receipt','bank_slip','card_confirmation','statement_line','refund_note','contract_note')
            THEN evidence_role
            ELSE 'payment_receipt'
          END,
          match_score, linked_by, linked_at
        FROM transaction_documents
      `);
      db.exec("DROP TABLE transaction_documents");
      db.exec("ALTER TABLE transaction_documents_new RENAME TO transaction_documents");
      db.exec("CREATE INDEX IF NOT EXISTS idx_txndocs_doc ON transaction_documents(document_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_txndoc_evidence_key ON transaction_documents(document_id, evidence_role)");
      db.exec("COMMIT");
      db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('td_evidence_role_checked','1')").run();
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
