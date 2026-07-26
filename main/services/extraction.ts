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
import type { CurrencyFields } from "./database.js";

const MAX_AI_CHARS = 8000;

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
};

const schema = z.object({
  documentType: z
    .string()
    .nullable()
    .describe(
      "The kind of document, e.g. 'bank statement', 'invoice', 'tax document', 'insurance policy', " +
        "'credit card statement', 'receipt', 'salary slip'. Null if genuinely unclear.",
    ),
  documentTypeConfident: z.boolean().describe("true only if the document type is clearly identifiable"),
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
    .describe("The primary document/statement/invoice date as YYYY-MM-DD. Null if no clear date is present."),
  documentDateConfident: z.boolean().describe("true only if a single clear document date was found"),
  amount: z
    .number()
    .nullable()
    .describe(
      "The single primary amount — invoice total, grand total, amount due, or statement balance — as a " +
        "plain number without symbols or separators. Null if there is no clear single primary amount.",
    ),
  amountConfident: z.boolean().describe("true only if the primary amount is clear and unambiguous"),
  currency: z
    .enum(["USD", "EUR", "GBP", "JPY", "INR", "NONE"])
    .describe("Currency of the primary amount; NONE if there is no clear monetary amount."),
});

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
    return { currency: (await convertToInr({ currency: null, amount: null, invoiceDate: null, confident: false })), extraction: EMPTY_EXTRACTION, aiBlocked: false };
  }

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
    const currency = await convertToInr({ currency: null, amount: null, invoiceDate: null, confident: false });
    return { currency, extraction: EMPTY_EXTRACTION, aiBlocked: true };
  }

  const amountValue =
    detected.amount != null && Number.isFinite(detected.amount) ? detected.amount : null;

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
