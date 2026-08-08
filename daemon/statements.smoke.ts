/**
 * Statement import acceptance tests (work order 04 §A.7).
 *   npx tsx daemon/statements.smoke.ts
 *
 * A synthetic 12-line statement with known opening/closing balances —
 * deterministic parsing, balance integrity, idempotent re-import, overlap
 * dedup, settlement-vs-gap reconciliation, chunking-safety (100 lines), and
 * an FX line. No AI calls: this is the "deterministic first" half of the
 * feature working entirely on its own.
 */
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import {
  parseStatementMarkdown,
  checkBalanceIntegrity,
  stageStatementLines,
  reconcileStatement,
  lineIdempotencyKey,
} from "./statements.js";
import { resolveEntity, recordTransaction } from "./ledger.js";
import type { ExtractionResult } from "./extraction-contract.js";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

function freshDb(): DatabaseSync {
  return openDatabase(":memory:");
}
function testPorts(): Ports {
  const logger = createLogger("error");
  return {
    logger,
    clock: systemClock,
    paths: createPaths("/tmp/q2v-stmt-test"),
    converter: { async toMarkdown() { throw new Error("not used by these tests"); } },
    bus: createEventBus(logger),
  };
}
function seedDoc(db: DatabaseSync, id: string, docType = "bank_statement"): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, docType, "2026-08-09T00:00:00.000Z");
}

// A realistic 12-line synthetic bank statement. Opening 1,00,000.00, twelve
// transactions, closing exactly reflects the sum — the balance column is
// deliberately present too so the running-balance continuity is checkable.
const FIXTURE_HEADER = `
# Example Bank — Savings Statement

Account Number: XXXX-XXXX-9876
Statement Period: 01-07-2026 to 31-07-2026
Opening Balance: Rs. 1,00,000.00
Closing Balance: Rs. 1,35,220.21
`;

