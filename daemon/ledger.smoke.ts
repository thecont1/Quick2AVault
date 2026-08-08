/**
 * Entity resolution invariants — deterministic, no API calls.
 *   npx tsx daemon/ledger.smoke.ts
 *
 * These are the rules the whole ledger rests on. A regression here silently
 * corrupts balances rather than throwing, so they get an explicit test.
 */
import { DatabaseSync } from "node:sqlite";
import * as assert from "node:assert";

import { openDatabase } from "./schema.js";
import { resolveEntity, isPlausibleOwnedAccount, recordTransaction } from "./ledger.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";

const logger = createLogger("error");
const ports: Ports = {
  logger,
  clock: systemClock,
  paths: createPaths("/tmp/q2v-smoke-vault"),
  converter: { async toMarkdown() { return ""; } },
  bus: createEventBus(logger),
};

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
    failed++;
  }
}

function freshDb(): DatabaseSync {
  return openDatabase(":memory:");
}

console.log("\nEntity resolution invariants\n");

check("same name across kinds creates SEPARATE entities (the same-name-across-kinds rule)", () => {
  const db = freshDb();
  const merchant = resolveEntity(db, ports, "Demo Merchant Limited", "organisation");
  const wallet = resolveEntity(db, ports, "Demo Merchant Limited", "account");
  const equity = resolveEntity(db, ports, "Demo Merchant Limited", "instrument");
  assert.notStrictEqual(merchant, wallet, "merchant and account must differ");
  assert.notStrictEqual(merchant, equity, "merchant and instrument must differ");
  assert.notStrictEqual(wallet, equity, "account and instrument must differ");
  const n = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  assert.strictEqual(n, 3, `expected 3 entities, got ${n}`);
});

check("same name + same kind resolves to ONE entity", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Demo Merchant Limited", "organisation");
  const b = resolveEntity(db, ports, "demo merchant limited", "organisation");
  const c = resolveEntity(db, ports, "Demo Merchant Ltd.", "organisation");
  assert.strictEqual(a, b, "case-insensitive match failed");
  assert.strictEqual(a, c, "suffix-normalised match failed");
});

check("wallet named inconsistently resolves to ONE account", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Demo Money Wallet (demo@examplebank)", "account");
  const b = resolveEntity(db, ports, "Demo Money", "account");
  const c = resolveEntity(db, ports, "Demo Money Wallet", "account");
  assert.strictEqual(a, b, "'Demo Money' should merge into the wallet");
  assert.strictEqual(a, c, "'Demo Money Wallet' should merge into the wallet");
});

check("savings vs credit card at the SAME bank never merge", () => {
  const db = freshDb();
  const card = resolveEntity(db, ports, "Example Bank Credit Card ending 4242", "account");
  const savings = resolveEntity(db, ports, "Example Bank Savings Account", "account");
  assert.notStrictEqual(card, savings, "credit card merged into savings account");
});

check("two accounts at one bank with different digits never merge", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Example Bank Account ...9876", "account");
  const b = resolveEntity(db, ports, "Example Bank Account ...4242", "account");
  assert.notStrictEqual(a, b, "different account numbers merged");
});

check("distinct merchants sharing a word never merge", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Alpha Foods", "organisation");
  const b = resolveEntity(db, ports, "Beta Foods", "organisation");
  assert.notStrictEqual(a, b, "containment leaked into organisations");
});

check("bare 'wallet' does not swallow a named wallet", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Demo Money Wallet", "account");
  const b = resolveEntity(db, ports, "Other Wallet", "account");
  assert.notStrictEqual(a, b, "unrelated wallets merged");
});

// ── owned-account plausibility ─────────────────────────────────────────────
// NOTE: every string below is SYNTHETIC. Test fixtures must never carry real
// account numbers, card digits, tax IDs, employer or counterparty names — a
// public repo is the wrong place to learn that lesson.
check("real accounts are accepted", () => {
  for (const s of [
    "Example Bank Credit Card ending 4242",
    "Example Bank Savings Account ...9876",
    "Demo Money Wallet (demo@examplebank)",
    "Example Bank Account 00000000000000",
    "Cash",
  ]) {
    assert.ok(isPlausibleOwnedAccount(s), `should accept: ${s}`);
  }
});

