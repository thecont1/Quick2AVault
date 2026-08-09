/**
 * Source-currency acceptance tests (work order 05 §A.4).
 *   npx tsx daemon/currency.smoke.ts
 *
 * The live regression: a USD invoice (59785 minor, "USD") displayed as ₹597.
 * The daemon stored USD correctly — the leak was every layer that defaulted
 * to INR or dropped the currency on the way to the UI. These tests pin the
 * contract end to end: extraction -> ledger -> resolver -> API payloads.
 */
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "./schema.js";
import { createApi, snapshot } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { recordTransaction } from "./ledger.js";
import { findMatches } from "./matcher.js";
import { resolveTransaction, writeClaim } from "./claims.js";
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

function testPorts(vault: string): Ports {
  const logger = createLogger("error");
  return {
    logger,
    clock: systemClock,
    paths: createPaths(vault),
    converter: { async toMarkdown() { throw new Error("not used"); } },
    bus: createEventBus(logger),
  };
}

function seedDoc(db: DatabaseSync, id: string, extraction?: Partial<ExtractionResult>): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at, extraction_json)
     VALUES (?,?,?,?,'merchant_invoice',?,?)`,
  ).run(
    id,
    `sha_${id}`,
    `${id}.pdf`,
    `/tmp/${id}.pdf`,
    "2026-08-09T00:00:00.000Z",
    extraction ? JSON.stringify(extraction) : null,
  );
}

/** The redacted PetaSight-shaped USD invoice extraction (work order 05 §A.1). */
function usdInvoice(): ExtractionResult {
  return {
    doc_type: "merchant_invoice",
    occurred_at: "2026-05-29",
    posted_at: "2026-06-28",
    amount_minor: 59785,
    currency: "USD",
    direction: "in",
    payment_rail: "netbanking",
    parties: [
      { name: "Mahesh Shantaram", kind: "person", role: "owner" },
      { name: "PetaSight Inc.", kind: "organisation", role: "counterparty" },
    ],
    reference_ids: { invoice_no: "INV/2026-27/03" },
    counterparty_descriptor: "PetaSight Inc.",
    source_of_funds_text: "PetaSight Inc. (client payment)",
    destination_of_funds_text: null,
    purpose_text: "Consulting services and reimbursement",
    category_hint: "consulting_income",
    is_wallet_topup: false,
    confidence: 0.85,
    notes: null,
  };
}

console.log("── §A.2: the ledger stores the SOURCE currency, never an assumed one");

check("a USD extraction is stored as USD with the exact minor amount", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-1");
  seedDoc(db, "doc_usd");
  const r = recordTransaction(db, ports, "doc_usd", usdInvoice());
  assert.ok(r, "transaction recorded");
  const t = db.prepare("SELECT amount_minor, currency FROM transactions WHERE id=?").get(r!.transaction_id) as {
    amount_minor: number;
    currency: string | null;
  };
  assert.equal(t.currency, "USD");
  assert.equal(t.amount_minor, 59785);
});

check("a missing currency is stored as NULL — never silently INR", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-2");
  seedDoc(db, "doc_nocur");
  const x = { ...usdInvoice(), currency: "" };
  const r = recordTransaction(db, ports, "doc_nocur", x);
  const t = db.prepare("SELECT currency FROM transactions WHERE id=?").get(r!.transaction_id) as {
    currency: string | null;
  };
  assert.equal(t.currency, null);
});

check("an INR extraction still stores INR", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-3");
  seedDoc(db, "doc_inr");
  const r = recordTransaction(db, ports, "doc_inr", { ...usdInvoice(), currency: "INR", amount_minor: 64372 });
  const t = db.prepare("SELECT currency FROM transactions WHERE id=?").get(r!.transaction_id) as { currency: string };
  assert.equal(t.currency, "INR");
});

console.log("\n── §A.2: the matcher respects currency");

check("two KNOWN but different currencies never match", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-4");
  seedDoc(db, "doc_usd");
  recordTransaction(db, ports, "doc_usd", usdInvoice());
  // An INR document for the same minor amount must NOT match the USD txn.
  const hits = findMatches(db, { ...usdInvoice(), currency: "INR" }, "doc_new");
  assert.equal(hits.length, 0);
});

check("a missing-currency document may still match (amount+date carry the score)", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-5");
  seedDoc(db, "doc_usd");
  recordTransaction(db, ports, "doc_usd", usdInvoice());
  const hits = findMatches(db, { ...usdInvoice(), currency: "" }, "doc_new");
  assert.equal(hits.length, 1);
});

console.log("\n── §A.2: the resolver carries currency WITH the amount");

check("currency follows the amount-winning document (invoice says USD)", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-6");
  seedDoc(db, "doc_inv", { amount_minor: 59785, currency: "USD", occurred_at: "2026-05-29" });
  // A transaction born wrong (the regression's shape: INR default).
  db.prepare(
    `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, created_at)
     VALUES ('txn_1','2026-05-29','FY 2026-27',59785,'INR','in','evidenced',?)`,
  ).run(ports.clock.isoNow());
  db.prepare(
    `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_at)
     VALUES ('txn_1','doc_inv','merchant_invoice',?)`,
  ).run(ports.clock.isoNow());
  const r = resolveTransaction(db, ports, "txn_1");
  assert.ok(r?.changed.includes("currency"), `expected currency change, got ${JSON.stringify(r?.changed)}`);
  const t = db.prepare("SELECT currency FROM transactions WHERE id='txn_1'").get() as { currency: string };
  assert.equal(t.currency, "USD");
});

check("a user claim on the transaction currency outranks the document", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-7");
  seedDoc(db, "doc_inv", { amount_minor: 59785, currency: "USD", occurred_at: "2026-05-29" });
  db.prepare(
    `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, created_at)
     VALUES ('txn_1','2026-05-29','FY 2026-27',59785,'USD','in','evidenced',?)`,
  ).run(ports.clock.isoNow());
  db.prepare(
    `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_at)
     VALUES ('txn_1','doc_inv','merchant_invoice',?)`,
  ).run(ports.clock.isoNow());
  writeClaim(db, ports, {
    subject: "transaction",
    subjectId: "txn_1",
    field: "currency",
    value: "EUR",
    source: "user",
  });
  resolveTransaction(db, ports, "txn_1");
  const t = db.prepare("SELECT currency FROM transactions WHERE id='txn_1'").get() as { currency: string };
  assert.equal(t.currency, "EUR");
});

console.log("\n── §A.2: aggregates are home-currency, foreign amounts stay visible");

check("a USD transaction is excluded from INR totals and listed as unconverted", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-8");
  seedDoc(db, "doc_usd");
  recordTransaction(db, ports, "doc_usd", usdInvoice());
  seedDoc(db, "doc_inr");
  recordTransaction(db, ports, "doc_inr", { ...usdInvoice(), currency: "INR", amount_minor: 64372, direction: "in" });
  const s = snapshot(db, { from: null, to: null, label: "All", key: "all" }, "INR");
  assert.equal(s.income_minor, 64372, "only the INR income counts");
  const un = s.unconverted.income.find((u: { currency: string | null }) => u.currency === "USD");
  assert.ok(un, "USD remainder is reported");
  assert.equal(un.amount_minor, 59785);
  assert.equal(s.currency, "INR");
});

check("a converted transaction counts at home_amount_minor, not the source figure", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-9");
  seedDoc(db, "doc_usd");
  const id = recordTransaction(db, ports, "doc_usd", usdInvoice())!.transaction_id;
  db.prepare(
    "UPDATE transactions SET home_amount_minor=?, fx_rate=?, fx_date=?, fx_source=? WHERE id=?",
  ).run(5020800, 84.0, "2026-05-29", "user", id);
  const s = snapshot(db, { from: null, to: null, label: "All", key: "all" }, "INR");
  assert.equal(s.income_minor, 5020800);
  assert.equal(s.unconverted.income.length, 0);
  // ...and the SOURCE figure is untouched.
  const t = db.prepare("SELECT amount_minor, currency FROM transactions WHERE id=?").get(id) as {
    amount_minor: number;
    currency: string;
  };
  assert.equal(t.amount_minor, 59785);
  assert.equal(t.currency, "USD");
});

check("a currency-uncertain transaction is excluded from totals, not assumed INR", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-curr-10");
  seedDoc(db, "doc_nocur");
  recordTransaction(db, ports, "doc_nocur", { ...usdInvoice(), currency: "" });
  const s = snapshot(db, { from: null, to: null, label: "All", key: "all" }, "INR");
  assert.equal(s.income_minor, 0);
  const un = s.unconverted.income.find((u: { currency: string | null }) => u.currency === null);
  assert.ok(un, "the unknown-currency remainder is reported");
});

// ── HTTP surface: /v1/reviews and /v1/documents/:id/detail ─────────────────
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-currency-api-"));
const db = openDatabase(":memory:");
const ports = testPorts(vault);

seedDoc(db, "doc_usd_api", {
  amount_minor: 59785,
  currency: "USD",
  occurred_at: "2026-05-29",
  posted_at: "2026-06-28",
  reference_ids: { invoice_no: "INV/2026-27/03" },
  counterparty_descriptor: "PetaSight Inc.",
  parties: [{ name: "Mahesh Shantaram", kind: "person", role: "owner" }],
});
const txnId = recordTransaction(db, ports, "doc_usd_api", usdInvoice())!.transaction_id;

const TOKEN = "test-token-currency";
const PORT = 47936;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault });
await api.listen();
const hdr = { Authorization: `Bearer ${TOKEN}` };
async function get(p: string) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { headers: hdr });
  const body = await r.text();
  return { status: r.status, json: body ? JSON.parse(body) : null };
}

console.log("\n── §A.4: API payloads carry source currency");

const txns = await get("/v1/transactions");
const txnRow = txns.json?.transactions?.find((r: { id: string }) => r.id === txnId);
check("/v1/transactions returns the USD source currency with the amount", () => {
  assert.equal(txnRow?.currency, "USD");
  assert.equal(txnRow?.amount_minor, 59785);
});

const reviews = await get("/v1/reviews");
const reviewItem = reviews.json?.reviews?.find(
  (r: { transaction_id?: string }) => r.transaction_id === txnId,
);
check("/v1/reviews single-evidence items carry currency", () => {
  assert.equal(reviewItem?.currency, "USD", JSON.stringify(reviewItem));
});

const detail = await get("/v1/documents/doc_usd_api/detail");
check("document detail returns 200", () => assert.equal(detail.status, 200));
check("evidence summary amount + currency agree with the extraction", () => {
  assert.equal(detail.json?.effective?.amount_minor?.value, "59785");
  assert.equal(detail.json?.effective?.currency?.value, "USD");
});
check("invoice number is visible in the summary", () => {
  assert.equal(detail.json?.effective?.reference_ids?.invoice_no, "INV/2026-27/03");
});
check("the resolved person party is listed", () => {
  assert.ok(detail.json?.parties?.some((pp: { kind: string }) => pp.kind === "person"));
});
check("the linked transaction carries currency and fx fields", () => {
  assert.equal(detail.json?.transactions?.[0]?.currency, "USD");
  assert.ok("home_amount_minor" in (detail.json?.transactions?.[0] ?? {}));
});

console.log(`\n${pass} passed, ${fail} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
