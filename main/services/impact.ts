/**
 * Financial impact — the plain-language "what changed in my money world?" layer.
 *
 * Once a document is recognized as a valid financial document, we don't just
 * store and classify it: we derive an immediate, human-readable impact and feed
 * the right summary bucket (income, household, business, investment, …). This is
 * a financial-organization signal, NOT accounting — it never implies certified
 * correctness, and low-confidence guesses are framed as suggestions ("Looks
 * like…") rather than certainties.
 *
 * Some documents can reasonably map to different buckets depending on the user's
 * household and working life, so a small set of user-editable treatment
 * preferences (software invoices, groceries, marketplace) steer the mapping, and
 * learned vendor→bucket rules (taught via Training / review corrections) win.
 */
import {
  getSetting,
  listLearnedRules,
  setSetting,
  type ContractNoteRecord,
  type CurrencyFields,
  type FieldSource,
  type FinancialImpact,
  type ImpactBucket,
  type ImpactDirection,
} from "./database.js";
import type { DocumentExtraction, SpendCategory } from "./extraction.js";

// ── Labels ─────────────────────────────────────────────────────────────────

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

/** The buckets a user preference can choose between for each ambiguous category. */
export const SOFTWARE_CHOICES: ImpactBucket[] = [
  "business_expense",
  "software_utility_expense",
  "personal_expense",
];
export const GROCERY_CHOICES: ImpactBucket[] = [
  "household_expense",
  "shared_family_expense",
  "personal_expense",
];
export const MARKETPLACE_CHOICES: ImpactBucket[] = [
  "shopping_discretionary",
  "household_expense",
  "business_expense",
];

// ── User impact-mapping preferences ─────────────────────────────────────────

const PREFS_KEY = "impact_prefs";

export interface ImpactPrefs {
  /** LLM / software / AI-provider invoices default to this bucket. */
  softwareInvoice: ImpactBucket;
  /** Grocery / supermarket bills default to this bucket. */
  grocery: ImpactBucket;
  /** Marketplace purchases (Amazon, Flipkart, …) default to this bucket. */
  marketplace: ImpactBucket;
}

export const IMPACT_PREFS_DEFAULTS: ImpactPrefs = {
  softwareInvoice: "business_expense",
  grocery: "household_expense",
  marketplace: "shopping_discretionary",
};

function coerceBucket(
  value: unknown,
  allowed: ImpactBucket[],
  fallback: ImpactBucket,
): ImpactBucket {
  return typeof value === "string" && (allowed as string[]).includes(value)
    ? (value as ImpactBucket)
    : fallback;
}

export function getImpactPrefs(): ImpactPrefs {
  const raw = getSetting(PREFS_KEY);
  if (!raw) return { ...IMPACT_PREFS_DEFAULTS };
  try {
    const p = JSON.parse(raw) as Partial<ImpactPrefs>;
    return {
      softwareInvoice: coerceBucket(
        p.softwareInvoice,
        SOFTWARE_CHOICES,
        IMPACT_PREFS_DEFAULTS.softwareInvoice,
      ),
      grocery: coerceBucket(p.grocery, GROCERY_CHOICES, IMPACT_PREFS_DEFAULTS.grocery),
      marketplace: coerceBucket(
        p.marketplace,
        MARKETPLACE_CHOICES,
        IMPACT_PREFS_DEFAULTS.marketplace,
      ),
    };
  } catch {
    return { ...IMPACT_PREFS_DEFAULTS };
  }
}

export function setImpactPrefs(patch: Partial<ImpactPrefs>): ImpactPrefs {
  const next: ImpactPrefs = { ...getImpactPrefs() };
  if (patch.softwareInvoice)
    next.softwareInvoice = coerceBucket(
      patch.softwareInvoice,
      SOFTWARE_CHOICES,
      next.softwareInvoice,
    );
  if (patch.grocery) next.grocery = coerceBucket(patch.grocery, GROCERY_CHOICES, next.grocery);
  if (patch.marketplace)
    next.marketplace = coerceBucket(patch.marketplace, MARKETPLACE_CHOICES, next.marketplace);
  setSetting(PREFS_KEY, JSON.stringify(next));
  return next;
}

