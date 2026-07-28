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
  listDocuments,
  listFieldReviews,
  listLearnedRules,
  listReviewAudit,
  countDocsNeedingReview,
  reviewQueueDocIds,
  setDocumentOverride,
  setFieldReviewResolution,
  updateDocumentCurrency,
  updateDocumentClassification,
  upsertConfirmedRule,
  upsertFieldReview,
  ACCOUNTING_TREATMENTS,
  IMPACT_BUCKETS,
  PENDING_REVIEW_STATUSES,
  REVIEW_FIELDS,
  type AccountingHint,
  type AccountingTreatment,
  type CurrencyFields,
  type DocumentFieldReview,
  type DocumentRecord,
  type FieldSource,
  type FinancialImpact,
  type ImpactBucket,
  type ReviewAuditEntry,
  type ReviewField,
  type ReviewStatus,
} from "./database.js";
import { convertToInr, CURRENCY_NONE } from "./currency.js";
import type { DocumentExtraction } from "./extraction.js";
import { TREATMENT_LABEL } from "./accounting.js";
import { directionFor, IMPACT_LABEL } from "./impact.js";
import { confirmNameForPerson, ensurePerson } from "./people.js";
import { financialYearKey, fyLabel, getFinancePrefs } from "./preferences.js";
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
function docTypeConflict(
  docType: string,
  haystack: string,
): { matchKey: string; value: string } | null {
  for (const r of listLearnedRules()) {
    if (r.ruleType !== "keyword_doctype") continue;
    if (r.matchKey.length < 2) continue;
    if (
      haystack.includes(r.matchKey) &&
      r.value.trim().toLowerCase() !== docType.trim().toLowerCase()
    ) {
      return { matchKey: r.matchKey, value: r.value };
    }
  }
  return null;
}

