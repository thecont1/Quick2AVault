/**
 * Local document database (node:sqlite, built-in).
 *
 * Stores one record per ingested file so we can detect duplicates and show a
 * history of everything the vault has processed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app, logger } from "@glaze/core/backend";

/** Outcome of foreign-currency detection for a document. */
export type CurrencyStatus = "none" | "converted" | "needs_review";

/**
 * Where a document sits in its lifecycle:
 *  - active               → a relevant financial document in normal analysis
 *  - irrelevant           → triaged as clearly non-financial; kept but not analyzed
 *  - excluded             → user removed it from active analysis (raw file kept)
 *  - reprocess_requested  → user asked to reprocess it (picked up by the queue)
 */
export type LifecycleState = "active" | "irrelevant" | "excluded" | "reprocess_requested";

export const LIFECYCLE_STATES: LifecycleState[] = [
  "active",
  "irrelevant",
  "excluded",
  "reprocess_requested",
];

/** Foreign-currency conversion fields stored alongside a document record. */
export interface CurrencyFields {
  foreignAmount: number | null;
  foreignCurrency: string | null;
  invoiceDate: string | null;
  inrValue: number | null;
  rateUsed: number | null;
  rateDate: string | null;
  rateIsNearest: boolean;
  currencyStatus: CurrencyStatus;
}

// ── Accounting policy hints (advisory, not bookkeeping truth) ─────────────

/** Whether a document represents money going out (expense) or coming in (income). */
export type AccountingFlow = "expense" | "income" | "unknown";

/** A suggested accounting treatment — a hint, never a booked entry. */
export type AccountingTreatment =
  | "current_period_expense"
  | "prepaid_expense"
  | "accrued_expense"
  | "deferred_revenue"
  | "recognized_revenue"
  | "reimbursement"
  | "needs_accounting_review";

export const ACCOUNTING_TREATMENTS: AccountingTreatment[] = [
  "current_period_expense",
  "prepaid_expense",
  "accrued_expense",
  "deferred_revenue",
  "recognized_revenue",
  "reimbursement",
  "needs_accounting_review",
];

/**
 * The app's advisory accounting interpretation of a document — kept separate
 * from the raw extracted facts. Presented as a suggestion with confidence and
 * evidence, never as final accounting truth.
 */
export interface AccountingHint {
  flow: AccountingFlow;
  treatment: AccountingTreatment;
  /** 0..1 confidence in the suggested treatment. */
  confidence: number;
  /** Short human-readable reason for the suggested treatment. */
  reason: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  paymentDate: string | null;
  source: FieldSource;
}

// ── Financial impact (what changed in the user's financial world) ─────────

/**
 * The meaningful "bucket" a recognized document (or a manual recurring entry)
 * feeds into. This is a financial-organization signal, NOT a ledger account —
 * it answers "what did this change in my money life?" in plain terms.
 */
export type ImpactBucket =
  | "income"
  | "household_expense"
  | "shared_family_expense"
  | "business_expense"
  | "software_utility_expense"
  | "personal_expense"
  | "shopping_discretionary"
  | "investment_purchase"
  | "investment_sale"
  | "liability_dues"
  | "tax_statutory"
  | "transfer_neutral"
  | "needs_review";

export const IMPACT_BUCKETS: ImpactBucket[] = [
  "income",
  "household_expense",
  "shared_family_expense",
  "business_expense",
  "software_utility_expense",
  "personal_expense",
  "shopping_discretionary",
  "investment_purchase",
  "investment_sale",
  "liability_dues",
  "tax_statutory",
  "transfer_neutral",
  "needs_review",
];

/** Whether the impact adds money in, sends money out, or is a neutral movement. */
export type ImpactDirection = "in" | "out" | "neutral";

/**
 * The app's plain-language financial interpretation of a document: which bucket
 * it feeds, how confident we are, and the canonical INR amount it moves. Framed
 * as a signal ("this looks like income"), never a booked accounting entry.
 */
export interface FinancialImpact {
  bucket: ImpactBucket;
  /** 0..1 confidence — low confidence renders as a suggestion ("Looks like…"). */
  confidence: number;
  direction: ImpactDirection;
  /** Canonical INR amount this document moves (for summary totals), or null. */
  amountInr: number | null;
  /** Coarse extraction category persisted for watch-category rollups. */
  spendCategory?: string | null;
  /** User-facing watch category, including custom labels, when detected. */
  watchCategory?: string | null;
  /** Short human-readable reason for the bucket. */
  reason: string;
  source: FieldSource;
}

export interface DocumentRecord extends CurrencyFields {
  id: number;
  hash: string;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
  /** Extracted primary document date (YYYY-MM-DD), or null when unknown. */
  documentDate: string | null;
  /** Financial-year key this document is classified into (e.g. "2025-26"). */
  financialYear: string | null;
  /** Advisory accounting treatment hint, or null when not applicable. */
  accounting: AccountingHint | null;
  /** Plain-language financial impact, or null when not a financial transaction. */
  impact: FinancialImpact | null;
  /** True when this document is a stock-broker contract note (securities trade). */
  isContractNote: boolean;
  /** Intake triage lane / lifecycle state (defaults to "active"). */
  lifecycleState: LifecycleState;
  /** One-line human explanation of the triage decision, or null. */
  triageReason: string | null;
}

/** A securities trade line item extracted from a broker contract note. */
export interface ContractNoteTrade {
  id: number;
  docId: number;
  securityName: string;
  symbol: string | null;
  isin: string | null;
  side: "buy" | "sell";
  quantity: number | null;
  price: number | null;
  netAmount: number | null;
}

/** The header/summary of a broker contract note (one row per contract-note document). */
export interface ContractNoteRecord {
  docId: number;
  broker: string | null;
  client: string | null;
  tradeDate: string | null;
  settlementDate: string | null;
  contractNoteNumber: string | null;
  /** Net amount payable(+) / receivable(-) by the client, in INR. */
  netAmount: number | null;
  totalCharges: number | null;
  /** Overall direction of the note: mostly buys (purchase) or sells (sale). */
  side: "buy" | "sell" | "mixed";
  trades: ContractNoteTrade[];
}

/** How often a manual recurring entry repeats. */
export type RecurringFrequency = "monthly" | "quarterly" | "annually" | "weekly" | "custom";

export const RECURRING_FREQUENCIES: RecurringFrequency[] = [
  "monthly",
  "quarterly",
  "annually",
  "weekly",
  "custom",
];

/** Business / personal / shared classification for an entry. */
export type EntryScope = "business" | "personal" | "shared";

export const ENTRY_SCOPES: EntryScope[] = ["business", "personal", "shared"];

/**
 * A manually-entered recurring financial item (salary, rent, SIP, EMI, …). It
 * participates in the financial picture alongside document-derived events, but
 * is always clearly marked as manual / recurring — never pretends a document
 * exists.
 */