// ── Direction + amount helpers ───────────────────────────────────────────────

const IN_BUCKETS = new Set<ImpactBucket>(["income", "investment_sale"]);
const NEUTRAL_BUCKETS = new Set<ImpactBucket>(["transfer_neutral", "needs_review"]);

export function directionFor(bucket: ImpactBucket): ImpactDirection {
  if (IN_BUCKETS.has(bucket)) return "in";
  if (NEUTRAL_BUCKETS.has(bucket)) return "neutral";
  return "out";
}

/** A learned vendor→bucket rule that applies to this vendor, if any. */
function bucketRuleFor(vendor: string | null): ImpactBucket | null {
  if (!vendor) return null;
  const v = vendor.toLowerCase();
  for (const r of listLearnedRules()) {
    if (r.ruleType !== "impact_bucket" || r.matchKey.length < 2) continue;
    if (!v.includes(r.matchKey.toLowerCase())) continue;
    const value = r.value.trim() as ImpactBucket;
    if (value in IMPACT_LABEL) return value;
  }
  return null;
}

/** Map a detected spend category to a bucket, honouring user preferences. */
function bucketForCategory(category: SpendCategory, prefs: ImpactPrefs): ImpactBucket | null {
  switch (category) {
    case "software_saas":
      return prefs.softwareInvoice;
    case "grocery":
      return prefs.grocery;
    case "marketplace":
      return prefs.marketplace;
    case "insurance":
      return "personal_expense";
    case "utilities":
      return "software_utility_expense";
    case "rent":
      return "household_expense";
    case "salary":
      return "income";
    case "tax":
      return "tax_statutory";
    case "credit_card":
      return "liability_dues";
    case "investment":
      return "investment_purchase";
    case "none":
      return null;
  }
}

// ── Canonical INR amount ─────────────────────────────────────────────────────

/** The minimal contract-note facts the impact layer needs. */
type ContractNoteImpactInput = Pick<ContractNoteRecord, "netAmount" | "side">;

function amountInrFor(
  extraction: DocumentExtraction,
  currency: CurrencyFields,
  contractNote: ContractNoteImpactInput | null,
): number | null {
  if (contractNote) {
    return contractNote.netAmount != null
      ? Math.round(Math.abs(contractNote.netAmount) * 100) / 100
      : null;
  }
  if (currency.currencyStatus === "converted" && currency.inrValue != null)
    return currency.inrValue;
  // A local-currency (INR / unmarked) amount is taken at face value.
  if (
    (extraction.currency === "INR" || extraction.currency === "NONE") &&
    extraction.amount.present
  ) {
    const n = Number(extraction.amount.value);
    if (Number.isFinite(n)) return Math.round(n * 100) / 100;
  }
  return null;
}

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Derive the plain-language financial impact of a recognized document. Returns
 * null when the document isn't a financial transaction at all (no flow, no
 * amount, not a contract note) — there's nothing to summarize.
 */
