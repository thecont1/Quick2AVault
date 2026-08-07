/**
 * Document detail / evidence assembly.
 *
 * Builds one canonical, inspectable view of any ingested document by joining:
 *  - the document record (paths, dates, file type, currency)
 *  - the per-field reviews (extracted value, confidence, source of truth, status)
 *  - the snapshot's AI attribution (person, category, period)
 *  - the canonical Person entity (aliases, roles, identity evidence)
 *  - learned rules (business/personal scope inference)
 *
 * This is a read-only assembly layer — field actions (confirm / correct / defer,
 * rule learning, audit) flow through the existing Review Queue service. Never
 * throws; a missing document returns null.
 */
import * as fs from "node:fs/promises";

import { logger, shell } from "@glaze/core/backend";

import {
  findDocumentById,
  getContractNote,
  listDocuments,
  listDocumentOverrides,
  listFieldReviews,
  listLearnedRules,
  listReviewAudit,
  REVIEW_FIELDS,
  type AccountingHint,
  type ContractNoteRecord,
  type CurrencyFields,
  type DocumentFieldReview,
  type FieldSource,
  type FinancialImpact,
  type LifecycleState,
  type PersonRole,
  type ReviewAuditEntry,
  type ReviewField,
  type ReviewStatus,
} from "./database.js";
import { buildAliasIndex, listAllAliases, listPeople, resolveNameToPersonId, type PersonEntity } from "./people.js";
// getAttributionMap reads the snapshot cache (person/category/period per doc) — no AI.
import { getAttributionMap } from "./snapshot.js";

// ── Public shapes (IPC / UI) ─────────────────────────────────────────────

/** Human-readable label per review field. */
export const FIELD_LABEL: Record<ReviewField, string> = {
  person: "Person",
  doc_type: "Document type",
  vendor: "Vendor",
  doc_date: "Document date",
  fin_year: "Financial year",
  amount: "Amount",
  fx: "Currency conversion",
  accounting: "Accounting",
  impact: "Financial impact",
};

/** Compact status used for the browser list's overall review badge. */
export type OverallReviewStatus = "conflict" | "missing" | "low_confidence" | "ok";

export interface DocumentBrowserRow {
  docId: number;
  filename: string;
  fileType: string;
  rawPath: string;
  markdownPath: string;
  dateIngested: string;
  /** Canonical/display person name, or null when unidentified. */
  personName: string | null;
  personIsSelf: boolean;
  personRoles: PersonRole[];
  docType: string | null;
  vendor: string | null;
  docDate: string | null;
  /** Financial-year key (e.g. "2025-26"), or null when undetermined. */
  financialYear: string | null;
  category: string | null;
  /** Worst pending review state across fields; "ok" when nothing pending. */
  reviewStatus: OverallReviewStatus;
  pendingCount: number;
  /** True when the user has confirmed/corrected at least one field. */
  hasManualOverride: boolean;
  /** True when a foreign-currency conversion was computed for this document. */
  hasFx: boolean;
  /** Foreign-currency snapshot for a compact summary line. */
  foreignAmount: number | null;
  foreignCurrency: string | null;
  inrValue: number | null;
  currencyStatus: CurrencyFields["currencyStatus"];
  /** Plain-language financial impact (bucket + amount), or null. */
  impact: FinancialImpact | null;
  impactBucket: string | null;
  impactDirection: "in" | "out" | "neutral" | null;
  /** True when this is a broker contract note (securities trade). */
  isContractNote: boolean;
  /** Intake triage lane / lifecycle state. */
  lifecycleState: LifecycleState;
  /** One-line explanation of the triage decision, or null. */
  triageReason: string | null;
  /** Whether the document was ingested from Gmail or a file import. */
  source: "gmail" | "file";
}

export interface DetailField {
  field: ReviewField;
  label: string;
  /** The value in effect now (final if resolved, else extracted). */
  value: string | null;
  extractedValue: string | null;
  suggestedValue: string | null;
  confidence: number;
  source: FieldSource;
  status: ReviewStatus;
  reason: string;
  /** True when the user has personally confirmed/corrected this field. */
  userTouched: boolean;
}

