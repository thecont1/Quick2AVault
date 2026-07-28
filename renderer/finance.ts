/**
 * Shared finance / locale preferences for the renderer.
 *
 * Mirrors main/services/preferences.ts. Provides a `useFinancePrefs()` hook
 * (fetched once per window, cached by React Query) plus prefs-aware formatters
 * so currency, numbers, dates, and financial-year labels stay consistent and
 * actually reflect the user's chosen preferences. All formatters accept optional
 * prefs and fall back to India defaults so existing call sites keep working.
 */
import { useQuery } from "@tanstack/react-query";

export type DateFormat = "DD-MM-YYYY" | "DD MMM YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
export type NumberGrouping = "indian" | "western";

export interface FinancePrefs {
  currency: string;
  locale: string;
  dateFormat: DateFormat;
  decimalSeparator: string;
  thousandsSeparator: string;
  grouping: NumberGrouping;
  fyStartMonth: number;
}

export const INDIA_DEFAULTS: FinancePrefs = {
  currency: "INR",
  locale: "en-IN",
  dateFormat: "DD-MM-YYYY",
  decimalSeparator: ".",
  thousandsSeparator: ",",
  grouping: "indian",
  fyStartMonth: 4,
};

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The current window's finance preferences (India defaults until loaded). */
export function useFinancePrefs(): FinancePrefs {
  const q = useQuery({
    queryKey: ["financePrefs"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<FinancePrefs>("prefs:get"),
    staleTime: 60_000,
  });
  return q.data ?? INDIA_DEFAULTS;
}

// ── Money / numbers ────────────────────────────────────────────────────────

export function formatMoney(
  amount: number,
  prefs: FinancePrefs = INDIA_DEFAULTS,
  currency = prefs.currency,
): string {
  try {
    return new Intl.NumberFormat(prefs.locale, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

/** Format a foreign amount in its own currency (independent of the vault currency). */
export function formatForeign(
  amount: number,
  currency: string,
  prefs: FinancePrefs = INDIA_DEFAULTS,
): string {
  try {
    return new Intl.NumberFormat(prefs.locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ── Dates ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Format an ISO-ish date string per the user's date-format preference. */
export function formatDatePref(
  value: string | null | undefined,
  prefs: FinancePrefs = INDIA_DEFAULTS,
): string {
  if (!value) return "—";
  const iso = value.length <= 10 ? value : value.slice(0, 10);
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m) return value;
  const y = m[1];
  const mo = Number(m[2]);
  const d = m[3] ? Number(m[3]) : null;
  if (mo < 1 || mo > 12) return value;
  if (d == null) return `${MONTH_SHORT[mo - 1]} ${y}`;
  switch (prefs.dateFormat) {
    case "YYYY-MM-DD":
      return `${y}-${pad(mo)}-${pad(d)}`;
    case "MM/DD/YYYY":
      return `${pad(mo)}/${pad(d)}/${y}`;
    case "DD MMM YYYY":
      return `${pad(d)} ${MONTH_SHORT[mo - 1]} ${y}`;
    case "DD-MM-YYYY":
    default:
      return `${pad(d)}-${pad(mo)}-${y}`;
  }
}

// ── Financial impact ─────────────────────────────────────────────────────

export type ImpactBucket =
  | "income"
  | "household_expense"
  | "shared_family_expense"
  | "business_expense"
  | "software_utility_expense"
  | "personal_expense"
  | "shopping_discretionary"
  | "investment_purchase"
  | "investment_sale"
  | "liability_dues"
  | "tax_statutory"
  | "transfer_neutral"
  | "needs_review";

export const IMPACT_BUCKETS: ImpactBucket[] = [
  "income",
  "household_expense",
  "shared_family_expense",
  "business_expense",
  "software_utility_expense",
  "personal_expense",
  "shopping_discretionary",
  "investment_purchase",
  "investment_sale",
  "liability_dues",
  "tax_statutory",
  "transfer_neutral",
  "needs_review",
];

export const IMPACT_LABEL: Record<ImpactBucket, string> = {
  income: "Income",
  household_expense: "Household expense",
  shared_family_expense: "Shared family expense",
  business_expense: "Business expense",
  software_utility_expense: "Software / utility expense",
  personal_expense: "Personal expense",
  shopping_discretionary: "Shopping / discretionary",
  investment_purchase: "Investment purchase",
  investment_sale: "Investment sale",
  liability_dues: "Liability / dues",
  tax_statutory: "Tax / statutory payment",
  transfer_neutral: "Transfer / neutral movement",
  needs_review: "Needs review",
};

export type ImpactDirection = "in" | "out" | "neutral";
export type RecurringFrequency = "monthly" | "quarterly" | "annually" | "weekly" | "custom";
export type EntryScope = "business" | "personal" | "shared";

export interface FinancialImpact {
  bucket: ImpactBucket;
  confidence: number;
  direction: ImpactDirection;
  amountInr: number | null;
  reason: string;
  source: string;
}

/** A manual recurring entry (mirrors main/services/database.ts RecurringEntry). */
export interface RecurringEntry {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: RecurringFrequency;
  startDate: string | null;
  endDate: string | null;
  person: string | null;
  impactBucket: ImpactBucket;
  scope: EntryScope;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
  weekly: "Weekly",
  custom: "Custom",
};

export const SCOPE_LABEL: Record<EntryScope, string> = {
  business: "Business",
  personal: "Personal",
  shared: "Shared",
};

/**
 * A calm, plain-language "what this means" sentence for a document's financial
 * impact. Confidence-aware: soft ("Looks like…" / "Possibly…") when the app is
 * unsure, direct when it's confident.
 */
export function impactSummary(
  impact: FinancialImpact,
  prefs: FinancePrefs = INDIA_DEFAULTS,
): string {
  const label = IMPACT_LABEL[impact.bucket].toLowerCase();
  const amount = impact.amountInr != null ? formatMoney(impact.amountInr, prefs) : null;
  const unsure = impact.confidence < 0.6;

  if (impact.bucket === "needs_review") {
    return "Recognized — but the financial impact needs a quick review.";
  }
  if (impact.direction === "in") {
    if (impact.bucket === "investment_sale") {
      return amount
        ? `${unsure ? "Possibly a" : "An"} investment sale of ${amount}.`
        : "Looks like an investment sale.";
    }
    return amount
      ? `${unsure ? "Looks like income of" : "Income of"} ${amount}.`
      : `${unsure ? "Looks like income." : "Recognized as income."}`;
  }
  if (impact.bucket === "investment_purchase") {
    return amount
      ? `${unsure ? "Possibly added" : "Added"} ${amount} to investments.`
      : `${unsure ? "Looks like an" : "An"} investment purchase.`;
  }
  if (amount) {
    return `${unsure ? "Possibly adds" : "Added"} ${amount} to ${label}.`;
  }
  return `${unsure ? "Looks like" : "Recognized as"} ${label}.`;
}

// ── Financial year ───────────────────────────────────────────────────────

export function fyLabel(key: string | null | undefined): string {
  return key ? `FY ${key}` : "FY —";
}

/** Client-side mirror of the FY computation, for any local classification. */
export function financialYearKey(
  dateIso: string | null | undefined,
  fyStartMonth = INDIA_DEFAULTS.fyStartMonth,
): string | null {
  if (!dateIso) return null;
  const m = /^(\d{4})-(\d{2})/.exec(dateIso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const start = fyStartMonth >= 1 && fyStartMonth <= 12 ? fyStartMonth : 4;
  const startYear = month >= start ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}
