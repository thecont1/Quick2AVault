/**
 * Financial snapshot: read the vault's Markdown files and use Glaze AI to
 * attribute each document to a person, then aggregate a high-level, per-person
 * summary (who appears, how many documents, the date range they span, and which
 * categories were found). The raw per-document attribution is cached, so manual
 * corrections (rename / merge / reassign) re-aggregate instantly without AI.
 *
 * Never throws for AI/consent problems — blocked states are returned so the
 * renderer can show a friendly message alongside the raw ingestion stats.
 */
import * as fs from "node:fs/promises";

import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import {
  countDocsNeedingReview,
  findPerson,
  getLastActivity,
  getSnapshotCache,
  listActiveDocuments,
  listAllContractNoteTrades,
  listDocumentOverrides,
  listDocuments,
  listPersons,
  listRecurringEntries,
  saveSnapshotCache,
  type DocumentRecord,
  type EntryScope,
  type ImpactBucket,
  type ImpactDirection,
  type PersonRole,
  type RecurringFrequency,
} from "./database.js";
import {
  buildAliasIndex,
  consolidateCandidateDuplicates,
  listAllAliases,
  resolveNameToPersonId,
  resolvePersonForName,
  seedPeopleFromExisting,
} from "./people.js";
import { recordPersonReview } from "./reviews.js";
import { directionFor, IMPACT_LABEL } from "./impact.js";
import { isActiveNow, monthlyEquivalent } from "./recurring.js";
import { fyLabel, getFinancePrefs } from "./preferences.js";
import { summarizeDocumentMoney } from "./financial-explainability.js";
import {
  documentIsInPeriod,
  recurringContributionForPeriod,
  snapshotPeriodInfo,
  type SnapshotPeriod,
} from "./snapshot-period.js";
import {
  getWatchCategories,
  rollupWatchCategories,
  type WatchCategoryPreference,
} from "./watch-categories.js";

export interface DocRef {
  docId: number;
  filename: string;
}

/** A confidently-converted foreign-currency invoice. */
export interface ForeignInvoice {
  docId: number;
  filename: string;
  amount: number;
  currency: string;
  inrValue: number;
  rateUsed: number;
  rateDate: string;
  rateIsNearest: boolean;
}