export interface PersonContext {
  personId: number | null;
  name: string | null;
  isSelf: boolean;
  roles: PersonRole[];
  aliases: string[];
  confidence: number | null;
  source: FieldSource | null;
  status: "candidate" | "confirmed" | null;
  /** Identity reasoning: why this name resolved to this canonical person. */
  evidence: { kind: string; detail: string }[];
}

export interface DocumentDetail {
  docId: number;
  filename: string;
  fileType: string;
  rawPath: string;
  markdownPath: string;
  dateIngested: string;
  docDate: string | null;
  /** Financial-year key (e.g. "2025-26"), or null when undetermined. */
  financialYear: string | null;
  docType: string | null;
  vendor: string | null;
  category: string | null;
  /** Intake triage lane / lifecycle state. */
  lifecycleState: LifecycleState;
  /** One-line explanation of the triage decision, or null. */
  triageReason: string | null;
  /** Best-effort business/personal classification from a learned rule. */
  scope: "business" | "personal" | null;
  scopeEvidence: string | null;
  person: PersonContext;
  currency: CurrencyFields;
  /** Advisory accounting treatment hint, or null when not applicable. */
  accounting: AccountingHint | null;
  /** Plain-language financial impact (bucket + amount), or null. */
  impact: FinancialImpact | null;
  /** Broker contract-note header + trades, when this is a contract note. */
  contractNote: ContractNoteRecord | null;
  fields: DetailField[];
  audit: ReviewAuditEntry[];
  /** A short excerpt of the converted Markdown, for evidence context. */
  markdownExcerpt: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const FIELD_ORDER = new Map(REVIEW_FIELDS.map((f, i) => [f, i]));

function userTouched(r: DocumentFieldReview): boolean {
  return r.status === "corrected" || r.source === "user_confirmed" || r.source === "manual";
}

function toDetailField(r: DocumentFieldReview): DetailField {
  return {
    field: r.field,
    label: FIELD_LABEL[r.field],
    value: r.finalValue ?? r.extractedValue,
    extractedValue: r.extractedValue,
    suggestedValue: r.suggestedValue,
    confidence: r.confidence,
    source: r.source,
    status: r.status,
    reason: r.reason,
    userTouched: userTouched(r),
  };
}

/** Worst pending state wins for the list badge; resolved fields don't count. */
function overallStatus(reviews: DocumentFieldReview[]): {
  status: OverallReviewStatus;
  pending: number;
} {
  let conflict = false;
  let missing = false;
  let low = false;
  let pending = 0;
  for (const r of reviews) {
    if (r.status === "conflict") {
      conflict = true;
      pending++;
    } else if (r.status === "missing") {
      missing = true;
      pending++;
    } else if (r.status === "low_confidence") {
      low = true;
      pending++;
    }
  }
  const status: OverallReviewStatus = conflict
    ? "conflict"
    : missing
      ? "missing"
      : low
        ? "low_confidence"
        : "ok";
  return { status, pending };
}

/**
 * Best-effort business/personal classification: a learned `source_scope` rule
 * whose match key appears in the document's vendor / filename / category.
 */
function detectScope(
  haystack: string,
): { scope: "business" | "personal"; matchKey: string } | null {
  const h = haystack.toLowerCase();
  for (const r of listLearnedRules()) {
    if (r.ruleType !== "source_scope" || r.matchKey.length < 2) continue;
    if (h.includes(r.matchKey.toLowerCase())) {
      const v = r.value.trim().toLowerCase();
      if (v === "business" || v === "personal") return { scope: v, matchKey: r.matchKey };
    }
  }
  return null;
}

function fieldValue(reviews: DocumentFieldReview[], field: ReviewField): string | null {
  const r = reviews.find((x) => x.field === field);
  if (!r) return null;
  return r.finalValue ?? r.extractedValue;
}

// ── Browser list ─────────────────────────────────────────────────────────

/** A lightweight row per ingested document for the browser list (no file reads). */
export function listDocumentBrowser(): DocumentBrowserRow[] {
  const docs = listDocuments(1000);
  const overrides = new Map(listDocumentOverrides().map((o) => [o.docId, o.person]));
  const attribution = getAttributionMap();
  const aliasIndex = buildAliasIndex();
  const allAliases = listAllAliases();
  const peopleById = new Map(listPeople().map((p) => [p.id, p]));

  return docs.map((doc) => {
    const reviews = listFieldReviews(doc.id);
    const { status, pending } = overallStatus(reviews);

    // Person: a manual pin beats the AI attribution; resolve to canonical.
    const rawName = overrides.has(doc.id)
      ? overrides.get(doc.id)!
      : (attribution.get(doc.id)?.person ?? null);
    const personId = resolveNameToPersonId(rawName, aliasIndex, allAliases);
    const entity = personId != null ? peopleById.get(personId) : undefined;

    const hasManualOverride =
      overrides.has(doc.id) ||
      reviews.some((r) => r.source === "user_confirmed" || r.source === "manual");

    return {
      docId: doc.id,
      filename: doc.originalFilename,
      fileType: doc.fileType,
      rawPath: doc.rawPath,
      markdownPath: doc.markdownPath,
      dateIngested: doc.dateIngested,
      personName: entity ? entity.displayName : rawName,
      personIsSelf: entity?.isSelf ?? false,
      personRoles: entity?.roles ?? [],
      docType: fieldValue(reviews, "doc_type"),
      vendor: fieldValue(reviews, "vendor"),
      docDate:
        doc.documentDate ??
        fieldValue(reviews, "doc_date") ??
        attribution.get(doc.id)?.periodStart ??
        null,
      financialYear: doc.financialYear,
      category: attribution.get(doc.id)?.category ?? null,
      reviewStatus: status,
      pendingCount: pending,
      hasManualOverride,
      hasFx: doc.currencyStatus === "converted",
      foreignAmount: doc.foreignAmount,
      foreignCurrency: doc.foreignCurrency,
      inrValue: doc.inrValue,
      currencyStatus: doc.currencyStatus,
      impact: doc.impact,
      impactBucket: doc.impact?.bucket ?? null,
      impactDirection: doc.impact?.direction ?? null,
      isContractNote: doc.isContractNote,
      lifecycleState: doc.lifecycleState,
      triageReason: doc.triageReason,
      source: isGmailSourced(doc.id) ? "gmail" : "file",
    };
  });
}

// ── Full detail / evidence card ──────────────────────────────────────────

function buildPersonContext(
  doc: { id: number },
  overrides: Map<number, string | null>,
  attribution: Map<number, { person: string | null }>,
  aliasIndex: Map<string, number>,
  entities: PersonEntity[],
): PersonContext {
  const rawName = overrides.has(doc.id)
    ? overrides.get(doc.id)!
    : (attribution.get(doc.id)?.person ?? null);
  const personId = resolveNameToPersonId(rawName, aliasIndex);
  const entity = personId != null ? entities.find((e) => e.id === personId) : undefined;
  if (!entity) {
    return {
      personId: null,
      name: rawName,
      isSelf: false,
      roles: [],
      aliases: [],
      confidence: null,
      source: null,
      status: null,
      evidence: [],
    };
  }
  return {
    personId: entity.id,
    name: entity.displayName,
    isSelf: entity.isSelf,
    roles: entity.roles,
    aliases: entity.aliases.map((a) => a.alias),
    confidence: entity.confidence,
    source: entity.nameSource,
    status: entity.status,
    // Prefer evidence tied to this document, then general identity evidence.
    evidence: entity.evidence
      .slice()
      .sort((a, b) => Number(b.docId === doc.id) - Number(a.docId === doc.id))
      .slice(0, 6)
      .map((e) => ({ kind: e.kind, detail: e.detail })),
  };
}

async function readExcerpt(markdownPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(markdownPath, "utf-8");
    const trimmed = content.trim();
    if (!trimmed) return null;
    return trimmed.length > 1200 ? `${trimmed.slice(0, 1200).trimEnd()}…` : trimmed;
  } catch {
    return null;
  }
}