export interface RecurringEntry {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: RecurringFrequency;
  startDate: string | null;
  endDate: string | null;
  person: string | null;
  impactBucket: ImpactBucket;
  scope: EntryScope;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewRecurringEntry = Omit<RecurringEntry, "id" | "createdAt" | "updatedAt">;

/** A logged exact-duplicate drop (same SHA-256 as an already-ingested document). */
export interface DuplicateEvent {
  id: number;
  hash: string;
  /** The visible filename the user dropped this time. */
  filename: string;
  /** Absolute source path of the dropped file (for reference only). */
  sourcePath: string | null;
  /** The document this is an exact duplicate of, or null if it's gone. */
  duplicateOfDocId: number | null;
  detectedAt: string;
  /** new = unacknowledged; acknowledged = user has seen and kept it ignored. */
  status: "new" | "acknowledged";
  reason: string;
}

/** The kinds of rule Training Mode / review corrections can learn. */
export type RuleType =
  | "vendor_category"
  | "person_variant"
  | "keyword_doctype"
  | "source_scope"
  | "accounting_treatment"
  | "impact_bucket";

/** A piece of evidence explaining why a rule exists. */
export interface RuleEvidence {
  filename: string;
  phrase?: string;
  docId?: number;
}

export interface LearnedRule {
  id: number;
  ruleType: RuleType;
  /** The thing matched in a document (vendor / name variant / keyword / source), lower-cased. */
  matchKey: string;
  /** What the rule concludes (category / canonical person / doc type / "business"|"personal"). */
  value: string;
  /** Rises by one each time the same rule is confirmed. */
  confidence: number;
  /** "confirmed" = learned from a Training answer; "manual" = added by hand in Settings. */
  source: "confirmed" | "manual";
  /** When true the rule is applied automatically without asking again. */
  autoApply: boolean;
  evidence: RuleEvidence[];
  createdAt: string;
  updatedAt: string;
}

// ── Canonical person ontology ────────────────────────────────────────────

/** The semantic role a person plays in the user's financial world. */
export type PersonRole =
  | "self"
  | "spouse"
  | "client"
  | "supplier"
  | "tax_officer"
  | "owner"
  | "tenant"
  | "landlord"
  | "insurer"
  | "employee"
  | "consultant"
  | "bank_rm"
  | "accountant"
  | "other";

export const PERSON_ROLES: PersonRole[] = [
  "self",
  "spouse",
  "client",
  "supplier",
  "tax_officer",
  "owner",
  "tenant",
  "landlord",
  "insurer",
  "employee",
  "consultant",
  "bank_rm",
  "accountant",
  "other",
];

/**
 * Where a given field's value came from, in ascending authority. AI guesses may
 * only overwrite `ai_inferred` fields — never a `learned_rule`, `user_confirmed`,
 * or `manual` value.
 */
export type FieldSource = "ai_inferred" | "learned_rule" | "user_confirmed" | "manual";

const SOURCE_RANK: Record<FieldSource, number> = {
  ai_inferred: 0,
  learned_rule: 1,
  user_confirmed: 2,
  manual: 3,
};

/** True when a value from `next` is allowed to overwrite one currently held at `current`. */
export function canOverwrite(current: FieldSource, next: FieldSource): boolean {
  return SOURCE_RANK[next] >= SOURCE_RANK[current];
}

/** How a document/name came to be linked to a person (for explainability). */
export type PersonEvidenceKind =
  | "matched_alias"
  | "reordered_name"
  | "initials"
  | "learned_rule"
  | "training_answer"
  | "recurring_vendor"
  | "manual"
  | "ai_inferred"
  | "merge"
  | "split";

export interface PersonAlias {
  id: number;
  personId: number;
  /** Display form of the alias (as first seen). */
  alias: string;
  /** Normalized key used for matching (lower-cased, punctuation-stripped). */
  normalized: string;
  source: FieldSource;
}

export interface PersonEvidence {
  id: number;
  personId: number;
  kind: PersonEvidenceKind;
  /** Human-readable explanation of why this link exists. */
  detail: string;
  docId: number | null;
  createdAt: string;
}

export interface PersonRecord {
  id: number;
  displayName: string;
  roles: PersonRole[];
  isSelf: boolean;
  /** 0..1 confidence that this canonical person is a real, correctly-resolved identity. */
  confidence: number;
  nameSource: FieldSource;
  rolesSource: FieldSource;
  /** "candidate" until the user confirms it; "confirmed" once user-touched. */
  status: "candidate" | "confirmed";
  createdAt: string;
  updatedAt: string;
}

export type TrainingReviewStatus = "pending" | "answered" | "skipped" | "auto";

export interface TrainingReviewRecord {
  docId: number;
  status: TrainingReviewStatus;
  /** JSON-encoded question set generated for this document. */
  questions: string;
  /** JSON-encoded answers once the user responds, else null. */
  answers: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Field-level document review ─────────────────────────────────────────

/** The document-intelligence fields tracked for review. */
export type ReviewField =
  | "person"
  | "doc_type"
  | "vendor"
  | "doc_date"
  | "fin_year"
  | "amount"
  | "fx"
  | "accounting"
  | "impact";

export const REVIEW_FIELDS: ReviewField[] = [
  "person",
  "doc_type",
  "vendor",
  "doc_date",
  "fin_year",
  "amount",
  "fx",
  "accounting",
  "impact",
];

/**
 * The review state of a single field. The first three are "pending" (they need
 * the user's attention); the last two are resolved outcomes.
 */
export type ReviewStatus = "low_confidence" | "conflict" | "missing" | "confirmed" | "corrected";

/** Statuses that keep a field (and its document) in the Review Queue. */
export const PENDING_REVIEW_STATUSES: ReviewStatus[] = ["low_confidence", "conflict", "missing"];

export interface DocumentFieldReview {
  id: number;
  docId: number;
  field: ReviewField;
  /** The value the app originally extracted (display string), or null when missing. */
  extractedValue: string | null;
  /** 0..1 confidence in the extracted value. */
  confidence: number;
  /** Authority of the current value (AI vs rule vs user). */
  source: FieldSource;
  /** Short human-readable reason/evidence explaining the flag. */
  reason: string;
  /** The app's current suggested resolution (usually the extracted value). */
  suggestedValue: string | null;
  /** The value after the user reviewed it (null until resolved). */
  finalValue: string | null;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
}

/** One entry in a field's audit trail. */
export type ReviewAction = "flagged" | "confirmed" | "corrected" | "deferred";

export interface ReviewAuditEntry {
  id: number;
  docId: number;
  field: ReviewField;
  action: ReviewAction;
  oldValue: string | null;
  newValue: string | null;
  confidence: number | null;
  source: FieldSource | null;
  at: string;
}

export interface NewDocument {
  hash: string;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
  /** Foreign-currency conversion computed at ingestion, if any. */
  currency?: CurrencyFields;
  /** Primary document date (YYYY-MM-DD) extracted at ingestion. */
  documentDate?: string | null;
  /** Financial-year key classified at ingestion. */
  financialYear?: string | null;
  /** Advisory accounting hint computed at ingestion. */
  accounting?: AccountingHint | null;
  /** Plain-language financial impact computed at ingestion. */
  impact?: FinancialImpact | null;
  /** True when the document is a broker contract note. */
  isContractNote?: boolean;
  /** Intake triage lane (defaults to "active"). */
  lifecycleState?: LifecycleState;
  /** One-line explanation of the triage decision. */
  triageReason?: string | null;
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;

  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, "quick2afvault.db");

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      date_ingested TEXT NOT NULL,
      date_folder TEXT NOT NULL,
      markdown_success INTEGER NOT NULL,
      raw_path TEXT NOT NULL,
      markdown_path TEXT NOT NULL
    );
  `);
  // Single-row cache of the most recent AI financial snapshot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `);
  // Manual corrections the user makes to the AI's attribution:
  //  - person_name_overrides maps one person name onto another (rename / merge).
  //  - document_overrides pins a single document to a person (NULL = unidentified).
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_name_overrides (
      from_name TEXT PRIMARY KEY,
      to_name TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_overrides (
      doc_id INTEGER PRIMARY KEY,
      person TEXT
    );
  `);
  // Local cache of fetched historical exchange rates, keyed by currency + the
  // requested (invoice) date, so the same combination is never fetched twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rate_cache (
      currency TEXT NOT NULL,
      req_date TEXT NOT NULL,
      rate REAL NOT NULL,
      rate_date TEXT NOT NULL,
      is_nearest INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (currency, req_date)
    );
  `);
  // Generic key/value app settings (e.g. Training Mode on/off).
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Rules the app has learned from Training Mode answers. One row per
  // (rule_type, match_key); confidence rises each time the same rule is
  // confirmed, and evidence records why the rule exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_type TEXT NOT NULL,
      match_key TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL,
      auto_apply INTEGER NOT NULL DEFAULT 0,
      evidence TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (rule_type, match_key)
    );
  `);
  // One row per document that passed through Training Mode, holding its
  // generated questions and (once answered) the user's answers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_reviews (
      doc_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      questions TEXT NOT NULL DEFAULT '[]',
      answers TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Field-level review: one row per (document, field) tracking what the app
  // extracted, how confident it was, and whether it still needs the user's eyes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_field_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      extracted_value TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'ai_inferred',
      reason TEXT NOT NULL DEFAULT '',
      suggested_value TEXT,
      final_value TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (doc_id, field)
    );
  `);
  // Append-only audit trail of every review action (flag / confirm / correct /
  // defer), preserving the original extraction and each correction over time.
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      field TEXT NOT NULL,
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      confidence REAL,
      source TEXT,
      at TEXT NOT NULL
    );
  `);
  // Canonical Person ontology: one row per real person, with their known
  // aliases (name variants) and the evidence explaining every link.
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      roles TEXT NOT NULL DEFAULT '[]',
      is_self INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.6,
      name_source TEXT NOT NULL DEFAULT 'ai_inferred',
      roles_source TEXT NOT NULL DEFAULT 'ai_inferred',
      status TEXT NOT NULL DEFAULT 'candidate',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      normalized TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'ai_inferred',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT NOT NULL,
      doc_id INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  // Add the foreign-currency columns to older document tables (idempotent).
  // Log of exact-duplicate drops (same content hash as an already-ingested doc).
  // Kept lightweight so duplicates can surface in review/history without being
  // re-processed or bloating the vault.
  db.exec(`
    CREATE TABLE IF NOT EXISTS duplicate_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      filename TEXT NOT NULL,
      source_path TEXT,
      duplicate_of_doc_id INTEGER,
      detected_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      reason TEXT NOT NULL DEFAULT ''
    );
  `);
  // Broker contract notes: one header row per contract-note document, plus one
  // row per traded security. Kept as document-driven trade activity, not a
  // portfolio ledger (no mark-to-market).
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_notes (
      doc_id INTEGER PRIMARY KEY,
      broker TEXT,
      client TEXT,
      trade_date TEXT,
      settlement_date TEXT,
      contract_note_number TEXT,
      net_amount REAL,
      total_charges REAL,
      side TEXT NOT NULL DEFAULT 'buy',
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contract_note_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      security_name TEXT NOT NULL,
      symbol TEXT,
      isin TEXT,
      side TEXT NOT NULL DEFAULT 'buy',
      quantity REAL,
      price REAL,
      net_amount REAL
    );
  `);
  // Manually-entered recurring income/expenses (salary, rent, SIP, EMI, …).
  db.exec(`
    CREATE TABLE IF NOT EXISTS recurring_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      frequency TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      person TEXT,
      impact_bucket TEXT NOT NULL,
      scope TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureCurrencyColumns(db);
  logger.info("database", "Document database ready", { dbPath });
  return db;
}

/**
 * Add the later-added `documents` columns if they don't exist yet: the currency
 * conversion fields, plus the financial-year classification and accounting hint.
 */
function ensureCurrencyColumns(database: DatabaseSync): void {
  const existing = new Set(
    (database.prepare("PRAGMA table_info(documents)").all() as Row[]).map((r) => String(r.name)),
  );
  const columns: [string, string][] = [
    ["foreign_amount", "REAL"],
    ["foreign_currency", "TEXT"],
    ["invoice_date", "TEXT"],
    ["inr_value", "REAL"],
    ["rate_used", "REAL"],
    ["rate_date", "TEXT"],
    ["rate_is_nearest", "INTEGER"],
    ["currency_status", "TEXT"],
    ["document_date", "TEXT"],
    ["financial_year", "TEXT"],
    ["accounting_json", "TEXT"],
    ["impact_json", "TEXT"],
    ["is_contract_note", "INTEGER"],
    ["lifecycle_state", "TEXT"],
    ["triage_reason", "TEXT"],
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) database.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
  }
}

function parseAccounting(raw: unknown): AccountingHint | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as AccountingHint;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseImpact(raw: unknown): FinancialImpact | null {
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(String(raw)) as FinancialImpact;
    return parsed && typeof parsed === "object" && "bucket" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

function mapRow(row: Row): DocumentRecord {
  return {
    id: Number(row.id),
    hash: String(row.hash),
    originalFilename: String(row.original_filename),
    fileType: String(row.file_type),
    dateIngested: String(row.date_ingested),
    dateFolder: String(row.date_folder),
    markdownSuccess: Number(row.markdown_success) === 1,
    rawPath: String(row.raw_path),
    markdownPath: String(row.markdown_path),
    foreignAmount: row.foreign_amount == null ? null : Number(row.foreign_amount),
    foreignCurrency: row.foreign_currency == null ? null : String(row.foreign_currency),
    invoiceDate: row.invoice_date == null ? null : String(row.invoice_date),
    inrValue: row.inr_value == null ? null : Number(row.inr_value),
    rateUsed: row.rate_used == null ? null : Number(row.rate_used),
    rateDate: row.rate_date == null ? null : String(row.rate_date),
    rateIsNearest: Number(row.rate_is_nearest) === 1,
    currencyStatus:
      row.currency_status == null ? "none" : (String(row.currency_status) as CurrencyStatus),
    documentDate: row.document_date == null ? null : String(row.document_date),
    financialYear: row.financial_year == null ? null : String(row.financial_year),
    accounting: parseAccounting(row.accounting_json),
    impact: parseImpact(row.impact_json),
    isContractNote: Number(row.is_contract_note) === 1,
    lifecycleState:
      row.lifecycle_state == null ? "active" : (String(row.lifecycle_state) as LifecycleState),
    triageReason: row.triage_reason == null ? null : String(row.triage_reason),
  };
}

/** Return an existing record for this content hash, or null if unseen. */
export function findByHash(hash: string): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE hash = ?").get(hash) as
    | Row
    | undefined;
  return row ? mapRow(row) : null;
}

export function insertDocument(doc: NewDocument): DocumentRecord {
  const c: CurrencyFields = doc.currency ?? {
    foreignAmount: null,
    foreignCurrency: null,
    invoiceDate: null,
    inrValue: null,
    rateUsed: null,
    rateDate: null,
    rateIsNearest: false,
    currencyStatus: "none",
  };
  const documentDate = doc.documentDate ?? null;
  const financialYear = doc.financialYear ?? null;
  const accounting = doc.accounting ?? null;
  const impact = doc.impact ?? null;
  const isContractNote = doc.isContractNote ?? false;
  const lifecycleState = doc.lifecycleState ?? "active";
  const triageReason = doc.triageReason ?? null;
  const stmt = getDb().prepare(`
    INSERT INTO documents
      (hash, original_filename, file_type, date_ingested, date_folder, markdown_success, raw_path, markdown_path,
       foreign_amount, foreign_currency, invoice_date, inr_value, rate_used, rate_date, rate_is_nearest, currency_status,
       document_date, financial_year, accounting_json, impact_json, is_contract_note, lifecycle_state, triage_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    doc.hash,
    doc.originalFilename,
    doc.fileType,
    doc.dateIngested,
    doc.dateFolder,
    doc.markdownSuccess ? 1 : 0,
    doc.rawPath,
    doc.markdownPath,
    c.foreignAmount,
    c.foreignCurrency,
    c.invoiceDate,
    c.inrValue,
    c.rateUsed,
    c.rateDate,
    c.rateIsNearest ? 1 : 0,
    c.currencyStatus,
    documentDate,
    financialYear,
    accounting ? JSON.stringify(accounting) : null,
    impact ? JSON.stringify(impact) : null,
    isContractNote ? 1 : 0,
    lifecycleState,
    triageReason,
  );
  return {
    id: Number(info.lastInsertRowid),
    hash: doc.hash,
    originalFilename: doc.originalFilename,
    fileType: doc.fileType,
    dateIngested: doc.dateIngested,
    dateFolder: doc.dateFolder,
    markdownSuccess: doc.markdownSuccess,
    rawPath: doc.rawPath,
    markdownPath: doc.markdownPath,
    ...c,
    documentDate,
    financialYear,
    accounting,
    impact,
    isContractNote,
    lifecycleState,
    triageReason,
  };
}

