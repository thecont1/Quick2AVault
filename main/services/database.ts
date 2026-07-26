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
}

/** The four kinds of rule Training Mode can learn. */
export type RuleType = "vendor_category" | "person_variant" | "keyword_doctype" | "source_scope";

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
  ensureCurrencyColumns(db);
  logger.info("database", "Document database ready", { dbPath });
  return db;
}

/** Add the currency conversion columns to `documents` if they don't exist yet. */
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
  ];
  for (const [name, type] of columns) {
    if (!existing.has(name)) database.exec(`ALTER TABLE documents ADD COLUMN ${name} ${type}`);
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
    currencyStatus: row.currency_status == null ? "none" : (String(row.currency_status) as CurrencyStatus),
  };
}

/** Return an existing record for this content hash, or null if unseen. */
export function findByHash(hash: string): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE hash = ?").get(hash) as Row | undefined;
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
  const stmt = getDb().prepare(`
    INSERT INTO documents
      (hash, original_filename, file_type, date_ingested, date_folder, markdown_success, raw_path, markdown_path,
       foreign_amount, foreign_currency, invoice_date, inr_value, rate_used, rate_date, rate_is_nearest, currency_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  };
}

export function listDocuments(limit = 200): DocumentRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM documents ORDER BY id DESC LIMIT ?")
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
      "SELECT COUNT(*) AS total, COALESCE(SUM(markdown_success), 0) AS converted FROM documents",
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
  const row = getDb()
    .prepare("SELECT json, generated_at FROM snapshot_cache WHERE id = 1")
    .get() as Row | undefined;
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
  const rows = getDb().prepare("SELECT from_name, to_name FROM person_name_overrides").all() as Row[];
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
  getDb().prepare("DELETE FROM person_name_overrides WHERE from_name = ? AND to_name = ?").run(to, from);
}

/** Per-document attribution pins. `person === null` forces "unidentified". */
export function listDocumentOverrides(): { docId: number; person: string | null }[] {
  const rows = getDb().prepare("SELECT doc_id, person FROM document_overrides").all() as Row[];
  return rows.map((r) => ({ docId: Number(r.doc_id), person: r.person == null ? null : String(r.person) }));
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
    .prepare("SELECT rate, rate_date, is_nearest FROM rate_cache WHERE currency = ? AND req_date = ?")
    .get(currency, reqDate) as Row | undefined;
  if (!row) return null;
  return { rate: Number(row.rate), rateDate: String(row.rate_date), isNearest: Number(row.is_nearest) === 1 };
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
    .run(currency, reqDate, entry.rate, entry.rateDate, entry.isNearest ? 1 : 0, new Date().toISOString());
}

// ── App settings (key/value) ────────────────────────────────────────────

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as Row | undefined;
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
      .run(input.value.trim(), confidence, autoApply ? 1 : 0, JSON.stringify(merged), now, existing.id);
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
export function updateLearnedRule(id: number, patch: { value?: string; autoApply?: boolean }): void {
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
  getDb().prepare(`UPDATE learned_rules SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
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
  const row = getDb().prepare("SELECT * FROM training_reviews WHERE doc_id = ?").get(docId) as Row | undefined;
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
    (getDb().prepare("SELECT COUNT(*) AS n FROM training_reviews WHERE status != 'pending'").get() as Row).n,
  );
  const ruleCount = Number((getDb().prepare("SELECT COUNT(*) AS n FROM learned_rules").get() as Row).n);
  return { reviewed, ruleCount };
}

/** Wipe all learned rules and training reviews (start over). */
export function resetTraining(): void {
  const database = getDb();
  database.exec("DELETE FROM learned_rules");
  database.exec("DELETE FROM training_reviews");
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
  const rows = getDb().prepare("SELECT * FROM persons ORDER BY is_self DESC, display_name ASC").all() as Row[];
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
  getDb().prepare(`UPDATE persons SET ${sets.join(", ")} WHERE id = ?`).run(...(args as never[]));
}

/** Mark one person as "Self", clearing the flag on everyone else. */
export function setSelfPerson(id: number): void {
  const database = getDb();
  const now = new Date().toISOString();
  database.prepare("UPDATE persons SET is_self = 0, updated_at = ? WHERE is_self = 1").run(now);
  database.prepare("UPDATE persons SET is_self = 1, status = 'confirmed', updated_at = ? WHERE id = ?").run(now, id);
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
      : db_.prepare("SELECT * FROM person_aliases WHERE person_id = ? ORDER BY id ASC").all(personId)
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
