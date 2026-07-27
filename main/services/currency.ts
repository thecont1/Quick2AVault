/**
 * Foreign-currency conversion.
 *
 * Given a primary amount, its currency, and the invoice date (extracted upstream
 * by the unified document extraction pass), and when the currency is foreign
 * (USD / EUR / GBP / JPY) and the inputs are confident, we fetch India's official
 * FBIL benchmark rate for that date (via the free Frankfurter API) and compute
 * the rupee value. FBIL doesn't publish rates on weekends / Mumbai bank holidays,
 * so the API falls back to the most recent prior business day — we record that.
 *
 * Anything uncertain (low confidence, missing amount/date, or an unavailable
 * rate) is flagged `needs_review` instead of guessing a wrong number. Never
 * throws — network problems degrade to `none`/`needs_review`.
 */
import { logger } from "@glaze/core/backend";

import { getCachedRate, saveCachedRate, type CurrencyFields, type RateCacheEntry } from "./database.js";

/** Currencies we convert to INR ("dollar, euro, pound, or yen"). */
export const FOREIGN = new Set(["USD", "EUR", "GBP", "JPY"]);
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const CURRENCY_NONE: CurrencyFields = {
  foreignAmount: null,
  foreignCurrency: null,
  invoiceDate: null,
  inrValue: null,
  rateUsed: null,
  rateDate: null,
  rateIsNearest: false,
  currencyStatus: "none",
};

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
 * Convert an already-extracted primary amount to INR at the invoice date's FBIL
 * rate. `confident` reflects whether the upstream extraction was sure about the
 * currency/amount/date. Non-foreign currencies return `none`; uncertain inputs
 * or an unavailable rate return `needs_review` (with the detected fields kept).
 * Never throws.
 */
export async function convertToInr(input: {
  currency: string | null;
  amount: number | null;
  invoiceDate: string | null;
  confident: boolean;
  filename?: string;
}): Promise<CurrencyFields> {
  const currency = input.currency ?? "NONE";
  // Only foreign currencies are converted; INR/NONE need no conversion.
  if (!FOREIGN.has(currency)) return CURRENCY_NONE;

  // A zero amount is a legitimate value (e.g. a $0 invoice / statement), so we
  // accept >= 0 here; only a negative or non-numeric amount is treated as absent.
  const amount =
    input.amount != null && Number.isFinite(input.amount) && input.amount >= 0 ? input.amount : null;
  const invoiceDate =
    input.invoiceDate && ISO_DATE.test(input.invoiceDate.trim()) ? input.invoiceDate.trim() : null;

  // Uncertain detection → flag for review instead of converting a wrong number.
  if (!input.confident || amount == null || invoiceDate == null) {
    logger.info("currency", "Flagged for review", {
      filename: input.filename,
      currency,
      hasAmount: amount != null,
      hasDate: invoiceDate != null,
    });
    return { ...CURRENCY_NONE, foreignAmount: amount, foreignCurrency: currency, invoiceDate, currencyStatus: "needs_review" };
  }

  // A confident zero-value foreign invoice converts to ₹0 at any rate — there's
  // nothing uncertain to resolve, so treat it as a plain (non-foreign) document
  // rather than flagging it for review.
  if (amount === 0) {
    logger.info("currency", "Zero-value invoice — no conversion needed", { filename: input.filename, currency });
    return CURRENCY_NONE;
  }

  const rate = await fetchRate(currency, invoiceDate);
  if (!rate) {
    // A rate couldn't be obtained — surface it for review rather than guessing.
    return { ...CURRENCY_NONE, foreignAmount: amount, foreignCurrency: currency, invoiceDate, currencyStatus: "needs_review" };
  }

  const inrValue = Math.round(amount * rate.rate * 100) / 100;
  logger.info("currency", "Converted foreign invoice", { filename: input.filename, currency, amount, inrValue, rateDate: rate.rateDate });
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
