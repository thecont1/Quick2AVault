export type SnapshotPeriod = "month" | "financial_year";

export type RecurringFrequency = "weekly" | "monthly" | "quarterly" | "annually" | "custom";

export interface RecurringSchedule {
  amount: number;
  frequency: RecurringFrequency;
  startDate: string | null;
  endDate: string | null;
}

export interface DatedMoneyImpact {
  documentDate: string | null;
  bucket: string;
  direction: "in" | "out" | "neutral";
  amountInr: number | null;
}

export interface SnapshotMoneyTotals {
  income: number;
  spending: number;
  investments: number;
  documentCount: number;
  undatedDocumentCount: number;
}

export interface SnapshotPeriodInfo {
  period: SnapshotPeriod;
  label: string;
  startDate: string;
  endDate: string;
}

const isoDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const clampMonth = (value: number): number =>
  Number.isInteger(value) && value >= 1 && value <= 12 ? value : 4;

const financialYearLabel = (year: number, month: number, startMonth: number): string => {
  const startYear = month >= startMonth ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
};

export function snapshotPeriodInfo(
  period: SnapshotPeriod,
  now = new Date(),
  fyStartMonth = 4,
): SnapshotPeriodInfo {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  if (period === "month") {
    return {
      period,
      label: now.toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
      startDate: `${year}-${String(month).padStart(2, "0")}-01`,
      endDate: isoDate(new Date(year, month, 0)),
    };
  }

  fyStartMonth = clampMonth(fyStartMonth);
  const startYear = month >= fyStartMonth ? year : year - 1;
  const endYear = startYear + 1;
  const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;
  const endYearForDate = fyStartMonth === 1 ? startYear : endYear;
  return {
    period,
    label: financialYearLabel(year, month, fyStartMonth),
    startDate: `${startYear}-${String(fyStartMonth).padStart(2, "0")}-01`,
    endDate: isoDate(new Date(endYearForDate, endMonth, 0)),
  };
}

export function documentIsInPeriod(
  document: { documentDate: string | null },
  info: SnapshotPeriodInfo,
): boolean {
  const date = document.documentDate;
  return (
    date != null &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date >= info.startDate &&
    date <= info.endDate
  );
}

const parseIsoDate = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return isoDate(date) === value ? date : null;
};

const anchoredMonth = (anchor: Date, months: number): Date => {
  const target = new Date(anchor.getFullYear(), anchor.getMonth() + months, 1);
  const anchorLastDay = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const targetLastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(
    anchor.getDate() === anchorLastDay ? targetLastDay : Math.min(anchor.getDate(), targetLastDay),
  );
  return target;
};

/** Amount a recurring entry contributes in a snapshot period. */
export function recurringContributionForPeriod(
  entry: RecurringSchedule,
  info: SnapshotPeriodInfo,
): number {
  if (!Number.isFinite(entry.amount) || entry.amount < 0) return 0;
  if (entry.frequency === "custom") {
    if (!entry.startDate) return 0;
    return documentIsInPeriod({ documentDate: entry.startDate }, info) ? entry.amount : 0;
  }
  return entry.amount * recurringOccurrencesInPeriod(entry, info);
}

/** Count concrete payment occurrences inside a snapshot period. */
export function recurringOccurrencesInPeriod(
  entry: RecurringSchedule,
  info: SnapshotPeriodInfo,
): number {
  if (!Number.isFinite(entry.amount) || entry.amount < 0 || entry.frequency === "custom") return 0;
  const periodStart = parseIsoDate(info.startDate);
  const periodEnd = parseIsoDate(info.endDate);
  const start = entry.startDate ? parseIsoDate(entry.startDate) : null;
  const end = entry.endDate ? parseIsoDate(entry.endDate) : null;
  if (!periodStart || !periodEnd) return 0;
  if (!start) {
    // Dates were optional before period-aware rollups. Preserve undated monthly
    // entries by counting calendar months; other cadences need a real anchor.
    if (entry.frequency !== "monthly" || end) return 0;
    return (
      (periodEnd.getFullYear() - periodStart.getFullYear()) * 12 +
      periodEnd.getMonth() -
      periodStart.getMonth() +
      1
    );
  }
  if (end && end < start) return 0;

  const last = end && end < periodEnd ? end : periodEnd;
  if (start > last) return 0;
  let count = 0;
  let occurrence = 0;
  let cursor = start;
  while (cursor <= last) {
    if (cursor >= periodStart) count += 1;
    occurrence += 1;
    switch (entry.frequency) {
      case "weekly":
        cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate() + occurrence * 7);
        break;
      case "monthly":
        cursor = anchoredMonth(start, occurrence);
        break;
      case "quarterly":
        cursor = anchoredMonth(start, occurrence * 3);
        break;
      case "annually":
        cursor = anchoredMonth(start, occurrence * 12);
        break;
    }
  }
  return count;
}

export function rollupMoneyForPeriod(
  documents: DatedMoneyImpact[],
  info: SnapshotPeriodInfo,
): SnapshotMoneyTotals {
  const totals: SnapshotMoneyTotals = {
    income: 0,
    spending: 0,
    investments: 0,
    documentCount: 0,
    undatedDocumentCount: 0,
  };

  for (const document of documents) {
    if (document.amountInr == null) continue;
    if (!document.documentDate) {
      totals.undatedDocumentCount += 1;
      continue;
    }
    if (!documentIsInPeriod(document, info)) continue;

    const amount = Math.abs(document.amountInr);
    totals.documentCount += 1;
    if (document.bucket === "income") totals.income += amount;
    if (document.bucket === "investment_purchase") totals.investments += amount;
    else if (document.direction === "out") totals.spending += amount;
  }

  totals.income = Math.round(totals.income * 100) / 100;
  totals.spending = Math.round(totals.spending * 100) / 100;
  totals.investments = Math.round(totals.investments * 100) / 100;
  return totals;
}