/** Assemble the full evidence card for one document, or null when it's gone. */
export async function getDocumentDetail(docId: number): Promise<DocumentDetail | null> {
  const doc = findDocumentById(docId);
  if (!doc) return null;

  const overrides = new Map(listDocumentOverrides().map((o) => [o.docId, o.person]));
  const attribution = getAttributionMap();
  const aliasIndex = buildAliasIndex();
  const entities = listPeople();

  const reviews = listFieldReviews(docId).sort(
    (a, b) => (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0),
  );

  const person = buildPersonContext(doc, overrides, attribution, aliasIndex, entities);
  const docType = fieldValue(reviews, "doc_type");
  const vendor = fieldValue(reviews, "vendor");
  const docDate =
    doc.documentDate ??
    fieldValue(reviews, "doc_date") ??
    attribution.get(docId)?.periodStart ??
    null;
  const category = attribution.get(docId)?.category ?? null;

  const scopeHit = detectScope([vendor ?? "", doc.originalFilename, category ?? ""].join(" "));

  return {
    docId,
    filename: doc.originalFilename,
    fileType: doc.fileType,
    rawPath: doc.rawPath,
    markdownPath: doc.markdownPath,
    dateIngested: doc.dateIngested,
    docDate,
    financialYear: doc.financialYear,
    docType,
    vendor,
    category,
    lifecycleState: doc.lifecycleState,
    triageReason: doc.triageReason,
    scope: scopeHit?.scope ?? null,
    scopeEvidence: scopeHit ? `Learned rule: “${scopeHit.matchKey}” → ${scopeHit.scope}` : null,
    person,
    currency: {
      foreignAmount: doc.foreignAmount,
      foreignCurrency: doc.foreignCurrency,
      invoiceDate: doc.invoiceDate,
      inrValue: doc.inrValue,
      rateUsed: doc.rateUsed,
      rateDate: doc.rateDate,
      rateIsNearest: doc.rateIsNearest,
      currencyStatus: doc.currencyStatus,
    },
    accounting: doc.accounting,
    impact: doc.impact,
    contractNote: doc.isContractNote ? getContractNote(docId) : null,
    fields: reviews.map(toDetailField),
    audit: listReviewAudit(docId),
    markdownExcerpt: await readExcerpt(doc.markdownPath),
  };
}

