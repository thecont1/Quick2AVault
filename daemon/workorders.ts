/**
 * WO09 + WO10 backend contracts.
 *
 * This module is deliberately small and dependency-free: the existing daemon
 * can adopt these contracts incrementally while old v1 state names and routes
 * remain supported at the edges.
 */
import type { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";

import type { DomainEvent, EventBus, Ports } from "./ports.js";
import type { RuleKind } from "./learning.js";
import { linkEvidence } from "./matcher.js";
import type { ExtractionResult } from "./extraction-contract.js";

export const PIPELINE_STATES = [
  "received", "stable", "hashed", "triaged", "converting", "analysing",
  "complete", "failed", "duplicate", "irrelevant", "password_needed",
] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export const TERMINAL_PIPELINE_STATES = new Set<PipelineState>([
  "complete", "failed", "duplicate", "irrelevant", "password_needed",
]);

export type SourceAction = "retain" | "remove" | "archive-copy-retain-source";
/** Policy for a watched input path. Only successful completion consumes it. */
export function sourceActionFor(state: PipelineState): SourceAction {
  if (state === "complete") return "remove";
  return TERMINAL_PIPELINE_STATES.has(state) ? "archive-copy-retain-source" : "retain";
}

const EDGES: Record<PipelineState, readonly PipelineState[]> = {
  received: ["stable", "failed"],
  stable: ["hashed", "failed"],
  hashed: ["triaged", "duplicate", "failed"],
  triaged: ["converting", "irrelevant", "failed", "duplicate"],
  converting: ["analysing", "password_needed", "failed"],
  analysing: ["complete", "failed", "password_needed"],
  complete: [], failed: [], duplicate: [], irrelevant: [], password_needed: [],
};

export class PipelineTransitionRefused extends Error {
  constructor(readonly fromState: PipelineState | null, readonly toState: PipelineState) {
    super(`illegal pipeline transition: ${fromState ?? "(none)"} → ${toState}`);
    this.name = "PipelineTransitionRefused";
  }
}

export interface PipelineEvent {
  id: number;
  documentId: string;
  fromState: PipelineState | null;
  toState: PipelineState;
  timestamp: string;
  source: string;
  reason?: string | null;
  payload: Record<string, unknown>;
}

function ensurePipelineTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_pipeline (
      document_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
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
  `);
}

/** Canonical, idempotent state transition. Repeating the current state is a no-op. */
export function transitionPipeline(
  db: DatabaseSync,
  input: {
    documentId: string;
    toState: PipelineState;
    timestamp: string;
    source: string;
    reason?: string;
    payload?: Record<string, unknown>;
  },
): { changed: boolean; event: PipelineEvent | null } {
  ensurePipelineTables(db);
  const current = db.prepare("SELECT state FROM document_pipeline WHERE document_id=?").get(input.documentId) as
    | { state: PipelineState }
    | undefined;
  const fromState = current?.state ?? null;
  if (fromState === input.toState) return { changed: false, event: null };
  if ((fromState === null && input.toState !== "received") || (fromState !== null && !EDGES[fromState].includes(input.toState))) {
    throw new PipelineTransitionRefused(fromState, input.toState);
  }
  const payload = input.payload ?? {};
  const insert = db.prepare(
    `INSERT INTO pipeline_events (document_id, from_state, to_state, timestamp, source, reason, payload_json)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(input.documentId, fromState, input.toState, input.timestamp, input.source, input.reason ?? null, JSON.stringify(payload));
  db.prepare(
    `INSERT INTO document_pipeline(document_id,state,updated_at) VALUES(?,?,?)
     ON CONFLICT(document_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
  ).run(input.documentId, input.toState, input.timestamp);
  return {
    changed: true,
    event: {
      id: Number(insert.lastInsertRowid), documentId: input.documentId, fromState,
      toState: input.toState, timestamp: input.timestamp, source: input.source,
      reason: input.reason ?? null, payload,
    },
  };
}

export function pipelineEventsFor(db: DatabaseSync, documentId: string): PipelineEvent[] {
  ensurePipelineTables(db);
  return (db.prepare(
    `SELECT id, document_id, from_state, to_state, timestamp, source, reason, payload_json
       FROM pipeline_events WHERE document_id=? ORDER BY id`,
  ).all(documentId) as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id), documentId: String(row.document_id), fromState: (row.from_state as PipelineState | null) ?? null,
    toState: row.to_state as PipelineState, timestamp: String(row.timestamp), source: String(row.source),
    reason: row.reason as string | null,
    payload: typeof row.payload_json === "string" ? JSON.parse(row.payload_json) as Record<string, unknown> : {},
  }));
}

export const IMPACT_BUCKETS = [
  "income", "expense", "investment_purchase", "investment_sale", "transfer", "fee", "refund", "uncategorized",
] as const;
export type ImpactBucket = (typeof IMPACT_BUCKETS)[number];
export const DOC_TYPES = ["tax_invoice", "contract_note", "bank_statement", "card_confirmation", "rent_receipt", "form_16", "unknown"] as const;
export type DocumentType = (typeof DOC_TYPES)[number];

export const DOCUMENT_TAXONOMY: Record<DocumentType, {
  recognitionHints: readonly string[]; defaultImpactBucket: ImpactBucket; advisoryHint: string; fields: readonly string[];
}> = {
  tax_invoice: { recognitionHints: ["tax invoice", "gstin", "hsn/sac"], defaultImpactBucket: "expense", advisoryHint: "Recognized as a tax invoice — review whether this is income or an expense.", fields: ["lineItems"] },
  contract_note: { recognitionHints: ["contract note", "isin", "broker"], defaultImpactBucket: "investment_purchase", advisoryHint: "Recognized as a broker contract note — mapped to investment activity, not a generic expense.", fields: ["trades"] },
  bank_statement: { recognitionHints: ["bank statement"], defaultImpactBucket: "uncategorized", advisoryHint: "Recognized as a bank statement.", fields: [] },
  card_confirmation: { recognitionHints: ["card", "transaction confirmation"], defaultImpactBucket: "expense", advisoryHint: "Recognized as a card confirmation.", fields: [] },
  rent_receipt: { recognitionHints: ["rent receipt"], defaultImpactBucket: "expense", advisoryHint: "Recognized as a rent receipt.", fields: [] },
  form_16: { recognitionHints: ["form 16", "tds certificate"], defaultImpactBucket: "uncategorized", advisoryHint: "Recognized as a TDS certificate.", fields: [] },
  unknown: { recognitionHints: [], defaultImpactBucket: "uncategorized", advisoryHint: "Document type is uncertain — review the classification.", fields: [] },
};

function isoCurrency(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw new RangeError("currency must be an ISO 4217 code");
  return code;
}
function isoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new RangeError("date must be YYYY-MM-DD");
  return value;
}
function priorDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() - 1);
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() - 1);
  return next.toISOString().slice(0, 10);
}

export interface CurrencyConversion {
  originalAmount: number; originalCurrency: string; convertedAmount: number; rate: number; rateDate: string;
  rateSource: "frankfurter"; provenance: "ai-derived" | "rule-derived"; freshness: "fresh" | "cache-hit" | "stale" | "prior-business-day";
}
export type HttpGet = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The number of minor-unit decimal places for an ISO-4217 currency, sourced
 * from the runtime's own CLDR data via Intl rather than a hand-maintained
 * table. USD/INR/EUR → 2, JPY → 0, BHD → 3, etc. Falls back to 2 for any code
 * Intl cannot describe.
 */
export function minorUnitDigits(currency: string): number {
  try {
    const parts = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions();
    return parts.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Frankfurter implementation with an injectable HTTP boundary for deterministic tests. */
export class FrankfurterFx {
  constructor(
    private readonly db: DatabaseSync,
    private readonly http: HttpGet = (url) => fetch(url, { signal: AbortSignal.timeout(8000) }),
  ) {}

  async convert(input: { amountMinor: number; from: string; to: string; date: string }): Promise<CurrencyConversion | null> {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) throw new RangeError("amountMinor must be a non-negative safe integer");
    const from = isoCurrency(input.from); const to = isoCurrency(input.to); const requested = isoDate(input.date);
    if (from === to) return { originalAmount: input.amountMinor, originalCurrency: from, convertedAmount: input.amountMinor, rate: 1, rateDate: requested, rateSource: "frankfurter", provenance: "rule-derived", freshness: "fresh" };
    this.db.exec(`CREATE TABLE IF NOT EXISTS rate_cache (base_currency TEXT NOT NULL, quote_currency TEXT NOT NULL, rate_date TEXT NOT NULL, rate REAL NOT NULL, source TEXT NOT NULL, fetched_at TEXT NOT NULL, PRIMARY KEY(base_currency, quote_currency, rate_date, source))`);
    const cached = (date: string) => this.db.prepare("SELECT rate FROM rate_cache WHERE base_currency=? AND quote_currency=? AND rate_date=? AND source='frankfurter'").get(from, to, date) as { rate: number } | undefined;
    const fromCache = cached(requested);
    if (fromCache) return this.make(input.amountMinor, from, to, fromCache.rate, requested, "cache-hit");
    let date = requested;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const response = await this.http(`https://api.frankfurter.app/${date}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
        if (response.ok) {
          const body = await response.json() as { rates?: Record<string, unknown> };
          const rate = Number(body.rates?.[to]);
          if (!Number.isFinite(rate) || rate <= 0) throw new Error("Frankfurter response has no usable rate");
          this.db.prepare("INSERT OR REPLACE INTO rate_cache(base_currency,quote_currency,rate_date,rate,source,fetched_at) VALUES(?,?,?,?, 'frankfurter',?)").run(from, to, date, rate, new Date().toISOString());
          return this.make(input.amountMinor, from, to, rate, date, date === requested ? "fresh" : "prior-business-day");
        }
        if (response.status !== 404) break;
      } catch { break; }
      date = priorDay(date);
    }
    const stale = this.db.prepare("SELECT rate, rate_date FROM rate_cache WHERE base_currency=? AND quote_currency=? AND source='frankfurter' ORDER BY rate_date DESC LIMIT 1").get(from, to) as { rate: number; rate_date: string } | undefined;
    return stale ? this.make(input.amountMinor, from, to, stale.rate, stale.rate_date, "stale") : null;
  }
  private make(amount: number, from: string, to: string, rate: number, date: string, freshness: CurrencyConversion["freshness"]): CurrencyConversion {
    const sourceScale = 10 ** minorUnitDigits(from);
    const targetScale = 10 ** minorUnitDigits(to);
    const convertedAmount = Math.round((amount / sourceScale) * rate * targetScale);
    if (!Number.isSafeInteger(convertedAmount)) throw new RangeError("converted amount exceeds the safe-integer range");
    return { originalAmount: amount, originalCurrency: from, convertedAmount, rate, rateDate: date, rateSource: "frankfurter", provenance: "rule-derived", freshness };
  }
}