function fixtureTable(rows: string[][]): string {
  const header = "| Date | Narration | Debit | Credit | Balance |";
  const sep = "|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

function fixtureTableWithRef(rows: string[][]): string {
  const header = "| Date | Narration | Debit | Credit | Balance | Ref No |";
  const sep = "|---|---|---|---|---|---|";
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

const TWELVE_LINES: string[][] = [
  ["01-07-2026", "SWIGGY BLR 080", "643.72", "", "99356.28"],
  ["02-07-2026", "SALARY CREDIT ACME CORP", "", "250000.00", "349356.28"],
  ["03-07-2026", "AMAZON PAY INDIA", "1200.00", "", "348156.28"],
  ["04-07-2026", "ATM WDL ANDHERI", "5000.00", "", "343156.28"],
  ["05-07-2026", "NEFT RENT PAYMENT", "45000.00", "", "298156.28"],
  ["07-07-2026", "ZOMATO ORDER", "899.50", "", "297256.78"],
  ["10-07-2026", "MUTUAL FUND SIP HDFC", "10000.00", "", "287256.78"],
  ["12-07-2026", "ELECTRICITY BILL BESCOM", "3450.00", "", "283806.78"],
  ["15-07-2026", "REFUND AMAZON", "", "1200.00", "285006.78"],
  ["18-07-2026", "CREDIT CARD BILL PAYMENT", "150000.00", "", "135006.78"],
  ["22-07-2026", "INTEREST CREDIT", "", "612.43", "135619.21"],
  ["28-07-2026", "MOBILE RECHARGE JIO", "399.00", "", "135220.21"],
];

console.log("── §A.7 acceptance: 12-line fixture, known balances");

check("all 12 lines parse; column mapping is confident", () => {
  const md = FIXTURE_HEADER + "\n" + fixtureTable(TWELVE_LINES);
  const parsed = parseStatementMarkdown(md);
  assert.equal(parsed.column_mapping_confident, true);
  assert.equal(parsed.lines.length, 12, "no truncation");
  assert.equal(parsed.header.account_ref, "9876");
  assert.equal(parsed.header.period_from, "2026-07-01");
  assert.equal(parsed.header.period_to, "2026-07-31");
  assert.equal(parsed.header.opening_balance_minor, 10000000);
  assert.equal(parsed.header.closing_balance_minor, 13522021);
});

check("amounts, dates and directions parse correctly for representative rows", () => {
  const md = FIXTURE_HEADER + "\n" + fixtureTable(TWELVE_LINES);
  const parsed = parseStatementMarkdown(md);
  const swiggy = parsed.lines[0];
  assert.equal(swiggy.occurred_at, "2026-07-01");
  assert.equal(swiggy.amount_minor, 64372);
  assert.equal(swiggy.direction, "out");
  assert.equal(swiggy.raw_descriptor, "SWIGGY BLR 080");

  const salary = parsed.lines[1];
  assert.equal(salary.direction, "in");
  assert.equal(salary.amount_minor, 25000000);
});

check("balance integrity: this fixture's sum matches closing minus opening exactly", () => {
  const md = FIXTURE_HEADER + "\n" + fixtureTable(TWELVE_LINES);
  const parsed = parseStatementMarkdown(md);
  const integrity = checkBalanceIntegrity(parsed.header, parsed.lines);
  assert.ok(integrity, "both balances present -> integrity check must run");
  assert.equal(integrity!.ok, true, `expected ${integrity!.expected}, got ${integrity!.actual}`);
});

check("a deliberately corrupted fixture (one line off by 1 rupee) FAILS integrity, not trusted silently", () => {
  const corrupted = TWELVE_LINES.map((r) => [...r]);
  corrupted[3][2] = "5001.00"; // ATM withdrawal off by a rupee
  const md = FIXTURE_HEADER + "\n" + fixtureTable(corrupted);
  const parsed = parseStatementMarkdown(md);
  const integrity = checkBalanceIntegrity(parsed.header, parsed.lines);
  assert.ok(integrity);
  assert.equal(integrity!.ok, false, "a real discrepancy must be flagged, not silently accepted");
  assert.equal(integrity!.delta, -100, "delta is in minor units: 1 rupee = 100");
});

console.log("\n── §A.7 acceptance: staging is idempotent");

check("re-importing the identical statement stages nothing new the second time", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  const md = FIXTURE_HEADER + "\n" + fixtureTable(TWELVE_LINES);
  const parsed = parseStatementMarkdown(md);
  const acct = resolveEntity(db, ports, "Example Bank Savings ...9876", "account");

  const first = stageStatementLines(db, ports, "doc_1", parsed, acct);
  assert.equal(first.staged, 12);
  assert.equal(first.already_present, 0);

  const second = stageStatementLines(db, ports, "doc_1", parsed, acct);
  assert.equal(second.staged, 0, "re-import must stage nothing new");
  assert.equal(second.already_present, 12);

  const total = (db.prepare("SELECT COUNT(*) n FROM statement_lines").get() as { n: number }).n;
  assert.equal(total, 12, "no duplicate rows in the table itself");
});

check("overlapping statements (shared lines from adjacent months) dedupe on the shared lines only", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_july");
  seedDoc(db, "doc_august");
  const acct = resolveEntity(db, ports, "Example Bank Savings ...9876", "account");

  const julyParsed = parseStatementMarkdown(FIXTURE_HEADER + "\n" + fixtureTable(TWELVE_LINES));
  stageStatementLines(db, ports, "doc_july", julyParsed, acct);

  // August's statement OVERLAPS on the last 2 July lines (a common real-world
  // case: banks often include a few trailing days of the prior period) plus
  // 3 genuinely new lines.
  const augustRows = [
    ...TWELVE_LINES.slice(10), // the last 2 lines, shared with July
    ["01-08-2026", "SALARY CREDIT ACME CORP", "", "250000.00", "385220.21"],
    ["03-08-2026", "SWIGGY BLR 080", "550.00", "", "384670.21"],
    ["05-08-2026", "GYM MEMBERSHIP CULTFIT", "1999.00", "", "382671.21"],
  ];
  const augustParsed = parseStatementMarkdown(fixtureTable(augustRows));
  const result = stageStatementLines(db, ports, "doc_august", augustParsed, acct);

  assert.equal(result.staged, 3, "only the 3 genuinely new lines are staged");
  assert.equal(result.already_present, 2, "the 2 overlapping lines are recognised, not duplicated");

  const total = (db.prepare("SELECT COUNT(*) n FROM statement_lines").get() as { n: number }).n;
  assert.equal(total, 15, "12 (july) + 3 new (august) = 15, never 17");
});

check("idempotency key is scoped per account: identical amount+date+descriptor on a DIFFERENT account does not collide", () => {
  const a = lineIdempotencyKey("ent_acct_a", "2026-07-01", 64372, "out", "SWIGGY BLR 080");
  const b = lineIdempotencyKey("ent_acct_b", "2026-07-01", 64372, "out", "SWIGGY BLR 080");
  assert.notEqual(a, b, "same event on two different accounts must not be treated as the same line");
});

