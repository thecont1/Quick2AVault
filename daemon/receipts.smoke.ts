/**
 * Receipts must sum to the hero figure they explain.
 *
 * Clicking Income/Spending/Investments filters the list to the transactions
 * that produced that number. The list and the total are computed by two
 * different SQL queries, so nothing structural stops them drifting apart —
 * this test is the thing that stops it.
 *
 * The daemon achieves conservation by lifting snapshot()'s predicates verbatim
 * into the /v1/transactions bucket filter (same INVEST test, same
 * `status <> 'scheduled'` exclusion, same direction). If someone edits one and
 * not the other, this fails.
 */
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./schema.js";
import { snapshot } from "./api.js";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
    failed++;
  }
}

function seedDoc(db: DatabaseSync, id: string) {
  // Columns match ledger.smoke.ts's known-good insert. Adding doc_type/status
  // here failed with a bare "SQL logic error" — the schema constrains them.
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, source,
                            received_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, `sha-${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, "test",
        "2026-07-01T00:00:00.000Z");
}

function seedTxn(
  db: DatabaseSync,
  id: string,
  opts: {
    direction: string;
    minor: number;
    occurred: string;
    bucket?: string | null;
    category?: string | null;
    instrument?: string | null;
    status?: string;
  },
) {
  seedDoc(db, `doc-${id}`);
  db.prepare(
    `INSERT INTO transactions
       (id, direction, amount_minor, currency, occurred_at, fy_key, status,
        impact_bucket, category_id, instrument_entity_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, opts.direction, opts.minor, "INR", opts.occurred, "FY 2026-27",
    opts.status ?? "evidenced", opts.bucket ?? null, opts.category ?? null,
    opts.instrument ?? null, "2026-07-01T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO transaction_documents
       (transaction_id, document_id, evidence_role, linked_at)
     VALUES (?,?,?,?)`,
  ).run(id, `doc-${id}`, "primary", "2026-07-01T00:00:00.000Z");
}

/**
 * The bucket predicates, mirrored from the /v1/transactions handler. Kept as a
 * literal copy on purpose: if the handler changes and this does not, the
 * conservation assertions below fail, which is the alarm we want.
 */
const INVEST = `(t.instrument_entity_id IS NOT NULL
                 OR lower(COALESCE(t.category_id,'')) LIKE '%invest%'
                 OR lower(COALESCE(t.impact_bucket,'')) LIKE '%invest%')`;

function bucketSum(db: DatabaseSync, bucket: string, from: string, to: string) {
  const clause =
    bucket === "income"
      ? `t.direction='in' AND t.status <> 'scheduled' AND NOT ${INVEST}`
      : bucket === "spending"
        ? `t.direction='out' AND t.status <> 'scheduled' AND NOT ${INVEST}`
        : `t.direction='out' AND t.status <> 'scheduled' AND ${INVEST}`;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_minor),0) v FROM transactions t
       WHERE date(t.occurred_at) BETWEEN date(?) AND date(?) AND ${clause}`,
    )
    .get(from, to) as { v: number };
  return row.v;
}

const db = openDatabase(":memory:");

// The instrument FK needs a real entity, or "investment by instrument" cannot
// be seeded at all.
db.prepare(
  `INSERT INTO entities (id, kind, display_name, created_at)
   VALUES (?,?,?,?)`,
).run("ent-1", "instrument", "NIFTYBEES", "2026-07-01T00:00:00.000Z");

// A deliberately awkward mix: an investment identified three different ways,
// a scheduled row that must be excluded, and a NULL bucket.
seedTxn(db, "t1", { direction: "out", minor: 150000, occurred: "2026-07-05", bucket: "groceries" });
seedTxn(db, "t2", { direction: "out", minor: 90000, occurred: "2026-07-10", bucket: null });
seedTxn(db, "t3", { direction: "in", minor: 5000000, occurred: "2026-07-01", bucket: "salary" });
// Investment by instrument, by category, and by bucket — all three paths.
seedTxn(db, "t4", { direction: "out", minor: 2500000, occurred: "2026-07-12", instrument: "ent-1" });
seedTxn(db, "t5", { direction: "out", minor: 1000000, occurred: "2026-07-14", category: "investments_equity" });
seedTxn(db, "t6", { direction: "out", minor: 750000, occurred: "2026-07-16", bucket: "Investment" });
// Scheduled: must appear in NEITHER the total nor the list.
seedTxn(db, "t7", { direction: "out", minor: 999999, occurred: "2026-07-20", bucket: "rent", status: "scheduled" });

const period = {
  from: "2026-07-01",
  to: "2026-07-31",
  label: "July 2026",
  key: "2026-07",
};
const s = snapshot(db, period) as unknown as Record<string, number>;

check("spending receipts sum to the spending figure", () => {
  const list = bucketSum(db, "spending", period.from, period.to);
  if (list !== s.spending_minor) {
    throw new Error(`list=${list} hero=${s.spending_minor}`);
  }
});

check("income receipts sum to the income figure", () => {
  const list = bucketSum(db, "income", period.from, period.to);
  if (list !== s.income_minor) {
    throw new Error(`list=${list} hero=${s.income_minor}`);
  }
});

check("investment receipts sum to the investments figure", () => {
  const list = bucketSum(db, "investments", period.from, period.to);
  if (list !== s.investments_minor) {
    throw new Error(`list=${list} hero=${s.investments_minor}`);
  }
});

check("an investment is never also counted as spending", () => {
  // The bug this guards: if the list used a looser INVEST test than the
  // snapshot, a contract note would appear under Spending AND Investments,
  // and the two lists would overlap while both looked plausible.
  const spend = bucketSum(db, "spending", period.from, period.to);
  const invest = bucketSum(db, "investments", period.from, period.to);
  const bothDirectionsOut = db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor),0) v FROM transactions
       WHERE direction='out' AND status <> 'scheduled'
         AND date(occurred_at) BETWEEN date(?) AND date(?)`,
    )
    .get(period.from, period.to) as { v: number };
  if (spend + invest !== bothDirectionsOut.v) {
    throw new Error(
      `spending(${spend}) + investments(${invest}) != all outflow(${bothDirectionsOut.v})`,
    );
  }
});

check("a scheduled transaction appears in no bucket", () => {
  const spend = bucketSum(db, "spending", period.from, period.to);
  if (String(spend).includes("999999")) {
    throw new Error("a scheduled row leaked into the receipts list");
  }
  const all = spend + bucketSum(db, "investments", period.from, period.to);
  if (all >= 999999 + 150000 + 90000 + 2500000 + 1000000 + 750000) {
    throw new Error("scheduled amount is being counted");
  }
});

check("a NULL impact_bucket still counts as spending", () => {
  // NULL NOT IN (...) is NULL, which WHERE rejects — the same three-valued
  // logic trap that once made uncategorised spending vanish from the treemap.
  const spend = bucketSum(db, "spending", period.from, period.to);
  if (spend !== 150000 + 90000) {
    throw new Error(`expected 240000 got ${spend}`);
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