/** Update a document's classification fields (document date, FY, accounting hint) in place. */
export function updateDocumentClassification(
  docId: number,
  patch: {
    documentDate?: string | null;
    financialYear?: string | null;
    accounting?: AccountingHint | null;
    impact?: FinancialImpact | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if ("documentDate" in patch) {
    sets.push("document_date = ?");
    values.push(patch.documentDate ?? null);
  }
  if ("financialYear" in patch) {
    sets.push("financial_year = ?");
    values.push(patch.financialYear ?? null);
  }
  if ("accounting" in patch) {
    sets.push("accounting_json = ?");
    values.push(patch.accounting ? JSON.stringify(patch.accounting) : null);
  }
  if ("impact" in patch) {
    sets.push("impact_json = ?");
    values.push(patch.impact ? JSON.stringify(patch.impact) : null);
  }
  if (sets.length === 0) return;
  values.push(docId);
  getDb()
    .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as never[]));
}

/** Set a document's lifecycle state and (optionally) the human triage reason. */
export function setDocumentLifecycle(
  docId: number,
  state: LifecycleState,
  reason?: string | null,
): void {
  if (reason === undefined) {
    getDb().prepare("UPDATE documents SET lifecycle_state = ? WHERE id = ?").run(state, docId);
  } else {
    getDb()
      .prepare("UPDATE documents SET lifecycle_state = ?, triage_reason = ? WHERE id = ?")
      .run(state, reason ?? null, docId);
  }
}

