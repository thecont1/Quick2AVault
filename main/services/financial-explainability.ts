import type { SnapshotPeriodInfo } from "./snapshot-period.js";
import { documentIsInPeriod } from "./snapshot-period.js";

export type ExplainableMoneyMetric = "income" | "spending" | "investments";

export interface ExplainableMoneyDocument {
  docId: number;
  documentDate: string | null;
  lifecycleState: string;
  bucket: string;
  direction: "in" | "out" | "neutral";
  amountInr: number | null;
}

export interface ExplainableMoneySummary {
  totals: {
    income: number;
    spending: number;
    investments: number;
    documentCount: number;
    undatedDocumentCount: number;
  };
  drilldownIds: Record<ExplainableMoneyMetric, number[]>;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

const contributesTo = (
  document: ExplainableMoneyDocument,
  metric: ExplainableMoneyMetric,
): boolean => {
  if (metric === "income") return document.bucket === "income";
  if (metric === "investments") return document.bucket === "investment_purchase";
  return document.direction === "out" && document.bucket !== "investment_purchase";
};

/**
 * Canonical source for document-only hero totals and drill-down IDs. Manual
 * schedules deliberately do not enter this API until reconciliation exists.
 */
export function summarizeDocumentMoney(
  documents: ExplainableMoneyDocument[],
  period: SnapshotPeriodInfo,
): ExplainableMoneySummary {
  const summary: ExplainableMoneySummary = {
    totals: {
      income: 0,
      spending: 0,
      investments: 0,
      documentCount: 0,
      undatedDocumentCount: 0,
    },
    drilldownIds: { income: [], spending: [], investments: [] },
  };

  for (const document of documents) {
    if (document.lifecycleState !== "active" || document.amountInr == null) continue;
    if (!document.documentDate) {
      summary.totals.undatedDocumentCount += 1;
      continue;
    }
    if (!documentIsInPeriod(document, period)) continue;

    const amount = Math.abs(document.amountInr);
    summary.totals.documentCount += 1;
    for (const metric of ["income", "spending", "investments"] as const) {
      if (!contributesTo(document, metric)) continue;
      summary.totals[metric] += amount;
      summary.drilldownIds[metric].push(document.docId);
    }
  }

  summary.totals.income = round2(summary.totals.income);
  summary.totals.spending = round2(summary.totals.spending);
  summary.totals.investments = round2(summary.totals.investments);
  return summary;
}

/** Testable accounting invariant: the visible drill-down sum equals its hero. */
export function sumDrilldownMetric(
  documents: ExplainableMoneyDocument[],
  docIds: number[],
  metric: ExplainableMoneyMetric,
  period: SnapshotPeriodInfo,
): number {
  const allowedIds = new Set(docIds);
  return round2(
    documents.reduce((total, document) => {
      if (
        !allowedIds.has(document.docId) ||
        document.lifecycleState !== "active" ||
        document.amountInr == null ||
        !documentIsInPeriod(document, period) ||
        !contributesTo(document, metric)
      ) {
        return total;
      }
      return total + Math.abs(document.amountInr);
    }, 0),
  );
}