export interface PersonSummary {
  name: string;
  /** Canonical person id when this group resolved to a stored person, else null. */
  personId: number | null;
  roles: PersonRole[];
  isSelf: boolean;
  documentCount: number;
  dateRange: { start: string; end: string } | null;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

export interface UnidentifiedSummary {
  documentCount: number;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

/** A document with a detected foreign amount that couldn't be converted confidently. */
export interface NeedsReviewDoc {
  docId: number;
  filename: string;
  currency: string | null;
  amount: number | null;
}

export interface NeedsReviewSummary {
  documentCount: number;
  documents: NeedsReviewDoc[];
}

export interface FinancialYearSummary {
  /** FY key, e.g. "2025-26". */
  key: string;
  /** Display label, e.g. "FY 2025-26". */
  label: string;
  documentCount: number;
}

/** The big, life-defining numbers shown first on the snapshot. All in INR. */
export interface SnapshotTotals {
  /** Money coming in (document-derived income). */
  income: number;
  /** Household + shared-family expenses. */
  householdExpenses: number;
  /** Business + software/utility expenses. */
  businessExpenses: number;
  /** Money put into investments (document-derived purchases). */
  investments: number;
  /** Documents still awaiting review. */
  reviewCount: number;
  /** How many active documents contributed a monetary impact. */
  documentCount: number;
  /** Money documents excluded from period totals because they have no reliable date. */
  undatedDocumentCount: number;
}

export interface WatchCategorySummary {
  id: string;
  label: string;
  totalInr: number;
  documentCount: number;
  scheduledEntryCount: number;
}

export interface SnapshotDrilldownIds {
  income: number[];
  spending: number[];
  investments: number[];
}

export interface PeriodSnapshot {
  period: SnapshotPeriod;
  label: string;
  startDate: string;
  endDate: string;
  totals: SnapshotTotals;
  watchCategories: WatchCategorySummary[];
  drilldownIds: SnapshotDrilldownIds;
}

/** One impact bucket's rolled-up total across all active documents. */
export interface ImpactBucketSummary {
  bucket: ImpactBucket;
  label: string;
  direction: ImpactDirection;
  totalInr: number;
  documentCount: number;
}

/** One security's aggregated trade activity across contract notes. */
export interface InvestmentSecurity {
  name: string;
  symbol: string | null;
  isin: string | null;
  buyQuantity: number;
  sellQuantity: number;
  buyAmount: number;
  sellAmount: number;
}

export interface InvestmentByPerson {
  name: string;
  buyAmount: number;
  sellAmount: number;
  documentCount: number;
}

/** Document-driven securities trade activity (never portfolio valuation). */
export interface InvestmentActivity {
  totalBuy: number;
  totalSell: number;
  documentCount: number;
  tradeCount: number;
  securities: InvestmentSecurity[];
  byPerson: InvestmentByPerson[];
}

/** A manual recurring entry as surfaced in the snapshot (with derived fields). */
export interface RecurringEntryView {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: RecurringFrequency;
  person: string | null;
  bucket: ImpactBucket;
  bucketLabel: string;
  scope: EntryScope;
  direction: ImpactDirection;
  monthlyEquivalent: number;
  active: boolean;
}

export interface RecurringSummary {
  entries: RecurringEntryView[];
  monthlyOutflow: number;
  monthlyInflow: number;
  /** Set when some entries are in a currency other than the reporting one. */
  hasOtherCurrencies: boolean;
}

export interface SnapshotData {
  /** Big-number-first all-time totals retained for compatibility. */
  totals: SnapshotTotals;
  /** Dated money totals for the two primary dashboard periods. */
  periods: Record<SnapshotPeriod, PeriodSnapshot>;
  /** Per-bucket rolled-up impact totals (secondary breakdown). */
  impactBuckets: ImpactBucketSummary[];
  /** Document-driven investment (securities trade) activity. */
  investments: InvestmentActivity | null;
  /** Manual recurring entries + their monthly normalization. */
  recurring: RecurringSummary;
  people: PersonSummary[];
  unidentified: UnidentifiedSummary | null;
  needsReview: NeedsReviewSummary | null;
  /** Document counts per financial year (newest first); empty when none dated. */
  financialYears: FinancialYearSummary[];
}

export interface FallbackStats {
  totalDocuments: number;
  documents: { filename: string; fileType: string; dateIngested: string }[];
  dateRange: { start: string; end: string } | null;
}

export interface SnapshotResponse {
  /** The aggregated summary (fresh, or the last cached one when a refresh is blocked). */
  snapshot: SnapshotData | null;
  /** ISO timestamp of when the underlying attribution was generated. */
  generatedAt: string | null;
  /** ISO timestamp of the most recent vault activity (file drop, Gmail sync, refresh). */
  lastActivity: string | null;
  /** GlazeAIError.state when the AI step was blocked. */
  aiBlocked?: string;
  /** Generic (non-AI-consent) failure message. */
  error?: string;
  /** Raw ingestion stats, always available without AI. */
  fallback: FallbackStats;
}

/** One document's AI attribution, resolved to a concrete database record. */
interface Attribution {
  docId: number;
  filename: string;
  fileType: string;
  /** Raw person name from the AI, or null when the AI couldn't attribute it. */
  person: string | null;
  category: string;
  /** ISO-ish period the document covers (YYYY / YYYY-MM / YYYY-MM-DD), or null. */
  periodStart: string | null;
  periodEnd: string | null;
}

interface CachedAttributions {
  version: 2;
  attributions: Attribution[];
}

// Bound AI input so a large vault doesn't burn excess credits.
const MAX_TOTAL_CHARS = 24000;
const MAX_PER_DOC = 1800;
const MAX_DOCS = 60;

const snapshotSchema = z.object({
  attributions: z
    .array(
      z.object({
        documentIndex: z
          .number()
          .int()
          .describe("The 'Document N' number from the input this attribution refers to"),
        person: z
          .string()
          .nullable()
          .describe(
            "The account holder / signatory's name exactly as it appears in the document content, " +
              "or null if the document can't be confidently attributed to a named person",
          ),
        category: z
          .string()
          .describe(
            "Document category, e.g. 'bank statement', 'tax document', 'insurance', 'credit card'",
          ),
        periodStart: z
          .string()
          .nullable()
          .describe(
            "Earliest date the document covers, as YYYY, YYYY-MM, or YYYY-MM-DD; null if unclear",
          ),
        periodEnd: z
          .string()
          .nullable()
          .describe(
            "Latest date the document covers, as YYYY, YYYY-MM, or YYYY-MM-DD; null if unclear",
          ),
      }),
    )
    .describe("Exactly one entry per provided document"),
});

function buildFallback(): FallbackStats {
  const docs = listActiveDocuments(500);
  const documents = docs.map((d) => ({
    filename: d.originalFilename,
    fileType: d.fileType,
    dateIngested: d.dateIngested,
  }));
  let dateRange: { start: string; end: string } | null = null;
  if (docs.length > 0) {
    const dates = docs.map((d) => d.dateIngested).sort();
    dateRange = { start: dates[0], end: dates[dates.length - 1] };
  }
  return { totalDocuments: docs.length, documents, dateRange };
}

// ── Override resolution + aggregation ───────────────────────────────────

/** Turn per-document attributions + manual overrides into a per-person summary. */
function aggregate(attributions: Attribution[]): SnapshotData {
  const docMap = new Map(listDocumentOverrides().map((o) => [o.docId, o.person]));
  // Currency data lives on the document record (computed at ingestion), so join
  // it in at read time rather than caching it in the attribution blob.
  const docMeta = new Map(listActiveDocuments(500).map((d) => [d.id, d]));
  // Canonical person resolution: every raw name resolves to a stored person via
  // its alias index, so reorders/variants and user merges collapse instantly.
  const aliasIndex = buildAliasIndex();
  const allAliases = listAllAliases();
  const personById = new Map(listPersons().map((p) => [p.id, p]));

  type Bucket = {
    key: string;
    name: string;
    personId: number | null;
    roles: PersonRole[];
    isSelf: boolean;
    categories: Set<string>;
    documents: DocRef[];
    starts: string[];
    ends: string[];
    foreignInvoices: ForeignInvoice[];
    foreignTotalInr: number;
  };
  const people = new Map<string, Bucket>();
  const unidentified: {
    categories: Set<string>;
    documents: DocRef[];
    foreignInvoices: ForeignInvoice[];
    foreignTotalInr: number;
  } = {
    categories: new Set<string>(),
    documents: [],
    foreignInvoices: [],
    foreignTotalInr: 0,
  };
  const needsReview: NeedsReviewDoc[] = [];
  // docId → effective (canonical/raw) person name, for the investment breakdown.
  const docPersonName = new Map<number, string | null>();

  for (const attr of attributions) {
    // A manual per-document pin wins over the AI's attribution.
    const rawName = docMap.has(attr.docId) ? docMap.get(attr.docId)! : attr.person;
    const personId = resolveNameToPersonId(rawName, aliasIndex, allAliases);
    const person = personId != null ? personById.get(personId) : undefined;
    // Display: canonical person name when resolved; else the raw name (transient).
    const effective = person ? person.displayName : rawName;
    docPersonName.set(attr.docId, effective ?? null);

    const ref: DocRef = { docId: attr.docId, filename: attr.filename };
    const category = attr.category?.trim();

    let foreign: { foreignInvoices: ForeignInvoice[]; foreignTotalInr: number };
    if (effective == null) {
      if (category) unidentified.categories.add(category);
      unidentified.documents.push(ref);
      foreign = unidentified;
    } else {
      const key = personId != null ? `p${personId}` : `raw:${effective}`;
      let bucket = people.get(key);
      if (!bucket) {
        bucket = {
          key,
          name: effective,
          personId: personId ?? null,
          roles: person?.roles ?? [],
          isSelf: person?.isSelf ?? false,
          categories: new Set(),
          documents: [],
          starts: [],
          ends: [],
          foreignInvoices: [],
          foreignTotalInr: 0,
        };
        people.set(key, bucket);
      }
      if (category) bucket.categories.add(category);
      bucket.documents.push(ref);
      if (attr.periodStart) bucket.starts.push(attr.periodStart);
      if (attr.periodEnd) bucket.ends.push(attr.periodEnd);
      foreign = bucket;
    }

    // Attach foreign-currency conversion (or flag for review) to the same bucket.
    const meta = docMeta.get(attr.docId);
    if (meta?.currencyStatus === "needs_review") {
      needsReview.push({
        docId: attr.docId,
        filename: attr.filename,
        currency: meta.foreignCurrency,
        amount: meta.foreignAmount,
      });
    } else if (
      meta?.currencyStatus === "converted" &&
      meta.inrValue != null &&
      meta.foreignAmount != null &&
      meta.foreignCurrency &&
      meta.rateUsed != null &&
      meta.rateDate != null
    ) {
      foreign.foreignInvoices.push({
        docId: attr.docId,
        filename: attr.filename,
        amount: meta.foreignAmount,
        currency: meta.foreignCurrency,
        inrValue: meta.inrValue,
        rateUsed: meta.rateUsed,
        rateDate: meta.rateDate,
        rateIsNearest: meta.rateIsNearest,
      });
      foreign.foreignTotalInr += meta.inrValue;
    }
  }

  const peopleList: PersonSummary[] = Array.from(people.values())
    .map((b) => {
      const start = b.starts.length ? b.starts.slice().sort()[0] : null;
      const end = b.ends.length ? b.ends.slice().sort()[b.ends.length - 1] : null;
      return {
        name: b.name,
        personId: b.personId,
        roles: b.roles,
        isSelf: b.isSelf,
        documentCount: b.documents.length,
        dateRange: start || end ? { start: start ?? end!, end: end ?? start! } : null,
        categories: Array.from(b.categories),
        documents: b.documents,
        foreignInvoices: b.foreignInvoices,
        foreignTotalInr: Math.round(b.foreignTotalInr * 100) / 100,
      };
    })
    .sort(
      (a, b) =>
        Number(b.isSelf) - Number(a.isSelf) ||
        b.documentCount - a.documentCount ||
        a.name.localeCompare(b.name),
    );

  // Financial-year breakdown across all documents (a natural organizing lens).
  const fyCounts = new Map<string, number>();
  for (const d of docMeta.values()) {
    if (d.financialYear) fyCounts.set(d.financialYear, (fyCounts.get(d.financialYear) ?? 0) + 1);
  }
  const financialYears: FinancialYearSummary[] = Array.from(fyCounts.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, documentCount]) => ({ key, label: fyLabel(key), documentCount }));

