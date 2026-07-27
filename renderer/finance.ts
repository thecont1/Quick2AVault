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

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

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

export function formatMoney(amount: number, prefs: FinancePrefs = INDIA_DEFAULTS, currency = prefs.currency): string {
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
export function formatForeign(amount: number, currency: string, prefs: FinancePrefs = INDIA_DEFAULTS): string {
  try {
    return new Intl.NumberFormat(prefs.locale, { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

// ── Dates ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Format an ISO-ish date string per the user's date-format preference. */
export function formatDatePref(value: string | null | undefined, prefs: FinancePrefs = INDIA_DEFAULTS): string {
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

// ── Financial year ───────────────────────────────────────────────────────

export function fyLabel(key: string | null | undefined): string {
  return key ? `FY ${key}` : "FY —";
}

/** Client-side mirror of the FY computation, for any local classification. */
export function financialYearKey(dateIso: string | null | undefined, fyStartMonth = INDIA_DEFAULTS.fyStartMonth): string | null {
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
