/**
 * Intake relevance triage — a fast, deterministic (no-AI) first pass that decides
 * whether a dropped file is plausibly a financial document worth deep processing,
 * or clearly irrelevant (a family photo, a personal note) that should be kept
 * safely but kept out of the financial pipeline.
 *
 * The bar to be treated as *relevant* is intentionally low: any financial signal
 * keeps a file in the normal lane. A file is only marked irrelevant when it is
 * clearly non-financial, so real documents are never quietly dropped.
 */
import type { FileType } from "./converter.js";

export interface TriageResult {
  relevant: boolean;
  /** Calm, explicit one-line explanation of the lane decision. */
  reason: string;
}

// Currency symbols and ISO codes that strongly imply a financial document.
const CURRENCY = /[₹$€£¥]|\b(?:inr|usd|eur|gbp|jpy|rs\.?|rupees?)\b/i;

// Vocabulary that reliably shows up in invoices, receipts, statements, etc.
const FINANCIAL_KEYWORDS = [
  "invoice", "receipt", "statement", "tax", "gst", "vat", "tds", "payment", "paid",
  "amount", "total", "subtotal", "balance", "due", "account", "transaction", "salary",
  "payroll", "rent", "bill", "billed", "order", "purchase", "expense", "income", "debit",
  "credit", "refund", "deposit", "withdrawal", "bank", "ledger", "fee", "charge", "premium",
  "policy", "emi", "loan", "interest", "reimbursement", "vendor", "supplier", "customer",
  "quantity", "unit price", "grand total", "net amount", "tax invoice",
];
const KEYWORD_RE = new RegExp(`\\b(?:${FINANCIAL_KEYWORDS.map((k) => k.replace(/ /g, "\\s+")).join("|")})\\b`, "i");

/**
 * Classify a dropped file's relevance from its type + extracted text.
 * `text` is the deterministic extraction (empty for images / unreadable files).
 */
export function classifyRelevance(type: FileType, filename: string, text: string): TriageResult {
  // Images carry no extractable financial text (we don't OCR) — treat as personal.
  if (type === "image") {
    return {
      relevant: false,
      reason: "Marked irrelevant: appears to be a non-financial image or photo.",
    };
  }

  const haystack = `${filename}\n${text}`;
  const hasCurrency = CURRENCY.test(haystack);
  const hasKeyword = KEYWORD_RE.test(haystack);

  // No text at all from a structured format (e.g. a scanned/image-only PDF): we
  // can't judge it, so keep it in the normal lane rather than risk dropping a
  // real receipt. The pipeline will route it to review if nothing extracts.
  if (!text.trim()) {
    if (hasCurrency || hasKeyword) return { relevant: true, reason: "" };
    return { relevant: true, reason: "" };
  }

  if (hasCurrency || hasKeyword) return { relevant: true, reason: "" };

  return {
    relevant: false,
    reason: "Marked irrelevant: no financial content detected (looks like a personal note).",
  };
}
