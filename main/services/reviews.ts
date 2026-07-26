/**
 * Review Queue: a lightweight triage inbox for document intelligence the app
 * isn't confident about.
 *
 * Every ingested document gets one review row per tracked field (document type,
 * vendor, date, amount, foreign-currency conversion, and — after the snapshot
 * runs — person). Anything low-confidence, conflicting, or missing stays
 * "pending" and surfaces in the queue; confident fields are recorded as
 * "confirmed" so the detail view always shows the full picture.
 *
 * Resolving a field keeps a full audit trail, never overwrites a value the user
 * has already confirmed/corrected, and feeds corrections back into learned rules
 * (which auto-apply once repeatedly confirmed). Never throws.
 */
import { logger } from "@glaze/core/backend";

import {
  addReviewAudit,
  findDocumentById,
  getFieldReview,
  listFieldReviews,
  listLearnedRules,
  listReviewAudit,
  countDocsNeedingReview,
  reviewQueueDocIds,
  setDocumentOverride,
  setFieldReviewResolution,
  updateDocumentCurrency,
  upsertConfirmedRule,
  upsertFieldReview,
  PENDING_REVIEW_STATUSES,
  REVIEW_FIELDS,
  type CurrencyFields,
  type DocumentFieldReview,
  type DocumentRecord,
  type FieldSource,
  type ReviewAuditEntry,
  type ReviewField,
  type ReviewStatus,
} from "./database.js";
import { convertToInr } from "./currency.js";
import type { DocumentExtraction } from "./extraction.js";
import { confirmNameForPerson, ensurePerson } from "./people.js";
import { writeRulesMarkdown } from "./training.js";

// ── Public shapes (for IPC / UI) ─────────────────────────────────────────

export interface ReviewQueueItem {
  docId: number;
  filename: string;
  fileType: string;
  dateIngested: string;
  pendingFields: { field: ReviewField; status: ReviewStatus }[];
}

export interface DocumentReviewDetail {
  docId: number;
  filename: string;
  fileType: string;
  dateIngested: string;
  fields: DocumentFieldReview[];
  audit: ReviewAuditEntry[];
}

export interface ResolveResult {
  ok: boolean;
  ruleLearned?: boolean;
  ruleReinforced?: boolean;
  ruleAutoApplies?: boolean;
  message?: string;
}

// ── Confidence helpers ───────────────────────────────────────────────────

const CONFIDENT = 0.9;
const UNSURE = 0.45;
const CONFLICTING = 0.5;

function fieldConfidence(present: boolean, confident: boolean): number {
  if (!present) return 0;
  return confident ? CONFIDENT : UNSURE;
}

/** A keyword→doc-type rule that contradicts the extracted type, if any. */
function docTypeConflict(docType: string, haystack: string): { matchKey: string; value: string } | null {
  for (const r of listLearnedRules()) {
    if (r.ruleType !== "keyword_doctype") continue;
    if (r.matchKey.length < 2) continue;
    if (haystack.includes(r.matchKey) && r.value.trim().toLowerCase() !== docType.trim().toLowerCase()) {
      return { matchKey: r.matchKey, value: r.value };
    }
  }
  return null;
}

function describeFx(currency: CurrencyFields): string {
  if (currency.currencyStatus === "converted" && currency.inrValue != null && currency.foreignAmount != null) {
    return `${currency.foreignAmount} ${currency.foreignCurrency} → ₹${currency.inrValue}`;
  }
  const parts: string[] = [];
  parts.push(currency.foreignCurrency ?? "currency unclear");
  parts.push(currency.foreignAmount != null ? String(currency.foreignAmount) : "amount unclear");
  parts.push(currency.invoiceDate ?? "date unclear");
  return parts.join(" · ");
}

// ── Recording reviews at ingestion ───────────────────────────────────────

/**
 * Create the field reviews for a freshly-ingested document from its unified
 * extraction and computed currency. Runs once per document.
 */