export function deriveImpact(input: {
  extraction: DocumentExtraction;
  currency: CurrencyFields;
  contractNote: ContractNoteImpactInput | null;
  impactPrefs?: ImpactPrefs;
}): FinancialImpact | null {
  const { extraction, currency, contractNote } = input;
  const impactPrefs = input.impactPrefs ?? getImpactPrefs();
  const amountInr = amountInrFor(extraction, currency, contractNote);

  // A broker contract note is always investment activity (never a generic expense).
  if (contractNote) {
    const bucket: ImpactBucket =
      contractNote.side === "sell" ? "investment_sale" : "investment_purchase";
    return {
      bucket,
      confidence: 0.95,
      direction: directionFor(bucket),
      amountInr,
      spendCategory: "investment",
      watchCategory: extraction.watchCategory,
      reason:
        contractNote.side === "sell"
          ? "A broker contract note — securities sold."
          : "A broker contract note — securities purchased.",
      source: "ai_inferred",
    };
  }

  // Not a financial transaction (no flow and no amount) — nothing to summarize.
  if (extraction.flow === "unknown" && !extraction.amount.present && !extraction.impactBucket) {
    return null;
  }

  let bucket: ImpactBucket | null = null;
  let confidence = 0.45;
  let source: FieldSource = "ai_inferred";
  let reason = "";

  const ruleHit = bucketRuleFor(extraction.vendor.value);
  const catBucket = bucketForCategory(extraction.spendCategory, impactPrefs);

  if (ruleHit) {
    bucket = ruleHit;
    confidence = 0.9;
    source = "learned_rule";
    reason = `You taught that documents from “${extraction.vendor.value}” are ${IMPACT_LABEL[ruleHit].toLowerCase()}.`;
  } else if (catBucket) {
    bucket = catBucket;
    confidence = 0.8;
    source = "learned_rule";
    reason = reasonForCategory(extraction.spendCategory, catBucket);
  } else if (extraction.impactBucket && extraction.impactBucket in IMPACT_LABEL) {
    bucket = extraction.impactBucket;
    confidence = extraction.impactConfident ? 0.75 : 0.5;
    reason = defaultReason(bucket, extraction);
  } else if (extraction.flow === "income") {
    bucket = "income";
    confidence = extraction.flowConfident ? 0.7 : 0.5;
    reason = "Looks like money coming in.";
  } else if (extraction.flow === "expense") {
    bucket = "personal_expense";
    confidence = 0.45;
    reason = "Looks like money going out — bucket not certain.";
  }

  if (!bucket) {
    return {
      bucket: "needs_review",
      confidence: 0.3,
      direction: "neutral",
      amountInr,
      reason: "Couldn’t confidently decide what this changes — please review.",
      source: "ai_inferred",
    };
  }

  // No usable amount weakens the signal but doesn't invalidate the bucket.
  if (amountInr == null && confidence > 0.6) confidence = 0.6;

  return {
    bucket,
    confidence,
    direction: directionFor(bucket),
    amountInr,
    spendCategory: extraction.spendCategory,
    watchCategory: extraction.watchCategory,
    reason,
    source,
  };
}

function reasonForCategory(category: SpendCategory, bucket: ImpactBucket): string {
  const label = IMPACT_LABEL[bucket].toLowerCase();
  switch (category) {
    case "software_saas":
      return `A software / AI-provider invoice — your preference files these as ${label}.`;
    case "grocery":
      return `A grocery / supermarket bill — your preference files these as ${label}.`;
    case "marketplace":
      return `A marketplace purchase — your preference files these as ${label}.`;
    default:
      return `Recognized as ${label}.`;
  }
}

function defaultReason(bucket: ImpactBucket, extraction: DocumentExtraction): string {
  const vendor = extraction.vendor.value ? ` from ${extraction.vendor.value}` : "";
  switch (bucket) {
    case "income":
      return "This looks like income.";
    case "investment_purchase":
      return "This appears to be an investment purchase.";
    case "investment_sale":
      return "This appears to be an investment sale.";
    case "liability_dues":
      return "This looks like a liability / dues summary.";
    case "tax_statutory":
      return "This looks like a tax / statutory payment.";
    default:
      return `This adds to ${IMPACT_LABEL[bucket].toLowerCase()}${vendor}.`;
  }
}

// ── Plain-language summary (for backend notifications) ───────────────────────

/** A short en-IN INR summary sentence for a document impact (used by notifications). */
export function buildImpactSummary(impact: FinancialImpact): string {
  const amount =
    impact.amountInr != null
      ? new Intl.NumberFormat("en-IN", {
          style: "currency",
          currency: "INR",
          maximumFractionDigits: 0,
        }).format(impact.amountInr)
      : null;
  const soft = impact.confidence < 0.6 ? "Possibly " : "";
  const label = IMPACT_LABEL[impact.bucket].toLowerCase();
  if (impact.bucket === "needs_review")
    return "Recognized, but the financial impact needs a quick review.";
  if (impact.direction === "in") {
    return amount ? `${soft}income of ${amount}.` : `${soft}recognized as income.`;
  }
  if (impact.bucket === "investment_purchase") {
    return amount ? `${soft}added ${amount} to investments.` : `${soft}an investment purchase.`;
  }
  return amount ? `${soft}added ${amount} to ${label}.` : `${soft}recognized as ${label}.`;
}
