/**
 * Manual recurring entries — the parts of a financial life that don't always
 * arrive as documents (salary, rent, SIPs, school fees, subscriptions, EMIs,
 * utilities).
 *
 * These are tracked separately from document-derived hero totals until a future
 * reconciliation layer can link scheduled entries to actual documents. This
 * module validates loosely-typed IPC input and calculates display-only monthly
 * equivalents for the recurring-entry workspace.
 */
import type {
  RecurringEntryScope as EntryScope,
  RecurringImpactBucket as ImpactBucket,
  RecurringInput as NewRecurringEntry,
  RecurringFrequency,
  StoredRecurringEntry as RecurringEntry,
} from "./recurring-types.js";

const RECURRING_FREQUENCIES: RecurringFrequency[] = [
  "monthly",
  "quarterly",
  "annually",
  "weekly",
  "custom",
];
const IMPACT_BUCKETS: ImpactBucket[] = [
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
const ENTRY_SCOPES: EntryScope[] = ["business", "personal", "shared"];

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export type RecurringInputResult =
  | { ok: true; value: NewRecurringEntry }
  | { ok: false; error: string };

/** Validate loosely-typed IPC input before it reaches persistence. */
export function validateRecurringInput(value: unknown): RecurringInputResult {
  if (!value || typeof value !== "object") {
    return { ok: false, error: "Recurring entry details are missing." };
  }
  const v = value as Record<string, unknown>;

  const name = typeof v.name === "string" ? v.name.trim() : "";
  const amount = Number(v.amount);
  if (!name) return { ok: false, error: "Name is required." };
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: "Amount must be a non-negative number." };
  }

  const parseOptionalDate = (
    input: unknown,
    label: "Start" | "End",
  ): { value: string | null; error?: string } => {
    if (input == null || input === "") return { value: null };
    const date = typeof input === "string" ? input.trim() : String(input);
    return isValidIsoDate(date)
      ? { value: date }
      : {
          value: null,
          error: `${label} date must be a real calendar date in YYYY-MM-DD format (${date} is invalid).`,
        };
  };
  const start = parseOptionalDate(v.startDate, "Start");
  if (start.error) return { ok: false, error: start.error };
  const end = parseOptionalDate(v.endDate, "End");
  if (end.error) return { ok: false, error: end.error };
  if (start.value && end.value && end.value < start.value) {
    return { ok: false, error: "End date must be on or after the start date." };
  }

  const currency =
    typeof v.currency === "string" && v.currency.trim() ? v.currency.trim().toUpperCase() : "INR";
  const frequency: RecurringFrequency = (RECURRING_FREQUENCIES as string[]).includes(
    String(v.frequency),
  )
    ? (v.frequency as RecurringFrequency)
    : "monthly";
  const impactBucket: ImpactBucket = (IMPACT_BUCKETS as string[]).includes(String(v.impactBucket))
    ? (v.impactBucket as ImpactBucket)
    : "household_expense";
  const scope: EntryScope = (ENTRY_SCOPES as string[]).includes(String(v.scope))
    ? (v.scope as EntryScope)
    : "personal";

  return {
    ok: true,
    value: {
      name,
      amount: Math.round(amount * 100) / 100,
      currency,
      frequency,
      startDate: start.value,
      endDate: end.value,
      person: typeof v.person === "string" && v.person.trim() ? v.person.trim() : null,
      impactBucket,
      category:
        typeof v.category === "string" && v.category.trim() ? v.category.trim().slice(0, 60) : null,
      scope,
      notes: typeof v.notes === "string" && v.notes.trim() ? v.notes.trim() : null,
    },
  };
}

/** Backwards-compatible nullable adapter for callers that do not need the reason. */
export function coerceRecurringInput(value: unknown): NewRecurringEntry | null {
  const result = validateRecurringInput(value);
  return result.ok ? result.value : null;
}

/** The amount this entry contributes per month, normalized by its frequency. */
export function monthlyEquivalent(entry: RecurringEntry): number {
  switch (entry.frequency) {
    case "weekly":
      return (entry.amount * 52) / 12;
    case "monthly":
      return entry.amount;
    case "quarterly":
      return entry.amount / 3;
    case "annually":
      return entry.amount / 12;
    case "custom":
      // No fixed cadence — treat the stated amount as a monthly estimate.
      return entry.amount;
  }
}

/** Whether an entry is live as of today (started, not yet ended). */
export function isActiveNow(entry: RecurringEntry, now: Date = new Date()): boolean {
  const today = now.toISOString().slice(0, 10);
  if (entry.startDate && entry.startDate > today) return false;
  if (entry.endDate && entry.endDate < today) return false;
  return true;
}

/** In/out/neutral direction implied by an entry's bucket. */
export function entryDirection(entry: RecurringEntry): "in" | "out" | "neutral" {
  if (entry.impactBucket === "income" || entry.impactBucket === "investment_sale") return "in";
  if (entry.impactBucket === "transfer_neutral" || entry.impactBucket === "needs_review") {
    return "neutral";
  }
  return "out";
}