// ── Opening the underlying files ─────────────────────────────────────────

/** Open the original file in the OS default application. Returns an error string on failure. */
export async function openDocumentFile(docId: number): Promise<string> {
  const doc = findDocumentById(docId);
  if (!doc) return "Document not found.";
  try {
    const result = await shell.openPath(doc.rawPath);
    return result; // "" on success; an OS error string otherwise
  } catch (error) {
    logger.error("document-detail", "Failed to open raw file", { docId, error: String(error) });
    return "Couldn't open the file.";
  }
}

/** Open the converted Markdown file in the OS default application. */
export async function openDocumentMarkdown(docId: number): Promise<string> {
  const doc = findDocumentById(docId);
  if (!doc) return "Document not found.";
  try {
    return await shell.openPath(doc.markdownPath);
  } catch (error) {
    logger.error("document-detail", "Failed to open markdown file", {
      docId,
      error: String(error),
    });
    return "Couldn't open the file.";
  }
}

/** Read the full Markdown content of a document. */
export async function readDocumentMarkdown(docId: number): Promise<string | null> {
  const doc = findDocumentById(docId);
  if (!doc || !doc.markdownPath) return null;
  try {
    return await fs.readFile(doc.markdownPath, "utf-8");
  } catch {
    return null;
  }
}

/** Check if a document was ingested from Gmail by looking up gmail_imports by hash. */
export function isGmailSourced(docId: number): boolean {
  const doc = findDocumentById(docId);
  if (!doc) return false;
  // Gmail body events are written as .eml / .html / .txt with "gmail-attachment" or
  // temp-derived names. The rawPath for Gmail docs won't be in a user-chosen folder.
  // We check by seeing if the original filename looks Gmail-derived.
  const name = doc.originalFilename.toLowerCase();
  return name.startsWith("gmail-") || name.includes("gmail-attachment") || name.endsWith(".eml");
}
