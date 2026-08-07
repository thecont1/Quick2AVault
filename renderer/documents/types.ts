/**
 * Shared types + display helpers for the Document Browser / evidence card.
 * These mirror the backend shapes in main/services/document-detail.ts and the
 * review/person types in main/services/database.ts.
 */
import type { BadgeColor } from "@glaze/core/components";
import {
  formatDatePref,
  formatForeign as formatForeignPref,
  formatMoney,
  IMPACT_BUCKETS,
  IMPACT_LABEL,
  INDIA_DEFAULTS,
  type FinancePrefs,
  type FinancialImpact,
  type ImpactBucket,
} from "../finance";

export type { FinancialImpact, ImpactBucket };
export { IMPACT_BUCKETS, IMPACT_LABEL };

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
export type ReviewField =
  | "person"
  | "doc_type"
  | "vendor"
  | "doc_date"
  | "fin_year"
  | "amount"
  | "fx"
  | "accounting"
  | "impact";
export type ReviewStatus = "low_confidence" | "conflict" | "missing" | "confirmed" | "corrected";

export type AccountingFlow = "expense" | "income" | "unknown";
export type AccountingTreatment =
  | "current_period_expense"
  | "prepaid_expense"
  | "accrued_expense"
  | "deferred_revenue"
  | "recognized_revenue"
  | "reimbursement"
  | "needs_accounting_review";

export interface AccountingHint {
  flow: AccountingFlow;
  treatment: AccountingTreatment;
  confidence: number;
  reason: string;
  servicePeriodStart: string | null;
  servicePeriodEnd: string | null;
  paymentDate: string | null;
  source: FieldSource;
}
export type OverallReviewStatus = "conflict" | "missing" | "low_confidence" | "ok";
export type ReviewAction = "flagged" | "confirmed" | "corrected" | "deferred";

export type LifecycleState = "active" | "irrelevant" | "excluded" | "reprocess_requested";

export interface DuplicateEvent {
  id: number;
  hash: string;
  filename: string;
  sourcePath: string | null;
  duplicateOfDocId: number | null;
  detectedAt: string;
  status: "new" | "acknowledged";
  reason: string;
}

export interface LifecycleResult {
  ok: boolean;
  message?: string;
}

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

export interface ContractNoteTrade {
  id: number;
  docId: number;
  securityName: string;
  symbol: string | null;
  isin: string | null;
  side: "buy" | "sell";
  quantity: number | null;
  price: number | null;
  netAmount: number | null;
}

export interface ContractNoteRecord {
  docId: number;
  broker: string | null;
  client: string | null;
  tradeDate: string | null;
  settlementDate: string | null;
  contractNoteNumber: string | null;
  netAmount: number | null;
  totalCharges: number | null;
  side: "buy" | "sell" | "mixed";
  trades: ContractNoteTrade[];
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
  financialYear: string | null;
  category: string | null;
  reviewStatus: OverallReviewStatus;
  pendingCount: number;
  hasManualOverride: boolean;
  hasFx: boolean;
  foreignAmount: number | null;
  foreignCurrency: string | null;
  inrValue: number | null;
  currencyStatus: CurrencyFields["currencyStatus"];
  impact: FinancialImpact | null;
  impactBucket: string | null;
  impactDirection: "in" | "out" | "neutral" | null;
  isContractNote: boolean;
  lifecycleState: LifecycleState;
  triageReason: string | null;
  source: "gmail" | "file";
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
  financialYear: string | null;
  docType: string | null;
  vendor: string | null;
  category: string | null;
  lifecycleState: LifecycleState;
  triageReason: string | null;
  scope: "business" | "personal" | null;
  scopeEvidence: string | null;
  person: PersonContext;
  currency: CurrencyFields;
  accounting: AccountingHint | null;
  impact: FinancialImpact | null;
  contractNote: ContractNoteRecord | null;
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
  person: "Person",
  doc_type: "Document type",
  vendor: "Vendor",
  doc_date: "Document date",
  fin_year: "Financial year",
  amount: "Amount",
  fx: "Currency conversion",
  accounting: "Accounting",
  impact: "Financial impact",
};

export const TREATMENT_LABEL: Record<AccountingTreatment, string> = {
  current_period_expense: "Current-period expense",
  prepaid_expense: "Prepaid expense",
  accrued_expense: "Accrued expense",
  deferred_revenue: "Deferred revenue",
  recognized_revenue: "Recognized revenue",
  reimbursement: "Reimbursement",
  needs_accounting_review: "Needs accounting review",
};

/** Treatments offered in the override picker (review-only isn't a target). */
export const TREATMENT_OPTIONS: AccountingTreatment[] = [
  "current_period_expense",
  "prepaid_expense",
  "accrued_expense",
  "deferred_revenue",
  "recognized_revenue",
  "reimbursement",
  "needs_accounting_review",
];

export const STATUS_META: Record<ReviewStatus, { label: string; color: BadgeColor }> = {
  low_confidence: { label: "Low confidence", color: "yellow" },
  conflict: { label: "Conflict", color: "red" },
  missing: { label: "Missing", color: "orange" },
  confirmed: { label: "Confirmed", color: "green" },
  corrected: { label: "Corrected", color: "blue" },
};

/** Calm, explicit labels for each intake lane / lifecycle state. */
export const LIFECYCLE_META: Record<LifecycleState, { label: string; color: BadgeColor }> = {
  active: { label: "Active", color: "green" },
  irrelevant: { label: "Irrelevant", color: "secondary" },
  excluded: { label: "Excluded", color: "orange" },
  reprocess_requested: { label: "Reprocess requested", color: "blue" },
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

/** Format the vault currency (INR by default), honoring the user's prefs. */
export function formatInr(amount: number, prefs: FinancePrefs = INDIA_DEFAULTS): string {
  return formatMoney(amount, prefs);
}

export function formatForeign(
  amount: number,
  currency: string,
  prefs: FinancePrefs = INDIA_DEFAULTS,
): string {
  return formatForeignPref(amount, currency, prefs);
}

export function formatDate(value: string | null, prefs: FinancePrefs = INDIA_DEFAULTS): string {
  return formatDatePref(value, prefs);
}

export { fyLabel } from "../finance";
