/**
 * Shared types + display helpers for the Document Browser / evidence card.
 * These mirror the backend shapes in main/services/document-detail.ts and the
 * review/person types in main/services/database.ts.
 */
import type { BadgeColor } from "@glaze/core/components";

export type PersonRole =
  | "self"
  | "spouse"
  | "client"
  | "supplier"
  | "tax_officer"
  | "owner"
  | "tenant"
  | "landlord"
  | "insurer"
  | "employee"
  | "consultant"
  | "bank_rm"
  | "accountant"
  | "other";

export type FieldSource = "ai_inferred" | "learned_rule" | "user_confirmed" | "manual";
export type ReviewField = "person" | "doc_type" | "vendor" | "doc_date" | "amount" | "fx";
export type ReviewStatus = "low_confidence" | "conflict" | "missing" | "confirmed" | "corrected";
export type OverallReviewStatus = "conflict" | "missing" | "low_confidence" | "ok";
export type ReviewAction = "flagged" | "confirmed" | "corrected" | "deferred";

export interface CurrencyFields {
  foreignAmount: number | null;
  foreignCurrency: string | null;
  invoiceDate: string | null;
  inrValue: number | null;
  rateUsed: number | null;
  rateDate: string | null;
  rateIsNearest: boolean;
  currencyStatus: "none" | "converted" | "needs_review";
}

export interface DocumentBrowserRow {
  docId: number;
  filename: string;
  fileType: string;
  rawPath: string;
  markdownPath: string;
  dateIngested: string;
  personName: string | null;
  personIsSelf: boolean;
  personRoles: PersonRole[];
  docType: string | null;
  vendor: string | null;
  docDate: string | null;
  category: string | null;
  reviewStatus: OverallReviewStatus;
  pendingCount: number;
  hasManualOverride: boolean;
  hasFx: boolean;
  foreignAmount: number | null;
  foreignCurrency: string | null;
  inrValue: number | null;
  currencyStatus: CurrencyFields["currencyStatus"];
}

export interface DetailField {
  field: ReviewField;
  label: string;
  value: string | null;
  extractedValue: string | null;
  suggestedValue: string | null;
  confidence: number;
  source: FieldSource;
  status: ReviewStatus;
  reason: string;
  userTouched: boolean;
}

export interface PersonContext {
  personId: number | null;
  name: string | null;
  isSelf: boolean;
  roles: PersonRole[];
  aliases: string[];
  confidence: number | null;
  source: FieldSource | null;
  status: "candidate" | "confirmed" | null;
  evidence: { kind: string; detail: string }[];
}

export interface ReviewAuditEntry {
  id: number;
  docId: number;
  field: ReviewField;
  action: ReviewAction;
  oldValue: string | null;
  newValue: string | null;
  confidence: number | null;
  source: FieldSource | null;
  at: string;
}

export interface DocumentDetail {
  docId: number;
  filename: string;
  fileType: string;
  rawPath: string;
  markdownPath: string;
  dateIngested: string;
  docDate: string | null;
  docType: string | null;
  vendor: string | null;
  category: string | null;
  scope: "business" | "personal" | null;
  scopeEvidence: string | null;
  person: PersonContext;
  currency: CurrencyFields;
  fields: DetailField[];
  audit: ReviewAuditEntry[];
  markdownExcerpt: string | null;
}

export interface ResolveResult {
  ok: boolean;
  ruleLearned?: boolean;
  ruleReinforced?: boolean;
  ruleAutoApplies?: boolean;
  message?: string;
}

// ── Display helpers ──────────────────────────────────────────────────────

export const ROLE_LABEL: Record<PersonRole, string> = {
  self: "Self",
  spouse: "Spouse",
  client: "Client",
  supplier: "Supplier",
  tax_officer: "Tax officer",
  owner: "Owner",
  tenant: "Tenant",
  landlord: "Landlord",
  insurer: "Insurer",
  employee: "Employee",
  consultant: "Consultant",
  bank_rm: "Bank RM",
  accountant: "Accountant",
  other: "Other",
};

export const SOURCE_LABEL: Record<FieldSource, string> = {
  ai_inferred: "AI inferred",
  learned_rule: "Learned rule",
  user_confirmed: "Confirmed by you",
  manual: "Set manually",
};

export const FIELD_LABEL: Record<ReviewField, string> = {
  person: "Canonical person",
  doc_type: "Document type",
  vendor: "Vendor / institution",
  doc_date: "Document date",
  amount: "Amount",
  fx: "Currency conversion",
};

export const STATUS_META: Record<ReviewStatus, { label: string; color: BadgeColor }> = {
  low_confidence: { label: "Low confidence", color: "yellow" },
  conflict: { label: "Conflict", color: "red" },
  missing: { label: "Missing", color: "orange" },
  confirmed: { label: "Confirmed", color: "green" },
  corrected: { label: "Corrected", color: "blue" },
};

export const OVERALL_META: Record<OverallReviewStatus, { label: string; color: BadgeColor }> = {
  conflict: { label: "Conflict", color: "red" },
  missing: { label: "Missing", color: "orange" },
  low_confidence: { label: "Needs review", color: "yellow" },
  ok: { label: "Understood", color: "green" },
};

const PENDING = new Set<ReviewStatus>(["low_confidence", "conflict", "missing"]);
export function isPending(status: ReviewStatus): boolean {
  return PENDING.has(status);
}

/** A small color band for a 0..1 confidence value. */
export function confidenceColor(confidence: number): BadgeColor {
  if (confidence >= 0.8) return "green";
  if (confidence >= 0.5) return "yellow";
  return "red";
}

export function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatForeign(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  // Accept YYYY, YYYY-MM, YYYY-MM-DD and ISO timestamps.
  const iso = value.length <= 10 ? value : value.slice(0, 10);
  const d = new Date(iso.length === 4 ? `${iso}-01-01` : iso);
  if (Number.isNaN(d.getTime())) return value;
  if (iso.length === 4) return iso;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