  const layers = buildFinancialLayers(docMeta, docPersonName);

  return {
    totals: { ...layers.totals, reviewCount: countDocsNeedingReview() },
    periods: layers.periods,
    impactBuckets: layers.impactBuckets,
    investments: layers.investments,
    recurring: layers.recurring,
    people: peopleList,
    unidentified:
      unidentified.documents.length > 0
        ? {
            documentCount: unidentified.documents.length,
            categories: Array.from(unidentified.categories),
            documents: unidentified.documents,
            foreignInvoices: unidentified.foreignInvoices,
            foreignTotalInr: Math.round(unidentified.foreignTotalInr * 100) / 100,
          }
        : null,
    needsReview:
      needsReview.length > 0 ? { documentCount: needsReview.length, documents: needsReview } : null,
    financialYears,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Roll up financial-impact buckets, document-driven investment activity, and
 * separately-labelled manual schedules. Hero totals remain document-only until
 * scheduled-to-actual reconciliation can make every top-line rupee explainable.
 */
function buildFinancialLayers(
  docMeta: Map<number, DocumentRecord>,
  docPersonName: Map<number, string | null>,
): {
  totals: Omit<SnapshotTotals, "reviewCount">;
  periods: Record<SnapshotPeriod, PeriodSnapshot>;
  impactBuckets: ImpactBucketSummary[];
  investments: InvestmentActivity | null;
  recurring: RecurringSummary;
} {
  const reviewCount = countDocsNeedingReview();
  const financePrefs = getFinancePrefs();
  const watchPrefs = getWatchCategories();
  const recurringEntries = listRecurringEntries();
  const periodFor = (period: SnapshotPeriod): PeriodSnapshot => {
    const info = snapshotPeriodInfo(period, new Date(), financePrefs.fyStartMonth);
    const scopedDocs = new Map(
      Array.from(docMeta.entries()).filter(([, document]) => documentIsInPeriod(document, info)),
    );
    const money = rollupMoney(scopedDocs, watchPrefs, reviewCount);
    const documentMoney = summarizeDocumentMoney(
      Array.from(docMeta.values(), (document) => ({
        docId: document.id,
        documentDate: document.documentDate,
        lifecycleState: document.lifecycleState,
        bucket: document.impact?.bucket ?? "needs_review",
        direction: document.impact?.direction ?? "neutral",
        amountInr: document.impact?.amountInr ?? null,
      })),
      info,
    );
    money.totals.income = documentMoney.totals.income;
    money.totals.householdExpenses = documentMoney.totals.spending;
    money.totals.investments = documentMoney.totals.investments;
    money.totals.documentCount = documentMoney.totals.documentCount;
    money.totals.undatedDocumentCount = documentMoney.totals.undatedDocumentCount;

    // Scheduled/manual entries stay out of hero totals until reconciliation can
    // link them to actual documents without double-counting. They may still feed
    // watch categories, explicitly labelled as scheduled contributions.
    const recurringImpacts = recurringEntries.flatMap((entry) => {
      if (entry.currency.toUpperCase() !== financePrefs.currency.toUpperCase()) return [];
      const amountInr = round2(recurringContributionForPeriod(entry, info));
      if (amountInr === 0) return [];
      return [
        {
          amountInr,
          source: "scheduled" as const,
          spendCategory: entry.category,
          watchCategory: entry.category,
          impactBucket: entry.impactBucket,
        },
      ];
    });
    return {
      ...info,
      totals: money.totals,
      watchCategories: rollupWatchCategories(
        [...money.impactsForWatch, ...recurringImpacts],
        watchPrefs,
      ),
      drilldownIds: documentMoney.drilldownIds,
    };
  };
  const periods: Record<SnapshotPeriod, PeriodSnapshot> = {
    month: periodFor("month"),
    previous_month: periodFor("previous_month"),
    financial_year: periodFor("financial_year"),
  };

  // ── Impact buckets ──
  const bucketTotals = new Map<ImpactBucket, { totalInr: number; count: number }>();
  let contributing = 0;
  for (const d of docMeta.values()) {
    const imp = d.impact;
    if (!imp) continue;
    const e = bucketTotals.get(imp.bucket) ?? { totalInr: 0, count: 0 };
    e.count += 1;
    if (imp.amountInr != null) {
      e.totalInr += imp.amountInr;
      contributing += 1;
    }
    bucketTotals.set(imp.bucket, e);
  }
  const bucketTotal = (b: ImpactBucket) => round2(bucketTotals.get(b)?.totalInr ?? 0);
  const impactBuckets: ImpactBucketSummary[] = Array.from(bucketTotals.entries())
    .map(([bucket, v]) => ({
      bucket,
      label: IMPACT_LABEL[bucket],
      direction: directionFor(bucket),
      totalInr: round2(v.totalInr),
      documentCount: v.count,
    }))
    .sort((a, b) => b.totalInr - a.totalInr || b.documentCount - a.documentCount);

  // ── Investment activity (contract-note trades, active docs only) ──
  const trades = listAllContractNoteTrades().filter((t) => docMeta.has(t.docId));
  let investments: InvestmentActivity | null = null;
  if (trades.length > 0) {
    const secMap = new Map<string, InvestmentSecurity>();
    const personMap = new Map<string, InvestmentByPerson>();
    const personDocs = new Map<string, Set<number>>();
    const docIds = new Set<number>();
    let totalBuy = 0;
    let totalSell = 0;
    for (const t of trades) {
      docIds.add(t.docId);
      const amt = t.netAmount ?? 0;
      const qty = t.quantity ?? 0;
      const secKey = (t.isin || t.securityName).toLowerCase();
      let s = secMap.get(secKey);
      if (!s) {
        s = {
          name: t.securityName,
          symbol: t.symbol,
          isin: t.isin,
          buyQuantity: 0,
          sellQuantity: 0,
          buyAmount: 0,
          sellAmount: 0,
        };
        secMap.set(secKey, s);
      }
      const pname = docPersonName.get(t.docId) ?? "Unattributed";
      const pKey = pname.toLowerCase();
      let p = personMap.get(pKey);
      if (!p) {
        p = { name: pname, buyAmount: 0, sellAmount: 0, documentCount: 0 };
        personMap.set(pKey, p);
      }
      if (!personDocs.has(pKey)) personDocs.set(pKey, new Set());
      personDocs.get(pKey)!.add(t.docId);
      if (t.side === "sell") {
        s.sellQuantity += qty;
        s.sellAmount += amt;
        p.sellAmount += amt;
        totalSell += amt;
      } else {
        s.buyQuantity += qty;
        s.buyAmount += amt;
        p.buyAmount += amt;
        totalBuy += amt;
      }
    }
    for (const [pKey, p] of personMap) {
      p.documentCount = personDocs.get(pKey)?.size ?? 0;
      p.buyAmount = round2(p.buyAmount);
      p.sellAmount = round2(p.sellAmount);
    }
    investments = {
      totalBuy: round2(totalBuy),
      totalSell: round2(totalSell),
      documentCount: docIds.size,
      tradeCount: trades.length,
      securities: Array.from(secMap.values())
        .map((s) => ({ ...s, buyAmount: round2(s.buyAmount), sellAmount: round2(s.sellAmount) }))
        .sort((a, b) => b.buyAmount + b.sellAmount - (a.buyAmount + a.sellAmount)),
      byPerson: Array.from(personMap.values()).sort(
        (a, b) => b.buyAmount + b.sellAmount - (a.buyAmount + a.sellAmount),
      ),
    };
  }

  // ── Manual recurring entries ──
  const reportingCurrency = financePrefs.currency.toUpperCase();
  let monthlyOutflow = 0;
  let monthlyInflow = 0;
  let hasOtherCurrencies = false;
  const entryViews: RecurringEntryView[] = listRecurringEntries().map((e) => {
    const active = isActiveNow(e);
    const monthly = monthlyEquivalent(e);
    const direction = directionFor(e.impactBucket);
    const sameCurrency = e.currency.toUpperCase() === reportingCurrency;
    if (!sameCurrency) hasOtherCurrencies = true;
    if (active && sameCurrency) {
      if (direction === "out") monthlyOutflow += monthly;
      else if (direction === "in") monthlyInflow += monthly;
    }
    return {
      id: e.id,
      name: e.name,
      amount: e.amount,
      currency: e.currency,
      frequency: e.frequency,
      person: e.person,
      bucket: e.impactBucket,
      bucketLabel: IMPACT_LABEL[e.impactBucket],
      scope: e.scope,
      direction,
      monthlyEquivalent: round2(monthly),
      active,
    };
  });
  const recurring: RecurringSummary = {
    entries: entryViews,
    monthlyOutflow: round2(monthlyOutflow),
    monthlyInflow: round2(monthlyInflow),
    hasOtherCurrencies,
  };

  return {
    totals: {
      income: bucketTotal("income"),
      householdExpenses: round2(
        bucketTotal("household_expense") + bucketTotal("shared_family_expense"),
      ),
      businessExpenses: round2(
        bucketTotal("business_expense") + bucketTotal("software_utility_expense"),
      ),
      investments: bucketTotal("investment_purchase"),
      documentCount: contributing,
      undatedDocumentCount: Array.from(docMeta.values()).filter(
        (document) => document.impact?.amountInr != null && !document.documentDate,
      ).length,
    },
    periods,
    impactBuckets,
    investments,
    recurring,
  };
}

function rollupMoney(
  docs: Map<number, DocumentRecord>,
  watchPrefs: WatchCategoryPreference[],
  reviewCount: number,
): {
  totals: SnapshotTotals;
  watchCategories: WatchCategorySummary[];
  impactsForWatch: Array<{
    amountInr: number | null;
    source: "document";
    spendCategory: string | null;
    watchCategory: string | null;
    impactBucket: string | null;
  }>;
  drilldownIds: SnapshotDrilldownIds;
} {
  const totals: SnapshotTotals = {
    income: 0,
    householdExpenses: 0,
    businessExpenses: 0,
    investments: 0,
    reviewCount,
    documentCount: 0,
    undatedDocumentCount: 0,
  };
  const impactsForWatch: Array<{
    amountInr: number | null;
    source: "document";
    spendCategory: string | null;
    watchCategory: string | null;
    impactBucket: string | null;
  }> = [];
  const drilldownIds: SnapshotDrilldownIds = { income: [], spending: [], investments: [] };

  for (const document of docs.values()) {
    const impact = document.impact;
    if (!impact || impact.amountInr == null) continue;
    const amount = Math.abs(impact.amountInr);
    totals.documentCount += 1;
    if (impact.bucket === "income") {
      totals.income += amount;
      drilldownIds.income.push(document.id);
    }
    if (impact.direction === "out" && impact.bucket !== "investment_purchase") {
      totals.householdExpenses += amount;
      drilldownIds.spending.push(document.id);
    }
    if (impact.bucket === "business_expense" || impact.bucket === "software_utility_expense") {
      totals.businessExpenses += amount;
    }
    if (impact.bucket === "investment_purchase") {
      totals.investments += amount;
      drilldownIds.investments.push(document.id);
    }

    impactsForWatch.push({
      amountInr: impact.amountInr,
      source: "document",
      spendCategory: impact.spendCategory ?? null,
      watchCategory: impact.watchCategory ?? null,
      impactBucket: impact.bucket,
    });
  }
  totals.income = round2(totals.income);
  totals.householdExpenses = round2(totals.householdExpenses);
  totals.businessExpenses = round2(totals.businessExpenses);
  totals.investments = round2(totals.investments);
  const watchCategories = rollupWatchCategories(impactsForWatch, watchPrefs);
  return { totals, watchCategories, impactsForWatch, drilldownIds };
}

function parseCache(json: string): Attribution[] | null {
  try {
    const parsed = JSON.parse(json) as Partial<CachedAttributions>;
    if (parsed && parsed.version === 2 && Array.isArray(parsed.attributions)) {
      return parsed.attributions;
    }
    return null;
  } catch {
    return null;
  }
}

/** One document's AI attribution (person/category/period) from the snapshot cache. */
export interface DocAttribution {
  person: string | null;
  category: string | null;
  periodStart: string | null;
  periodEnd: string | null;
}

/**
 * Per-document AI attribution from the snapshot cache, keyed by docId. Used by
 * the Document Browser / evidence card to show who/what the AI thinks each file
 * is without re-running AI. Empty when no snapshot has been generated yet.
 */
export function getAttributionMap(): Map<number, DocAttribution> {
  const cache = getSnapshotCache();
  const attributions = cache ? parseCache(cache.json) : null;
  const map = new Map<number, DocAttribution>();
  if (attributions) {
    for (const a of attributions) {
      map.set(a.docId, {
        person: a.person,
        category: a.category?.trim() || null,
        periodStart: a.periodStart,
        periodEnd: a.periodEnd,
      });
    }
  }
  return map;
}

/** Read Markdown excerpts for the vault's documents, bounded for the AI. */
async function buildAiInput(): Promise<{ text: string; docs: ReturnType<typeof listDocuments> }> {
  const docs = listActiveDocuments(MAX_DOCS);
  const used: typeof docs = [];
  const blocks: string[] = [];
  let total = 0;
  for (const doc of docs) {
    let content = "";
    try {
      content = await fs.readFile(doc.markdownPath, "utf-8");
    } catch {
      content = "";
    }
    const excerpt = content.slice(0, MAX_PER_DOC).trim();
    const index = used.length + 1;
    const block =
      `### Document ${index}\n` +
      `Filename: ${doc.originalFilename}\n` +
      `Type: ${doc.fileType}\n` +
      `Ingested: ${doc.dateIngested}\n` +
      `Content excerpt:\n${excerpt || "(no extractable content)"}\n`;
    if (total + block.length > MAX_TOTAL_CHARS) break;
    blocks.push(block);
    total += block.length;
    used.push(doc);
  }
  return { text: blocks.join("\n"), docs: used };
}

/** Return the cached snapshot (if any) plus current fallback stats. No AI. */
export function getCachedSnapshot(): SnapshotResponse {
  seedPeopleFromExisting();
  consolidateCandidateDuplicates();
  const cache = getSnapshotCache();
  const attributions = cache ? parseCache(cache.json) : null;
  return {
    snapshot: attributions ? aggregate(attributions) : null,
    generatedAt: attributions ? (cache?.generatedAt ?? null) : null,
    lastActivity: getLastActivity(),
    fallback: buildFallback(),
  };
}

/** Re-run the AI attribution, update the cache, and return the fresh summary. */
export async function refreshSnapshot(): Promise<SnapshotResponse> {
  const fallback = buildFallback();
  const cache = getSnapshotCache();
  const previous = cache ? parseCache(cache.json) : null;

  // Empty vault: nothing to attribute — don't spend AI credits, but still build
  // the (zeroed) totals + any manual recurring entries so the big-number
  // skeleton stays intact.
  if (fallback.totalDocuments === 0) {
    const now = new Date().toISOString();
    saveSnapshotCache(
      JSON.stringify({ version: 2, attributions: [] } satisfies CachedAttributions),
      now,
    );
    return { snapshot: aggregate([]), generatedAt: now, lastActivity: getLastActivity(), fallback };
  }

  const { text: documentsText, docs } = await buildAiInput();

  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema: snapshotSchema,
      system:
        "You analyze a collection of personal financial documents and attribute each one to a person. " +
        "Identify the person by their name as it appears in the document content (account holders, " +
        "signatories, addressees) — never infer a person from a filename. Only attribute a document to a " +
        "person when the content clearly names them; otherwise set person to null. Stay high-level: do not " +
        "compute balances or transaction-level detail. Never invent people, dates, or categories.",
      prompt:
        `Below are ${docs.length} documents from a personal financial vault. Return exactly one attribution ` +
        "per document (matched by its 'Document N' number), each with the person it belongs to (or null if " +
        "unattributable), a category (e.g. bank statement, tax document, investment statement, insurance, " +
        `credit card), and the period the document covers.\n\n${documentsText}`,
    });

