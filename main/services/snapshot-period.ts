export type SnapshotPeriod = "month" | "financial_year";

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