console.log("\n── §A.7 acceptance: reconciliation — settle, gap, no double-count");

check("a line matching an existing invoice-only transaction on amount+date+descriptor reaches the REVIEW band (0.8), not auto-link", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_invoice", "merchant_invoice");
  seedDoc(db, "doc_stmt");

  // An invoice-only transaction, exactly the awaiting_settlement case: a
  // merchant invoice was seen, but no bank confirmation yet.
  const invoiceExtraction: ExtractionResult = {
    doc_type: "merchant_invoice",
    occurred_at: "2026-07-01",
    posted_at: null,
    amount_minor: 64372,
    currency: "INR",
    direction: "out",
    payment_rail: "card",
    parties: [{ name: "Swiggy Limited", kind: "organisation", role: "counterparty" }],
    reference_ids: {},
    counterparty_descriptor: "SWIGGY BLR 080",
    source_of_funds_text: null,
    destination_of_funds_text: null,
    purpose_text: "food delivery",
    category_hint: "food_delivery",
    is_wallet_topup: false,
    confidence: 0.95,
    notes: null,
  };
  const rec = recordTransaction(db, ports, "doc_invoice", invoiceExtraction);
  assert.ok(rec, "invoice-only transaction recorded");

  const md = fixtureTable([TWELVE_LINES[0]]); // just the Swiggy line
  const parsed = parseStatementMarkdown(md);
  const acct = resolveEntity(db, ports, "Example Bank Credit Card ending 4242", "account");
  stageStatementLines(db, ports, "doc_stmt", parsed, acct);

  const totals = reconcileStatement(db, ports, "doc_stmt");
  // Amount + date + descriptor overlap, with NO shared reference id, is
  // exactly the matcher's REVIEW band (0.4 amount + 0.25 date + 0.15
  // descriptor = 0.8 — verified directly against matcher.ts's own scoring).
  // Real bank/card statements rarely carry the merchant's own invoice number,
  // so this is the realistic case, not the exception.
  assert.equal(totals.review, 1, "ambiguous match without a shared reference id goes to review, not auto-link");
  assert.equal(totals.linked, 0, "must NOT silently auto-link on descriptor+amount+date alone");
  assert.equal(totals.created, 0, "must NOT create a duplicate transaction either — it stays pending for review");

  const txnCount = (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
  assert.equal(txnCount, 1, "one transaction total — the review candidate, not a second one");

  const line = db
    .prepare("SELECT status FROM statement_lines WHERE document_id='doc_stmt'")
    .get() as { status: string };
  assert.equal(line.status, "pending", "left pending for a human to confirm via the review queue");
});

check("a line sharing a reference id with an existing invoice-only transaction crosses AUTO_LINK and settles it", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_invoice", "merchant_invoice");
  seedDoc(db, "doc_stmt");

  const invoiceExtraction: ExtractionResult = {
    doc_type: "merchant_invoice",
    occurred_at: "2026-07-01",
    posted_at: null,
    amount_minor: 64372,
    currency: "INR",
    direction: "out",
    payment_rail: "card",
    parties: [{ name: "Swiggy Limited", kind: "organisation", role: "counterparty" }],
    reference_ids: { approval_code: "AUTH998877" },
    counterparty_descriptor: "SWIGGY BLR 080",
    source_of_funds_text: null,
    destination_of_funds_text: null,
    purpose_text: "food delivery",
    category_hint: "food_delivery",
    is_wallet_topup: false,
    confidence: 0.95,
    notes: null,
  };
  const rec = recordTransaction(db, ports, "doc_invoice", invoiceExtraction);
  assert.ok(rec);
  // recordTransaction() links transaction_documents but does not itself write
  // documents.extraction_json — that happens in runAnalyseJob (pipeline.ts)
  // as part of the real per-document flow. matcher.ts's shared-reference-id
  // check reads extraction_json off the DOCUMENT, so it must be present here
  // too, exactly as it would be for a real analysed invoice.
  db.prepare("UPDATE documents SET extraction_json=? WHERE id='doc_invoice'").run(
    JSON.stringify(invoiceExtraction),
  );

  // The statement itself prints the SAME code under its own "Ref No" column
  // — the realistic case for a card statement/RRN or NEFT/UTR.
  const md = fixtureTableWithRef([[...TWELVE_LINES[0], "AUTH998877"]]);
  const parsed = parseStatementMarkdown(md);
  assert.equal(parsed.lines[0].reference_id, "AUTH998877", "the reference column must be read");

  const acct = resolveEntity(db, ports, "Example Bank Credit Card ending 4242", "account");
  stageStatementLines(db, ports, "doc_stmt", parsed, acct);

  const totals = reconcileStatement(db, ports, "doc_stmt");
  assert.equal(totals.linked, 1, "a shared reference id crosses AUTO_LINK — settles the existing invoice");
  assert.equal(totals.created, 0, "must NOT create a second transaction for the same rupee");

  const txnCount = (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
  assert.equal(txnCount, 1, "one transaction total — many documents, one rupee");

  const line = db
    .prepare("SELECT status, transaction_id FROM statement_lines WHERE document_id='doc_stmt'")
    .get() as { status: string; transaction_id: string };
  assert.equal(line.status, "linked");
  assert.equal(line.transaction_id, rec!.transaction_id);
});