/**
 * Update a document's record after a (re)process pass: markdown result + path,
 * currency, classification, lifecycle. Used when reprocessing an existing raw file.
 */
export function updateDocumentProcessing(
  docId: number,
  patch: {
    markdownSuccess?: boolean;
    markdownPath?: string;
    rawPath?: string;
    dateFolder?: string;
    currency?: CurrencyFields;
    documentDate?: string | null;
    financialYear?: string | null;
    accounting?: AccountingHint | null;
    impact?: FinancialImpact | null;
    isContractNote?: boolean;
    lifecycleState?: LifecycleState;
    triageReason?: string | null;
  },
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, val: unknown) => {
    sets.push(`${col} = ?`);
    values.push(val);
  };
  if (patch.markdownSuccess !== undefined) push("markdown_success", patch.markdownSuccess ? 1 : 0);
  if (patch.markdownPath !== undefined) push("markdown_path", patch.markdownPath);
  if (patch.rawPath !== undefined) push("raw_path", patch.rawPath);
  if (patch.dateFolder !== undefined) push("date_folder", patch.dateFolder);
  if (patch.currency) {
    const c = patch.currency;
    push("foreign_amount", c.foreignAmount);
    push("foreign_currency", c.foreignCurrency);
    push("invoice_date", c.invoiceDate);
    push("inr_value", c.inrValue);
    push("rate_used", c.rateUsed);
    push("rate_date", c.rateDate);
    push("rate_is_nearest", c.rateIsNearest ? 1 : 0);
    push("currency_status", c.currencyStatus);
  }
  if ("documentDate" in patch) push("document_date", patch.documentDate ?? null);
  if ("financialYear" in patch) push("financial_year", patch.financialYear ?? null);
  if ("accounting" in patch)
    push("accounting_json", patch.accounting ? JSON.stringify(patch.accounting) : null);
  if ("impact" in patch) push("impact_json", patch.impact ? JSON.stringify(patch.impact) : null);
  if (patch.isContractNote !== undefined) push("is_contract_note", patch.isContractNote ? 1 : 0);
  if (patch.lifecycleState !== undefined) push("lifecycle_state", patch.lifecycleState);
  if ("triageReason" in patch) push("triage_reason", patch.triageReason ?? null);
  if (sets.length === 0) return;
  values.push(docId);
  getDb()
    .prepare(`UPDATE documents SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as never[]));
}

/** Most-recently-ingested document sharing this exact original filename, if any. */
export function findLatestByFilename(filename: string): DocumentRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM documents WHERE original_filename = ? ORDER BY id DESC LIMIT 1")
    .get(filename) as Row | undefined;
  return row ? mapRow(row) : null;
}

/** Permanently remove a document row and its reviews/audit (files handled by caller). */
export function deleteDocumentRow(docId: number): void {
  const d = getDb();
  d.prepare("DELETE FROM document_field_reviews WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM review_audit WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM document_overrides WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM training_reviews WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM contract_notes WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM contract_note_trades WHERE doc_id = ?").run(docId);
  d.prepare("DELETE FROM documents WHERE id = ?").run(docId);
}

/** Ids of documents currently waiting to be reprocessed (user requested "later"). */
export function reprocessRequestedDocIds(): number[] {
  const rows = getDb()
    .prepare(
      "SELECT id FROM documents WHERE lifecycle_state = 'reprocess_requested' ORDER BY id ASC",
    )
    .all() as Row[];
  return rows.map((r) => Number(r.id));
}

// ── Duplicate events ──────────────────────────────────────────────────────

function mapDuplicateEvent(row: Row): DuplicateEvent {
  return {
    id: Number(row.id),
    hash: String(row.hash),
    filename: String(row.filename),
    sourcePath: row.source_path == null ? null : String(row.source_path),
    duplicateOfDocId: row.duplicate_of_doc_id == null ? null : Number(row.duplicate_of_doc_id),
    detectedAt: String(row.detected_at),
    status: String(row.status) === "acknowledged" ? "acknowledged" : "new",
    reason: String(row.reason ?? ""),
  };
}

export function insertDuplicateEvent(entry: {
  hash: string;
  filename: string;
  sourcePath: string | null;
  duplicateOfDocId: number | null;
  reason: string;
}): DuplicateEvent {
  const info = getDb()
    .prepare(
      `INSERT INTO duplicate_events (hash, filename, source_path, duplicate_of_doc_id, detected_at, status, reason)
       VALUES (?, ?, ?, ?, ?, 'new', ?)`,
    )
    .run(
      entry.hash,
      entry.filename,
      entry.sourcePath,
      entry.duplicateOfDocId,
      new Date().toISOString(),
      entry.reason,
    );
  return {
    id: Number(info.lastInsertRowid),
    hash: entry.hash,
    filename: entry.filename,
    sourcePath: entry.sourcePath,
    duplicateOfDocId: entry.duplicateOfDocId,
    detectedAt: new Date().toISOString(),
    status: "new",
    reason: entry.reason,
  };
}

export function listDuplicateEvents(): DuplicateEvent[] {
  const rows = getDb().prepare("SELECT * FROM duplicate_events ORDER BY id DESC").all() as Row[];
  return rows.map(mapDuplicateEvent);
}

/** How many duplicate events are still unacknowledged (drive the review badge). */
export function countNewDuplicateEvents(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM duplicate_events WHERE status = 'new'")
    .get() as Row;
  return Number(row.n);
}

export function setDuplicateEventStatus(id: number, status: DuplicateEvent["status"]): void {
  getDb().prepare("UPDATE duplicate_events SET status = ? WHERE id = ?").run(status, id);
}

export function deleteDuplicateEvent(id: number): void {
  getDb().prepare("DELETE FROM duplicate_events WHERE id = ?").run(id);
}

// ── Contract notes (broker securities trades) ─────────────────────────────

function mapTrade(row: Row): ContractNoteTrade {
  return {
    id: Number(row.id),
    docId: Number(row.doc_id),
    securityName: String(row.security_name),
    symbol: row.symbol == null ? null : String(row.symbol),
    isin: row.isin == null ? null : String(row.isin),
    side: String(row.side) === "sell" ? "sell" : "buy",
    quantity: row.quantity == null ? null : Number(row.quantity),
    price: row.price == null ? null : Number(row.price),
    netAmount: row.net_amount == null ? null : Number(row.net_amount),
  };
}

export interface NewContractNote {
  docId: number;
  broker: string | null;
  client: string | null;
  tradeDate: string | null;
  settlementDate: string | null;
  contractNoteNumber: string | null;
  netAmount: number | null;
  totalCharges: number | null;
  side: "buy" | "sell" | "mixed";
  trades: Omit<ContractNoteTrade, "id" | "docId">[];
}

/** Persist a contract note's header + trades. Replaces any prior rows for the doc. */
export function saveContractNote(note: NewContractNote): void {
  const d = getDb();
  d.prepare("DELETE FROM contract_notes WHERE doc_id = ?").run(note.docId);
  d.prepare("DELETE FROM contract_note_trades WHERE doc_id = ?").run(note.docId);
  d.prepare(
    `INSERT INTO contract_notes
       (doc_id, broker, client, trade_date, settlement_date, contract_note_number, net_amount, total_charges, side, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    note.docId,
    note.broker,
    note.client,
    note.tradeDate,
    note.settlementDate,
    note.contractNoteNumber,
    note.netAmount,
    note.totalCharges,
    note.side,
    new Date().toISOString(),
  );
  const insert = d.prepare(
    `INSERT INTO contract_note_trades (doc_id, security_name, symbol, isin, side, quantity, price, net_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of note.trades) {
    insert.run(
      note.docId,
      t.securityName,
      t.symbol,
      t.isin,
      t.side,
      t.quantity,
      t.price,
      t.netAmount,
    );
  }
}

/** The contract note (header + trades) for a document, or null when not one. */
export function getContractNote(docId: number): ContractNoteRecord | null {
  const row = getDb().prepare("SELECT * FROM contract_notes WHERE doc_id = ?").get(docId) as
    | Row
    | undefined;
  if (!row) return null;
  const trades = (
    getDb()
      .prepare("SELECT * FROM contract_note_trades WHERE doc_id = ? ORDER BY id ASC")
      .all(docId) as Row[]
  ).map(mapTrade);
  return {
    docId: Number(row.doc_id),
    broker: row.broker == null ? null : String(row.broker),
    client: row.client == null ? null : String(row.client),
    tradeDate: row.trade_date == null ? null : String(row.trade_date),
    settlementDate: row.settlement_date == null ? null : String(row.settlement_date),
    contractNoteNumber: row.contract_note_number == null ? null : String(row.contract_note_number),
    netAmount: row.net_amount == null ? null : Number(row.net_amount),
    totalCharges: row.total_charges == null ? null : Number(row.total_charges),
    side: (String(row.side) as ContractNoteRecord["side"]) || "buy",
    trades,
  };
}

/** All contract-note trades (for the investment aggregation), across active docs. */
export function listAllContractNoteTrades(): ContractNoteTrade[] {
  const rows = getDb().prepare("SELECT * FROM contract_note_trades ORDER BY id ASC").all() as Row[];
  return rows.map(mapTrade);
}

/** All contract-note headers keyed by docId. */
export function listContractNotes(): ContractNoteRecord[] {
  const rows = getDb().prepare("SELECT doc_id FROM contract_notes").all() as Row[];
  return rows
    .map((r) => getContractNote(Number(r.doc_id)))
    .filter((n): n is ContractNoteRecord => n != null);
}

// ── Recurring entries (manual income/expenses) ────────────────────────────

function mapRecurring(row: Row): RecurringEntry {
  return {
    id: Number(row.id),
    name: String(row.name),
    amount: Number(row.amount),
    currency: String(row.currency),
    frequency: String(row.frequency) as RecurringFrequency,
    startDate: row.start_date == null ? null : String(row.start_date),
    endDate: row.end_date == null ? null : String(row.end_date),
    person: row.person == null ? null : String(row.person),
    impactBucket: String(row.impact_bucket) as ImpactBucket,
    scope: String(row.scope) as EntryScope,
    notes: row.notes == null ? null : String(row.notes),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listRecurringEntries(): RecurringEntry[] {
  const rows = getDb().prepare("SELECT * FROM recurring_entries ORDER BY id DESC").all() as Row[];
  return rows.map(mapRecurring);
}

export function insertRecurringEntry(entry: NewRecurringEntry): RecurringEntry {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO recurring_entries
         (name, amount, currency, frequency, start_date, end_date, person, impact_bucket, scope, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.name,
      entry.amount,
      entry.currency,
      entry.frequency,
      entry.startDate,
      entry.endDate,
      entry.person,
      entry.impactBucket,
      entry.scope,
      entry.notes,
      now,
      now,
    );
  return { ...entry, id: Number(info.lastInsertRowid), createdAt: now, updatedAt: now };
}

export function updateRecurringEntry(id: number, patch: Partial<NewRecurringEntry>): void {
  const cols: Record<string, string> = {
    name: "name",
    amount: "amount",
    currency: "currency",
    frequency: "frequency",
    startDate: "start_date",
    endDate: "end_date",
    person: "person",
    impactBucket: "impact_bucket",
    scope: "scope",
    notes: "notes",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, col] of Object.entries(cols)) {
    if (key in patch) {
      sets.push(`${col} = ?`);
      values.push((patch as Record<string, unknown>)[key] ?? null);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  values.push(new Date().toISOString());
  values.push(id);
  getDb()
    .prepare(`UPDATE recurring_entries SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(values as never[]));
}

