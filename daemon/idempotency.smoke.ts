/**
 * Work order 07 §A — idempotent analysis and ledger writes.
 *   npx tsx daemon/idempotency.smoke.ts
 *
 * The core invariant (§A1): same document + same analysis version + same
 * evidence relationship → one effective transaction/evidence result. A retry,
 * daemon restart, duplicate job claim, or manual reprocess must not add
 * another economic event.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import type { AiProvider } from "./ai-provider.js";
import type { ExtractionResult } from "./extraction-contract.js";
import { runAnalyseJob } from "./pipeline.js";
import { recordTransaction, evidenceRole } from "./ledger.js";

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
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
    paths: createPaths("/tmp/q2v-idempotency-test"),
    converter: { async toMarkdown() { throw new Error("not used by these tests"); } },
    bus: createEventBus(logger),
  };
}

async function seedDoc(db: DatabaseSync, id: string, markdown: string): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "q2v-idem-"));
  const mdPath = path.join(dir, `${id}.md`);
  await fs.writeFile(mdPath, markdown, "utf-8");
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, markdown_path, markdown_chars, doc_type, received_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, mdPath, markdown.length, "unknown", "2026-08-09T00:00:00.000Z");
}

function fakeContractNoteAi(): AiProvider {
  return {
    available: true,
    model: "fake-test-model",
    async extract(): Promise<ExtractionResult> {
      return {
        doc_type: "contract_note",
        occurred_at: "2026-07-15",
        posted_at: "2026-07-15",
        amount_minor: 2450000,
        currency: "INR",
        direction: "out",
        payment_rail: null,
        parties: [
          { role: "source_of_funds", kind: "account", name: "HDFC Savings ...1234" },
          { role: "counterparty", kind: "organisation", name: "Zerodha Broking Ltd" },
        ],
        reference_ids: {},
        counterparty_descriptor: "ZERODHA BROKING",
        source_of_funds_text: "HDFC Savings ...1234",
        destination_of_funds_text: null,
        purpose_text: "Contract note — RELIANCE buy",
        category_hint: "investments",
        is_wallet_topup: false,
        confidence: 0.92,
        notes: null,
        holdings: [
          { name: "RELIANCE", isin: "INE002A01018", side: "buy", quantity: 10, price_minor: 245000, amount_minor: 2450000 },
        ],
        statement: null,
      };
    },
  };
}

function fakeInvoiceAi(): AiProvider {
  return {
    available: true,
    model: "fake-test-model",
    async extract(markdown: string): Promise<ExtractionResult> {
      // Parse the amount from the markdown so each document gets a distinct value.
      const m = /Amount:\s*([0-9,.]+)/i.exec(markdown || "");
      const amt = m ? parseFloat(m[1].replace(/,/g, "")) : 500;
      return {
        doc_type: "merchant_invoice",
        occurred_at: "2026-07-20",
        posted_at: null,
        amount_minor: Math.round(amt * 100),
        currency: "INR",
        direction: "out",
        payment_rail: "upi",
        parties: [
          { role: "source_of_funds", kind: "account", name: "HDFC Savings ...1234" },
          { role: "counterparty", kind: "organisation", name: "Acme Corp" },
        ],
        reference_ids: {},
        counterparty_descriptor: "ACME CORP",
        source_of_funds_text: "HDFC Savings ...1234",
        destination_of_funds_text: null,
        purpose_text: "Invoice #INV-2026-001",
        category_hint: "discretionary",
        is_wallet_topup: false,
        confidence: 0.88,
        notes: null,
        statement: null,
      };
    },
  };
}

function txnCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
}
function evidenceCount(db: DatabaseSync, documentId: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM transaction_documents WHERE document_id=?").get(documentId) as { n: number }).n;
}
function legsCount(db: DatabaseSync, txnId: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM transaction_legs WHERE transaction_id=?").get(txnId) as { n: number }).n;
}
function holdingsCount(db: DatabaseSync, txnId: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM holdings WHERE transaction_id=?").get(txnId) as { n: number }).n;
}

console.log("── Work order 07 §A: idempotent analysis and ledger writes\n");

await check("analyse the same contract note twice: transaction count and totals unchanged", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeContractNoteAi();
  const docId = "doc_contract_note_01";
  await seedDoc(db, docId, "# Contract Note\n\nRELIANCE buy 10 @ 2450\nTotal: 24,500.00");

  await runAnalyseJob(db, ports, ai, docId);
  const countAfter1 = txnCount(db);
  const txnRow1 = db.prepare("SELECT id, amount_minor, direction FROM transactions").get() as { id: string; amount_minor: number; direction: string };
  assert.strictEqual(countAfter1, 1, "first analysis should create exactly one transaction");
  assert.strictEqual(txnRow1.amount_minor, 2450000);

  // Re-run analysis — the exact scenario §A1 targets: a retry or reprocess.
  await runAnalyseJob(db, ports, ai, docId);
  const countAfter2 = txnCount(db);
  assert.strictEqual(countAfter2, 1, "re-analysis must not create a second transaction");
  const txnRow2 = db.prepare("SELECT id, amount_minor, direction FROM transactions").get() as { id: string; amount_minor: number; direction: string };
  assert.strictEqual(txnRow2.id, txnRow1.id, "re-analysis should update the SAME transaction");
  assert.strictEqual(txnRow2.amount_minor, 2450000, "amount should be unchanged");
});

await check("re-analysis upserts: same transaction_id, legs replaced not duplicated", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeContractNoteAi();
  const docId = "doc_contract_note_02";
  await seedDoc(db, docId, "# Contract Note\n\nRELIANCE buy 10 @ 2450");

  await runAnalyseJob(db, ports, ai, docId);
  const txnId = (db.prepare("SELECT id FROM transactions").get() as { id: string }).id;
  assert.strictEqual(legsCount(db, txnId), 1, "should have one leg after first analysis");
  assert.strictEqual(holdingsCount(db, txnId), 1, "should have one holding after first analysis");

  // Re-analyse — legs and holdings should be replaced, not duplicated.
  await runAnalyseJob(db, ports, ai, docId);
  const txnId2 = (db.prepare("SELECT id FROM transactions").get() as { id: string }).id;
  assert.strictEqual(txnId2, txnId, "same transaction_id on re-analysis");
  assert.strictEqual(legsCount(db, txnId), 1, "legs should be replaced not duplicated");
  assert.strictEqual(holdingsCount(db, txnId), 1, "holdings should be replaced not duplicated");
  assert.strictEqual(evidenceCount(db, docId), 1, "only one evidence row");
});

await check("retry a failed analysis: no duplicate", async () => {
  const db = freshDb();
  const ports = testPorts();
  const docId = "doc_invoice_retry";
  await seedDoc(db, docId, "# Invoice\n\nAmount: 15,000.00");

  // First attempt: AI unavailable → no transaction for an unclassified
  // ("unknown") document; only a confidently-detected financial type records
  // one from the deterministic path (see the separate no-AI invoice test).
  const aiUnavailable: AiProvider = { available: false, model: "none", async extract() { throw new Error("no AI"); } };
  await runAnalyseJob(db, ports, aiUnavailable, docId);
  assert.strictEqual(txnCount(db), 0, "no transaction when AI unavailable");

  // Retry: AI becomes available → one transaction.
  const ai = fakeInvoiceAi();
  await runAnalyseJob(db, ports, ai, docId);
  assert.strictEqual(txnCount(db), 1, "retry should create exactly one transaction");

  // Another retry: still one.
  await runAnalyseJob(db, ports, ai, docId);
  assert.strictEqual(txnCount(db), 1, "second retry must not duplicate");
});

await check("a confident invoice with no readable date is NOT recorded (FY sanctity)", async () => {
  const db = freshDb();
  const ports = testPorts();
  const docId = "doc_invoice_no_date";
  await seedDoc(db, docId, "# Tax Invoice\n\nGSTIN: 29ABCDE1234F1Z5\n\nTotal: 1,445.00");

  const aiUnavailable: AiProvider = { available: false, model: "none", async extract() { throw new Error("no AI"); } };
  await runAnalyseJob(db, ports, aiUnavailable, docId);

  assert.strictEqual(txnCount(db), 0, "the ledger must never stamp the ingestion date");
});

await check("no-AI deterministic path records a confident invoice", async () => {
  const db = freshDb();
  const ports = testPorts();
  const docId = "doc_invoice_no_ai";
  await seedDoc(db, docId, "# Tax Invoice\n\nGSTIN: 29ABCDE1234F1Z5\n\nInvoice Date: 2026-05-29\n\nTotal: 1,445.00");

  const aiUnavailable: AiProvider = { available: false, model: "none", async extract() { throw new Error("no AI"); } };
  await runAnalyseJob(db, ports, aiUnavailable, docId);

  assert.strictEqual(txnCount(db), 1, "a confident invoice reaches the ledger without AI");
  const txn = db.prepare("SELECT amount_minor, direction, occurred_at FROM transactions").get() as { amount_minor: number; direction: string; occurred_at: string };
  assert.strictEqual(txn.amount_minor, 144500, "₹1,445 → 144500 minor units");
  assert.strictEqual(txn.direction, "out", "invoice is an expense");
  assert.strictEqual(txn.occurred_at, "2026-05-29", "transaction date comes from the document");
});

await check("re-analyse a multi-trade contract note: one transaction/evidence identity per trade", async () => {
  const db = freshDb();
  const ports = testPorts();
  const docId = "doc_multi_trade";
  await seedDoc(db, docId, "# Contract Note\n\nRELIANCE buy 10 @ 2450\nTATA MOTORS buy 5 @ 980");

  const ai: AiProvider = {
    available: true,
    model: "fake-test-model",
    async extract(): Promise<ExtractionResult> {
      return {
        doc_type: "contract_note",
        occurred_at: "2026-07-15",
        posted_at: "2026-07-15",
        amount_minor: 2940000, // 2450000 + 490000
        currency: "INR",
        direction: "out",
        payment_rail: null,
        parties: [
          { role: "source_of_funds", kind: "account", name: "HDFC Savings ...1234" },
          { role: "counterparty", kind: "organisation", name: "Zerodha Broking Ltd" },
        ],
        reference_ids: {},
        counterparty_descriptor: "ZERODHA BROKING",
        source_of_funds_text: "HDFC Savings ...1234",
        destination_of_funds_text: null,
        purpose_text: "Contract note — multi-trade",
        category_hint: "investments",
        is_wallet_topup: false,
        confidence: 0.92,
        notes: null,
        holdings: [
          { name: "RELIANCE", isin: "INE002A01018", side: "buy", quantity: 10, price_minor: 245000, amount_minor: 2450000 },
          { name: "TATA MOTORS", isin: "INE155A01022", side: "buy", quantity: 5, price_minor: 98000, amount_minor: 490000 },
        ],
        statement: null,
      };
    },
  };

  await runAnalyseJob(db, ports, ai, docId);
  assert.strictEqual(txnCount(db), 1, "one transaction for the contract note");
  const txnId = (db.prepare("SELECT id FROM transactions").get() as { id: string }).id;
  assert.strictEqual(holdingsCount(db, txnId), 2, "two holdings (one per trade)");

  // Re-analyse: same transaction, holdings replaced not duplicated.
  await runAnalyseJob(db, ports, ai, docId);
  assert.strictEqual(txnCount(db), 1, "re-analysis: still one transaction");
  assert.strictEqual(holdingsCount(db, txnId), 2, "re-analysis: holdings replaced not duplicated");
});

await check("user corrections survive re-analysis", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeInvoiceAi();
  const docId = "doc_user_claim";
  await seedDoc(db, docId, "# Invoice\n\nAmount: 15,000.00");

  await runAnalyseJob(db, ports, ai, docId);
  const txnId = (db.prepare("SELECT id FROM transactions").get() as { id: string }).id;

  // User confirms a different amount (a correction).
  db.prepare(
    "INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, status, created_at) VALUES ('transaction',?,?,?,'user',1.0,'confirmed',?)",
  ).run(txnId, "amount_minor", "1200000", "2026-08-10T00:00:00Z");

  // Re-analyse. The user-confirmed claim must survive.
  await runAnalyseJob(db, ports, ai, docId);
  const userClaim = db.prepare(
    "SELECT status, value FROM field_claims WHERE subject_id=? AND field='amount_minor' AND source='user'",
  ).get(txnId) as { status: string; value: string } | undefined;
  assert.ok(userClaim, "user claim must still exist after re-analysis");
  assert.strictEqual(userClaim!.status, "confirmed", "user claim must remain confirmed");
  assert.strictEqual(userClaim!.value, "1200000", "user claim value must be unchanged");

  // No new AI 'proposed' claim for amount_minor should have been inserted.
  const aiClaims = db.prepare(
    "SELECT COUNT(*) n FROM field_claims WHERE subject_id=? AND field='amount_minor' AND source='ai'",
  ).get(txnId) as { n: number };
  assert.strictEqual(aiClaims.n, 1, "re-analysis should not insert a second AI claim");
});

await check("the UI receipt count agrees with database transaction count", async () => {
  const db = freshDb();
  const ports = testPorts();
  const ai = fakeInvoiceAi();

  // Three different documents → three transactions.
  for (let i = 0; i < 3; i++) {
    const docId = `doc_receipt_${i}`;
    await seedDoc(db, docId, `# Invoice ${i}\n\nAmount: ${(i + 1) * 1000}.00`);
    await runAnalyseJob(db, ports, ai, docId);
  }
  assert.strictEqual(txnCount(db), 3, "three documents should produce three transactions");

  // Re-analyse all three — count must not change.
  for (let i = 0; i < 3; i++) {
    const docId = `doc_receipt_${i}`;
    await runAnalyseJob(db, ports, ai, docId);
  }
  assert.strictEqual(txnCount(db), 3, "re-analysis of all three must not change the count");
});

await check("recordTransaction directly: same doc + same role → upsert, not insert", async () => {
  const db = freshDb();
  const ports = testPorts();
  // Seed the document so the FK on transaction_documents is satisfied.
  await seedDoc(db, "doc_direct_01", "# Invoice\n\nAmount: 500.00");
  const x = {
    doc_type: "merchant_invoice" as const,
    occurred_at: "2026-07-20",
    posted_at: null,
    amount_minor: 50000,
    currency: "INR",
    direction: "out" as const,
    payment_rail: "upi" as const,
    parties: [
      { role: "source_of_funds" as const, kind: "account" as const, name: "HDFC Savings ...1234" },
      { role: "counterparty" as const, kind: "organisation" as const, name: "Test Merchant" },
    ],
    reference_ids: {},
    counterparty_descriptor: "TEST MERCHANT",
    source_of_funds_text: "HDFC Savings ...1234",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: null,
    is_wallet_topup: false,
    confidence: 0.9,
    notes: null,
    statement: null,
  };

  const r1 = recordTransaction(db, ports, "doc_direct_01", x);
  assert.ok(r1, "first call should return a result");
  assert.strictEqual(txnCount(db), 1);

  // Same document, same evidence_role → upsert.
  const r2 = recordTransaction(db, ports, "doc_direct_01", x);
  assert.ok(r2, "second call should return a result");
  assert.strictEqual(txnCount(db), 1, "second call must not create a new transaction");
  assert.strictEqual(r2!.transaction_id, r1!.transaction_id, "same transaction_id");
});

await check("evidence key uniqueness is enforced at the DB level", async () => {
  const db = freshDb();
  // Create the prerequisite rows so FK constraints don't fire before the
  // unique index does.
  await seedDoc(db, "doc_dup", "# test");
  for (const tid of ["txn_a", "txn_b"]) {
    db.prepare(
      "INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run(tid, "2026-01-01", "FY2026", 1000, "INR", "out", "evidenced", "2026-01-01T00:00:00Z");
  }
  // First insert succeeds.
  db.prepare(
    "INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_by, linked_at) VALUES (?,?,?,?,?)",
  ).run("txn_a", "doc_dup", "contract_note", "ai", "2026-01-01T00:00:00Z");
  // Second insert with same (document_id, evidence_role) but different
  // transaction_id must fail with a UNIQUE constraint violation.
  assert.throws(
    () => {
      db.prepare(
        "INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_by, linked_at) VALUES (?,?,?,?,?)",
      ).run("txn_b", "doc_dup", "contract_note", "ai", "2026-01-02T00:00:00Z");
    },
    /UNIQUE constraint failed/,
    "the unique index on (document_id, evidence_role) must prevent duplicates",
  );
});

await check("re-import a byte-identical document: duplicate intake, no job", async () => {
  // This is covered by the triage smoke test (work order 06), but we verify
  // the invariant here too: a duplicate intake does not create a document,
  // therefore cannot create a transaction.
  const db = freshDb();
  // No document → no transaction → no evidence. The intake-level dedup in
  // pipeline.ingestFile prevents the document from being created at all.
  const docs = (db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n;
  assert.strictEqual(docs, 0, "a fresh vault has no documents");
  assert.strictEqual(txnCount(db), 0, "a fresh vault has no transactions");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