export function recordExtractionReviews(input: {
  docId: number;
  filename: string;
  extraction: DocumentExtraction;
  currency: CurrencyFields;
  haystack: string;
}): void {
  const { docId, extraction, currency, haystack } = input;
  const put = (
    field: ReviewField,
    value: string | null,
    present: boolean,
    confident: boolean,
    status: ReviewStatus,
    reason: string,
    suggested: string | null,
    confidence?: number,
  ) => {
    upsertFieldReview({
      docId,
      field,
      extractedValue: value,
      confidence: confidence ?? fieldConfidence(present, confident),
      source: "ai_inferred",
      reason,
      suggestedValue: suggested,
      status,
    });
  };

  // Document type — may also conflict with a learned keyword rule.
  const dt = extraction.docType;
  if (!dt.present) {
    put("doc_type", null, false, false, "missing", "No document type could be identified.", null);
  } else {
    const conflict = docTypeConflict(dt.value ?? "", haystack.toLowerCase());
    if (conflict) {
      put(
        "doc_type",
        dt.value,
        true,
        dt.confident,
        "conflict",
        `Read as “${dt.value}”, but your rule for “${conflict.matchKey}” maps this to “${conflict.value}”.`,
        conflict.value,
        CONFLICTING,
      );
    } else if (!dt.confident) {
      put("doc_type", dt.value, true, false, "low_confidence", `Not fully sure this is a “${dt.value}”.`, dt.value);
    } else {
      put("doc_type", dt.value, true, true, "confirmed", "", dt.value);
    }
  }

  // Vendor / institution.
  const vn = extraction.vendor;
  if (!vn.present) {
    put("vendor", null, false, false, "missing", "No issuing vendor or institution was found.", null);
  } else if (!vn.confident) {
    put("vendor", vn.value, true, false, "low_confidence", `The vendor “${vn.value}” may be misread.`, vn.value);
  } else {
    put("vendor", vn.value, true, true, "confirmed", "", vn.value);
  }

  // Document date.
  const dd = extraction.docDate;
  if (!dd.present) {
    put("doc_date", null, false, false, "missing", "No clear document date was found.", null);
  } else if (!dd.confident) {
    put("doc_date", dd.value, true, false, "low_confidence", "The document date is ambiguous.", dd.value);
  } else {
    put("doc_date", dd.value, true, true, "confirmed", "", dd.value);
  }

  // Primary amount — only track when relevant (present, or a currency implies one).
  const am = extraction.amount;
  if (am.present) {
    if (!am.confident) {
      put("amount", am.value, true, false, "low_confidence", "The primary amount may be ambiguous.", am.value);
    } else {
      put("amount", am.value, true, true, "confirmed", "", am.value);
    }
  } else if (extraction.currency !== "NONE") {
    put("amount", null, false, false, "missing", "A currency was detected but no clear primary amount.", null);
  }

  // Foreign-currency conversion inputs.
  if (currency.currencyStatus === "needs_review") {
    put(
      "fx",
      describeFx(currency),
      true,
      false,
      "low_confidence",
      "A foreign amount was detected but couldn’t be converted confidently (uncertain currency, amount, date, or no rate available).",
      null,
      UNSURE,
    );
  } else if (currency.currencyStatus === "converted") {
    put("fx", describeFx(currency), true, true, "confirmed", "", describeFx(currency), CONFIDENT);
  }

  logger.info("reviews", "Recorded extraction reviews", { docId });
}

/**
 * Record (or refresh) the person review for a document, produced by snapshot
 * entity resolution. Never overwrites a person the user has already resolved.
 */
export function recordPersonReview(input: {
  docId: number;
  extracted: string | null;
  suggested: string | null;
  confidence: number;
  status: ReviewStatus;
  reason: string;
}): void {
  const existing = getFieldReview(input.docId, "person");
  if (
    existing &&
    (existing.status === "confirmed" || existing.status === "corrected") &&
    (existing.source === "user_confirmed" || existing.source === "manual")
  ) {
    return; // the user already decided this — don't override.
  }
  upsertFieldReview({
    docId: input.docId,
    field: "person",
    extractedValue: input.extracted,
    confidence: input.confidence,
    source: "ai_inferred",
    reason: input.reason,
    suggestedValue: input.suggested ?? input.extracted,
    status: input.status,
  });
}

// ── Reading the queue ────────────────────────────────────────────────────

const FIELD_ORDER = new Map(REVIEW_FIELDS.map((f, i) => [f, i]));

export function listReviewQueue(): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  for (const docId of reviewQueueDocIds()) {
    const doc = findDocumentById(docId);
    if (!doc) continue;
    const pendingFields = listFieldReviews(docId)
      .filter((r) => (PENDING_REVIEW_STATUSES as ReviewStatus[]).includes(r.status))
      .sort((a, b) => (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0))
      .map((r) => ({ field: r.field, status: r.status }));
    if (pendingFields.length === 0) continue;
    items.push({
      docId,
      filename: doc.originalFilename,
      fileType: doc.fileType,
      dateIngested: doc.dateIngested,
      pendingFields,
    });
  }
  return items;
}

export function getDocumentReviewDetail(docId: number): DocumentReviewDetail | null {
  const doc = findDocumentById(docId);
  if (!doc) return null;
  const fields = listFieldReviews(docId).sort(
    (a, b) => (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0),
  );
  return {
    docId,
    filename: doc.originalFilename,
    fileType: doc.fileType,
    dateIngested: doc.dateIngested,
    fields,
    audit: listReviewAudit(docId),
  };
}

export function reviewCount(): number {
  return countDocsNeedingReview();
}

// ── Resolving a field ────────────────────────────────────────────────────