export function deleteRecurringEntry(id: number): void {
  getDb().prepare("DELETE FROM recurring_entries WHERE id = ?").run(id);
}

export function listDocuments(limit = 200): DocumentRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM documents ORDER BY id DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(mapRow);
}

/** Active documents only (excludes irrelevant/excluded/reprocess_requested). */
export function listActiveDocuments(limit = 500): DocumentRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM documents WHERE lifecycle_state IS NULL OR lifecycle_state = 'active' ORDER BY id DESC LIMIT ?",
    )
    .all(limit) as Row[];
  return rows.map(mapRow);
}

export function findDocumentById(id: number): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function getStats(): { total: number; converted: number } {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(markdown_success), 0) AS converted FROM documents
       WHERE lifecycle_state IS NULL OR lifecycle_state = 'active'`,
    )
    .get() as Row;
  return { total: Number(row.total), converted: Number(row.converted) };
}

// ── Snapshot cache ──────────────────────────────────────────────────────

export interface SnapshotCacheRow {
  json: string;
  generatedAt: string;
}

/** Return the cached financial snapshot (raw JSON + timestamp), or null. */
export function getSnapshotCache(): SnapshotCacheRow | null {
  const row = getDb().prepare("SELECT json, generated_at FROM snapshot_cache WHERE id = 1").get() as
    | Row
    | undefined;
  return row ? { json: String(row.json), generatedAt: String(row.generated_at) } : null;
}

/** Insert or replace the single cached snapshot row. */
export function saveSnapshotCache(json: string, generatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO snapshot_cache (id, json, generated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, generated_at = excluded.generated_at`,
    )
    .run(json, generatedAt);
}

// ── Manual attribution corrections ──────────────────────────────────────

/** All person-name remappings (rename / merge), as { from → to } pairs. */
export function listNameOverrides(): { from: string; to: string }[] {
  const rows = getDb()
    .prepare("SELECT from_name, to_name FROM person_name_overrides")
    .all() as Row[];
  return rows.map((r) => ({ from: String(r.from_name), to: String(r.to_name) }));
}