function describeFx(currency: CurrencyFields): string {
  if (
    currency.currencyStatus === "converted" &&
    currency.inrValue != null &&
    currency.foreignAmount != null
  ) {
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
  financialYear: string | null;
  fyStartMonth: number;
  accounting: AccountingHint | null;
  impact: FinancialImpact | null;
  haystack: string;
}): void {
  const { docId, extraction, currency, financialYear, accounting, impact, haystack } = input;
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
      put(
        "doc_type",
        dt.value,
        true,
        false,
        "low_confidence",
        `Not fully sure this is a “${dt.value}”.`,
        dt.value,
      );
    } else {
      put("doc_type", dt.value, true, true, "confirmed", "", dt.value);
    }
  }

  // Vendor / institution.
  const vn = extraction.vendor;
  if (!vn.present) {
    put(
      "vendor",
      null,
      false,
      false,
      "missing",
      "No issuing vendor or institution was found.",
      null,
    );
  } else if (!vn.confident) {
    put(
      "vendor",
      vn.value,
      true,
      false,
      "low_confidence",
      `The vendor “${vn.value}” may be misread.`,
      vn.value,
    );
  } else {
    put("vendor", vn.value, true, true, "confirmed", "", vn.value);
  }

  // Document date.
  const dd = extraction.docDate;
  if (!dd.present) {
    put("doc_date", null, false, false, "missing", "No clear document date was found.", null);
  } else if (!dd.confident) {
    put(
      "doc_date",
      dd.value,
      true,
      false,
      "low_confidence",
      "The document date is ambiguous.",
      dd.value,
    );
  } else {
    put("doc_date", dd.value, true, true, "confirmed", "", dd.value);
  }

  // Financial year — a first-class classification derived from the document
  // date. A missing/ambiguous date makes the FY uncertain, so it goes to review
  // rather than being guessed silently.
  const fyText = fyLabel(financialYear);
  if (!financialYear) {
    if (!dd.present) {
      put(
        "fin_year",
        null,
        false,
        false,
        "missing",
        "Can't assign a financial year — no clear document date was found.",
        null,
      );
    } else {
      put(
        "fin_year",
        null,
        true,
        false,
        "low_confidence",
        "The document date is unclear, so its financial year can't be determined confidently.",
        null,
        UNSURE,
      );
    }
  } else if (!dd.confident) {
    put(
      "fin_year",
      fyText,
      true,
      false,
      "low_confidence",
      `Assigned to ${fyText} from an unconfident document date — please confirm the period.`,
      fyText,
      UNSURE,
    );
  } else {
    put(
      "fin_year",
      fyText,
      true,
      true,
      "confirmed",
      `Classified into ${fyText} from the document date.`,
      fyText,
    );
  }

  // Primary amount — only track when relevant (present, or a currency implies one).
  const am = extraction.amount;
  if (am.present) {
    if (!am.confident) {
      put(
        "amount",
        am.value,
        true,
        false,
        "low_confidence",
        "The primary amount may be ambiguous.",
        am.value,
      );
    } else {
      put("amount", am.value, true, true, "confirmed", "", am.value);
    }
  } else if (extraction.currency !== "NONE") {
    put(
      "amount",
      null,
      false,
      false,
      "missing",
      "A currency was detected but no clear primary amount.",
      null,
    );
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

  // Accounting treatment hint — advisory only. Route advances / prepaid /
  // deferred items and cross-financial-year cases to review; recognize plain
  // current-period items with confidence.
  if (accounting) {
    const routeToReview =
      accounting.treatment === "prepaid_expense" ||
      accounting.treatment === "accrued_expense" ||
      accounting.treatment === "deferred_revenue";
    if (accounting.treatment === "needs_accounting_review") {
      put(
        "accounting",
        accounting.treatment,
        true,
        false,
        "conflict",
        accounting.reason,
        accounting.treatment,
        accounting.confidence,
      );
    } else if (routeToReview || accounting.confidence < 0.6) {
      put(
        "accounting",
        accounting.treatment,
        true,
        false,
        "low_confidence",
        accounting.reason,
        accounting.treatment,
        accounting.confidence,
      );
    } else {
      put(
        "accounting",
        accounting.treatment,
        true,
        true,
        "confirmed",
        accounting.reason,
        accounting.treatment,
        accounting.confidence,
      );
    }
  }

  // Financial impact — the plain-language "what changed" bucket. Surface it for
  // review when the app is unsure or explicitly needs a decision.
  if (impact) {
    if (impact.bucket === "needs_review") {
      put(
        "impact",
        impact.bucket,
        true,
        false,
        "conflict",
        impact.reason,
        impact.bucket,
        impact.confidence,
      );
    } else if (impact.confidence < 0.6) {
      put(
        "impact",
        impact.bucket,
        true,
        false,
        "low_confidence",
        impact.reason,
        impact.bucket,
        impact.confidence,
      );
    } else {
      put(
        "impact",
        impact.bucket,
        true,
        true,
        "confirmed",
        impact.reason,
        impact.bucket,
        impact.confidence,
      );
    }
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

/**
 * Re-evaluate stale review rows against the current logic. Today this clears the
 * false positive where a legitimate zero-value invoice was flagged for foreign-
 * currency review (an earlier build treated a 0 amount as "couldn't convert").
 * A confident ₹0 conversion isn't anomalous, so the fx flag is cleared and the
 * stored currency status is normalized. Idempotent; safe to run at startup.
 * Returns how many documents were reconciled.
 */
export function reconcileReviews(): number {
  let reconciled = 0;
  for (const docId of reviewQueueDocIds()) {
    const fx = getFieldReview(docId, "fx");
    if (!fx || !(PENDING_REVIEW_STATUSES as ReviewStatus[]).includes(fx.status)) continue;

    // Is this a zero-value document? Trust the extracted amount review first
    // (older zero invoices stored a null foreign amount, so the record alone
    // can't tell us), then the stored foreign amount as a fallback.
    const amountReview = getFieldReview(docId, "amount");
    const amountText = amountReview?.finalValue ?? amountReview?.extractedValue;
    const amountNum = amountText != null && amountText.trim() !== "" ? Number(amountText) : NaN;
    const doc = findDocumentById(docId);
    const isZeroValue = (Number.isFinite(amountNum) && amountNum === 0) || doc?.foreignAmount === 0;
    if (!isZeroValue) continue;

    // Clear the stale FX flag: a zero-value invoice converts to ₹0 and needs no
    // review. Keep it in the record as a resolved/valid field.
    setFieldReviewResolution(docId, "fx", {
      status: "confirmed",
      finalValue: fx.extractedValue ?? null,
      source: "ai_inferred",
    });
    addReviewAudit({
      docId,
      field: "fx",
      action: "confirmed",
      oldValue: fx.extractedValue,
      newValue: fx.extractedValue,
      confidence: CONFIDENT,
      source: "ai_inferred",
    });
    if (doc && doc.currencyStatus === "needs_review") {
      updateDocumentCurrency(docId, CURRENCY_NONE);
    }
    reconciled += 1;
  }
  if (reconciled > 0) logger.info("reviews", "Reconciled stale reviews", { reconciled });
  return reconciled;
}

/**
 * Backfill the financial-year classification for documents ingested before FY
 * awareness existed (or before their date was known). Uses the stored document
 * date, else the document-date review value. Idempotent; safe to run at startup.
 */
export function backfillFinancialYears(): number {
  const startMonth = getFinancePrefs().fyStartMonth;
  let updated = 0;
  for (const doc of listDocuments(5000)) {
    if (doc.financialYear) continue;
    const dd = getFieldReview(doc.id, "doc_date");
    const dateVal = doc.documentDate ?? dd?.finalValue ?? dd?.extractedValue ?? null;
    const key = financialYearKey(dateVal, startMonth);
    if (!key) continue;
    updateDocumentClassification(doc.id, {
      documentDate: doc.documentDate ?? dateVal,
      financialYear: key,
    });
    if (!getFieldReview(doc.id, "fin_year")) {
      upsertFieldReview({
        docId: doc.id,
        field: "fin_year",
        extractedValue: fyLabel(key),
        confidence: CONFIDENT,
        source: "ai_inferred",
        reason: `Classified into ${fyLabel(key)} from the document date.`,
        suggestedValue: fyLabel(key),
        status: "confirmed",
      });
    }
    updated += 1;
  }
  if (updated > 0) logger.info("reviews", "Backfilled financial years", { updated });
  return updated;
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
    return {
      ok: true,
      ruleLearned: isNew,
      ruleReinforced: !isNew,
      ruleAutoApplies: rule.autoApply,
    };
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
    return {
      ok: true,
      ruleLearned: isNew,
      ruleReinforced: !isNew,
      ruleAutoApplies: rule.autoApply,
    };
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
    return {
      ok: true,
      message: "Noted, but the currency or date is unknown, so it can’t be re-converted.",
    };
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
    message:
      c.currencyStatus === "converted"
        ? "Re-converted to INR."
        : "Couldn’t fetch a rate for that date.",
  };
}

/**
 * When the document date is confirmed/corrected, reclassify the financial year
 * to match — and keep the (unresolved) FY review row consistent so 31-Mar vs
 * 01-Apr always land in the right period.
 */
function applyDocDateResolution(docId: number, finalValue: string): ResolveResult {
  const iso = /^\d{4}-\d{2}-\d{2}/.test(finalValue) ? finalValue.slice(0, 10) : null;
  const key = financialYearKey(iso, getFinancePrefs().fyStartMonth);
  updateDocumentClassification(docId, { documentDate: iso, financialYear: key });

  const fyReview = getFieldReview(docId, "fin_year");
  const userSetFy = fyReview?.source === "user_confirmed" || fyReview?.source === "manual";
  if (!userSetFy) {
    upsertFieldReview({
      docId,
      field: "fin_year",
      extractedValue: key ? fyLabel(key) : null,
      confidence: key ? CONFIDENT : 0,
      source: "ai_inferred",
      reason: key
        ? `Reclassified into ${fyLabel(key)} from the corrected document date.`
        : "No financial year — the corrected date is unclear.",
      suggestedValue: key ? fyLabel(key) : null,
      status: key ? "confirmed" : "missing",
    });
  }
  return { ok: true, message: key ? `Reclassified into ${fyLabel(key)}.` : undefined };
}

/** Persist a confirmed/corrected financial year onto the document record. */
function applyFinYearResolution(docId: number, finalValue: string): ResolveResult {
  const key = /(\d{4}-\d{2})/.exec(finalValue)?.[1] ?? null;
  updateDocumentClassification(docId, { financialYear: key });
  return { ok: true, message: key ? `Set to ${fyLabel(key)}.` : "Financial year cleared." };
}

/**
 * Persist a confirmed/corrected accounting treatment onto the record and — on a
 * correction with a known vendor — teach a reusable vendor→treatment rule.
 */
function applyAccountingResolution(
  docId: number,
  doc: DocumentRecord | null,
  finalValue: string,
  action: "confirm" | "correct",
  filename: string,
): ResolveResult {
  const treatment = (ACCOUNTING_TREATMENTS as string[]).includes(finalValue)
    ? (finalValue as AccountingTreatment)
    : null;
  if (!treatment) return { ok: true };

  const source: FieldSource = action === "confirm" ? "user_confirmed" : "manual";
  const current = doc?.accounting ?? null;
  const updated: AccountingHint = current
    ? {
        ...current,
        treatment,
        source,
        reason:
          action === "correct" ? `You set this to ${TREATMENT_LABEL[treatment]}.` : current.reason,
      }
    : {
        flow: "unknown",
        treatment,
        confidence: 1,
        reason: `You set this to ${TREATMENT_LABEL[treatment]}.`,
        servicePeriodStart: null,
        servicePeriodEnd: null,
        paymentDate: null,
        source,
      };
  updateDocumentClassification(docId, { accounting: updated });

  if (action === "correct") {
    const vendorReview = getFieldReview(docId, "vendor");
    const vendor = (vendorReview?.finalValue ?? vendorReview?.extractedValue)?.trim();
    if (vendor) {
      const { rule, isNew } = upsertConfirmedRule({
        ruleType: "accounting_treatment",
        matchKey: vendor,
        value: treatment,
        evidence: [{ filename, docId, phrase: vendor }],
      });
      return {
        ok: true,
        ruleLearned: isNew,
        ruleReinforced: !isNew,
        ruleAutoApplies: rule.autoApply,
      };
    }
  }
  return { ok: true };
}

/**
 * Persist a confirmed/corrected financial-impact bucket onto the record and — on
 * a correction with a known vendor — teach a reusable vendor→bucket rule so
 * future documents from that vendor land in the right bucket.
 */
function applyImpactResolution(
  docId: number,
  doc: DocumentRecord | null,
  finalValue: string,
  action: "confirm" | "correct",
  filename: string,
): ResolveResult {
  const bucket = (IMPACT_BUCKETS as string[]).includes(finalValue)
    ? (finalValue as ImpactBucket)
    : null;
  if (!bucket) return { ok: true };

  const source: FieldSource = action === "confirm" ? "user_confirmed" : "manual";
  const current = doc?.impact ?? null;
  const updated: FinancialImpact = {
    bucket,
    confidence: 1,
    direction: directionFor(bucket),
    amountInr: current?.amountInr ?? null,
    reason:
      action === "correct"
        ? `You set this to ${IMPACT_LABEL[bucket].toLowerCase()}.`
        : (current?.reason ?? `Confirmed as ${IMPACT_LABEL[bucket].toLowerCase()}.`),
    source,
  };
  updateDocumentClassification(docId, { impact: updated });

  if (action === "correct") {
    const vendorReview = getFieldReview(docId, "vendor");
    const vendor = (vendorReview?.finalValue ?? vendorReview?.extractedValue)?.trim();
    if (vendor) {
      const { rule, isNew } = upsertConfirmedRule({
        ruleType: "impact_bucket",
        matchKey: vendor,
        value: bucket,
        evidence: [{ filename, docId, phrase: vendor }],
      });
      return {
        ok: true,
        ruleLearned: isNew,
        ruleReinforced: !isNew,
        ruleAutoApplies: rule.autoApply,
      };
    }
  }
  return { ok: true };
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

  const finalValue =
    action === "confirm"
      ? (review.suggestedValue ?? review.extractedValue ?? "")
      : (value?.trim() ?? "");
  const status: ReviewStatus = action === "confirm" ? "confirmed" : "corrected";
  const source: FieldSource = action === "confirm" ? "user_confirmed" : "manual";

  let result: ResolveResult = { ok: true };
  if (field === "person")
    result = applyPersonResolution(docId, review, finalValue, action, filename);
  else if (field === "doc_type")
    result = applyDocTypeResolution(docId, finalValue, action, filename);
  else if (field === "fx") result = await applyFxResolution(docId, doc, finalValue, action);
  else if (field === "doc_date") result = applyDocDateResolution(docId, finalValue);
  else if (field === "fin_year") result = applyFinYearResolution(docId, finalValue);
  else if (field === "accounting")
    result = applyAccountingResolution(docId, doc, finalValue, action, filename);
  else if (field === "impact")
    result = applyImpactResolution(docId, doc, finalValue, action, filename);

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
