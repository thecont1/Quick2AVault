/**
 * Spend categorisation + treemap folding.
 *   npx tsx daemon/categories/spend-categories.smoke.ts
 *
 * The failure this guards against is a DISHONEST CHART: a treemap where area
 * does not equal money, either because rupees were dropped during folding or
 * because one concept was split across several tiles.
 */
import {
  normaliseKey,
  categorise,
  buildTreemap,
  SPEND_CATEGORIES,
  type TreemapRow,
} from "./spend-categories.js";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown, msg = "") {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}

check("normalisation collapses separators", () => {
  eq(normaliseKey("software/subscription"), "software_subscription");
  eq(normaliseKey("Software Subscription"), "software_subscription");
  eq(normaliseKey("software_subscription"), "software_subscription");
  eq(normaliseKey("  education/workshop  "), "education_workshop");
});

check("THE BUG: three spellings of software fold into ONE category", () => {
  const a = categorise("subscription");
  const b = categorise("software_subscription");
  const c = categorise("software/subscription");
  eq(a.id, "software");
  eq(b.id, "software", "software_subscription must not be its own tile");
  eq(c.id, "software", "software/subscription must not be its own tile");
});

check("food delivery and its fee are one category", () => {
  eq(categorise("food_delivery").id, "ordering_in");
  eq(categorise("food_delivery_fee").id, "ordering_in");
});

check("telecom and mobile bills are one category", () => {
  eq(categorise("telecom_bill").id, "utilities");
  eq(categorise("mobile_bill").id, "utilities");
});

check("unknown buckets pass through, they are NOT dropped", () => {
  const c = categorise("artisanal_cheese_club");
  eq(c.known, false);
  eq(c.label, "Artisanal Cheese Club");
});

check("null/empty bucket becomes Uncategorised rather than crashing", () => {
  eq(categorise(null).id, "uncategorised");
  eq(categorise("").id, "uncategorised");
  eq(categorise("   ").id, "uncategorised");
});

check("CONSERVATION: every paisa survives folding", () => {
  const rows: TreemapRow[] = [
    { impact_bucket: "subscription", amount_minor: 552_600, transactions: 13 },
    { impact_bucket: "software_subscription", amount_minor: 176_800, transactions: 12 },
    { impact_bucket: "software/subscription", amount_minor: 9_800, transactions: 2 },
    { impact_bucket: "food_delivery", amount_minor: 650_900, transactions: 10 },
    { impact_bucket: "food_delivery_fee", amount_minor: 17_000, transactions: 2 },
    { impact_bucket: "mystery_bucket", amount_minor: 1_234, transactions: 1 },
  ];
  const inTotal = rows.reduce((s, r) => s + r.amount_minor, 0);
  const nodes = buildTreemap(rows);
  const outTotal = nodes.reduce((s, n) => s + n.amount_minor, 0);
  eq(outTotal, inTotal, "treemap area must equal the money it represents:");

  const inTxns = rows.reduce((s, r) => s + r.transactions, 0);
  const outTxns = nodes.reduce((s, n) => s + n.transactions, 0);
  eq(outTxns, inTxns, "transaction counts must survive folding:");
});

check("folded node reports its constituent raw buckets", () => {
  const nodes = buildTreemap([
    { impact_bucket: "subscription", amount_minor: 552_600, transactions: 13 },
    { impact_bucket: "software_subscription", amount_minor: 176_800, transactions: 12 },
    { impact_bucket: "software/subscription", amount_minor: 9_800, transactions: 2 },
  ]);
  eq(nodes.length, 1, "three spellings must produce one tile:");
  eq(nodes[0].amount_minor, 739_200);
  eq(nodes[0].sources.length, 3, "the fold must remain auditable:");
  // Sources are ordered largest-first so a tooltip leads with the main one.
  eq(nodes[0].sources[0].bucket, "subscription");
});

check("nodes are ordered largest first", () => {
  const nodes = buildTreemap([
    { impact_bucket: "groceries", amount_minor: 100, transactions: 1 },
    { impact_bucket: "food_delivery", amount_minor: 900, transactions: 1 },
    { impact_bucket: "shopping", amount_minor: 500, transactions: 1 },
  ]);
  eq(
    nodes.map((n) => n.id),
    ["ordering_in", "shopping", "groceries"],
  );
});

check("empty input yields an empty treemap, not a crash", () => {
  eq(buildTreemap([]), []);
});

check("no bucket is claimed by two categories", () => {
  const seen = new Map<string, string>();
  for (const c of SPEND_CATEGORIES) {
    for (const b of c.buckets) {
      const k = normaliseKey(b);
      const prev = seen.get(k);
      if (prev) throw new Error(`bucket "${b}" claimed by both ${prev} and ${c.id}`);
      seen.set(k, c.id);
    }
  }
});

check("a NULL/empty bucket becomes Uncategorised, never dropped", () => {
  // The SQL used `impact_bucket NOT IN (...)`, and NULL NOT IN (...) is NULL,
  // so WHERE rejected the row: uncategorised spending vanished from the
  // treemap while the hero total still counted it. The query now COALESCEs,
  // which means buildTreemap really does receive blank rows and must fold them.
  const nodes = buildTreemap([
    { impact_bucket: "eating_out", amount_minor: 10_000, transactions: 1 },
    { impact_bucket: "", amount_minor: 25_000, transactions: 2 },
    { impact_bucket: null, amount_minor: 5_000, transactions: 1 },
  ]);
  const total = nodes.reduce((s, n) => s + n.amount_minor, 0);
  eq(total, 40_000, "uncategorised money went missing:");
  const uncat = nodes.find((n) => /uncategor|none/i.test(n.label));
  if (!uncat) throw new Error(`no Uncategorised node: ${nodes.map((n) => n.label).join(", ")}`);
  eq(uncat.amount_minor, 30_000, "both blank rows must fold into one tile:");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
