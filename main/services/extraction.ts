/**
 * Unified document extraction (one AI pass at ingestion).
 *
 * Reads a document's Markdown and extracts the fields the app reasons about —
 * document type, vendor/institution, document date, primary amount, and the
 * currency — each with a confidence flag. The foreign-currency conversion is
 * computed from the same extraction (no extra AI call), and the raw fields feed
 * the Review Queue so anything uncertain or missing surfaces for the user.
 *
 * Never throws: an AI/consent failure degrades to an empty extraction so the
 * document is still stored safely.
 */
import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import { convertToInr } from "./currency.js";
import {
  IMPACT_BUCKETS,
  type AccountingFlow,
  type CurrencyFields,
  type ImpactBucket,
} from "./database.js";
import { watchCategoryExtractionLabels } from "./watch-categories.js";

const MAX_AI_CHARS = 8000;

/**
 * A coarse spending category used to steer the financial-impact mapping. It's
 * intentionally small — the buckets these map to are user-configurable.
 */
export type SpendCategory =
  | "grocery"
  | "software_saas"
  | "marketplace"
  | "insurance"
  | "utilities"
  | "rent"
  | "salary"
  | "tax"
  | "credit_card"
  | "investment"
  | "none";

const SPEND_CATEGORIES: [SpendCategory, ...SpendCategory[]] = [
  "grocery",
  "software_saas",
  "marketplace",
  "insurance",
  "utilities",
  "rent",
  "salary",
  "tax",
  "credit_card",
  "investment",
  "none",
];

/** One extracted field: its value (null when absent) and whether the AI was sure. */
export interface ExtractedField {
  value: string | null;
  confident: boolean;
  /** Present in the document at all (used to tell "missing" from "unsure"). */
  present: boolean;
}

export interface DocumentExtraction {
  docType: ExtractedField;
  vendor: ExtractedField;
  docDate: ExtractedField;
  amount: ExtractedField;
  /** Detected currency code (USD/EUR/GBP/JPY/INR/NONE). */
  currency: string;
  // ── Accounting-relevant facts (feed the advisory accounting hint) ──
  /** Money out (expense) vs money in (income), or unknown. */
  flow: AccountingFlow;
  flowConfident: boolean;
  /** The period the goods/services cover, if stated (YYYY-MM-DD each). */
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  /** Date payment was actually made, if stated separately (YYYY-MM-DD). */
  paymentDate: string | null;
  /** Looks like an advance / deposit / prepaid or annual-up-front payment. */
  advanceOrPrepaid: boolean;
  // ── Financial-impact facts (feed the plain-language impact layer) ──
  /** The AI's best guess of which impact bucket this document feeds, or null. */
  impactBucket: ImpactBucket | null;
  impactConfident: boolean;
  /** A coarse spending category used to apply user impact-mapping preferences. */
  spendCategory: SpendCategory;
  /** A configured watch-category label, including custom categories, or null. */
  watchCategory: string | null;
  /** The AI thinks this is a stock-broker contract note / securities trade confirmation. */
  isContractNote: boolean;
}

export interface ExtractionResult {
  /** Foreign-currency conversion computed from the extraction. */
  currency: CurrencyFields;
  /** The raw extracted fields (for the Review Queue). */
  extraction: DocumentExtraction;
  /** True when the AI extraction step itself was blocked/unavailable. */
  aiBlocked: boolean;
}

const EMPTY_FIELD: ExtractedField = { value: null, confident: false, present: false };

const EMPTY_EXTRACTION: DocumentExtraction = {
  docType: EMPTY_FIELD,
  vendor: EMPTY_FIELD,
  docDate: EMPTY_FIELD,
  amount: EMPTY_FIELD,
  currency: "NONE",
  flow: "unknown",
  flowConfident: false,
  servicePeriodStart: null,
  servicePeriodEnd: null,
  paymentDate: null,
  advanceOrPrepaid: false,
  impactBucket: null,
  impactConfident: false,
  spendCategory: "none",
  watchCategory: null,
  isContractNote: false,
};

