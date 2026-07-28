/**
 * Manual recurring entries — the parts of a financial life that don't always
 * arrive as documents (salary, rent, SIPs, school fees, subscriptions, EMIs,
 * utilities).
 *
 * These participate in the financial picture alongside document-derived events,
 * but are always clearly marked as manual / recurring — the goal is completeness
 * of the money overview, not pretending a document exists. This module validates
 * loosely-typed IPC input and normalizes each entry to a monthly-equivalent
 * amount for the Snapshot's "recurring monthly outflow" figure.
 */
import {
  ENTRY_SCOPES,
  IMPACT_BUCKETS,
  RECURRING_FREQUENCIES,
  type EntryScope,
  type ImpactBucket,
  type NewRecurringEntry,
  type RecurringEntry,
  type RecurringFrequency,
} from "./database.js";
import { directionFor } from "./impact.js";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoOrNull(v: unknown): string | null {
  return typeof v === "string" && ISO_DATE.test(v.trim()) ? v.trim().slice(0, 10) : null;
}

/** Validate loosely-typed IPC input into a persistable recurring entry, or null. */
export function coerceRecurringInput(value: unknown): NewRecurringEntry | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;

  const name = typeof v.name === "string" ? v.name.trim() : "";
  const amount = Number(v.amount);
  if (!name || !Number.isFinite(amount) || amount < 0) return null;

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
    name,
    amount: Math.round(amount * 100) / 100,
    currency,
    frequency,
    startDate: toIsoOrNull(v.startDate),
    endDate: toIsoOrNull(v.endDate),
    person: typeof v.person === "string" && v.person.trim() ? v.person.trim() : null,
    impactBucket,
    scope,
    notes: typeof v.notes === "string" && v.notes.trim() ? v.notes.trim() : null,
  };
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
export function entryDirection(entry: RecurringEntry) {
  return directionFor(entry.impactBucket);
}
