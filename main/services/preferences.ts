/**
 * Finance / locale preferences.
 *
 * A small set of financial preferences the app is grounded in from first run.
 * For this build everything is prefilled with India defaults (INR, April–March
 * financial year, India-friendly date + number formatting); the values are
 * editable in Settings and actually drive display and interpretation across the
 * app (currency + number formatting, date rendering, and — most importantly —
 * the financial-year classification every dated document receives).
 *
 * Persisted as a single JSON blob in `app_settings`. When the key is absent the
 * app is on first run (defaults apply until the user confirms them).
 */
import { getSetting, setSetting } from "./database.js";

const PREFS_KEY = "finance_prefs";

export type DateFormat = "DD-MM-YYYY" | "DD MMM YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
export type NumberGrouping = "indian" | "western";

export interface FinancePrefs {
  /** ISO 4217 currency code the vault reports value in. */
  currency: string;
  /** BCP-47 locale used for number/date formatting. */
  locale: string;
  /** How dates are displayed and parsed. */
  dateFormat: DateFormat;
  /** Decimal mark for numbers. */
  decimalSeparator: string;
  /** Thousands/grouping mark for numbers. */
  thousandsSeparator: string;
  /** Indian (lakh/crore) vs Western (thousand) digit grouping. */
  grouping: NumberGrouping;
  /** Month (1–12) the financial year starts on. India = 4 (April). */
  fyStartMonth: number;
}

/** India defaults used on a fresh install and as the fallback everywhere. */
export const INDIA_DEFAULTS: FinancePrefs = {
  currency: "INR",
  locale: "en-IN",
  dateFormat: "DD-MM-YYYY",
  decimalSeparator: ".",
  thousandsSeparator: ",",
  grouping: "indian",
  fyStartMonth: 4,
};

function clampMonth(month: unknown): number {
  const m = Number(month);
  return Number.isInteger(m) && m >= 1 && m <= 12 ? m : INDIA_DEFAULTS.fyStartMonth;
}

/** True until the user has confirmed their finance preferences at least once. */
export function isFirstRun(): boolean {
  return getSetting(PREFS_KEY) == null;
}

export function getFinancePrefs(): FinancePrefs {
  const raw = getSetting(PREFS_KEY);
  if (!raw) return { ...INDIA_DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Partial<FinancePrefs>;
    return { ...INDIA_DEFAULTS, ...parsed, fyStartMonth: clampMonth(parsed.fyStartMonth) };
  } catch {
    return { ...INDIA_DEFAULTS };
  }
}

/** Merge a patch over the current prefs and persist. Also marks first-run done. */
export function setFinancePrefs(patch: Partial<FinancePrefs>): FinancePrefs {
  const next: FinancePrefs = { ...getFinancePrefs(), ...patch };
  next.fyStartMonth = clampMonth(next.fyStartMonth);
  setSetting(PREFS_KEY, JSON.stringify(next));
  return next;
}

// ── Financial year ─────────────────────────────────────────────────────────

const ISO_DATE_HEAD = /^(\d{4})-(\d{2})(?:-(\d{2}))?/;

/**
 * The financial-year key (e.g. "2025-26") a date belongs to, under a given FY
 * start month. Returns null when the date can't be parsed to at least a
 * year+month — the caller routes that uncertainty into review rather than
 * guessing a period.
 *
 * India (start month 4): 2026-03-31 → "2025-26"; 2026-04-01 → "2026-27".
 */
export function financialYearKey(
  dateIso: string | null | undefined,
  fyStartMonth: number = INDIA_DEFAULTS.fyStartMonth,
): string | null {
  if (!dateIso) return null;
  const m = ISO_DATE_HEAD.exec(dateIso.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  const start = clampMonth(fyStartMonth);
  const startYear = month >= start ? year : year - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

/** Display label for a FY key ("2025-26" → "FY 2025-26"). */
export function fyLabel(key: string | null | undefined): string {
  return key ? `FY ${key}` : "FY —";
}
