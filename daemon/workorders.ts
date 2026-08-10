/**
 * WO09 + WO10 backend contracts.
 *
 * This module is deliberately small and dependency-free: the existing daemon
 * can adopt these contracts incrementally while old v1 state names and routes
 * remain supported at the edges.
 */
import type { DatabaseSync } from "node:sqlite";
import * as crypto from "node:crypto";

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

/** Frankfurter implementation with an injectable HTTP boundary for deterministic tests. */
export class FrankfurterFx {
  constructor(private readonly db: DatabaseSync, private readonly http: HttpGet = (url) => fetch(url)) {}

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
  private make(amount: number, from: string, _to: string, rate: number, date: string, freshness: CurrencyConversion["freshness"]): CurrencyConversion {
    return { originalAmount: amount, originalCurrency: from, convertedAmount: Math.round(amount * rate), rate, rateDate: date, rateSource: "frankfurter", provenance: "ai-derived", freshness };
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
export interface LearningAmbiguity {
  kind: LearningTrigger; dedupeKey: string; prompt: string;
  sourceFact: Record<string, unknown>;
  predictedRule: { kind: PredictedRuleKind; payload: Record<string, unknown> };
  noveltyScore: number; why: string; ttl?: string;
}
export interface LearningQuestion {
  type: "learning.question"; questionId: string; askedAt: string;
  trigger: { kind: LearningTrigger; documentId: string; pipelineState: "analysing" | "complete"; noveltyScore: number };
  prompt: string; sourceFact: Record<string, unknown>;
  predictedRule: LearningAmbiguity["predictedRule"]; dedupeKey: string; why: string; ttl?: string;
}
function setting(db: DatabaseSync, key: string): string | undefined {
  return (db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value?: string } | undefined)?.value;
}
function availableQuestionBudget(db: DatabaseSync): number {
  if (setting(db, "learning.enabled") === "false") return 0;
  const manual = Number(setting(db, "learning.question_budget"));
  const cap = Number.isInteger(manual) && manual >= 0 ? Math.min(20, manual) : 3;
  const open = (db.prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NULL AND dismissed=0").get() as { n: number }).n;
  const rules = (db.prepare("SELECT COUNT(*) n FROM learned_rules WHERE active=1").get() as { n: number }).n;
  return Math.max(0, cap - open - Math.floor(rules / 10));
}
export function generateLearningQuestions(
  db: DatabaseSync,
  ports: { clock: { isoNow(): string }; bus: { publish(e: never): void } },
  input: { documentId: string; pipelineState: "analysing" | "complete"; ambiguities: LearningAmbiguity[] },
): LearningQuestion[] {
  let remaining = availableQuestionBudget(db);
  if (remaining <= 0) return [];
  const out: LearningQuestion[] = [];
  for (const ambiguity of input.ambiguities) {
    if (remaining-- <= 0) break;
    if (!LEARNING_TRIGGERS.includes(ambiguity.kind)) continue;
    if (!(ambiguity.noveltyScore >= 0 && ambiguity.noveltyScore <= 1) || !ambiguity.why.trim()) continue;
    const existing = db.prepare("SELECT 1 FROM training_reviews WHERE dedupe_key=?").get(ambiguity.dedupeKey);
    if (existing) continue; // answered, ignored and open questions all dedupe
    const askedAt = ports.clock.isoNow();
    const inserted = db.prepare(
      `INSERT INTO training_reviews(question,context,trigger,options,dedupe_key,novelty_score,predicted_rule,why,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(ambiguity.prompt, JSON.stringify({ document_id: input.documentId, pipeline_state: input.pipelineState, source_fact: ambiguity.sourceFact }), ambiguity.kind,
      JSON.stringify(["Yes", "No", "Later"]), ambiguity.dedupeKey, ambiguity.noveltyScore, JSON.stringify(ambiguity.predictedRule), ambiguity.why, askedAt);
    const q: LearningQuestion = { type: "learning.question", questionId: String(inserted.lastInsertRowid), askedAt,
      trigger: { kind: ambiguity.kind, documentId: input.documentId, pipelineState: input.pipelineState, noveltyScore: ambiguity.noveltyScore },
      prompt: ambiguity.prompt, sourceFact: ambiguity.sourceFact, predictedRule: ambiguity.predictedRule,
      dedupeKey: ambiguity.dedupeKey, why: ambiguity.why, ttl: ambiguity.ttl };
    ports.bus.publish(q as never); out.push(q);
  }
  return out;
}
export function answerLearningQuestion(
  db: DatabaseSync,
  ports: { clock: { isoNow(): string }; bus: { publish(e: never): void } },
  questionId: string | number, answer: string,
): { ruleId: number | null } {
  const row = db.prepare("SELECT id,predicted_rule,answered_at,dismissed,context FROM training_reviews WHERE id=?").get(questionId) as
    | { id: number; predicted_rule: string | null; answered_at: string | null; dismissed: number; context: string | null } | undefined;
  if (!row) throw new Error("learning question not found");
  if (row.answered_at || row.dismissed) return { ruleId: null };
  const now = ports.clock.isoNow(); let ruleId: number | null = null;
  if (/^(yes|confirm|accept)/i.test(answer) && row.predicted_rule) {
    const predicted = JSON.parse(row.predicted_rule) as LearningAmbiguity["predictedRule"];
    const key = String(predicted.payload.match_key ?? predicted.payload.alias ?? questionId);
    const value = String(predicted.payload.value ?? predicted.payload.entity_id ?? answer);
    const info = db.prepare(
      `INSERT INTO learned_rules(kind,match_key,match_kind,value,source,confidence,active,created_at)
       VALUES(?,?,NULL,?,'user',1,1,?)
       ON CONFLICT(kind,match_key,COALESCE(match_kind,'')) DO UPDATE SET value=excluded.value,active=1,confidence=1`,
    ).run(predicted.kind, key, value, now);
    ruleId = Number(info.lastInsertRowid);
    const context = row.context ? JSON.parse(row.context) as Record<string, unknown> : {};
    ports.bus.publish({ type: "learning.rule.applied", ruleId, documentId: context.document_id as string | undefined, at: now } as never);
  }
  db.prepare("UPDATE training_reviews SET answer=?,answered_at=?,rule_id=? WHERE id=?").run(answer, now, ruleId, row.id);
  ports.bus.publish({ type: "learning.answer", questionId: String(row.id), answeredAt: now, answer } as never);
  return { ruleId };
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
  if (/tax\s+invoice/i.test(text) && (/gstin/i.test(text) || /hsn\s*\/\s*sac/i.test(text))) {
    return { type: "tax_invoice", confidence: 1 };
  }
  let best:DocumentType="unknown", score=0;
  for(const type of DOC_TYPES){if(type==="unknown")continue;const hints=DOCUMENT_TAXONOMY[type].recognitionHints;const hits=hints.filter(h=>lower.includes(h)).length;const s=hints.length?hits/hints.length:0;if(s>score){score=s;best=type;}}
  return{type:best,confidence:best==="unknown"?.2:Math.max(.5,Math.min(1,.7+.15*DOCUMENT_TAXONOMY[best].recognitionHints.filter(h=>lower.includes(h)).length))};
}
export interface TypedExtraction { documentType:DocumentType; confidence:number; vendor?:string; documentNumber?:string; documentDate?:string; dueDate?:string; currency?:string; amountMinor?:number; lineItems?:Array<{description:string;hsnSac:string;quantity:number;rateMinor:number;amountMinor:number}>; contractNoteNumber?:string; tradeDate?:string; settlementDate?:string; settlementNumber?:string; trades?:Array<{securityName:string;isin:string;quantity?:number;priceMinor?:number;amountMinor:number}>; defaultImpactBucket:ImpactBucket; advisoryHint:string; }
function minor(s:string):number{return Math.round(Number(s.replace(/,/g,""))*100);}
function dateISO(raw:string):string|undefined{const s=raw.trim();let m=/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);if(m)return`${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;const d=new Date(s);return Number.isNaN(d.valueOf())?undefined:d.toISOString().slice(0,10);}
export function extractTypedDocument(text:string):TypedExtraction {
  const detected=detectDocumentType(text), meta=DOCUMENT_TAXONOMY[detected.type]; const out:TypedExtraction={documentType:detected.type,confidence:detected.confidence,defaultImpactBucket:meta.defaultImpactBucket,advisoryHint:meta.advisoryHint};
  const capture=(re:RegExp)=>re.exec(text)?.[1]?.trim();
  if(detected.type==="tax_invoice"){
    out.documentNumber=capture(/(?:invoice\s*(?:number|no\.?|#))\s*[:#-]?\s*([^\n]+)/i); const ds=capture(/invoice\s*date\s*[:#-]?\s*([^\n]+)/i); if(ds)out.documentDate=dateISO(ds); const due=capture(/due\s*date\s*[:#-]?\s*([^\n]+)/i);if(due)out.dueDate=dateISO(due);
    out.vendor=capture(/bill\s*to\s*[:#-]?\s*([^\n,]+)/i); out.currency=capture(/currency\s*[:#-]?\s*([A-Z]{3})/i)?.toUpperCase()??capture(/total\s*[:#-]?\s*[\d,.]+\s*([A-Z]{3})/i)?.toUpperCase(); const total=capture(/(?:grand\s+)?total\s*[:#-]?\s*(?:[$₹€£]\s*)?([\d,]+\.\d{2})/i);if(total)out.amountMinor=minor(total);
    out.lineItems=[]; for(const line of text.split(/\r?\n/)){const m=/^(.+?)\s*\|\s*(\d{4,8})\s*\|\s*([\d.]+)\s*\|\s*[$₹€£]?([\d,.]+)\s*\|\s*[$₹€£]?([\d,.]+)\s*$/.exec(line.trim());if(m)out.lineItems.push({description:m[1].trim(),hsnSac:m[2],quantity:Number(m[3]),rateMinor:minor(m[4]),amountMinor:minor(m[5])});}
  } else if(detected.type==="contract_note"){
    out.vendor=text.split(/\r?\n/).map(s=>s.trim()).find(s=>/\b(?:limited|securities|broker)\b/i.test(s)); out.contractNoteNumber=capture(/contract\s*note\s*(?:number|no\.?|#)?\s*[:#-]?\s*(\d+)/i);const td=capture(/trade\s*date\s*[:#-]?\s*([^\n]+)/i);if(td)out.tradeDate=dateISO(td);const sd=capture(/settlement\s*date\s*[:#-]?\s*([^\n]+)/i);if(sd)out.settlementDate=dateISO(sd);out.settlementNumber=capture(/settlement\s*(?:number|no\.?)\s*[:#-]?\s*(\d+)/i);const total=capture(/net\s+amount\s+receivable\/payable\s+by\s+client\s*[:#-]?\s*([\d,]+\.\d{2})/i);if(total)out.amountMinor=minor(total);
    out.trades=[];for(const line of text.split(/\r?\n/)){const m=/^(.+?)\s+(INE[A-Z0-9]{9})\s+Qty\s+([\d.]+)\s+Price\s+([\d,.]+)\s+Net\s+([\d,.]+)\s+(?:DR|CR)/i.exec(line.trim());if(m)out.trades.push({securityName:m[1].trim(),isin:m[2],quantity:Number(m[3]),priceMinor:minor(m[4]),amountMinor:minor(m[5])});}
  } else { const amt=capture(/(?:total|amount)\s*[:#-]?\s*(?:[$₹€£]\s*)?([\d,]+\.\d{2})/i);if(amt)out.amountMinor=minor(amt); }
  return out;
}
