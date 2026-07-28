import type { SnapshotPeriod } from "./snapshot-period.js";

export type DrilldownMetric = "income" | "spending" | "investments";

export interface DocumentDrilldown {
  metric: DrilldownMetric;
  period: SnapshotPeriod;
  label: string;
  startDate: string;
  endDate: string;
  /** Exact documents used by the snapshot aggregation. */
  docIds: number[];
}

export interface BrowserDocument {
  docId: number;
  category: string | null;
  docDate: string | null;
  dateIngested: string;
  lifecycleState: string;
  impactBucket: string | null;
  impactDirection: "in" | "out" | "neutral" | null;
}

export interface DocumentGroup<T extends BrowserDocument> {
  label: string;
  rows: T[];
}

export function matchesDocumentDrilldown(
  row: BrowserDocument,
  drilldown: DocumentDrilldown,
): boolean {
  if (!drilldown.docIds.includes(row.docId)) return false;
  if (row.lifecycleState !== "active" || !row.docDate) return false;
  if (row.docDate < drilldown.startDate || row.docDate > drilldown.endDate) return false;
  if (drilldown.metric === "income") return row.impactBucket === "income";
  if (drilldown.metric === "investments") return row.impactBucket === "investment_purchase";
  return row.impactDirection === "out" && row.impactBucket !== "investment_purchase";
}

export function applyDocumentDrilldown<T extends BrowserDocument>(
  rows: T[],
  drilldown: DocumentDrilldown | null,
): T[] {
  return drilldown ? rows.filter((row) => matchesDocumentDrilldown(row, drilldown)) : rows;
}

const rowDate = (row: BrowserDocument): string => row.docDate ?? row.dateIngested;

/** Group by category; category and row ordering are deterministic. */
export function groupDocumentRows<T extends BrowserDocument>(rows: T[]): DocumentGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const label = row.category?.trim() || "Uncategorized";
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return Array.from(groups, ([label, groupRows]) => ({
    label,
    rows: groupRows
      .slice()
      .sort((a, b) => rowDate(b).localeCompare(rowDate(a)) || b.docId - a.docId),
  })).sort((a, b) => {
    if (a.label === "Uncategorized") return 1;
    if (b.label === "Uncategorized") return -1;
    return a.label.localeCompare(b.label);
  });
}