check("counterparty ledgers are REJECTED as accounts", () => {
  // These SHAPES (not the real names) were invented as "accounts" on real
  // documents, turning a share sale or salary credit into a bogus transfer.
  for (const s of [
    "Client ledger balance with Example Broker Limited",
    "Client ledger/settlement account with Example Broker Limited",
    "Client trading/ledger account with Example Broker Limited",
    "Example Broker Limited (broker) - net amount payable by client",
    "Employer (Example Corp) payroll",
    "Sale proceeds of equity shares (Example Holdings Limited)",
    "Sale proceeds from equity trades net of purchases, brokerage, taxes and levies",
    "Card/online payment (pay online link)",
    "Third party online payment",
  ]) {
    assert.ok(!isPlausibleOwnedAccount(s), `should reject: ${s}`);
  }
});

// ── leg direction ───────────────────────────────────────────────────────────
// Every transaction used to DEBIT the source account regardless of direction,
// so a salary arriving in your bank was recorded as money leaving it. Any
// balance derived from legs drifted by twice the value of each inbound payment.

/** Minimal extraction for a transaction with one owned account. */
function extraction(direction: "in" | "out", opts: Record<string, unknown> = {}) {
  return {
    doc_type: "receipt",
    occurred_at: "2026-08-01",
    posted_at: null,
    amount_minor: 16_864_100,
    currency: "INR",
    direction,
    payment_rail: "neft",
    parties: [],
    reference_ids: {},
    counterparty_descriptor: direction === "in" ? "UNext Learning" : "Blue Tokai",
    source_of_funds_text: "HDFC Bank Savings 1234",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: direction === "in" ? "salary" : "eating_out",
    is_wallet_topup: false,
    confidence: 0.9,
    notes: null,
    holdings: null,
    ...opts,
  } as never;
}

function legsOf(db: DatabaseSync, txnId: string) {
  return db
    .prepare("SELECT leg, amount_minor FROM transaction_legs WHERE transaction_id=? ORDER BY leg")
    .all(txnId) as Array<{ leg: string; amount_minor: number }>;
}

/**
 * transaction_documents.document_id is a real FK, so a transaction needs a
 * document row to hang its evidence off. Columns listed explicitly — deriving
 * them from PRAGMA missed `id` (it has no NOT NULL flag as a PRIMARY KEY) and
 * produced rows that satisfied nothing.
 */
function seedDoc(db: DatabaseSync, id: string) {
  db.prepare(
    "INSERT INTO documents (id, sha256, original_filename, raw_path, source, received_at) VALUES (?,?,?,?,?,?)",
  ).run(id, `sha-${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, "test", "2026-08-01T00:00:00Z");
}

check("inbound money CREDITS the account I own", () => {
  const db = freshDb();
  seedDoc(db, "doc_in");
  const rec = recordTransaction(db, ports, "doc_in", extraction("in"));
  assert.ok(rec, "no transaction recorded");
  const legs = legsOf(db, rec.transaction_id);
  assert.strictEqual(legs.length, 1, "expected exactly one leg");
  assert.strictEqual(legs[0].leg, "credit", "salary arriving must CREDIT my account, not debit it");
});

check("outbound money DEBITS the account I own", () => {
  const db = freshDb();
  seedDoc(db, "doc_out");
  const rec = recordTransaction(db, ports, "doc_out", extraction("out"));
  assert.ok(rec);
  const legs = legsOf(db, rec.transaction_id);
  assert.strictEqual(legs.length, 1);
  assert.strictEqual(legs[0].leg, "debit", "a purchase must DEBIT my account");
});

check("a wallet top-up debits source and credits destination", () => {
  const db = freshDb();
  seedDoc(db, "doc_xfer");
  const rec = recordTransaction(
    db,
    ports,
    "doc_xfer",
    extraction("out", {
      is_wallet_topup: true,
      destination_of_funds_text: "Swiggy Money Wallet",
      category_hint: "transfer",
    }),
  );
  assert.ok(rec);
  const legs = legsOf(db, rec.transaction_id);
  assert.strictEqual(legs.length, 2, "a transfer needs both legs");
  assert.deepStrictEqual(legs.map((l) => l.leg).sort(), ["credit", "debit"]);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