function applyPersonResolution(
  docId: number,
  review: DocumentFieldReview,
  finalValue: string,
  action: "confirm" | "correct",
  filename: string,
): ResolveResult {
  const isUnidentified = !finalValue || finalValue.toLowerCase() === "unidentified";
  if (isUnidentified) {
    setDocumentOverride(docId, null);
    return { ok: true };
  }
  const personId = ensurePerson(finalValue);
  setDocumentOverride(docId, finalValue);

  // Correcting to a different name than was detected teaches a reusable mapping.
  const extracted = review.extractedValue?.trim();
  if (action === "correct" && extracted && extracted.toLowerCase() !== finalValue.toLowerCase()) {
    confirmNameForPerson(extracted, personId, "user_confirmed", { docId });
    const { rule, isNew } = upsertConfirmedRule({
      ruleType: "person_variant",
      matchKey: extracted,
      value: finalValue,
      evidence: [{ filename, docId, phrase: extracted }],
    });
    return { ok: true, ruleLearned: isNew, ruleReinforced: !isNew, ruleAutoApplies: rule.autoApply };
  }
  return { ok: true };
}

function applyDocTypeResolution(
  docId: number,
  finalValue: string,
  action: "confirm" | "correct",
  filename: string,
): ResolveResult {
  if (action !== "correct" || !finalValue) return { ok: true };
  // Learn a vendor→category rule when the vendor is known, so future docs benefit.
  const vendorReview = getFieldReview(docId, "vendor");
  const vendor = (vendorReview?.finalValue ?? vendorReview?.extractedValue)?.trim();
  if (vendor) {
    const { rule, isNew } = upsertConfirmedRule({
      ruleType: "vendor_category",
      matchKey: vendor,
      value: finalValue,
      evidence: [{ filename, docId, phrase: vendor }],
    });
    return { ok: true, ruleLearned: isNew, ruleReinforced: !isNew, ruleAutoApplies: rule.autoApply };
  }
  return { ok: true };
}

async function applyFxResolution(
  docId: number,
  doc: DocumentRecord | null,
  finalValue: string,
  action: "confirm" | "correct",
): Promise<ResolveResult> {
  if (action !== "correct" || !doc) return { ok: true };
  const amount = Number(finalValue.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: true, message: "Noted. Enter a numeric amount to re-convert to INR." };
  }
  if (!doc.foreignCurrency || !doc.invoiceDate) {
    return { ok: true, message: "Noted, but the currency or date is unknown, so it can’t be re-converted." };
  }
  const c = await convertToInr({
    currency: doc.foreignCurrency,
    amount,
    invoiceDate: doc.invoiceDate,
    confident: true,
    filename: doc.originalFilename,
  });
  updateDocumentCurrency(docId, c);
  return {
    ok: true,
    message: c.currencyStatus === "converted" ? "Re-converted to INR." : "Couldn’t fetch a rate for that date.",
  };
}

/**
 * Resolve one field. `confirm` accepts the app's suggestion, `correct` records a
 * user-supplied value, `defer` leaves it pending for later. Writes an audit
 * entry either way and applies the field's side effects.
 */
export async function resolveField(
  docId: number,
  field: ReviewField,
  action: "confirm" | "correct" | "defer",
  value?: string,
): Promise<ResolveResult> {
  const review = getFieldReview(docId, field);
  if (!review) return { ok: false, message: "Nothing to resolve." };
  const doc = findDocumentById(docId);
  const filename = doc?.originalFilename ?? `document ${docId}`;

  if (action === "defer") {
    addReviewAudit({
      docId,
      field,
      action: "deferred",
      oldValue: review.finalValue ?? review.extractedValue,
      newValue: null,
      confidence: review.confidence,
      source: review.source,
    });
    return { ok: true, message: "Deferred for later." };
  }

  const finalValue = action === "confirm" ? (review.suggestedValue ?? review.extractedValue ?? "") : (value?.trim() ?? "");
  const status: ReviewStatus = action === "confirm" ? "confirmed" : "corrected";
  const source: FieldSource = action === "confirm" ? "user_confirmed" : "manual";

  let result: ResolveResult = { ok: true };
  if (field === "person") result = applyPersonResolution(docId, review, finalValue, action, filename);
  else if (field === "doc_type") result = applyDocTypeResolution(docId, finalValue, action, filename);
  else if (field === "fx") result = await applyFxResolution(docId, doc, finalValue, action);

  setFieldReviewResolution(docId, field, { status, finalValue: finalValue || null, source });
  addReviewAudit({
    docId,
    field,
    action: status === "confirmed" ? "confirmed" : "corrected",
    oldValue: review.extractedValue,
    newValue: finalValue || null,
    confidence: review.confidence,
    source,
  });
  if (result.ruleLearned || result.ruleReinforced) await writeRulesMarkdown();
  logger.info("reviews", "Resolved field", { docId, field, action });
  return result;
}

/** Confirm every pending field that has a suggestion — the fast "looks right" path. */
export async function confirmAllSuggestions(docId: number): Promise<{ confirmed: number }> {
  const pending = listFieldReviews(docId).filter((r) =>
    (PENDING_REVIEW_STATUSES as ReviewStatus[]).includes(r.status),
  );
  let confirmed = 0;
  for (const r of pending) {
    if (r.suggestedValue == null || r.suggestedValue === "") continue;
    await resolveField(docId, r.field, "confirm");
    confirmed += 1;
  }
  return { confirmed };
}