function extractionSchema(watchCategories: string[]) {
  return z.object({
    documentType: z
      .string()
      .nullable()
      .describe(
        "The kind of document, e.g. 'bank statement', 'invoice', 'tax document', 'insurance policy', " +
          "'credit card statement', 'receipt', 'salary slip'. Null if genuinely unclear.",
      ),
    documentTypeConfident: z
      .boolean()
      .describe("true only if the document type is clearly identifiable"),
    vendor: z
      .string()
      .nullable()
      .describe(
        "The issuing institution, vendor, or company the document is from (e.g. 'HDFC Bank', 'Amazon', " +
          "'LIC'). Null if there is no clear issuer.",
      ),
    vendorConfident: z.boolean().describe("true only if the vendor/institution is clearly stated"),
    documentDate: z
      .string()
      .nullable()
      .describe(
        "The primary document/statement/invoice date as YYYY-MM-DD. Null if no clear date is present.",
      ),
    documentDateConfident: z
      .boolean()
      .describe("true only if a single clear document date was found"),
    amount: z
      .number()
      .nullable()
      .describe(
        "The single primary amount — invoice total, grand total, amount due, or statement balance — as a " +
          "plain number without symbols or separators. Null if there is no clear single primary amount.",
      ),
    amountConfident: z
      .boolean()
      .describe("true only if the primary amount is clear and unambiguous"),
    currency: z
      .enum(["USD", "EUR", "GBP", "JPY", "INR", "NONE"])
      .describe("Currency of the primary amount; NONE if there is no clear monetary amount."),
    flow: z
      .enum(["expense", "income", "unknown"])
      .describe(
        "Does this document represent money the user PAYS (expense: invoices, bills, receipts) or RECEIVES " +
          "(income: sales invoices you issued, salary, interest)? 'unknown' when it isn't a financial transaction.",
      ),
    flowConfident: z.boolean().describe("true only if the expense/income direction is clear"),
    servicePeriodStart: z
      .string()
      .nullable()
      .describe(
        "Start of the period the goods/services cover, as YYYY-MM-DD (e.g. a subscription, rental, or insurance " +
          "period). Null if no coverage period is stated.",
      ),
    servicePeriodEnd: z
      .string()
      .nullable()
      .describe("End of the covered service period as YYYY-MM-DD. Null if none is stated."),
    paymentDate: z
      .string()
      .nullable()
      .describe(
        "The date payment was actually made, as YYYY-MM-DD, if stated separately from the document date. Null otherwise.",
      ),
    advanceOrPrepaid: z
      .boolean()
      .describe(
        "true if this looks like an advance payment, deposit, retainer, or a prepaid / annual subscription paid " +
          "up front for a future period",
      ),
    impactBucket: z
      .enum(IMPACT_BUCKETS as [ImpactBucket, ...ImpactBucket[]])
      .nullable()
      .describe(
        "Which financial bucket this document most likely feeds. Use 'income' for money received (sales invoice, " +
          "salary, interest), 'household_expense' for groceries/home bills, 'business_expense' for work costs, " +
          "'software_utility_expense' for SaaS/AI/utility bills, 'investment_purchase'/'investment_sale' for " +
          "securities/mutual-fund trades, 'liability_dues' for credit-card statements/loans due, 'tax_statutory' " +
          "for tax/GST/statutory payments, 'transfer_neutral' for internal transfers, 'needs_review' if unclear. " +
          "Null if it isn't a financial transaction.",
      ),
    impactBucketConfident: z.boolean().describe("true only if the impact bucket is clear"),
    spendCategory: z
      .enum(SPEND_CATEGORIES)
      .describe(
        "A coarse category of what this is, used to apply the user's preferences: 'grocery', 'software_saas' " +
          "(SaaS / AI / software subscription), 'marketplace' (Amazon/Flipkart-style shopping), 'insurance', " +
          "'utilities', 'rent', 'salary', 'tax', 'credit_card', 'investment', or 'none' if it fits none of these.",
      ),
    watchCategory: z
      .string()
      .nullable()
      .describe(
        watchCategories.length > 0
          ? `If clearly applicable, return exactly one of these user watch-category labels: ${watchCategories.join(", ")}. Otherwise null.`
          : "Null; no user watch categories are configured.",
      ),
    isContractNote: z
      .boolean()
      .describe(
        "true if this is a stock-broker contract note / securities trade confirmation / 'contract note cum tax " +
          "invoice' listing traded shares with ISINs — NOT a generic invoice.",
      ),
  });
}

