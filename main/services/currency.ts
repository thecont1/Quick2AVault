/**
 * Foreign-currency detection & conversion.
 *
 * For each ingested document we use Glaze AI to extract a single primary
 * amount, its currency, and the invoice date from the document content. If the
 * currency is foreign (USD / EUR / GBP / JPY) and the extraction is confident,
 * we fetch India's official FBIL benchmark rate for that date (via the free
 * Frankfurter API) and compute the rupee value at ingestion time. FBIL doesn't
 * publish rates on weekends / Mumbai bank holidays, so the API falls back to the
 * most recent prior business day — we record when that happened.
 *
 * Anything uncertain (low confidence, missing amount/date, or an unavailable
 * rate) is flagged `needs_review` instead of guessing a wrong number. Never
 * throws — AI/network problems degrade to `none`/`needs_review`.
 */
import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import { getCachedRate, saveCachedRate, type CurrencyFields, type RateCacheEntry } from "./database.js";

/** Currencies we convert to INR ("dollar, euro, pound, or yen"). */
const FOREIGN = new Set(["USD", "EUR", "GBP", "JPY"]);
const MAX_AI_CHARS = 8000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const NONE: CurrencyFields = {
  foreignAmount: null,
  foreignCurrency: null,
  invoiceDate: null,
  inrValue: null,
  rateUsed: null,
  rateDate: null,
  rateIsNearest: false,
  currencyStatus: "none",
};

const extractSchema = z.object({
  currency: z
    .enum(["USD", "EUR", "GBP", "JPY", "INR", "NONE"])
    .describe(
      "The currency of the document's primary/total amount. Use the ISO code for US dollars, euros, " +
        "British pounds, Japanese yen, or Indian rupees; use NONE if there is no clear monetary amount.",
    ),
  amount: z
    .number()
    .nullable()
    .describe(
      "The document's single primary amount — the invoice total, grand total, or amount due — as a plain " +
        "number without currency symbols or thousands separators. Null if there is no clear single total.",
    ),
  invoiceDate: z
    .string()
    .nullable()
    .describe("The invoice / document date as YYYY-MM-DD. Null if no clear document date is present."),
  confidence: z
    .enum(["high", "low"])
    .describe(
      "'high' only if you are confident about BOTH the currency AND the amount AND the date; otherwise 'low'.",
    ),
});

/**
 * Fetch the FBIL reference rate for `currency`→INR on `reqDate`, falling back to
 * the most recent prior business day. Results are cached by currency + reqDate.
 * Returns null when no rate could be obtained.
 */
async function fetchRate(currency: string, reqDate: string): Promise<RateCacheEntry | null> {
  const cached = getCachedRate(currency, reqDate);
  if (cached) return cached;

  const url = `https://api.frankfurter.dev/v2/rate/${currency}/INR?providers=FBIL&date=${reqDate}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn("currency", "Rate request failed", { currency, reqDate, status: res.status });
      return null;
    }
    const data = (await res.json()) as { date?: string; rate?: number };
    if (typeof data.rate !== "number" || !Number.isFinite(data.rate) || data.rate <= 0) {
      logger.warn("currency", "Rate response had no usable rate", { currency, reqDate });
      return null;
    }
    // The API echoes the actual business day the rate belongs to; if it differs
    // from what we asked for, a prior day's rate was substituted.
    const rateDate = typeof data.date === "string" && ISO_DATE.test(data.date) ? data.date : reqDate;
    const entry: RateCacheEntry = { rate: data.rate, rateDate, isNearest: rateDate !== reqDate };
    saveCachedRate(currency, reqDate, entry);
    return entry;
  } catch (error) {
    logger.warn("currency", "Rate fetch error", { currency, reqDate, error: String(error) });
    return null;
  }
}

/**
 * Analyze a document's text for a foreign-currency amount and, when confident,
 * convert it to INR at the invoice date's rate. Returns the currency fields to
 * store on the document record. Never throws.
 */
export async function analyzeCurrency(text: string, filename: string): Promise<CurrencyFields> {
  const excerpt = text.slice(0, MAX_AI_CHARS).trim();
  if (!excerpt) return NONE;

  let detected: z.infer<typeof extractSchema>;
  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema: extractSchema,
      system:
        "You extract the single primary monetary amount, its currency, and the document date from a " +
        "financial document (often an invoice). Read only what is present — never guess or infer a currency, " +
        "amount, or date that isn't clearly stated. If the amount or currency is ambiguous, set confidence to 'low'.",
      prompt: `Extract the primary amount, currency, and date from this document named "${filename}":\n\n${excerpt}`,
    });
    detected = object;
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("currency", "AI extraction blocked", { filename, state: error.state });
    } else {
      logger.warn("currency", "AI extraction failed", { filename, error: String(error) });
    }
    return NONE;
  }

  // Only foreign currencies are converted; INR/NONE need no conversion.
  const currency = detected.currency;
  if (!FOREIGN.has(currency)) return NONE;

  const amount =
    detected.amount != null && Number.isFinite(detected.amount) && detected.amount > 0 ? detected.amount : null;
  const invoiceDate =
    detected.invoiceDate && ISO_DATE.test(detected.invoiceDate.trim()) ? detected.invoiceDate.trim() : null;

  // Uncertain detection → flag for review instead of converting a wrong number.
  if (detected.confidence === "low" || amount == null || invoiceDate == null) {
    logger.info("currency", "Flagged for review", { filename, currency, hasAmount: amount != null, hasDate: invoiceDate != null });
    return { ...NONE, foreignAmount: amount, foreignCurrency: currency, invoiceDate, currencyStatus: "needs_review" };
  }

  const rate = await fetchRate(currency, invoiceDate);
  if (!rate) {
    // A rate couldn't be obtained — surface it for review rather than guessing.
    return { ...NONE, foreignAmount: amount, foreignCurrency: currency, invoiceDate, currencyStatus: "needs_review" };
  }

  const inrValue = Math.round(amount * rate.rate * 100) / 100;
  logger.info("currency", "Converted foreign invoice", { filename, currency, amount, inrValue, rateDate: rate.rateDate });
  return {
    foreignAmount: amount,
    foreignCurrency: currency,
    invoiceDate,
    inrValue,
    rateUsed: rate.rate,
    rateDate: rate.rateDate,
    rateIsNearest: rate.isNearest,
    currencyStatus: "converted",
  };
}
