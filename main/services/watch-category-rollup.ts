export interface WatchCategoryMatcher {
  id: string;
  label: string;
  pinned: boolean;
  spendCategories: string[];
  impactBuckets: string[];
}

export interface WatchImpact {
  amountInr: number | null;
  source: "document" | "scheduled";
  spendCategory: string | null;
  watchCategory: string | null;
  impactBucket: string | null;
}

export const normalizeWatchTag = (value: string | null | undefined): string =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export function matchesWatchCategory(
  impact: Omit<WatchImpact, "amountInr">,
  category: WatchCategoryMatcher,
): boolean {
  const tags = new Set(category.spendCategories.map(normalizeWatchTag));
  for (const tag of [
    normalizeWatchTag(impact.spendCategory),
    normalizeWatchTag(impact.watchCategory),
  ]) {
    if (tag && tags.has(tag)) return true;
  }
  return impact.impactBucket != null && category.impactBuckets.includes(impact.impactBucket);
}

export function rollupWatchCategories(
  impacts: WatchImpact[],
  categories: WatchCategoryMatcher[],
): Array<{
  id: string;
  label: string;
  totalInr: number;
  documentCount: number;
  scheduledEntryCount: number;
}> {
  const summaries = categories
    .filter((category) => category.pinned)
    .map((category) => ({
      id: category.id,
      label: category.label,
      totalInr: 0,
      documentCount: 0,
      scheduledEntryCount: 0,
    }));
  for (const impact of impacts) {
    if (impact.amountInr == null) continue;
    for (const category of categories) {
      if (!category.pinned || !matchesWatchCategory(impact, category)) continue;
      const summary = summaries.find((item) => item.id === category.id)!;
      summary.totalInr += Math.abs(impact.amountInr);
      if (impact.source === "document") summary.documentCount += 1;
      else summary.scheduledEntryCount += 1;
    }
  }
  for (const summary of summaries) summary.totalInr = Math.round(summary.totalInr * 100) / 100;
  return summaries;
}