function trimField(value: string | null, confident: boolean): ExtractedField {
  const v = value?.trim() ? value.trim() : null;
  return { value: v, confident: v != null && confident, present: v != null };
}

/**
 * Extract the document's fields and compute its currency conversion in a single
 * AI pass. Never throws — a blocked AI returns an empty extraction.
 */
export async function extractDocument(text: string, filename: string): Promise<ExtractionResult> {
  const excerpt = text.slice(0, MAX_AI_CHARS).trim();
  if (!excerpt) {
    return {
      currency: await convertToInr({
        currency: null,
        amount: null,
        invoiceDate: null,
        confident: false,
      }),
      extraction: EMPTY_EXTRACTION,
      aiBlocked: false,
    };
  }

  const configuredWatchCategories = watchCategoryExtractionLabels();
  const schema = extractionSchema(configuredWatchCategories);
  let detected: z.infer<typeof schema>;
  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema,
      system:
        "You extract structured facts from a personal financial document. Read only what is present — never " +
        "guess or invent a type, vendor, date, amount, or currency that isn't clearly in the text. When a field " +
        "is ambiguous or absent, set its value to null (or its *Confident flag to false).",
      prompt: `Extract the fields from this document named "${filename}":\n\n${excerpt}`,
    });
    detected = object;
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("extraction", "AI extraction blocked", { filename, state: error.state });
    } else {
      logger.warn("extraction", "AI extraction failed", { filename, error: String(error) });
    }
    const currency = await convertToInr({
      currency: null,
      amount: null,
      invoiceDate: null,
      confident: false,
    });
    return { currency, extraction: EMPTY_EXTRACTION, aiBlocked: true };
  }

  const amountValue =
    detected.amount != null && Number.isFinite(detected.amount) ? detected.amount : null;

  const isoOrNull = (v: string | null): string | null => {
    const t = v?.trim();
    return t && /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
  };

  const extraction: DocumentExtraction = {
    docType: trimField(detected.documentType, detected.documentTypeConfident),
    vendor: trimField(detected.vendor, detected.vendorConfident),
    docDate: trimField(detected.documentDate, detected.documentDateConfident),
    amount: {
      value: amountValue != null ? String(amountValue) : null,
      confident: amountValue != null && detected.amountConfident,
      present: amountValue != null,
    },
    currency: detected.currency,
    flow: detected.flow,
    flowConfident: detected.flowConfident,
    servicePeriodStart: isoOrNull(detected.servicePeriodStart),
    servicePeriodEnd: isoOrNull(detected.servicePeriodEnd),
    paymentDate: isoOrNull(detected.paymentDate),
    advanceOrPrepaid: detected.advanceOrPrepaid,
    impactBucket: detected.impactBucket,
    impactConfident: detected.impactBucket != null && detected.impactBucketConfident,
    spendCategory: detected.spendCategory,
    watchCategory:
      detected.watchCategory && configuredWatchCategories.includes(detected.watchCategory.trim())
        ? detected.watchCategory.trim()
        : null,
    isContractNote: detected.isContractNote,
  };

  // Compute the FX conversion from the same extraction (no extra AI call).
  const currency = await convertToInr({
    currency: detected.currency,
    amount: amountValue,
    invoiceDate: detected.documentDate,
    confident: detected.amountConfident && detected.documentDateConfident,
    filename,
  });

  return { currency, extraction, aiBlocked: false };
}