check("a line with NO existing invoice creates a no_invoice transaction — the gap report", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_stmt");

  // Nothing recorded yet. This line has no invoice on file anywhere.
  const md = fixtureTable([["09-07-2026", "UNKNOWN MERCHANT XYZ", "1500.00", "", "0.00"]]);
  const parsed = parseStatementMarkdown(md);
  const acct = resolveEntity(db, ports, "Example Bank Savings ...9876", "account");
  stageStatementLines(db, ports, "doc_stmt", parsed, acct);

  const totals = reconcileStatement(db, ports, "doc_stmt");
  assert.equal(totals.created, 1, "no match anywhere -> a new transaction, this is the gap");
  assert.equal(totals.linked, 0);

  const txn = db.prepare("SELECT status, amount_minor FROM transactions").get() as {
    status: string;
    amount_minor: number;
  };
  assert.equal(txn.status, "no_invoice", "flagged as a gap, not silently marked evidenced");
  assert.equal(txn.amount_minor, 150000);
});

console.log("\n── §A.7 acceptance: 100-line statement, no truncation");

check("a 100-line statement stages all 100 lines — the chunking-safety assertion", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_big");
  const acct = resolveEntity(db, ports, "Example Bank Savings ...9876", "account");

  const rows: string[][] = [];
  for (let i = 0; i < 100; i++) {
    const day = String((i % 28) + 1).padStart(2, "0");
    rows.push([`${day}-07-2026`, `MERCHANT ${i}`, `${(100 + i).toFixed(2)}`, "", "0.00"]);
  }
  const md = fixtureTable(rows);
  const parsed = parseStatementMarkdown(md);
  assert.equal(parsed.lines.length, 100, "the parser itself must not truncate — this is the array-drop bug, restated");

  const result = stageStatementLines(db, ports, "doc_big", parsed, acct);
  assert.equal(result.staged, 100, "every line reaches the database, none silently dropped");

  const total = (db.prepare("SELECT COUNT(*) n FROM statement_lines WHERE document_id='doc_big'").get() as {
    n: number;
  }).n;
  assert.equal(total, 100);
});

console.log("\n── §A.7 acceptance: FX line records both currencies");

check("a foreign-currency line keeps the original amount+currency alongside the converted figure", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_fx");
  const acct = resolveEntity(db, ports, "Example Bank Credit Card ending 4242", "account");

  const parsed = parseStatementMarkdown(fixtureTable([["11-07-2026", "AWS SINGAPORE FX MARKUP", "830.00", "", "0.00"]]));
  // Attach FX detail the way the AI-assisted classification path would —
  // parseStatementMarkdown() cannot read a printed "USD 10.00" sub-line
  // deterministically without a documented, bank-specific format, so this
  // simulates the enrichment step rather than inventing table syntax.
  parsed.lines[0].fx_original = { amount_minor: 1000, currency: "USD" };

  stageStatementLines(db, ports, "doc_fx", parsed, acct);
  const row = db
    .prepare("SELECT amount_minor, currency, fx_original_json FROM statement_lines WHERE document_id='doc_fx'")
    .get() as { amount_minor: number; currency: string; fx_original_json: string };

  assert.equal(row.amount_minor, 83000, "the converted INR figure is what the ledger uses");
  assert.equal(row.currency, "INR");
  const fx = JSON.parse(row.fx_original_json) as { amount_minor: number; currency: string };
  assert.equal(fx.currency, "USD");
  assert.equal(fx.amount_minor, 1000, "original USD amount is preserved, not lost in conversion");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