export function impactFor(docType: DocumentType, bucket: ImpactBucket, amountMinor: number, currency = "INR"): { bucket: ImpactBucket; advisoryHint: string; wording: string } {
  const amount = new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(amountMinor / 100);
  const wording = bucket === "income" ? `Income of ${amount}.`
    : bucket === "expense" ? `Expense of ${amount}.`
      : bucket === "investment_purchase" ? `Added ${amount} to investments.`
        : bucket === "investment_sale" ? `Removed ${amount} from investments.` : `${bucket.replace(/_/g, " ")} of ${amount}.`;
  return { bucket, advisoryHint: DOCUMENT_TAXONOMY[docType].advisoryHint, wording };
}

// ── Adaptive learning ──────────────────────────────────────────────────────
export const LEARNING_TRIGGERS = [
  "new-entity", "name-variant-uncertain", "known-vendor-new-doctype",
  "amount-anomaly", "new-currency-or-account", "rule-conflict",
  "reconciliation-ambiguity",
] as const;
export type LearningTrigger = (typeof LEARNING_TRIGGERS)[number];
type PredictedRuleKind = "alias" | "vendor-rule" | "entity-rule" | "document-type-rule" | "merge";
interface ResolvedPredictedRule {
  kind: RuleKind;
  matchKind?: string;
}
const PREDICTED_RULE_KINDS: Record<PredictedRuleKind, ResolvedPredictedRule | null> = {
  alias: { kind: "entity_alias" },
  "vendor-rule": { kind: "vendor_to_account" },
  "entity-rule": { kind: "descriptor_to_entity", matchKind: "organisation" },
  "document-type-rule": { kind: "doctype_to_category" },
  // A merge is destructive identity work, not a lookup rule. It must go
  // through the explicit merge flow rather than becoming an inert DB row.
  merge: null,
};
export interface LearningAmbiguity {
  kind: LearningTrigger; dedupeKey: string; prompt: string;
  sourceFact: Record<string, unknown>;
  predictedRule: { kind: PredictedRuleKind; payload: Record<string, unknown> };
  noveltyScore: number; why: string; ttl?: string;
}
export interface LearningQuestion {
  type: "learning.question"; question_id: string; at: string;
  trigger: { kind: LearningTrigger; document_id: string; pipeline_state: "analysing" | "complete"; novelty_score: number };
  prompt: string; source_fact: Record<string, unknown>;
  predicted_rule: LearningAmbiguity["predictedRule"]; dedupe_key: string; why: string;
}
function setting(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value?: string } | undefined)?.value;
}
function availableQuestionBudget(db: DatabaseSync, ports: { clock: { isoNow(): string } }): number {
  if (setting(db, "learning.enabled") === "false") return 0;
  const manual = Number(setting(db, "learning.question_budget"));
  const cap = Number.isInteger(manual) && manual >= 0 ? Math.min(20, manual) : 3;
  const open = (db.prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NULL AND dismissed=0 AND (backoff_until IS NULL OR backoff_until < ?)").get(ports.clock.isoNow()) as { n: number }).n;
  const rules = (db.prepare("SELECT COUNT(*) n FROM learned_rules WHERE active=1").get() as { n: number }).n;
  return Math.max(0, cap - open - Math.floor(rules / 10));
}
export function generateLearningQuestions(
  db: DatabaseSync,
  ports: { clock: { isoNow(): string }; bus: Pick<EventBus, "publish"> },
  input: { documentId: string; pipelineState: "analysing" | "complete"; ambiguities: LearningAmbiguity[] },
): LearningQuestion[] {
  let remaining = availableQuestionBudget(db, ports);
  if (remaining <= 0) return [];
  const out: LearningQuestion[] = [];
  for (const ambiguity of input.ambiguities) {
    if (remaining <= 0) break;
    if (!LEARNING_TRIGGERS.includes(ambiguity.kind)) continue;
    if (!(ambiguity.noveltyScore >= 0 && ambiguity.noveltyScore <= 1) || !ambiguity.why.trim()) continue;

    // WO12 phase 2: consult learned_rules for a standing 'reconciliation_decline'
    // rule. If the user previously said "Don't link" for this candidate pair,
    // never re-ask — the rule is the durable decision, the dedupe key is the
    // transient one.
    if (ambiguity.kind === "reconciliation-ambiguity") {
      const declineRule = db
        .prepare("SELECT 1 FROM learned_rules WHERE kind='reconciliation_decline' AND match_key=? AND active=1")
        .get(ambiguity.dedupeKey);
      if (declineRule) continue;
    }

    // WO12 phase 2: respect backoff_until. A question that was deferred with
    // "Later" should re-ask after the backoff period expires. The old logic
    // blocked ALL re-asks via the dedupe key, making "Later" equivalent to
    // "never ask again."
    const existing = db.prepare("SELECT answered_at, dismissed, backoff_until FROM training_reviews WHERE dedupe_key=?")
      .get(ambiguity.dedupeKey) as
      | { answered_at: string | null; dismissed: number; backoff_until: string | null }
      | undefined;
    if (existing) {
      if (existing.answered_at || existing.dismissed) continue; // answered or dismissed — never re-ask
      if (existing.backoff_until) {
        // "Later" — re-ask only after the backoff period expires
        const now = ports.clock.isoNow();
        if (existing.backoff_until > now) continue; // still in backoff
        // Backoff expired: clear the old row and allow re-asking
        db.prepare("DELETE FROM training_reviews WHERE dedupe_key=?").run(ambiguity.dedupeKey);
      } else {
        // Open question with no backoff — still pending, don't re-ask
        continue;
      }
    }
    const askedAt = ports.clock.isoNow();
    const inserted = db.prepare(
      `INSERT INTO training_reviews(question,context,trigger,options,dedupe_key,novelty_score,predicted_rule,why,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(ambiguity.prompt, JSON.stringify({ document_id: input.documentId, pipeline_state: input.pipelineState, source_fact: ambiguity.sourceFact }), ambiguity.kind,
      JSON.stringify(["Yes", "No", "Later"]), ambiguity.dedupeKey, ambiguity.noveltyScore, JSON.stringify(ambiguity.predictedRule), ambiguity.why, askedAt);
    remaining--;
    const q: LearningQuestion = { type: "learning.question", question_id: String(inserted.lastInsertRowid), at: askedAt,
      trigger: { kind: ambiguity.kind, document_id: input.documentId, pipeline_state: input.pipelineState, novelty_score: ambiguity.noveltyScore },
      prompt: ambiguity.prompt, source_fact: ambiguity.sourceFact, predicted_rule: ambiguity.predictedRule,
      dedupe_key: ambiguity.dedupeKey, why: ambiguity.why };
    ports.bus.publish(q); out.push(q);
  }
  return out;
}
export function answerLearningQuestion(
  db: DatabaseSync,
  ports: Pick<Ports, "clock" | "bus" | "logger">,
  questionId: string | number, answer: string,
): { ruleId: number | null; linked: boolean; dismissed: boolean; deferred: boolean } {
  const row = db.prepare("SELECT id,trigger,predicted_rule,answered_at,dismissed,context,dedupe_key FROM training_reviews WHERE id=?").get(questionId) as
    | { id: number; trigger: string; predicted_rule: string | null; answered_at: string | null; dismissed: number; context: string | null; dedupe_key: string | null } | undefined;
  if (!row) throw new Error("learning question not found");
  if (row.answered_at || row.dismissed) return { ruleId: null, linked: false, dismissed: false, deferred: false };
  const now = ports.clock.isoNow(); let ruleId: number | null = null;
  let appliedRuleId: number | null = null;
  let contextForEvent: Record<string, unknown> | null = null;
  let linked = false;
  let dismissed = false;
  let deferred = false;

  // ── Reconciliation-ambiguity: Link / Don't link / Later ─────────────
  if (row.trigger === "reconciliation-ambiguity") {
    let ctx: Record<string, unknown> | null = null;
    try { ctx = row.context ? JSON.parse(row.context) as Record<string, unknown> : null; } catch { /* ignore */ }
    const sourceFact = (ctx?.source_fact ?? ctx) as Record<string, unknown> | undefined;
    const docId = String(sourceFact?.document_id ?? "");
    const txnId = String(sourceFact?.transaction_id ?? "");

    if (/^(yes|confirm|accept|link)/i.test(answer)) {
      db.prepare("BEGIN IMMEDIATE").run();
      try {
        if (docId && txnId) {
          const docRow = db.prepare("SELECT extraction_json FROM documents WHERE id=?").get(docId) as { extraction_json: string } | undefined;
          if (docRow?.extraction_json) {
            let x: ExtractionResult | undefined;
            try {
              x = JSON.parse(docRow.extraction_json);
            } catch {
              // Fallback: if extraction_json won't parse, link with a generic role.
              // INSERT OR IGNORE (not REPLACE) — never silently move evidence
              // from another transaction.
              const info = db.prepare(
                `INSERT OR IGNORE INTO transaction_documents
                   (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
                  VALUES (?,?,?,?, 'user', ?)`,
              ).run(txnId, docId, "payment_receipt", 1.0, now);
              linked = Number(info.changes ?? 0) > 0;
            }
            if (x) {
              // Call linkEvidence outside the JSON.parse try/catch so its
              // constraint violations propagate naturally.
              linked = linkEvidence(db, ports, txnId, docId, x, 1.0, "user");
            }
          }
        }
        db.prepare("UPDATE training_reviews SET answer=?, answered_at=?, rule_id=NULL WHERE id=?").run(answer, now, row.id);
      } catch {
        db.prepare("ROLLBACK").run();
        throw new Error("failed to apply reconciliation link answer");
      }
      db.prepare("COMMIT").run();
      ports.bus.publish({ type: "learning.answer", question_id: String(row.id), at: now, answer });
      return { ruleId: null, linked, dismissed: false, deferred: false };
    }

    if (/^(no|dont|nope|dismiss)/i.test(answer)) {
      // D5: write a standing rule so this candidate pair is never proposed again.
      // The rule key is the dedupe_key of the ambiguity question.
      const dedupeKey = row.dedupe_key ?? null;
      let ruleIdForDismiss: number | null = null;
      db.exec("BEGIN");
      try {
        if (dedupeKey) {
          const row2 = db.prepare(
            `INSERT INTO learned_rules(kind, match_key, match_kind, value, source, created_at)
             VALUES('reconciliation_decline', ?, '', 'no', 'user', ?)
             ON CONFLICT(kind, match_key, COALESCE(match_kind,'')) DO UPDATE SET value='no', active=1
             RETURNING id`,
          ).get(dedupeKey, now) as { id: number } | undefined;
          ruleIdForDismiss = row2 ? row2.id : null;
        }
        db.prepare("UPDATE training_reviews SET answer=?, answered_at=?, dismissed=1, rule_id=? WHERE id=?").run(answer, now, ruleIdForDismiss, row.id);
        db.prepare("COMMIT").run();
      } catch {
        db.prepare("ROLLBACK").run();
        throw new Error("failed to apply reconciliation decline answer");
      }
      ports.bus.publish({ type: "learning.answer", question_id: String(row.id), at: now, answer });
      return { ruleId: ruleIdForDismiss, linked: false, dismissed: true, deferred: false };
    }

    if (/^(later|defer|skip)/i.test(answer)) {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() + 7);
      db.prepare("UPDATE training_reviews SET answer=?, backoff_until=?, rule_id=NULL WHERE id=?").run(answer, start.toISOString(), row.id);
      ports.bus.publish({ type: "learning.answer", question_id: String(row.id), at: now, answer });
      return { ruleId: null, linked: false, dismissed: false, deferred: true };
    }
  }

  if (/^(yes|confirm|accept)/i.test(answer) && row.predicted_rule) {
    const predicted = JSON.parse(row.predicted_rule) as LearningAmbiguity["predictedRule"];
    const resolved = PREDICTED_RULE_KINDS[predicted.kind];
    if (!resolved) throw new Error(`unsupported predicted rule kind: ${predicted.kind}`);
    const key = String(predicted.payload.match_key ?? predicted.payload.alias ?? questionId);
    const value = String(predicted.payload.value ?? predicted.payload.entity_id ?? answer);
    contextForEvent = row.context ? JSON.parse(row.context) as Record<string, unknown> : {};
    db.exec("BEGIN");
    try {
      const row2 = db.prepare(
        `INSERT INTO learned_rules(kind,match_key,match_kind,value,source,confidence,active,created_at)
         VALUES(?,?,?,?, 'user',1,1,?)
         ON CONFLICT(kind,match_key,COALESCE(match_kind,'')) DO UPDATE SET value=excluded.value,active=1,confidence=1
         RETURNING id`,
      ).get(resolved.kind, key, resolved.matchKind ?? null, value, now) as { id: number };
      ruleId = row2.id;
      db.prepare("UPDATE training_reviews SET answer=?,answered_at=?,rule_id=? WHERE id=?").run(answer, now, ruleId, row.id);
      db.exec("COMMIT");
      appliedRuleId = ruleId;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } else {
    db.prepare("UPDATE training_reviews SET answer=?,answered_at=?,rule_id=? WHERE id=?").run(answer, now, ruleId, row.id);
  }
  if (appliedRuleId !== null && contextForEvent !== null) {
    ports.bus.publish({ type: "learning.rule.applied", rule_id: appliedRuleId, document_id: contextForEvent.document_id as string | undefined, at: now });
  }
  ports.bus.publish({ type: "learning.answer", question_id: String(row.id), at: now, answer });
  return { ruleId, linked: false, dismissed: false, deferred: false };
}
export function ignoreLearningQuestion(db: DatabaseSync, ports: { clock: { isoNow(): string } }, questionId: number): void {
  const start = new Date(ports.clock.isoNow()); start.setUTCDate(start.getUTCDate() + 1);
  db.prepare("UPDATE training_reviews SET dismissed=1,backoff_until=? WHERE id=? AND answered_at IS NULL").run(start.toISOString(), questionId);
}

// ── Zero-input vocabularies and registry ──────────────────────────────────
export type Vocabulary = "entities" | "accounts" | "categories" | "impactBuckets" | "docTypes" | "settings";
export function listVocabulary(db: DatabaseSync, vocabulary: Vocabulary, kind?: string): unknown[] {
  if (vocabulary === "impactBuckets") return [...IMPACT_BUCKETS];
  if (vocabulary === "docTypes") return [...DOC_TYPES];
  if (vocabulary === "settings") return db.prepare("SELECT key,value FROM app_settings ORDER BY key").all();
  if (vocabulary === "categories") {
    const configured = db.prepare("SELECT value FROM value_registry WHERE field='category' ORDER BY value").all() as { value: string }[];
    return configured.map(r => r.value);
  }
  const filter = vocabulary === "accounts" ? "account" : kind;
  return filter ? db.prepare("SELECT id,kind,display_name,identifiers_json FROM entities WHERE kind=? ORDER BY display_name").all(filter)
    : db.prepare("SELECT id,kind,display_name,identifiers_json FROM entities ORDER BY kind,display_name").all();
}
const normalRegistry = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function editDistance(a: string, b: string): number {
  const d = Array.from({length:a.length+1},()=>Array<number>(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++)d[i][0]=i; for(let j=0;j<=b.length;j++)d[0][j]=j;
  for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[a.length][b.length];
}
export function createRegistryValue(db: DatabaseSync, ports: { clock: { isoNow(): string } }, field: string, value: string): { created: boolean; value: string; suggestion: string | null } {
  const clean=value.trim(), norm=normalRegistry(clean); if(!field.trim()||!norm) throw new RangeError("field and value are required");
  const rows=db.prepare("SELECT value,normalised FROM value_registry WHERE field=?").all(field) as {value:string;normalised:string}[];
  const exact=rows.find(r=>r.normalised===norm); if(exact)return{created:false,value:exact.value,suggestion:null};
  const best=rows.map(r=>({r,score:1-editDistance(norm,r.normalised)/Math.max(norm.length,r.normalised.length)})).sort((a,b)=>b.score-a.score)[0];
  db.prepare("INSERT INTO value_registry(field,value,normalised,created_at) VALUES(?,?,?,?)").run(field,clean,norm,ports.clock.isoNow());
  return{created:true,value:clean,suggestion:best&&best.score>=.72?best.r.value:null};
}

// ── Kind-safe entity support ──────────────────────────────────────────────
export function resolveAccountEntity(db: DatabaseSync, ports: { clock: { isoNow(): string } }, ref: {institution:string;last4:string;type:"bank"|"credit_card"|"wallet"|"cash"}): {id:string;created:boolean} {
  const institution=ref.institution.trim(), last4=ref.last4.replace(/\D/g,"").slice(-4); if(!institution||(!last4&&ref.type!=="cash"))throw new RangeError("invalid accountRef");
  const rows=db.prepare("SELECT id,identifiers_json FROM entities WHERE kind='account'").all() as {id:string;identifiers_json:string|null}[];
  for(const row of rows){try{const j=JSON.parse(row.identifiers_json??"{}") as {accountRef?:Array<{institution:string;last4:string;type:string}>};if(j.accountRef?.some(a=>a.institution.toLowerCase()===institution.toLowerCase()&&a.last4===last4&&a.type===ref.type))return{id:row.id,created:false};}catch{/* legacy malformed identifiers */}}
  const id=`ent_${crypto.randomBytes(8).toString("hex")}`, now=ports.clock.isoNow();
  db.prepare("INSERT INTO entities(id,kind,display_name,identifiers_json,status,confidence,created_at) VALUES(?,?,?,?, 'confirmed',1,?)")
    .run(id,"account",`${institution}${last4?` •${last4}`:""}`,JSON.stringify({accountRef:[{institution,last4,type:ref.type}]}),now);
  return{id,created:true};
}
export function identifierConflicts(db: DatabaseSync, identifier: string): Array<{id:string;kind:string;displayName:string;sameKind:boolean;crossKind:boolean}> {
  const needle=identifier.trim().toLowerCase();
  const hits=(db.prepare("SELECT id,kind,display_name,identifiers_json FROM entities WHERE status='confirmed'").all() as Array<{id:string;kind:string;display_name:string;identifiers_json:string|null}>).filter(row=>{
    try{return JSON.stringify(JSON.parse(row.identifiers_json??"{}") as unknown).toLowerCase().includes(needle);}catch{return false;}
  });
  return hits.map(h=>({id:h.id,kind:h.kind,displayName:h.display_name,sameKind:hits.some(o=>o.id!==h.id&&o.kind===h.kind),crossKind:hits.some(o=>o.kind!==h.kind)}));
}

// ── Document taxonomy and deterministic typed extractors ─────────────────
export function detectDocumentType(text: string): {type:DocumentType;confidence:number} {
  const lower=text.toLowerCase();
  // A contract note may legally be titled "contract note cum tax invoice";
  // the more specific financial instrument wins over the embedded tax label.
  if (/contract\s+note/i.test(text) && (/\bINE[A-Z0-9]{9}\b/.test(text) || /trade\s+date/i.test(text))) {
    return { type: "contract_note", confidence: 1 };
  }
  if (/tax\s+invoice/i.test(text) && (/gstin/i.test(text) || /\bgst\b/i.test(text) || /hsn\s*\/\s*sac/i.test(text))) {
    return { type: "tax_invoice", confidence: 1 };
  }
  let best:DocumentType="unknown", score=0;
  for(const type of DOC_TYPES){if(type==="unknown")continue;const hints=DOCUMENT_TAXONOMY[type].recognitionHints;const hits=hints.filter(h=>lower.includes(h)).length;const s=hints.length?hits/hints.length:0;if(s>score){score=s;best=type;}}
  return{type:best,confidence:best==="unknown"?.2:Math.max(.5,Math.min(1,.7+.15*DOCUMENT_TAXONOMY[best].recognitionHints.filter(h=>lower.includes(h)).length))};
}
export interface TypedExtraction {
  documentType: DocumentType;
  confidence: number;
  issuer?: { name: string; kind: "person" | "organisation" | "account"; address?: string; contact?: string; email?: string; gstin?: string };
  vendor?: { name: string; kind: "organisation"; address?: string; contact?: string; email?: string };
  broker?: { name: string; kind: "organisation"; pan?: string; gstin?: string };
  client?: { name: string; kind: "person"; ucc?: string; pan?: string; mobile?: string };
  documentNumber?: string;
  documentDate?: string;
  dueDate?: string;
  financialYear?: string;
  currency?: string;
  amountMinor?: number;
  subtotalMinor?: number;
  taxMinor?: number;
  placeOfSupply?: string;
  lineItems?: Array<{ description: string; hsnSac: string; quantity: string; rateMinor: number; amountMinor: number }>;
  currencyConversion?: { required: boolean; originalAmountMinor: number; originalCurrency: string; targetCurrency: string; rateDate: string; source: "frankfurter" };
  bank?: { institution?: string; branch?: string; accountNumber?: string; last4?: string; type: "bank"; ifsc?: string; swift?: string };
  contractNoteNumber?: string;
  tradeDate?: string;
  settlementDate?: string;
  settlementNumber?: string;
  trades?: Array<{ security: string; isin: string; quantity?: number; priceMinor?: number; netObligationMinor: number; side?: "buy" | "sell" }>;
  payInOutObligationMinor?: number;
  ledgerBalanceMinor?: number;
  ledgerBalanceDirection?: "DR" | "CR";
  amountDirection?: "DR" | "CR";
  totalAmountInWords?: string;
  charges?: { brokerageMinor?: number; cgstMinor?: number; sgstMinor?: number; stampDutyMinor?: number; securitiesTransactionTaxMinor?: number };
  defaultImpactBucket: ImpactBucket;
  advisoryHint: string;
}

function minor(value: string): number {
  return Math.round(Number(value.replace(/[^\d.-]/g, "")) * 100);
}

function dateISO(raw: string): string | undefined {
  const value = raw.replace(/[\s*_#]+$/g, "").trim();
  const numeric = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (numeric) return `${numeric[3]}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  const english = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (english) {
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(english[1].toLowerCase());
    if (month >= 0) return `${english[3]}-${String(month + 1).padStart(2, "0")}-${english[2].padStart(2, "0")}`;
  }
  return undefined;
}

const clean = (value: string | undefined): string | undefined =>
  value?.replace(/[*#_|]+/g, " ").replace(/\s+/g, " ").trim() || undefined;

function financialYear(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const [year, month] = date.split("-").map(Number);
  const start = month >= 4 ? year : year - 1;
  return `FY ${start}-${String(start + 1).slice(-2)}`;
}

export function extractTypedDocument(text: string): TypedExtraction {
  const structuredText = text.replace(
    /\s+(?=(?:Invoice Number|Invoice Date|Due Date|Contact|Currency|Email|Place of Supply|GSTIN|BILL TO|Bank Details|Name|Bank|Branch|Current Account No\.?|IFS Code|SWIFT|Notes|PAN of Trading Member|GSTIN of Trading Member|Name of the Client|Address|UCC & Client Code|PAN of Client|Mobile No\.?|Contract Note No\.?|Trade Date|Settlement Number|Settlement Date|Net amount receivable\/payable by client|Pay In\/Pay Out Obligation|Ledger Balance|Total Amount in Words|CHARGES|TRADE DETAILS)\s*[:|])/gi,
    "\n",
  );
  const detected = detectDocumentType(structuredText);
  const meta = DOCUMENT_TAXONOMY[detected.type];
  const out: TypedExtraction = {
    documentType: detected.type,
    confidence: detected.confidence,
    defaultImpactBucket: meta.defaultImpactBucket,
    advisoryHint: meta.advisoryHint,
  };
  const capture = (pattern: RegExp): string | undefined => clean(pattern.exec(structuredText)?.[1]);
  const amount = (label: RegExp): number | undefined => {
    // Match amounts with optional decimal places: "1,445.00" or "1445" or "1,42,356.28"
    const raw = capture(new RegExp(`${label.source}[^\\d]{0,30}([\\d,]+(?:\\.\\d{1,2})?)`, "i"));
    if (!raw) return undefined;
    // If no decimal places, append ".00" so minor() works correctly.
    const normalized = raw.includes(".") ? raw : raw + ".00";
    return minor(normalized);
  };
  const personName = capture(/(?:issuer|invoice\s+for|receipt\s+for|person)\s*:?\s*(.+?)(?=\.\s+total\b|<|\n|$)/i);
  const organisationName = capture(/organisation\s*:?\s*(.+?)(?=\s*<|\.\s+total\b|\n|$)/i)
    ?? capture(/vendor\s*:?\s*(.+?)(?=\s*<|\.\s+total\b|\n|$)/i);
  const emails = [...structuredText.matchAll(/[\w.+-]+@[\w.-]+/g)].map((match) => match[0]);

  if (detected.type === "tax_invoice") {
    out.documentNumber = capture(/invoice\s+number\s*[:#-]?\s*([^\n*]+)/i)
      ?? capture(/^\s*invoice\s+no\.?\s*[:#-]?\s*([^\n*]+)/im)
      ?? capture(/(?:sr|s\.?no|receipt|bill)\s*(?:no|number)\s*[:#-]?\s*([A-Z0-9-]+)/i);
    out.documentDate = dateISO(capture(/invoice\s*date\s*[:#-]?\s*([^\n*]+)/i) ?? "")
      ?? dateISO(capture(/^\s*date\s*[:#|]?\s*([^\n*]+)/im) ?? "");
    out.dueDate = dateISO(capture(/due\s*date\s*[:#-]?\s*([^\n*]+)/i) ?? "");
    out.financialYear = financialYear(out.documentDate);
    out.currency = capture(/currency\s*[:#-]?\s*\**\s*([A-Z]{3})/i)?.toUpperCase();
    out.placeOfSupply = capture(/place\s+of\s+supply\s*[:#-]?\s*\**\s*([A-Za-z ]+)/i);
    out.amountMinor = amount(/(?:grand\s+)?total/i)
      ?? [...structuredText.matchAll(/[$₹€£]\s*([\d,]+(?:\.\d{1,2})?)/g)].map((m) => minor(m[1].includes(".") ? m[1] : m[1] + ".00")).at(-1);
    out.subtotalMinor = amount(/subtotal/i) ?? out.amountMinor;
    out.taxMinor = amount(/\btax\b/i) ?? 0;
    if (out.currency && out.currency !== "INR" && out.amountMinor && out.documentDate) {
      out.currencyConversion = {
        required: true,
        originalAmountMinor: out.amountMinor,
        originalCurrency: out.currency,
        targetCurrency: "INR",
        rateDate: out.documentDate,
        source: "frankfurter",
      };
    }

    const heading = structuredText.split(/\r?\n/).map(clean).find((line) => line && !/tax invoice/i.test(line));
    const headingPrefix = clean(structuredText.split(/tax\s+invoice/i)[0]);
    const issuerName = headingPrefix || clean(/^\s*(?:#{1,4}\s*)?([^\n]+)$/m.exec(structuredText)?.[1]) || heading;
    if (issuerName) {
      const issuerGstin = capture(/gstin\s*:\s*([A-Z0-9]{15})/i);
      const address = [
        capture(/tax\s+invoice\s*\n+\s*([^\n]+)/i),
        capture(/invoice\s+number[^\n]*\n+\s*([^\n]+)/i),
        capture(/invoice\s+date[^\n]*\n+\s*([^\n]+)/i),
        capture(/due\s+date[^\n]*\n+\s*([^\n*]+?)(?=\*\*contact)/i),
      ].filter(Boolean).join(", ");
      out.issuer = {
        name: issuerName,
        kind: issuerGstin ? "organisation" : "person",
        address: address || undefined,
        contact: clean(/contact\s*:\s*\**\s*([^*\n]+?)(?=\*+currency|\n|$)/i.exec(structuredText)?.[1]),
        email: [...structuredText.matchAll(/[\w.+-]+@[\w.-]+/g)].map((match) => match[0])[0],
        gstin: issuerGstin,
      };
    }
    const vendor = capture(/bill\s+to\s+details[\s\S]{0,500}?^\s*#{1,4}\s*([^\n]+)/im)
      ?? capture(/bill\s+to(?:\s+details)?\s*[:#-]?\s*([^\n]+)/i);
    if (vendor && !/details/i.test(vendor)) {
      out.vendor = {
        name: vendor,
        kind: "organisation",
        address: capture(new RegExp(`${vendor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\n+([^\\n]+)`, "i")),
        contact: capture(/contact\s+person\s*:\s*([^\n*]+?)(?=email|gst|$)/i),
        email: [...structuredText.matchAll(/[\w.+-]+@[\w.-]+/g)].map((m) => m[0]).find((email) => email !== out.issuer?.email),
      };
    }
    const bankText = capture(/bank\s+details\s*:(.+?)(?=notes|terms|supply meant|$)/is);
    if (bankText) {
      const accountNumber = clean(/(?:account\s*(?:no\.?|number)|current\s+account\s+no\.?)\s*:\s*(\d+)/i.exec(bankText)?.[1]);
      const institution = capture(/bank\s*:\s*([^\n*]+?)(?=branch|current|account|$)/i);
      const branch = capture(/branch\s*:\s*(.+?)(?=,\s*INDIA|current|account|terms|$)/i);
      const ifsc = capture(/(?:ifsc|ifs\s+code)\s*:\s*([A-Z0-9]+)/i);
      const swift = capture(/swift\s*:\s*([A-Z0-9]+)/i);
      if (institution || branch || accountNumber || ifsc || swift) {
        out.bank = {
          type: "bank",
          institution,
          branch,
          accountNumber,
          last4: accountNumber?.slice(-4),
          ifsc,
          swift,
        };
      }
    }
    const descriptions = /description\s+amount\s*\n+([^\n]+)/i.exec(structuredText)?.[1] ?? "";
    const hsnRows = [...structuredText.matchAll(/([^\n|]+?)\s*\|\s*(\d{4,8})\s*\|\s*([\d.]+)\s*\|\s*[$₹€£]?\s*([\d,.]+)\s*\|\s*[$₹€£]?\s*([\d,.]+)(?=\s+(?:[^\n|]+?\s*\|\s*\d{4,8}\s*\|)|\s+(?:subtotal|tax|total)\s*:|$)/gi)];
    const itemAmounts = [...descriptions.matchAll(/(.+?)\s+[$₹€£]\s*([\d,]+(?:\.\d{2})?)(?=\s+[A-Z]|$)/g)];
    out.lineItems = hsnRows.length > 0
      ? hsnRows.map((row) => ({
          description: clean(row[1]) ?? "Line item",
          hsnSac: row[2],
          quantity: row[3],
          rateMinor: minor(row[4]),
          amountMinor: minor(row[5]),
        }))
      : [...structuredText.matchAll(/^(.+?)\s*\|\s*(\d{4,8})\s*\|\s*([\d.]+)\s*\|\s*[$₹€£]?([\d,.]+)\s*\|\s*[$₹€£]?([\d,.]+)\s*$/gm)].map((row) => ({
          description: clean(row[1]) ?? "Line item",
          hsnSac: row[2],
          quantity: row[3],
          rateMinor: minor(row[4]),
          amountMinor: minor(row[5]),
        }));
  } else if (detected.type === "contract_note") {
    const brokerName = capture(/^\s*(?:#{1,4}\s*)?([A-Z][A-Z ]+LIMITED)\s+CONTRACT\s+NOTE/im)
      ?? capture(/(?:^|\n)\s*#{1,4}\s*([^\n]*\blimited\b)/im)
      ?? capture(/contract\s+note(?:\s+cum\s+tax\s+invoice)?[\s\S]{0,160}?([A-Z][A-Z ]+LIMITED)/i);
    out.broker = brokerName ? {
      name: brokerName,
      kind: "organisation",
      pan: capture(/pan\s+of\s+trading\s+member\s*\|?\s*([A-Z0-9]+)/i),
      gstin: capture(/gstin\s+of\s+trading\s+member\s*\|?\s*([A-Z0-9]+)/i),
    } : undefined;
    if (brokerName) out.vendor = { name: brokerName, kind: "organisation" };
    const clientName = capture(/name\s+of\s+the\s+client\s*:\s*([^*]+?)(?=branch|address|$)/i);
    if (clientName) out.client = {
      name: clientName,
      kind: "person",
      ucc: capture(/ucc\s*&\s*client\s+code\s*:\s*([A-Z0-9]+)/i),
      pan: /pan\s+of\s+client\s*:\s*([A-Z0-9*]+)/i.exec(text)?.[1],
      mobile: /mobile\s+no\.\s*:\s*\*{0,2}\s*([*]+\d+)/i.exec(text)?.[1],
    };
    out.contractNoteNumber = capture(/contract\s+note\s*(?:number|no\.?)\s*:?\s*\**\s*(\d+)/i);
    out.tradeDate = dateISO(capture(/trade\s+date\s*:\s*\**\s*(\d{1,2}\/\d{1,2}\/\d{4})/i) ?? "");
    out.financialYear = financialYear(out.tradeDate);
    out.settlementNumber = capture(/settlement\s+(?:number|no\.?)\s*\|?\s*(\d+)/i)
      ?? capture(/settlement\s+no\**\s*(\d+)/i);
    out.settlementDate = dateISO(capture(/settlement(?:\s+date)?\**\s*(\d{1,2}\/\d{1,2}\/\d{4})/i) ?? "");
    out.currency = "INR";
    const totalMatch = /net\s+amount\s+receivable\/payable\s+by\s+client[^\d]*([\d,]+\.\d{2})\s*(DR|CR)/i.exec(structuredText);
    if (totalMatch) {
      out.amountMinor = minor(totalMatch[1]);
      out.amountDirection = totalMatch[2].toUpperCase() as "DR" | "CR";
    }
    out.payInOutObligationMinor = amount(/pay\s+in\/pay\s+out\s+obligation/i);
    const ledger = /ledger\s+balance[^\d]*([\d,]+\.\d{2})\s*(DR|CR)/i.exec(structuredText);
    if (ledger) {
      out.ledgerBalanceMinor = minor(ledger[1]);
      out.ledgerBalanceDirection = ledger[2].toUpperCase() as "DR" | "CR";
    }
    out.totalAmountInWords = capture(/total\s+amount\s+in\s+words\s*\|?\s*([^\n|]+)/i);
    out.charges = {
      brokerageMinor: amount(/taxable\s+value\s+of\s+supply\s*\(brokerage\)/i),
      cgstMinor: amount(/cgst[^\n|]*/i),
      sgstMinor: amount(/sgst[^\n|]*/i),
      stampDutyMinor: amount(/stamp\s+duty/i),
      securitiesTransactionTaxMinor: amount(/securities\s+transactions?\s+tax/i),
    };
    out.trades = [];
    const seenTradeIsins = new Set<string>();
    for (const labelled of structuredText.matchAll(/(.+?)\s+(INE[A-Z0-9]{9})\s+Qty\s+([\d.]+)\s+Price\s+([\d,.]+)\s+Net\s+([\d,.]+)\s+(DR|CR)(?=\s+.+?\s+INE[A-Z0-9]{9}\s+Qty\b|\s+Net\s+amount\b|\n|$)/gi)) {
      if (seenTradeIsins.has(labelled[2])) continue;
      out.trades.push({
        security: clean(labelled[1]) ?? labelled[2],
        isin: labelled[2],
        quantity: Number(labelled[3]),
        priceMinor: minor(labelled[4]),
        netObligationMinor: minor(labelled[5]),
        side: labelled[6].toUpperCase() === "CR" ? "sell" : "buy",
      });
      seenTradeIsins.add(labelled[2]);
    }
    for (const line of structuredText.split(/\r?\n/)) {
      const compact = clean(line) ?? "";
      const isin = /(INE[A-Z0-9]{9})/i.exec(compact);
      if (!isin || seenTradeIsins.has(isin[1])) continue;
      const before = compact.slice(0, isin.index).trim();
      const after = compact.slice(isin.index + isin[0].length).trim();
      const tailSource = after;
      const numericTail = /\s(\d+(?:\.\d+)?)\s+([\d,.]+)\s+\2\s+([\d,.]+)\s+\d+\s*-?([\d,.]+)\s*$/.exec(tailSource)
        ?? /\s(\d+(?:\.\d+)?)\s+([\d,.]+)(?:\s+[\d,.]+)*\s+-?([\d,.]+)\s*$/.exec(tailSource);
      if (!numericTail) continue;
      const quantity = Number(numericTail[1]);
      const price = Number(numericTail[2].replace(/,/g, ""));
      const amountValue = Math.abs(Number((numericTail[4] ?? numericTail[3]).replace(/,/g, "")));
      let name = clean(tailSource.slice(0, numericTail.index)) ?? isin[0];
      if (before) name = `${before} ${name}`;
      if (/^LIMITED\//i.test(name)) {
        const parts = name.split(/\s+/);
        name = `${parts.at(-1)} ${parts.slice(0, -1).join(" ")}`;
      }

      out.trades.push({
        security: name,
        isin: isin[1],
        quantity,
        priceMinor: Math.round(price * 100),
        netObligationMinor: Math.round(amountValue * 100),
        side: "buy",
      });
      seenTradeIsins.add(isin[1]);
    }
    for (const line of structuredText.split(/\r?\n/)) {
      const wrapped = /^(.*?)\s*(INE[A-Z0-9]{9})\s+(.+?)\s+(\d+(?:\.\d+)?)\s+([\d,.]+)\s+[\d,.]+\s+([\d,.]+)\s+\d+-([\d,.]+)\s+(.+)$/.exec(clean(line) ?? "");
      if (!wrapped || out.trades.some((trade) => trade.isin === wrapped[2])) continue;
      const suffix = wrapped[8];
      out.trades.push({
        security: clean(`${wrapped[1]} ${wrapped[3]} ${suffix}`) ?? wrapped[2],
        isin: wrapped[2],
        quantity: Number(wrapped[4]),
        priceMinor: minor(wrapped[5]),
        netObligationMinor: minor(wrapped[7] || wrapped[6]),
        side: "buy",
      });
    }
  } else {
    out.amountMinor = amount(/(?:total|amount)/i);
    if (personName) out.issuer = { name: personName, kind: "person", email: emails[0] };
    if (organisationName) {
      out.vendor = { name: organisationName, kind: "organisation", email: emails.at(-1) };
    }
  }
  return out;
}
