/**
 * Spending categories for the treemap.
 *
 * The extractor emits a free-text `impact_bucket` per transaction, and across
 * a real vault the same concept arrives under several names:
 *
 *   subscription · software_subscription · software/subscription
 *   food_delivery · food_delivery_fee
 *   telecom_bill · mobile_bill
 *
 * Rendered raw, a treemap shows three small "software" tiles instead of one
 * honest one — the chart would understate the category it is meant to expose.
 * This module folds raw buckets into the user's own taxonomy (ported from the
 * Glaze app's watch-categories) so area means what it appears to mean.
 *
 * Design notes:
 *  - Matching is on a NORMALISED key (lowercase, non-alphanumerics collapsed),
 *    so `software/subscription`, `software_subscription` and `Software
 *    Subscription` are the same thing without needing an entry each.
 *  - Unmatched buckets are NOT dropped and NOT silently merged into "Other":
 *    they pass through under a titled version of their own name, so a new
 *    category the user starts spending on appears immediately rather than
 *    vanishing into a catch-all.
 */

/** Lowercase, collapse any run of non-alphanumerics to a single underscore. */
export function normaliseKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export interface SpendCategory {
  id: string;
  label: string;
  /** Raw impact_bucket values (any spelling) that roll up here. */
  buckets: string[];
}

/**
 * The user's taxonomy, from the Glaze app's WATCH_CATEGORY_DEFAULTS, extended
 * with the buckets actually present in the vault. Order is display priority.
 */
export const SPEND_CATEGORIES: SpendCategory[] = [
  {
    id: "ordering_in",
    label: "Ordering In",
    buckets: ["ordering_in", "food_delivery", "food_delivery_fee"],
  },
  {
    id: "eating_out",
    label: "Eating Out",
    buckets: ["eating_out", "dining_out", "restaurant", "cafe"],
  },
  {
    id: "groceries",
    label: "Groceries",
    buckets: ["groceries", "grocery", "supermarket"],
  },
  {
    id: "software",
    label: "Software & Subscriptions",
    buckets: [
      "subscription",
      "software_subscription",
      "software_cloud_services",
      "software_saas",
      "ai_expense",
      "cloud_hosting",
    ],
  },
  {
    id: "utilities",
    label: "Rent & Utilities",
    buckets: ["utility_bill", "telecom_bill", "mobile_bill", "internet_bill", "rent"],
  },
  {
    id: "events",
    label: "Events & Learning",
    buckets: ["event_ticket", "conference_event", "education_workshop", "course", "books"],
  },
  {
    id: "shopping",
    label: "Shopping",
    buckets: ["shopping", "shopping_discretionary", "marketplace", "discretionary"],
  },
  {
    id: "professional",
    label: "Professional Services",
    buckets: ["tax_filing_service", "legal_service", "accounting", "professional_service"],
  },
  {
    id: "transport",
    label: "Transport",
    buckets: ["transport", "cab", "fuel", "travel", "flight", "train"],
  },
  {
    id: "health",
    label: "Health",
    buckets: ["health", "pharmacy", "medical", "insurance_premium"],
  },
];

/** bucket key -> category, built once. */
const BUCKET_INDEX: Map<string, SpendCategory> = (() => {
  const m = new Map<string, SpendCategory>();
  for (const c of SPEND_CATEGORIES) {
    for (const b of c.buckets) m.set(normaliseKey(b), c);
  }
  return m;
})();

/** Turn `education/workshop` into `Education Workshop` for passthrough. */
function titleise(raw: string): string {
  const k = normaliseKey(raw);
  if (!k) return "Uncategorised";
  return k
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface CategorisedBucket {
  id: string;
  label: string;
  /** True when this came from the taxonomy rather than passthrough. */
  known: boolean;
}

/**
 * Map one raw impact_bucket onto a display category.
 * Unknown buckets pass through under their own titled name — never dropped,
 * never lumped into "Other", because a treemap that hides a category is worse
 * than one with an extra tile.
 */
export function categorise(bucket: string | null | undefined): CategorisedBucket {
  const key = normaliseKey(bucket ?? "");
  if (!key) return { id: "uncategorised", label: "Uncategorised", known: false };
  const hit = BUCKET_INDEX.get(key);
  if (hit) return { id: hit.id, label: hit.label, known: true };
  return { id: key, label: titleise(key), known: false };
}

export interface TreemapNode {
  id: string;
  label: string;
  /** Minor units (paise). The UI formats; the daemon never rounds to rupees. */
  amount_minor: number;
  transactions: number;
  known: boolean;
  /** Raw buckets folded into this node, for the tooltip and for auditability. */
  sources: Array<{ bucket: string; amount_minor: number; transactions: number }>;
}

export interface TreemapRow {
  impact_bucket: string | null;
  amount_minor: number;
  transactions: number;
}

/**
 * Fold raw per-bucket rows into treemap nodes, largest first.
 *
 * Every input rupee appears in exactly one node: the caller can assert that
 * the node total equals the query total, which is the property a treemap has
 * to satisfy to be honest about area.
 */
export function buildTreemap(rows: TreemapRow[]): TreemapNode[] {
  const byId = new Map<string, TreemapNode>();

  for (const r of rows) {
    const c = categorise(r.impact_bucket);
    let node = byId.get(c.id);
    if (!node) {
      node = {
        id: c.id,
        label: c.label,
        amount_minor: 0,
        transactions: 0,
        known: c.known,
        sources: [],
      };
      byId.set(c.id, node);
    }
    node.amount_minor += r.amount_minor;
    node.transactions += r.transactions;
    node.sources.push({
      bucket: r.impact_bucket ?? "(none)",
      amount_minor: r.amount_minor,
      transactions: r.transactions,
    });
  }

  const nodes = [...byId.values()];
  for (const n of nodes) n.sources.sort((a, b) => b.amount_minor - a.amount_minor);
  return nodes.sort((a, b) => b.amount_minor - a.amount_minor);
}
