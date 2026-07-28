/**
 * Accounting Policy Hints — a lightweight, advisory classification layer.
 *
 * This keeps document *facts* (dates, amounts, vendor) separate from an
 * *accounting interpretation*. From the extracted facts it suggests a treatment
 * hint (current-period expense, prepaid, accrued, deferred / recognized revenue,
 * reimbursement, or needs-review) with a confidence and a plain-language reason.
 *
 * It is explicitly NOT a bookkeeping engine and never implies GAAP compliance or
 * final correctness — the UI always frames it as a "Suggested treatment". When
 * the invoice date and a stated service period fall in different financial
 * years, or the document looks like an advance / prepaid / deferred item, it
 * routes the decision to review rather than forcing a current-period entry.
 */
import { listLearnedRules, type AccountingHint, type AccountingTreatment } from "./database.js";
import type { DocumentExtraction } from "./extraction.js";
import { financialYearKey } from "./preferences.js";

export const TREATMENT_LABEL: Record<AccountingTreatment, string> = {
  current_period_expense: "Current-period expense",
  prepaid_expense: "Prepaid expense",
  accrued_expense: "Accrued expense",
  deferred_revenue: "Deferred revenue",
  recognized_revenue: "Recognized revenue",
  reimbursement: "Reimbursement",
  needs_accounting_review: "Needs accounting review",
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v: string | null): v is string => v != null && ISO.test(v);

/** A learned vendor→treatment rule that applies to this vendor, if any. */
function accountingRuleFor(vendor: string | null): AccountingTreatment | null {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  for (const r of listLearnedRules()) {
    if (r.ruleType !== "accounting_treatment" || r.matchKey.length < 2) continue;
    if (!v.includes(r.matchKey.toLowerCase())) continue;
    const value = r.value.trim() as AccountingTreatment;
    if (value in TREATMENT_LABEL) return value;
  }
  return null;
}

/**
 * Derive the advisory accounting hint for a document from its extracted facts.
 * Returns null when the document isn't a clear financial transaction (no flow or
 * no amount) — there's nothing to interpret.
 */
export function deriveAccountingHint(
  extraction: DocumentExtraction,
  fyStartMonth: number,
): AccountingHint | null {
  const flow = extraction.flow;
  if (flow === "unknown" || !extraction.amount.present) return null;

  const invoiceDate = isIso(extraction.docDate.value) ? extraction.docDate.value : null;
  const spStart = extraction.servicePeriodStart;
  const spEnd = extraction.servicePeriodEnd;
  const paymentDate = extraction.paymentDate;

  const invoiceFy = financialYearKey(invoiceDate, fyStartMonth);
  const spStartFy = financialYearKey(spStart, fyStartMonth);
  const spEndFy = financialYearKey(spEnd, fyStartMonth);

  // Invoice date and the service period straddle different financial years.
  const crossPeriod =
    (!!spStartFy && !!invoiceFy && spStartFy !== invoiceFy) ||
    (!!spEndFy && !!invoiceFy && spEndFy !== invoiceFy) ||
    (!!spStartFy && !!spEndFy && spStartFy !== spEndFy);

  const ruleHit = accountingRuleFor(extraction.vendor.value);

  let treatment: AccountingTreatment;
  let confidence: number;
  let reason: string;

  if (ruleHit) {
    treatment = ruleHit;
    confidence = 0.9;
    reason = `You taught a rule that documents from “${extraction.vendor.value}” are treated as ${TREATMENT_LABEL[ruleHit].toLowerCase()}.`;
  } else if (crossPeriod) {
    // Different FYs → which period governs is a real decision for the user.
    treatment = "needs_accounting_review";
    confidence = 0.4;
    reason =
      "The document date and the stated service period fall in different financial years — please choose which period should govern for this app.";
  } else if (flow === "income") {
    if (isIso(invoiceDate) && isIso(spStart) && spStart > invoiceDate) {
      treatment = "deferred_revenue";
      confidence = 0.55;
      reason =
        "This looks billed before the service period begins — suggested as deferred revenue until it's earned.";
    } else {
      treatment = "recognized_revenue";
      confidence = extraction.flowConfident ? 0.75 : 0.5;
      reason = "Income that appears earned within the document-date period.";
    }
  } else {
    // Expense flow.
    if (extraction.advanceOrPrepaid) {
      treatment = "prepaid_expense";
      confidence = 0.5;
      reason =
        "This looks like an advance / deposit or a prepaid or annual-up-front payment — suggested as a prepaid expense to spread across the period rather than a single-period cost.";
    } else if (isIso(paymentDate) && isIso(invoiceDate) && paymentDate < invoiceDate) {
      treatment = "prepaid_expense";
      confidence = 0.45;
      reason =
        "Payment appears to have been made before the document date — it may be a prepaid / advance expense.";
    } else {
      treatment = "current_period_expense";
      confidence = extraction.flowConfident ? 0.75 : 0.5;
      reason = spStart
        ? "Expense whose service period sits within a single financial year."
        : "Expense recognized in the document-date period (no separate service period was stated, so the document date governs).";
    }
  }

  return {
    flow,
    treatment,
    confidence,
    reason,
    servicePeriodStart: spStart,
    servicePeriodEnd: spEnd,
    paymentDate,
    source: ruleHit ? "learned_rule" : "ai_inferred",
  };
}