/** Remap one person name onto another (used for both rename and merge). */
export function setNameOverride(from: string, to: string): void {
  if (!from || !to || from === to) return;
  getDb()
    .prepare(
      `INSERT INTO person_name_overrides (from_name, to_name)
       VALUES (?, ?)
       ON CONFLICT(from_name) DO UPDATE SET to_name = excluded.to_name`,
    )
    .run(from, to);
  // If the target already pointed elsewhere, keep chains from looping back.
  getDb()
    .prepare("DELETE FROM person_name_overrides WHERE from_name = ? AND to_name = ?")
    .run(to, from);
}

/** Per-document attribution pins. `person === null` forces "unidentified". */
export function listDocumentOverrides(): { docId: number; person: string | null }[] {
  const rows = getDb().prepare("SELECT doc_id, person FROM document_overrides").all() as Row[];
  return rows.map((r) => ({
    docId: Number(r.doc_id),
    person: r.person == null ? null : String(r.person),
  }));
}

/** Pin a document to a person, or to "unidentified" when person is null. */
export function setDocumentOverride(docId: number, person: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO document_overrides (doc_id, person)
       VALUES (?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET person = excluded.person`,
    )
    .run(docId, person);
}

/** Clear a document's manual pin so it follows the AI attribution again. */
export function removeDocumentOverride(docId: number): void {
  getDb().prepare("DELETE FROM document_overrides WHERE doc_id = ?").run(docId);
}

// ── Exchange-rate cache ─────────────────────────────────────────────────

export interface RateCacheEntry {
  /** Units of INR per one unit of the foreign currency. */
  rate: number;
  /** The business day the rate actually corresponds to (YYYY-MM-DD). */
  rateDate: string;
  /** True when the requested date had no rate and a prior day's was used. */
  isNearest: boolean;
}

/** Look up a previously fetched rate for a currency + requested date, or null. */
export function getCachedRate(currency: string, reqDate: string): RateCacheEntry | null {
  const row = getDb()
    .prepare(
      "SELECT rate, rate_date, is_nearest FROM rate_cache WHERE currency = ? AND req_date = ?",
    )
    .get(currency, reqDate) as Row | undefined;
  if (!row) return null;
  return {
    rate: Number(row.rate),
    rateDate: String(row.rate_date),
    isNearest: Number(row.is_nearest) === 1,
  };
}

/** Store a fetched rate so the same currency + date isn't fetched again. */
export function saveCachedRate(currency: string, reqDate: string, entry: RateCacheEntry): void {
  getDb()
    .prepare(
      `INSERT INTO rate_cache (currency, req_date, rate, rate_date, is_nearest, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(currency, req_date) DO UPDATE SET
         rate = excluded.rate, rate_date = excluded.rate_date,
         is_nearest = excluded.is_nearest, fetched_at = excluded.fetched_at`,
    )
    .run(
      currency,
      reqDate,
      entry.rate,
      entry.rateDate,
      entry.isNearest ? 1 : 0,
      new Date().toISOString(),
    );
}

// ── App settings (key/value) ────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | Row
    | undefined;
  return row ? String(row.value) : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

// ── Learned rules (Training Mode) ───────────────────────────────────────

/** How many consistent confirmations before a rule is auto-applied silently. */
export const AUTO_APPLY_THRESHOLD = 2;

function parseEvidence(raw: unknown): RuleEvidence[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? (parsed as RuleEvidence[]) : [];
  } catch {
    return [];
  }
}

function mapRule(row: Row): LearnedRule {
  return {
    id: Number(row.id),
    ruleType: String(row.rule_type) as RuleType,
    matchKey: String(row.match_key),
    value: String(row.value),
    confidence: Number(row.confidence),
    source: String(row.source) === "manual" ? "manual" : "confirmed",
    autoApply: Number(row.auto_apply) === 1,
    evidence: parseEvidence(row.evidence),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listLearnedRules(): LearnedRule[] {
  const rows = getDb()
    .prepare("SELECT * FROM learned_rules ORDER BY rule_type ASC, confidence DESC, match_key ASC")
    .all() as Row[];
  return rows.map(mapRule);
}

export function findLearnedRule(ruleType: RuleType, matchKey: string): LearnedRule | null {
  const row = getDb()
    .prepare("SELECT * FROM learned_rules WHERE rule_type = ? AND match_key = ?")
    .get(ruleType, matchKey.toLowerCase()) as Row | undefined;
  return row ? mapRule(row) : null;
}

/**
 * Insert a new confirmed rule or reinforce an existing one (confidence + 1),
 * merging evidence. Returns the resulting rule and whether it was newly created.
 */
export function upsertConfirmedRule(input: {
  ruleType: RuleType;
  matchKey: string;
  value: string;
  evidence?: RuleEvidence[];
}): { rule: LearnedRule; isNew: boolean } {
  const matchKey = input.matchKey.trim().toLowerCase();
  const now = new Date().toISOString();
  const existing = findLearnedRule(input.ruleType, matchKey);

  if (existing) {
    const confidence = existing.confidence + 1;
    // Dedup evidence by filename + phrase.
    const merged = [...existing.evidence];
    for (const e of input.evidence ?? []) {
      if (!merged.some((m) => m.filename === e.filename && m.phrase === e.phrase)) merged.push(e);
    }
    const autoApply = existing.source === "manual" || confidence >= AUTO_APPLY_THRESHOLD;
    getDb()
      .prepare(
        `UPDATE learned_rules SET value = ?, confidence = ?, auto_apply = ?, evidence = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.value.trim(),
        confidence,
        autoApply ? 1 : 0,
        JSON.stringify(merged),
        now,
        existing.id,
      );
    return { rule: findLearnedRule(input.ruleType, matchKey)!, isNew: false };
  }

  getDb()
    .prepare(
      `INSERT INTO learned_rules (rule_type, match_key, value, confidence, source, auto_apply, evidence, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'confirmed', ?, ?, ?, ?)`,
    )
    .run(
      input.ruleType,
      matchKey,
      input.value.trim(),
      AUTO_APPLY_THRESHOLD <= 1 ? 1 : 0,
      JSON.stringify(input.evidence ?? []),
      now,
      now,
    );
  return { rule: findLearnedRule(input.ruleType, matchKey)!, isNew: true };
}

/** Add a rule by hand from Settings — explicit, so it auto-applies immediately. */
export function addManualRule(input: {
  ruleType: RuleType;
  matchKey: string;
  value: string;
}): LearnedRule {
  const matchKey = input.matchKey.trim().toLowerCase();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO learned_rules (rule_type, match_key, value, confidence, source, auto_apply, evidence, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'manual', 1, '[]', ?, ?)
       ON CONFLICT(rule_type, match_key) DO UPDATE SET
         value = excluded.value, source = 'manual', auto_apply = 1, updated_at = excluded.updated_at`,
    )
    .run(input.ruleType, matchKey, input.value.trim(), now, now);
  return findLearnedRule(input.ruleType, matchKey)!;
}

/** Patch a rule's value and/or auto-apply flag (from Settings editing). */
export function updateLearnedRule(
  id: number,
  patch: { value?: string; autoApply?: boolean },
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.value != null) {
    sets.push("value = ?");
    args.push(patch.value.trim());
  }
  if (patch.autoApply != null) {
    sets.push("auto_apply = ?");
    args.push(patch.autoApply ? 1 : 0);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
  args.push(id);
  getDb()
    .prepare(`UPDATE learned_rules SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(args as never[]));
}

export function deleteLearnedRule(id: number): void {
  getDb().prepare("DELETE FROM learned_rules WHERE id = ?").run(id);
}

// ── Training reviews (per-document) ──────────────────────────────────────

