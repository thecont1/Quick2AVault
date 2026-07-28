/**
 * User-chosen categories shown on the primary money dashboard.
 *
 * Built-ins cover the obvious day-to-day questions. Custom categories are
 * deliberately lightweight: their label becomes an extraction hint for future
 * documents (so data accumulates), and matching is performed against the
 * persisted spend-category / watch-category tags plus a broad impact-bucket
 * fallback. The ordered list is also the dashboard priority order; only the
 * first few pinned categories are shown in the compact snapshot.
 */
import { getSetting, setSetting, type ImpactBucket } from "./database.js";
import { normalizeWatchTag, type WatchCategoryMatcher } from "./watch-category-rollup.js";

export { rollupWatchCategories } from "./watch-category-rollup.js";

const SETTING_KEY = "snapshot_watch_categories";
const MAX_CATEGORIES = 24;
const MAX_LABEL_LENGTH = 40;

export interface WatchCategoryPreference {
  id: string;
  label: string;
  pinned: boolean;
  builtIn: boolean;
  /** Persisted spend/watch tags (normalized) that feed this visible category. */
  spendCategories: string[];
  /** Optional broad impact buckets used for useful totals on older documents. */
  impactBuckets: ImpactBucket[];
}

export const WATCH_CATEGORY_DEFAULTS: WatchCategoryPreference[] = [
  {
    id: "discretionary",
    label: "Discretionary",
    pinned: true,
    builtIn: true,
    spendCategories: ["discretionary", "marketplace"],
    impactBuckets: ["shopping_discretionary"],
  },
  {
    id: "eating_out",
    label: "Eating Out",
    pinned: true,
    builtIn: true,
    spendCategories: ["eating_out", "dining_out", "restaurant"],
    impactBuckets: [],
  },
  {
    id: "ordering_in",
    label: "Ordering In",
    pinned: true,
    builtIn: true,
    spendCategories: ["ordering_in", "food_delivery"],
    impactBuckets: [],
  },
  {
    id: "groceries",
    label: "Groceries",
    pinned: true,
    builtIn: true,
    spendCategories: ["groceries", "grocery"],
    impactBuckets: [],
  },
  {
    id: "ai_expense",
    label: "AI Expense",
    pinned: false,
    builtIn: true,
    spendCategories: ["ai_expense", "ai", "software_saas"],
    impactBuckets: [],
  },
];

/** Normalize any label/tag to a stable comparison key. Exported for matching. */
export const normalizeTag = normalizeWatchTag;

function cloneDefaults(): WatchCategoryPreference[] {
  return WATCH_CATEGORY_DEFAULTS.map((c) => ({
    ...c,
    spendCategories: [...c.spendCategories],
    impactBuckets: [...c.impactBuckets],
  }));
}

function coerceStored(value: unknown): WatchCategoryPreference[] {
  if (!Array.isArray(value)) return cloneDefaults();
  const defaults = new Map(WATCH_CATEGORY_DEFAULTS.map((c) => [c.id, c]));
  const result: WatchCategoryPreference[] = [];
  const seen = new Set<string>();

  for (const raw of value.slice(0, MAX_CATEGORIES)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const label =
      typeof item.label === "string" ? item.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
    const id = typeof item.id === "string" ? normalizeTag(item.id) : normalizeTag(label);
    if (!id || !label || seen.has(id)) continue;
    const builtIn = defaults.get(id);
    result.push(
      builtIn
        ? {
            ...builtIn,
            pinned: typeof item.pinned === "boolean" ? item.pinned : builtIn.pinned,
            spendCategories: [...builtIn.spendCategories],
            impactBuckets: [...builtIn.impactBuckets],
          }
        : {
            id,
            label,
            pinned: typeof item.pinned === "boolean" ? item.pinned : true,
            builtIn: false,
            // A custom category matches its own normalized label as a tag.
            spendCategories: [id],
            impactBuckets: [],
          },
    );
    seen.add(id);
  }

  // New built-ins added by an app update appear without destroying the user's
  // existing order or pin choices.
  for (const item of WATCH_CATEGORY_DEFAULTS) {
    if (!seen.has(item.id))
      result.push({
        ...item,
        spendCategories: [...item.spendCategories],
        impactBuckets: [...item.impactBuckets],
      });
  }
  return result.slice(0, MAX_CATEGORIES);
}

export function getWatchCategories(): WatchCategoryPreference[] {
  const raw = getSetting(SETTING_KEY);
  if (!raw) return cloneDefaults();
  try {
    return coerceStored(JSON.parse(raw));
  } catch {
    return cloneDefaults();
  }
}

export function setWatchCategories(value: unknown): WatchCategoryPreference[] {
  const next = coerceStored(value);
  setSetting(SETTING_KEY, JSON.stringify(next));
  return next;
}

/**
 * Exact labels supplied to extraction so custom + built-in categories can
 * accumulate data on newly ingested documents. Deduped, capped, non-empty.
 */
export function watchCategoryExtractionLabels(): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const c of getWatchCategories()) {
    const key = normalizeTag(c.label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(c.label);
  }
  return labels;
}

/**
 * Does a document (by its persisted spend/watch tags + impact bucket) belong to
 * a given watch category? Matching is tag-first (spend_category / watch_category
 * columns), with a broad impact-bucket fallback so built-ins still total older
 * documents that predate per-category tagging.
 */
export function matchesWatchCategory(
  doc: { spendCategory: string | null; watchCategory: string | null; impactBucket: string | null },
  category: WatchCategoryPreference,
): boolean {
  return matchesWatchCategoryCore(doc, category);
}

function matchesWatchCategoryCore(
  doc: { spendCategory: string | null; watchCategory: string | null; impactBucket: string | null },
  category: WatchCategoryMatcher,
): boolean {
  const tags = new Set(category.spendCategories.map(normalizeTag));
  const docTags = [normalizeTag(doc.spendCategory), normalizeTag(doc.watchCategory)].filter(
    Boolean,
  );
  for (const tag of docTags) if (tags.has(tag)) return true;
  return doc.impactBucket != null && category.impactBuckets.includes(doc.impactBucket);
}
