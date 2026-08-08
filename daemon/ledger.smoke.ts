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
import { resolveEntity } from "./ledger.js";
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

check("same name across kinds creates SEPARATE entities (the Swiggy rule)", () => {
  const db = freshDb();
  const merchant = resolveEntity(db, ports, "Swiggy Limited", "organisation");
  const wallet = resolveEntity(db, ports, "Swiggy Limited", "account");
  const equity = resolveEntity(db, ports, "Swiggy Limited", "instrument");
  assert.notStrictEqual(merchant, wallet, "merchant and account must differ");
  assert.notStrictEqual(merchant, equity, "merchant and instrument must differ");
  assert.notStrictEqual(wallet, equity, "account and instrument must differ");
  const n = (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n;
  assert.strictEqual(n, 3, `expected 3 entities, got ${n}`);
});

check("same name + same kind resolves to ONE entity", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Swiggy Limited", "organisation");
  const b = resolveEntity(db, ports, "swiggy limited", "organisation");
  const c = resolveEntity(db, ports, "Swiggy Ltd.", "organisation");
  assert.strictEqual(a, b, "case-insensitive match failed");
  assert.strictEqual(a, c, "suffix-normalised match failed");
});

check("wallet named inconsistently resolves to ONE account", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Swiggy Money Wallet (swiggy@axisbank)", "account");
  const b = resolveEntity(db, ports, "Swiggy Money", "account");
  const c = resolveEntity(db, ports, "Swiggy Money Wallet", "account");
  assert.strictEqual(a, b, "'Swiggy Money' should merge into the wallet");
  assert.strictEqual(a, c, "'Swiggy Money Wallet' should merge into the wallet");
});

check("savings vs credit card at the SAME bank never merge", () => {
  const db = freshDb();
  const card = resolveEntity(db, ports, "HDFC Bank Credit Card ending 1668", "account");
  const savings = resolveEntity(db, ports, "HDFC Bank Savings Account", "account");
  assert.notStrictEqual(card, savings, "credit card merged into savings account");
});

check("two accounts at one bank with different digits never merge", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "HDFC Bank Account ...1767", "account");
  const b = resolveEntity(db, ports, "HDFC Bank Account ...1668", "account");
  assert.notStrictEqual(a, b, "different account numbers merged");
});

check("distinct merchants sharing a word never merge", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Meghana Foods", "organisation");
  const b = resolveEntity(db, ports, "Rameshwaram Foods", "organisation");
  assert.notStrictEqual(a, b, "containment leaked into organisations");
});

check("bare 'wallet' does not swallow a named wallet", () => {
  const db = freshDb();
  const a = resolveEntity(db, ports, "Swiggy Money Wallet", "account");
  const b = resolveEntity(db, ports, "Paytm Wallet", "account");
  assert.notStrictEqual(a, b, "unrelated wallets merged");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