function mapReview(row: Row): TrainingReviewRecord {
  return {
    docId: Number(row.doc_id),
    status: String(row.status) as TrainingReviewStatus,
    questions: String(row.questions ?? "[]"),
    answers: row.answers == null ? null : String(row.answers),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getTrainingReview(docId: number): TrainingReviewRecord | null {
  const row = getDb().prepare("SELECT * FROM training_reviews WHERE doc_id = ?").get(docId) as
    | Row
    | undefined;
  return row ? mapReview(row) : null;
}

/** Insert or replace a document's training review. */
export function saveTrainingReview(input: {
  docId: number;
  status: TrainingReviewStatus;
  questions: string;
  answers?: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO training_reviews (doc_id, status, questions, answers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET
         status = excluded.status, questions = excluded.questions,
         answers = excluded.answers, updated_at = excluded.updated_at`,
    )
    .run(input.docId, input.status, input.questions, input.answers ?? null, now, now);
}

export function updateTrainingReviewStatus(
  docId: number,
  status: TrainingReviewStatus,
  answers?: string | null,
): void {
  getDb()
    .prepare("UPDATE training_reviews SET status = ?, answers = ?, updated_at = ? WHERE doc_id = ?")
    .run(status, answers ?? null, new Date().toISOString(), docId);
}

/** The oldest still-pending review, or null. */
export function getNextPendingReview(): TrainingReviewRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM training_reviews WHERE status = 'pending' ORDER BY doc_id ASC LIMIT 1")
    .get() as Row | undefined;
  return row ? mapReview(row) : null;
}

export function getPendingReviewCount(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM training_reviews WHERE status = 'pending'")
    .get() as Row;
  return Number(row.n);
}

export function getTrainingStats(): { reviewed: number; ruleCount: number } {
  const reviewed = Number(
    (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM training_reviews WHERE status != 'pending'")
        .get() as Row
    ).n,
  );
  const ruleCount = Number(
    (getDb().prepare("SELECT COUNT(*) AS n FROM learned_rules").get() as Row).n,
  );
  return { reviewed, ruleCount };
}

/** Wipe all learned rules and training reviews (start over). */
export function resetTraining(): void {
  const database = getDb();
  database.exec("DELETE FROM learned_rules");
  database.exec("DELETE FROM training_reviews");
}

// ── Field-level document reviews ─────────────────────────────────────────

function mapFieldReview(row: Row): DocumentFieldReview {
  return {
    id: Number(row.id),
    docId: Number(row.doc_id),
    field: String(row.field) as ReviewField,
    extractedValue: row.extracted_value == null ? null : String(row.extracted_value),
    confidence: Number(row.confidence),
    source: String(row.source) as FieldSource,
    reason: String(row.reason ?? ""),
    suggestedValue: row.suggested_value == null ? null : String(row.suggested_value),
    finalValue: row.final_value == null ? null : String(row.final_value),
    status: String(row.status) as ReviewStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getFieldReview(docId: number, field: ReviewField): DocumentFieldReview | null {
  const row = getDb()
    .prepare("SELECT * FROM document_field_reviews WHERE doc_id = ? AND field = ?")
    .get(docId, field) as Row | undefined;
  return row ? mapFieldReview(row) : null;
}

/** All field reviews for one document (or for the whole vault when docId omitted). */
export function listFieldReviews(docId?: number): DocumentFieldReview[] {
  const rows =
    docId == null
      ? (getDb().prepare("SELECT * FROM document_field_reviews").all() as Row[])
      : (getDb()
          .prepare("SELECT * FROM document_field_reviews WHERE doc_id = ?")
          .all(docId) as Row[]);
  return rows.map(mapFieldReview);
}

/** Insert or replace a field's review row. */
export function upsertFieldReview(input: {
  docId: number;
  field: ReviewField;
  extractedValue: string | null;
  confidence: number;
  source: FieldSource;
  reason: string;
  suggestedValue: string | null;
  finalValue?: string | null;
  status: ReviewStatus;
}): DocumentFieldReview {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO document_field_reviews
         (doc_id, field, extracted_value, confidence, source, reason, suggested_value, final_value, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id, field) DO UPDATE SET
         extracted_value = excluded.extracted_value, confidence = excluded.confidence,
         source = excluded.source, reason = excluded.reason, suggested_value = excluded.suggested_value,
         final_value = excluded.final_value, status = excluded.status, updated_at = excluded.updated_at`,
    )
    .run(
      input.docId,
      input.field,
      input.extractedValue,
      input.confidence,
      input.source,
      input.reason,
      input.suggestedValue,
      input.finalValue ?? null,
      input.status,
      now,
      now,
    );
  return getFieldReview(input.docId, input.field)!;
}

/** Resolve a field: set its final value, status, and source authority. */
export function setFieldReviewResolution(
  docId: number,
  field: ReviewField,
  patch: { status: ReviewStatus; finalValue: string | null; source: FieldSource },
): void {
  getDb()
    .prepare(
      `UPDATE document_field_reviews SET status = ?, final_value = ?, source = ?, updated_at = ?
       WHERE doc_id = ? AND field = ?`,
    )
    .run(patch.status, patch.finalValue, patch.source, new Date().toISOString(), docId, field);
}

export function deleteFieldReviewsForDoc(docId: number): void {
  getDb().prepare("DELETE FROM document_field_reviews WHERE doc_id = ?").run(docId);
}

/**
 * Distinct document ids that still have at least one pending field, newest first.
 * Only active documents count — excluded/irrelevant docs drop out of the queue.
 */
export function reviewQueueDocIds(): number[] {
  const placeholders = PENDING_REVIEW_STATUSES.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT r.doc_id FROM document_field_reviews r
       JOIN documents d ON d.id = r.doc_id
       WHERE r.status IN (${placeholders}) AND (d.lifecycle_state IS NULL OR d.lifecycle_state = 'active')
       ORDER BY r.doc_id DESC`,
    )
    .all(...PENDING_REVIEW_STATUSES) as Row[];
  return rows.map((r) => Number(r.doc_id));
}

/** How many active documents currently have at least one pending field review. */
export function countDocsNeedingReview(): number {
  const placeholders = PENDING_REVIEW_STATUSES.map(() => "?").join(", ");
  const row = getDb()
    .prepare(
      `SELECT COUNT(DISTINCT r.doc_id) AS n FROM document_field_reviews r
       JOIN documents d ON d.id = r.doc_id
       WHERE r.status IN (${placeholders}) AND (d.lifecycle_state IS NULL OR d.lifecycle_state = 'active')`,
    )
    .get(...PENDING_REVIEW_STATUSES) as Row;
  return Number(row.n);
}

export function addReviewAudit(entry: {
  docId: number;
  field: ReviewField;
  action: ReviewAction;
  oldValue: string | null;
  newValue: string | null;
  confidence: number | null;
  source: FieldSource | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO review_audit (doc_id, field, action, old_value, new_value, confidence, source, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.docId,
      entry.field,
      entry.action,
      entry.oldValue,
      entry.newValue,
      entry.confidence,
      entry.source,
      new Date().toISOString(),
    );
}

export function listReviewAudit(docId: number, field?: ReviewField): ReviewAuditEntry[] {
  const rows = (
    field
      ? getDb()
          .prepare("SELECT * FROM review_audit WHERE doc_id = ? AND field = ? ORDER BY id ASC")
          .all(docId, field)
      : getDb().prepare("SELECT * FROM review_audit WHERE doc_id = ? ORDER BY id ASC").all(docId)
  ) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    docId: Number(row.doc_id),
    field: String(row.field) as ReviewField,
    action: String(row.action) as ReviewAction,
    oldValue: row.old_value == null ? null : String(row.old_value),
    newValue: row.new_value == null ? null : String(row.new_value),
    confidence: row.confidence == null ? null : Number(row.confidence),
    source: row.source == null ? null : (String(row.source) as FieldSource),
    at: String(row.at),
  }));
}

/** Update a document's currency fields in place (used when FX inputs are corrected). */
export function updateDocumentCurrency(docId: number, c: CurrencyFields): void {
  getDb()
    .prepare(
      `UPDATE documents SET foreign_amount = ?, foreign_currency = ?, invoice_date = ?, inr_value = ?,
         rate_used = ?, rate_date = ?, rate_is_nearest = ?, currency_status = ? WHERE id = ?`,
    )
    .run(
      c.foreignAmount,
      c.foreignCurrency,
      c.invoiceDate,
      c.inrValue,
      c.rateUsed,
      c.rateDate,
      c.rateIsNearest ? 1 : 0,
      c.currencyStatus,
      docId,
    );
}

// ── Canonical persons ────────────────────────────────────────────────────

function parseRoles(raw: unknown): PersonRole[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is PersonRole => (PERSON_ROLES as string[]).includes(String(r)));
  } catch {
    return [];
  }
}

function mapPerson(row: Row): PersonRecord {
  return {
    id: Number(row.id),
    displayName: String(row.display_name),
    roles: parseRoles(row.roles),
    isSelf: Number(row.is_self) === 1,
    confidence: Number(row.confidence),
    nameSource: String(row.name_source) as FieldSource,
    rolesSource: String(row.roles_source) as FieldSource,
    status: String(row.status) === "confirmed" ? "confirmed" : "candidate",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listPersons(): PersonRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM persons ORDER BY is_self DESC, display_name ASC")
    .all() as Row[];
  return rows.map(mapPerson);
}

export function findPerson(id: number): PersonRecord | null {
  const row = getDb().prepare("SELECT * FROM persons WHERE id = ?").get(id) as Row | undefined;
  return row ? mapPerson(row) : null;
}

export function countPersons(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM persons").get() as Row).n);
}

export function insertPerson(input: {
  displayName: string;
  roles?: PersonRole[];
  confidence?: number;
  nameSource?: FieldSource;
  rolesSource?: FieldSource;
  status?: "candidate" | "confirmed";
}): PersonRecord {
  const now = new Date().toISOString();
  const info = getDb()
    .prepare(
      `INSERT INTO persons (display_name, roles, is_self, confidence, name_source, roles_source, status, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.displayName.trim(),
      JSON.stringify(input.roles ?? []),
      input.confidence ?? 0.6,
      input.nameSource ?? "ai_inferred",
      input.rolesSource ?? "ai_inferred",
      input.status ?? "candidate",
      now,
      now,
    );
  return findPerson(Number(info.lastInsertRowid))!;
}

/** Patch mutable person fields. Only the provided fields are touched. */
export function updatePerson(
  id: number,
  patch: {
    displayName?: string;
    roles?: PersonRole[];
    confidence?: number;
    nameSource?: FieldSource;
    rolesSource?: FieldSource;
    status?: "candidate" | "confirmed";
  },
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.displayName != null) {
    sets.push("display_name = ?");
    args.push(patch.displayName.trim());
  }
  if (patch.roles != null) {
    sets.push("roles = ?");
    args.push(JSON.stringify(patch.roles));
  }
  if (patch.confidence != null) {
    sets.push("confidence = ?");
    args.push(patch.confidence);
  }
  if (patch.nameSource != null) {
    sets.push("name_source = ?");
    args.push(patch.nameSource);
  }
  if (patch.rolesSource != null) {
    sets.push("roles_source = ?");
    args.push(patch.rolesSource);
  }
  if (patch.status != null) {
    sets.push("status = ?");
    args.push(patch.status);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = ?");
  args.push(new Date().toISOString());
  args.push(id);
  getDb()
    .prepare(`UPDATE persons SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(args as never[]));
}

/** Mark one person as "Self", clearing the flag on everyone else. */
export function setSelfPerson(id: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare("UPDATE persons SET is_self = 0, updated_at = ? WHERE is_self = 1").run(now);
  database
    .prepare("UPDATE persons SET is_self = 1, status = 'confirmed', updated_at = ? WHERE id = ?")
    .run(now, id);
}

export function deletePerson(id: number): void {
  const database = getDb();
  database.prepare("DELETE FROM person_aliases WHERE person_id = ?").run(id);
  database.prepare("DELETE FROM person_evidence WHERE person_id = ?").run(id);
  database.prepare("DELETE FROM persons WHERE id = ?").run(id);
}

// ── Person aliases ───────────────────────────────────────────────────────

function mapAlias(row: Row): PersonAlias {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    alias: String(row.alias),
    normalized: String(row.normalized),
    source: String(row.source) as FieldSource,
  };
}

export function listAliases(personId?: number): PersonAlias[] {
  const db_ = getDb();
  const rows = (
    personId == null
      ? db_.prepare("SELECT * FROM person_aliases ORDER BY id ASC").all()
      : db_
          .prepare("SELECT * FROM person_aliases WHERE person_id = ? ORDER BY id ASC")
          .all(personId)
  ) as Row[];
  return rows.map(mapAlias);
}

export function findAliasByNormalized(normalized: string): PersonAlias | null {
  const row = getDb()
    .prepare("SELECT * FROM person_aliases WHERE normalized = ?")
    .get(normalized) as Row | undefined;
  return row ? mapAlias(row) : null;
}

/**
 * Attach an alias to a person. If the normalized form already exists it is moved
 * to `personId` and its source upgraded (never downgraded). Returns the alias.
 */
export function upsertAlias(input: {
  personId: number;
  alias: string;
  normalized: string;
  source: FieldSource;
}): PersonAlias {
  const existing = findAliasByNormalized(input.normalized);
  const now = new Date().toISOString();
  if (existing) {
    const source = canOverwrite(existing.source, input.source) ? input.source : existing.source;
    getDb()
      .prepare("UPDATE person_aliases SET person_id = ?, alias = ?, source = ? WHERE id = ?")
      .run(input.personId, input.alias.trim(), source, existing.id);
    return findAliasByNormalized(input.normalized)!;
  }
  getDb()
    .prepare(
      `INSERT INTO person_aliases (person_id, alias, normalized, source, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.personId, input.alias.trim(), input.normalized, input.source, now);
  return findAliasByNormalized(input.normalized)!;
}

export function deleteAlias(id: number): void {
  getDb().prepare("DELETE FROM person_aliases WHERE id = ?").run(id);
}

/** Repoint every alias of `fromId` onto `toId` (used when merging people). */
export function reassignAliases(fromId: number, toId: number): void {
  getDb().prepare("UPDATE person_aliases SET person_id = ? WHERE person_id = ?").run(toId, fromId);
}

// ── Person evidence ──────────────────────────────────────────────────────

function mapEvidence(row: Row): PersonEvidence {
  return {
    id: Number(row.id),
    personId: Number(row.person_id),
    kind: String(row.kind) as PersonEvidenceKind,
    detail: String(row.detail),
    docId: row.doc_id == null ? null : Number(row.doc_id),
    createdAt: String(row.created_at),
  };
}

export function listEvidence(personId: number): PersonEvidence[] {
  const rows = getDb()
    .prepare("SELECT * FROM person_evidence WHERE person_id = ? ORDER BY id DESC")
    .all(personId) as Row[];
  return rows.map(mapEvidence);
}

export function addEvidence(input: {
  personId: number;
  kind: PersonEvidenceKind;
  detail: string;
  docId?: number | null;
}): void {
  // Avoid piling up identical evidence rows for the same person + detail.
  const dupe = getDb()
    .prepare("SELECT id FROM person_evidence WHERE person_id = ? AND kind = ? AND detail = ?")
    .get(input.personId, input.kind, input.detail) as Row | undefined;
  if (dupe) return;
  getDb()
    .prepare(
      `INSERT INTO person_evidence (person_id, kind, detail, doc_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.personId, input.kind, input.detail, input.docId ?? null, new Date().toISOString());
}

export function reassignEvidence(fromId: number, toId: number): void {
  getDb().prepare("UPDATE person_evidence SET person_id = ? WHERE person_id = ?").run(toId, fromId);
}