    const raw = (object as z.infer<typeof snapshotSchema>).attributions;
    const byIndex = new Map<number, (typeof raw)[number]>();
    for (const a of raw) byIndex.set(a.documentIndex, a);

    // Resolve every input document to an attribution; anything the AI omitted
    // is kept as unidentified so per-person counts always cover the whole vault.
    const attributions: Attribution[] = docs.map((doc, i) => {
      const a = byIndex.get(i + 1);
      return {
        docId: doc.id,
        filename: doc.originalFilename,
        fileType: doc.fileType,
        person: a?.person?.trim() ? a.person.trim() : null,
        category: a?.category?.trim() ? a.category.trim() : "document",
        periodStart: a?.periodStart?.trim() || null,
        periodEnd: a?.periodEnd?.trim() || null,
      };
    });

    // Entity resolution: fold each detected name into the canonical Person
    // ontology (create/link + evidence) before caching and aggregating.
    seedPeopleFromExisting();
    for (const a of attributions) {
      if (a.person) {
        const res = resolvePersonForName(a.person, { docId: a.docId, filename: a.filename });
        if (res.uncertain) {
          // An uncertain identity match — surface it for review.
          recordPersonReview({
            docId: a.docId,
            extracted: res.uncertain.detected,
            suggested: res.uncertain.suggested,
            confidence: res.uncertain.score,
            status: "conflict",
            reason: res.uncertain.reason,
          });
        } else if (res.personId == null) {
          // Implausible name — don't confirm the raw fragment as a person.
          recordPersonReview({
            docId: a.docId,
            extracted: a.person,
            suggested: null,
            confidence: 0,
            status: "conflict",
            reason: "Detected name does not look like a person.",
          });
        } else {
          // Auto-linked: use the canonical person's display name as the
          // final value so the Evidence Card shows the resolved identity.
          const canonical = res.personId != null ? findPerson(res.personId) : null;
          const displayName = canonical?.displayName ?? a.person;
          recordPersonReview({
            docId: a.docId,
            extracted: a.person,
            suggested: displayName,
            confidence: 0.9,
            status: "confirmed",
            reason: "",
            finalValue: displayName,
          });
        }
      } else {
        // The AI couldn't attribute this document to a named person.
        recordPersonReview({
          docId: a.docId,
          extracted: null,
          suggested: "Unidentified",
          confidence: 0,
          status: "missing",
          reason: "Couldn’t confidently attribute this document to a named person.",
        });
      }
    }
    consolidateCandidateDuplicates();

    const now = new Date().toISOString();
    saveSnapshotCache(
      JSON.stringify({ version: 2, attributions } satisfies CachedAttributions),
      now,
    );
    const snapshot = aggregate(attributions);
    logger.info("snapshot", "Generated financial snapshot", {
      people: snapshot.people.length,
      unidentified: snapshot.unidentified?.documentCount ?? 0,
    });
    return { snapshot, generatedAt: now, lastActivity: getLastActivity(), fallback };
  } catch (error) {
    const previousSnapshot = previous ? aggregate(previous) : null;
    if (error instanceof GlazeAIError) {
      logger.info("snapshot", "AI snapshot blocked", { state: error.state });
      return {
        snapshot: previousSnapshot,
        generatedAt: cache?.generatedAt ?? null,
        lastActivity: getLastActivity(),
        aiBlocked: error.state,
        fallback,
      };
    }
    logger.warn("snapshot", "AI snapshot failed", { error: String(error) });
    return {
      snapshot: previousSnapshot,
      generatedAt: cache?.generatedAt ?? null,
      lastActivity: getLastActivity(),
      error: String(error),
      fallback,
    };
  }
}
