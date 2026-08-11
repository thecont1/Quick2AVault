/**
 * WO12 Track F4 — reconciliation smoke tests.
 *   npx tsx daemon/reconciliation.smoke.ts
 *
 * The full reconciliation cycle: candidate generation → matching →
 * confidence-tier routing → auto-link / review / separate → counting rule.
 *
 * Uses ?period=all per WO11 L5 so tests are calendar-independent.
 */
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createApi } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import { nullAiProvider, type MutableAiProvider } from "./ai-provider.js";
import { recordTransaction } from "./ledger.js";
import { findMatches, linkEvidence, AUTO_LINK, REVIEW_FLOOR } from "./matcher.js";
import { generateLearningQuestions, answerLearningQuestion } from "./workorders.js";
import { normaliseDescriptor } from "./schema.js";
import type { Ports } from "./ports.js";
import type { ExtractionResult } from "./extraction-contract.js";

const noAi: MutableAiProvider = { ...nullAiProvider, reconfigure: () => false };

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${(e as Error).message}`);
  }
}

// ── Test vault setup ──────────────────────────────────────────────────────
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-reconciliation-"));
const rawDir = path.join(vault, "Raw");
fs.mkdirSync(rawDir, { recursive: true });
const db = openDatabase(path.join(vault, "vault.db"));
const ports: Ports = {
  logger: createLogger("error"),
  clock: { now: () => new Date("2026-08-11T00:00:00.000Z"), isoNow: () => "2026-08-11T00:00:00.000Z" },
  paths: createPaths(vault),
  converter: {
    async toMarkdown() {
      return { markdown: "# Test\n\nTotal: 4722.87\n", converter: "plaintext", converterVersion: "test" };
    },
  },
  bus: createEventBus(createLogger("error")),
};

const TOKEN = "test-token-reconciliation";
const PORT = 47953;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault, ai: noAi });
await api.listen();
const hdr = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function req(method: string, p: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? hdr : { Authorization: `Bearer ${TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
// A tax invoice for ₹4,722.87 from "Swiggy Limited" on 2026-08-09.
function makeInvoice(): ExtractionResult {
  return {
    doc_type: "merchant_invoice",
    occurred_at: "2026-08-09",
    posted_at: null,
    amount_minor: 472287,
    currency: "INR",
    direction: "out",
    payment_rail: "upi",
    parties: [
      { name: "Swiggy Limited", kind: "organisation", role: "issuer", identifiers: { gstin: "29AABPM1234C1Z0" } },
      { name: "Arun Kamath", kind: "person", role: "owner" },
    ],
    reference_ids: { order_no: "ORD12345678", invoice_no: "INV-7705" },
    counterparty_descriptor: "SWIGGY*BLR 080",
    source_of_funds_text: "Example Bank Savings Account ...9876",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: "groceries",
    is_wallet_topup: false,
    confidence: 0.95,
    notes: null,
    holdings: null,
  };
}

// A bank slip for the same ₹4,722.87, dated 2026-08-09, same counterparty,
// shared reference ID (order_no), shared UPI ID.
function makeBankSlip(): ExtractionResult {
  return {
    doc_type: "bank_slip",
    occurred_at: "2026-08-09",
    posted_at: null,
    amount_minor: 472287,
    currency: "INR",
    direction: "out",
    payment_rail: "upi",
    parties: [
      { name: "Example Bank", kind: "organisation", role: "issuer" },
      { name: "Example Bank Savings Account ...9876", kind: "account", role: "source_of_funds" },
      { name: "Swiggy Limited", kind: "organisation", role: "counterparty" },
    ],
    reference_ids: { utr: "UTR123456789", order_no: "ORD12345678" },
    counterparty_descriptor: "SWIGGY*BLR 080",
    source_of_funds_text: "Example Bank Savings Account ...9876",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: "groceries",
    is_wallet_topup: false,
    confidence: 0.95,
    notes: null,
    holdings: null,
  };
}

// A bank slip with a DIFFERENT amount — should not match.
function makeBankSlipDifferent(): ExtractionResult {
  return {
    doc_type: "bank_slip",
    occurred_at: "2026-08-10",
    posted_at: null,
    amount_minor: 99999,
    currency: "INR",
    direction: "out",
    payment_rail: "upi",
    parties: [
      { name: "Example Bank", kind: "organisation", role: "issuer" },
      { name: "Example Bank Savings Account ...9876", kind: "account", role: "source_of_funds" },
      { name: "Big Bazaar", kind: "organisation", role: "counterparty" },
    ],
    reference_ids: { utr: "UTR987654321" },
    counterparty_descriptor: "BIG BAZAAR*BLR 080",
    source_of_funds_text: "Example Bank Savings Account ...9876",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: "groceries",
    is_wallet_topup: false,
    confidence: 0.95,
    notes: null,
    holdings: null,
  };
}

// A card confirmation — same amount, same counterparty, but only descriptor
// match (no shared reference ID). Score should be in the review band.
function makeCardConfirmation(): ExtractionResult {
  return {
    doc_type: "card_confirmation",
    occurred_at: "2026-08-09",
    posted_at: null,
    amount_minor: 472287,
    currency: "INR",
    direction: "out",
    payment_rail: "card",
    parties: [
      { name: "Example Bank Credit Card ending 4242", kind: "account", role: "source_of_funds" },
      { name: "Swiggy Limited", kind: "organisation", role: "counterparty" },
    ],
    reference_ids: {},
    counterparty_descriptor: "SWIGGY*BLR 080",
    source_of_funds_text: "Example Bank Credit Card ending 4242",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: "groceries",
    is_wallet_topup: false,
    confidence: 0.92,
    notes: null,
    holdings: null,
  };
}

// A refund note for the invoice.
function makeRefund(): ExtractionResult {
  return {
    doc_type: "refund_note",
    occurred_at: "2026-08-10",
    posted_at: null,
    amount_minor: 472287,
    currency: "INR",
    direction: "in",
    payment_rail: "upi",
    parties: [
      { name: "Swiggy Limited", kind: "organisation", role: "issuer" },
      { name: "Arun Kamath", kind: "person", role: "owner" },
    ],
    reference_ids: { order_no: "ORD12345678" },
    counterparty_descriptor: "SWIGGY*BLR 080",
    source_of_funds_text: "Example Bank Savings Account ...9876",
    destination_of_funds_text: null,
    purpose_text: null,
    category_hint: "groceries",
    is_wallet_topup: false,
    confidence: 0.9,
    notes: null,
    holdings: null,
  };
}

// Helper: seed a document row in the given DB
function seedDoc(targetDb: DatabaseSync, id: string, x: ExtractionResult): string {
  const rawPath = path.join(rawDir, `${id}.pdf`);
  fs.writeFileSync(rawPath, `bytes-of-${id}`);
  targetDb.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, raw_path, markdown_path, markdown_chars, doc_type, source, extraction_json, extraction_version, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, `sha_${id}`, `${id}.pdf`, ".pdf", rawPath, null, 0, x.doc_type, "folder",
    JSON.stringify(x), 1, ports.clock.isoNow(),
  );
  return id;
}

function txnCount(targetDb: DatabaseSync): number {
  return (targetDb.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n;
}

function evidenceCount(targetDb: DatabaseSync, txnId: string): number {
  return (targetDb.prepare("SELECT COUNT(*) n FROM transaction_documents WHERE transaction_id=?").get(txnId) as { n: number }).n;
}

// Helper: create a fresh in-memory DB with standard ports for E2E tests
function freshDb(): { db: DatabaseSync; ports: Ports } {
  const db = openDatabase(":memory:");
  const p: Ports = {
    logger: createLogger("error"),
    clock: { now: () => new Date("2026-08-11T00:00:00.000Z"), isoNow: () => "2026-08-11T00:00:00.000Z" },
    paths: createPaths(vault),
    converter: { async toMarkdown() { return { markdown: "# x\n", converter: "stub", converterVersion: "test" }; } },
    bus: createEventBus(createLogger("error")),
  };
  return { db, ports: p };
}

// Helper: create a counterparty entity in the DB
function seedEntity(targetDb: DatabaseSync, id: string, kind: string, name: string) {
  targetDb.prepare(
    "INSERT INTO entities(id,kind,display_name,status,confidence,created_at) VALUES(?,?,?,?,?,?)",
  ).run(id, kind, name, "confirmed", 1.0, "2026-08-11T00:00:00.000Z");
}

// ── Step 1: Drop a tax invoice — 1 candidate emitted, no transaction yet ─────
console.log("\n── WO12 reconciliation cycle\n");

await check("step 1: tax invoice creates a candidate transaction", async () => {
  const x = makeInvoice();
  const docId = seedDoc(db, "doc_invoice", x);
  const rec = recordTransaction(db, ports, docId, x);
  assert.ok(rec, "recordTransaction should return a result");
  assert.equal(rec!.amount_minor, 472287);
  assert.equal(rec!.direction, "out");
  assert.equal(evidenceCount(db, rec!.transaction_id), 1);
  assert.equal(txnCount(db), 1);
});

// ── Step 2: Drop a matching bank slip — auto-link fires ────────────────────
await check("step 2: matching bank slip auto-links (score >= 0.9)", async () => {
  const x = makeBankSlip();
  const docId = seedDoc(db, "doc_slip", x);

  const matches = findMatches(db, x, docId);
  assert.ok(matches.length > 0, "should find at least one match");
  const best = matches[0];
  assert.ok(best.score >= AUTO_LINK, `score ${best.score} should be >= ${AUTO_LINK}`);

  linkEvidence(db, ports, best.transaction_id, docId, x, best.score);
  const txnId = best.transaction_id;
  assert.equal(evidenceCount(db, txnId), 2, "transaction should now have 2 evidence rows");
  assert.equal(txnCount(db), 1, "still one transaction, not two");
});

// ── Step 3: Snapshot shows one transaction, not two ──────────────────────
await check("step 3: snapshot totals reflect one transaction (no double-count)", async () => {
  const r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.spending_minor, 472287, "spending should be exactly one transaction, not two");
});

// ── Step 4: A second invoice with a different amount — stays separate ─────
await check("step 4: different-amount slip does not match (score < 0.6)", async () => {
  const x = makeBankSlipDifferent();
  const docId = seedDoc(db, "doc_diff", x);
  const matches = findMatches(db, x, docId);
  const best = matches[0];
  assert.ok(!best || best.score < REVIEW_FLOOR, `score ${best?.score ?? 0} should be < ${REVIEW_FLOOR}`);
  const rec = recordTransaction(db, ports, docId, x);
  assert.ok(rec, "should create a new transaction");
  assert.equal(txnCount(db), 2, "should now have 2 transactions");
});

// ── Step 5: Card confirmation matches but in review band (0.6–0.9) ────────
let reviewQid: number | null = null;
await check("step 5: card confirmation in review band triggers Learning question", async () => {
  const x = makeCardConfirmation();
  const docId = seedDoc(db, "doc_card", x);
  const matches = findMatches(db, x, docId);
  const best = matches[0];
  assert.ok(best, "should find a match");
  assert.ok(best.score >= REVIEW_FLOOR && best.score < AUTO_LINK, `score ${best.score} should be in review band [${REVIEW_FLOOR}, ${AUTO_LINK})`);

  const ambiguity = {
    kind: "reconciliation-ambiguity" as const,
    dedupeKey: `${docId}|${best.transaction_id}|${x.amount_minor}|${x.currency}|${x.occurred_at ?? ""}`,
    prompt: "These look like the same purchase. Link?",
    sourceFact: {
      document_id: docId,
      transaction_id: best.transaction_id,
      amount_minor: x.amount_minor,
      currency: x.currency,
      occurred_at: x.occurred_at,
      counterparty_descriptor: x.counterparty_descriptor,
      source_of_funds_text: x.source_of_funds_text,
    },
    predictedRule: {
      kind: "entity-rule" as const,
      payload: {
        rule_type: "reconcile",
        candidate_document_id: docId,
        transaction_id: best.transaction_id,
        amount_minor: x.amount_minor,
        currency: x.currency,
      },
    },
    noveltyScore: best.score,
    why: best.reasons.join("; "),
  };
  const questions = generateLearningQuestions(db, ports, {
    documentId: docId,
    pipelineState: "analysing",
    ambiguities: [ambiguity],
  });
  assert.ok(questions.length > 0, "a learning question should have been raised");
  reviewQid = Number(questions[0].question_id);
});

// ── Step 6: User answers "Link" — document is promoted to a confirmed transaction ─
await check("step 6: user answers Link — evidence is attached", async () => {
  assert.ok(reviewQid, "need a review question from step 5");
  const result = answerLearningQuestion(db, ports, reviewQid!, "yes");
  assert.ok(result.linked, "the link should have been performed");

  const txn = db.prepare("SELECT transaction_id FROM transaction_documents WHERE document_id='doc_card'").get() as { transaction_id: string };
  assert.ok(txn, "the card confirmation should now be linked to a transaction");
  assert.equal(evidenceCount(db, txn.transaction_id), 3, "transaction should have 3 evidence rows");
});

// ── Step 7: User answers "Don't link" on a different review — dismissed ──────
let dismissedQid: number | null = null;
await check("step 7: user answers Don't link — question dismissed, no link", async () => {
  const x: ExtractionResult = {
    ...makeInvoice(),
    amount_minor: 472287,
    doc_type: "card_confirmation",
    payment_rail: "card",
    counterparty_descriptor: "SWIGGY*BLR 080",
    reference_ids: {},
    occurred_at: "2026-08-11",
  };
  const docId = seedDoc(db, "doc_card2", x);
  const matches = findMatches(db, x, docId);
  const best = matches[0];
  assert.ok(best, "should find a match");

  const ambiguity = {
    kind: "reconciliation-ambiguity" as const,
    dedupeKey: `${docId}|${best.transaction_id}|${x.amount_minor}|${x.currency}|${x.occurred_at ?? ""}`,
    prompt: "These look like the same purchase. Link?",
    sourceFact: { document_id: docId, transaction_id: best.transaction_id },
    predictedRule: { kind: "entity-rule" as const, payload: { rule_type: "reconcile", candidate_document_id: docId, transaction_id: best.transaction_id } },
    noveltyScore: best.score,
    why: best.reasons.join("; "),
  };
  const qs = generateLearningQuestions(db, ports, { documentId: docId, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.ok(qs.length > 0, "a learning question should have been raised");
  dismissedQid = Number(qs[0].question_id);
  const result = answerLearningQuestion(db, ports, dismissedQid, "no");
  assert.ok(result.dismissed, "question should be dismissed");
  assert.ok(result.ruleId, "dismissal should create a standing rule");
  const link = db.prepare("SELECT 1 FROM transaction_documents WHERE document_id='doc_card2'").get();
  assert.ok(!link, "the document should NOT be linked after dismissal");

  // Verify the question does NOT re-appear on a second call (dedupe suppression)
  const qs2 = generateLearningQuestions(db, ports, { documentId: docId, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.equal(qs2.length, 0, "question should not re-appear after dismissal");
});

// ── Step 7b: Standing rule suppresses re-asking even after the review row is gone ──
await check("step 7b: standing reconciliation_decline rule suppresses re-asking", async () => {
  const { db: dbR, ports: portsR } = freshDb();
  // Set up: invoice + matching card confirmation in the review band
  const inv = makeInvoice();
  const invDoc = seedDoc(dbR, "rule_inv", inv);
  recordTransaction(dbR, portsR, invDoc, inv);

  const card: ExtractionResult = {
    ...makeInvoice(),
    amount_minor: 472287,
    doc_type: "card_confirmation",
    payment_rail: "card",
    counterparty_descriptor: "SWIGGY*BLR 080",
    reference_ids: {},
    occurred_at: "2026-08-11",
  };
  const cardDoc = seedDoc(dbR, "rule_card", card);
  const matches = findMatches(dbR, card, cardDoc);
  assert.ok(matches.length > 0, "should find a match");

  const ambiguity = {
    kind: "reconciliation-ambiguity" as const,
    dedupeKey: `${cardDoc}|${matches[0].transaction_id}|${card.amount_minor}|${card.currency}|${card.occurred_at ?? ""}`,
    prompt: "These look like the same purchase. Link?",
    sourceFact: { document_id: cardDoc, transaction_id: matches[0].transaction_id },
    predictedRule: { kind: "entity-rule" as const, payload: { rule_type: "reconcile", candidate_document_id: cardDoc, transaction_id: matches[0].transaction_id } },
    noveltyScore: matches[0].score,
    why: matches[0].reasons.join("; "),
  };

  // Generate the question, then dismiss with "Don't link"
  const qs = generateLearningQuestions(dbR, portsR, { documentId: cardDoc, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.ok(qs.length > 0, "question should be generated");
  const result = answerLearningQuestion(dbR, portsR, Number(qs[0].question_id), "no");
  assert.ok(result.dismissed, "question should be dismissed");
  assert.ok(result.ruleId, "dismissal should create a standing rule");

  // Verify the rule exists in learned_rules
  const rule = dbR.prepare("SELECT kind, match_key, value, active FROM learned_rules WHERE id=?").get(result.ruleId) as { kind: string; match_key: string; value: string; active: number };
  assert.equal(rule.kind, "reconciliation_decline", "rule kind should be reconciliation_decline");
  assert.equal(rule.active, 1, "rule should be active");
  assert.equal(rule.match_key, ambiguity.dedupeKey, "rule key should be the dedupe key");

  // Delete the training_reviews row to simulate it being old/pruned.
  // The standing rule should STILL suppress the question.
  dbR.prepare("DELETE FROM training_reviews WHERE dedupe_key=?").run(ambiguity.dedupeKey);

  // Re-ask: should be suppressed by the standing rule, not the dedupe key
  const qs3 = generateLearningQuestions(dbR, portsR, { documentId: cardDoc, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.equal(qs3.length, 0, "standing rule should suppress re-asking even without a training_reviews row");
  dbR.close();
});

// ── Step 7c: "Later" re-asks after backoff expires ─────────────────────────
await check("step 7c: Later re-asks after backoff expires", async () => {
  const { db: dbL, ports: portsL } = freshDb();
  // Set up: invoice + matching card confirmation in the review band
  const inv = makeInvoice();
  const invDoc = seedDoc(dbL, "later_inv", inv);
  recordTransaction(dbL, portsL, invDoc, inv);

  const card: ExtractionResult = {
    ...makeInvoice(),
    amount_minor: 472287,
    doc_type: "card_confirmation",
    payment_rail: "card",
    counterparty_descriptor: "SWIGGY*BLR 080",
    reference_ids: {},
    occurred_at: "2026-08-11",
  };
  const cardDoc = seedDoc(dbL, "later_card", card);
  const matches = findMatches(dbL, card, cardDoc);
  assert.ok(matches.length > 0, "should find a match");

  const ambiguity = {
    kind: "reconciliation-ambiguity" as const,
    dedupeKey: `${cardDoc}|${matches[0].transaction_id}|${card.amount_minor}|${card.currency}|${card.occurred_at ?? ""}`,
    prompt: "These look like the same purchase. Link?",
    sourceFact: { document_id: cardDoc, transaction_id: matches[0].transaction_id },
    predictedRule: { kind: "entity-rule" as const, payload: { rule_type: "reconcile", candidate_document_id: cardDoc, transaction_id: matches[0].transaction_id } },
    noveltyScore: matches[0].score,
    why: matches[0].reasons.join("; "),
  };

  // Generate the question, then answer "Later"
  const qs = generateLearningQuestions(dbL, portsL, { documentId: cardDoc, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.ok(qs.length > 0, "question should be generated");
  const result = answerLearningQuestion(dbL, portsL, Number(qs[0].question_id), "later");
  assert.ok(result.deferred, "question should be deferred");

  // Verify backoff_until is set
  const review = dbL.prepare("SELECT backoff_until FROM training_reviews WHERE dedupe_key=?").get(ambiguity.dedupeKey) as { backoff_until: string };
  assert.ok(review.backoff_until, "backoff_until should be set");

  // Re-ask immediately: should be suppressed (in backoff)
  const qs2 = generateLearningQuestions(dbL, portsL, { documentId: cardDoc, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.equal(qs2.length, 0, "question should not re-appear during backoff");

  // Advance clock past backoff (8 days later)
  const futurePorts: Ports = {
    ...portsL,
    clock: {
      now: () => new Date("2026-08-19T00:00:00.000Z"),
      isoNow: () => "2026-08-19T00:00:00.000Z",
    },
  };

  // Re-ask: should re-appear (backoff expired)
  const qs3 = generateLearningQuestions(dbL, futurePorts, { documentId: cardDoc, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.equal(qs3.length, 1, "question should re-appear after backoff expires");
  dbL.close();
});

// ── Step 8: Drop a refund note — nets to zero ──────────────────────────────
await check("step 8: refund creates a separate credit transaction", async () => {
  const x = makeRefund();
  const docId = seedDoc(db, "doc_refund", x);
  const rec = recordTransaction(db, ports, docId, x);
  assert.ok(rec, "refund transaction should be created");
  assert.equal(rec!.direction, "in", "refund should be a credit (direction=in)");
  assert.equal(rec!.amount_minor, 472287);
  // WO12 phase 2: refund nets against spending, not counted as income.
  // Spending = (invoice 472287 + diff slip 99999) - refund 472287 = 99999
  const r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.spending_minor, 99999, "refund nets against spending — net spending is diff slip only");
  // Income excludes refunds (the refund reversed a spending transaction)
  assert.equal(r.json.income_minor, 0, "refund is not income — it reversed a spending transaction");
});

// ── Step 9: Remove an evidence document — transaction hides when all evidence removed ──
await check("step 9: removing evidence document hides transaction when all evidence is removed", async () => {
  // Current state: the main transaction has doc_invoice(active), doc_slip(active), doc_card(linked)
  // Remove doc_invoice
  db.prepare("UPDATE documents SET lifecycle='removed' WHERE id='doc_invoice'").run();

  // Transaction should still be visible (slip + card confirmation are active)
  // WO12 phase 2: refund nets against the main txn, so spending = 99999
  let r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.spending_minor, 99999, "both transactions still visible — slip and card are active; refund nets");

  // Remove doc_slip — main transaction still visible (card confirmation active)
  db.prepare("UPDATE documents SET lifecycle='removed' WHERE id='doc_slip'").run();
  r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.spending_minor, 99999, "main txn still visible — card confirmation is active; refund nets");

  // Now remove doc_card (the only remaining evidence for the main txn)
  db.prepare("UPDATE documents SET lifecycle='removed' WHERE id='doc_card'").run();
  r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  // Main txn hidden (all evidence removed), diff slip transaction still visible
  // Refund no longer nets (original is hidden) — but refund is direction='in',
  // so it doesn't affect spending. Spending is just the diff slip.
  assert.equal(r.json.spending_minor, 99999, "main transaction hidden — all evidence removed; diff slip remains");
});

// ── Step 10: Delete a document — same lifecycle behavior ────────────────────
await check("step 10: delete lifecycle behaves same as removed", async () => {
  // Restore doc_invoice and doc_slip, delete doc_card
  db.prepare("UPDATE documents SET lifecycle='active' WHERE id='doc_invoice'").run();
  db.prepare("UPDATE documents SET lifecycle='active' WHERE id='doc_slip'").run();
  db.prepare("UPDATE documents SET lifecycle='deleted' WHERE id='doc_card'").run();

  const r = await req("GET", "/v1/snapshot?period=all");
  assert.equal(r.status, 200);
  // doc_card is now deleted, but doc_invoice and doc_slip are still active, so main txn still visible
  // WO12 phase 2: refund nets against the main txn, so spending = 99999
  assert.equal(r.json.spending_minor, 99999, "transaction still visible — invoice + slip are active, card deleted; refund nets");
});

// ── E2E scenarios (F5) ──────────────────────────────────────────────────────

// A — Invoice + matching slip → totals correct, no double-count
await check("E2E A: invoice + matching slip → one transaction, correct total", async () => {
  const { db: dbA, ports: portsA } = freshDb();
  seedEntity(dbA, "ent_swiggy_a", "organisation", "Swiggy Limited");
  const x1 = makeInvoice();
  const docId1 = seedDoc(dbA, "e2e_a_invoice", x1);
  const rec = recordTransaction(dbA, portsA, docId1, x1);
  dbA.prepare("UPDATE transactions SET counterparty_entity_id='ent_swiggy_a' WHERE id=?").run(rec!.transaction_id);

  const x2 = makeBankSlip();
  const docId2 = seedDoc(dbA, "e2e_a_slip", x2);
  const matches = findMatches(dbA, x2, docId2);
  assert.ok(matches.length > 0, "should find a match to auto-link");
  assert.ok(matches[0].score >= AUTO_LINK);
  linkEvidence(dbA, portsA, matches[0].transaction_id, docId2, x2, matches[0].score);
  const count = txnCount(dbA);
  assert.equal(count, 1, "one transaction for invoice + slip");
  dbA.close();
});

// B — Invoice + ambiguous slip → review queue, user confirms
await check("E2E B: ambiguous match → Learning question → user confirms", async () => {
  const { db: dbB, ports: portsB } = freshDb();
  seedEntity(dbB, "ent_swiggy_b", "organisation", "Swiggy Limited");
  const x1 = makeInvoice();
  const docId1 = seedDoc(dbB, "e2e_b_invoice", x1);
  const rec = recordTransaction(dbB, portsB, docId1, x1);
  dbB.prepare("UPDATE transactions SET counterparty_entity_id='ent_swiggy_b' WHERE id=?").run(rec!.transaction_id);

  const x2 = makeCardConfirmation();
  const docId2 = seedDoc(dbB, "e2e_b_card", x2);
  const matches = findMatches(dbB, x2, docId2);
  assert.ok(matches.length > 0, "should find a match");
  const best = matches[0];
  // Card confirmation: same amount + date + counterparty but no shared
  // reference IDs → score lands in the review band, not auto-link.
  assert.ok(best.score >= REVIEW_FLOOR && best.score < AUTO_LINK,
    `score ${best.score} should be in review band [${REVIEW_FLOOR}, ${AUTO_LINK})`);

  const ambiguity = {
    kind: "reconciliation-ambiguity" as const,
    dedupeKey: `${docId2}|${best.transaction_id}|${x2.amount_minor}|${x2.currency}|${x2.occurred_at ?? ""}`,
    prompt: "These look like the same purchase. Link?",
    sourceFact: { document_id: docId2, transaction_id: best.transaction_id },
    predictedRule: { kind: "entity-rule" as const, payload: { rule_type: "reconcile" } },
    noveltyScore: best.score,
    why: best.reasons.join("; "),
  };
  const qs = generateLearningQuestions(dbB, portsB, { documentId: docId2, pipelineState: "analysing", ambiguities: [ambiguity] });
  assert.ok(qs.length > 0, "should get a question");
  const result = answerLearningQuestion(dbB, portsB, Number(qs[0].question_id), "yes");
  assert.ok(result.linked);
  const link = dbB.prepare("SELECT 1 FROM transaction_documents WHERE document_id=?").get(docId2);
  assert.ok(link, "document should be linked after user confirms");
  dbB.close();
});

// C — Invoice only, no slip → transaction exists with awaiting_settlement flag
await check("E2E C: invoice only with no settlement → transaction has awaiting_settlement flag", async () => {
  // Use a fresh db: the shared db's doc_invoice was already linked with a
  // matching slip in step 2, so its status was promoted to 'evidenced'.
  const { db: dbC, ports: portsC } = freshDb();
  const inv = makeInvoice();
  const docId = seedDoc(dbC, "c_invoice_only", inv);
  const rec = recordTransaction(dbC, portsC, docId, inv);
  assert.ok(rec, "invoice transaction should be created");
  const link = dbC.prepare("SELECT evidence_role FROM transaction_documents WHERE document_id=?").get(docId) as { evidence_role: string };
  assert.equal(link.evidence_role, "merchant_invoice", "invoice should be linked with merchant_invoice role");
  // WO12 phase 2: the transaction status should be 'awaiting_settlement' —
  // an invoice is on file but no settlement evidence has matched yet.
  const txn = dbC.prepare("SELECT status FROM transactions WHERE id=?").get(rec!.transaction_id) as { status: string };
  assert.equal(txn.status, "awaiting_settlement", "invoice-only transaction should be awaiting_settlement");
  dbC.close();
});

// D — Slip only, no invoice → creates separate transaction with no_invoice status
await check("E2E D: slip-only transaction → no_invoice on file", async () => {
  const x: ExtractionResult = {
    ...makeBankSlip(),
    amount_minor: 123456,
    doc_type: "bank_slip",
    counterparty_descriptor: "AMAZON*MKPL*IN",
    reference_ids: { utr: "UTR_NEVER_SEEN_BEFORE" },
    occurred_at: "2026-08-11",
  };
  const docId = seedDoc(db, "e2e_d_slip_only", x);
  const matches = findMatches(db, x, docId);
  assert.ok(matches.length === 0 || matches[0].score < REVIEW_FLOOR, "no matching invoice → stays separate");
  const rec = recordTransaction(db, ports, docId, x);
  assert.ok(rec, "slip-only transaction should be created");
  // WO12 phase 2: a settlement document with no matching invoice is a gap.
  const txn = db.prepare("SELECT status FROM transactions WHERE id=?").get(rec!.transaction_id) as { status: string };
  assert.equal(txn.status, "no_invoice", "slip-only transaction should be flagged no_invoice");
});

// C2 — Invoice (awaiting_settlement) → matching slip auto-links → status promotes to evidenced
await check("E2E C2: invoice awaiting_settlement → matching slip auto-links → status promotes to evidenced", async () => {
  const { db: dbC2, ports: portsC2 } = freshDb();
  // Step 1: record an invoice-only transaction
  const inv = makeInvoice();
  const invDoc = seedDoc(dbC2, "c2_invoice", inv);
  const invRec = recordTransaction(dbC2, portsC2, invDoc, inv);
  assert.ok(invRec, "invoice transaction should be created");
  let st = dbC2.prepare("SELECT status FROM transactions WHERE id=?").get(invRec!.transaction_id) as { status: string };
  assert.equal(st.status, "awaiting_settlement", "invoice-only should start as awaiting_settlement");
  // Step 2: drop a matching bank slip (same amount, same counterparty, close date)
  const slip = makeBankSlip();
  const slipDoc = seedDoc(dbC2, "c2_slip", slip);
  const matches = findMatches(dbC2, slip, slipDoc);
  assert.ok(matches.length > 0 && matches[0].score >= AUTO_LINK, "should find an auto-link match");
  linkEvidence(dbC2, portsC2, matches[0].transaction_id, slipDoc, slip, matches[0].score);
  // Step 3: the transaction should now be promoted to 'evidenced'
  st = dbC2.prepare("SELECT status FROM transactions WHERE id=?").get(invRec!.transaction_id) as { status: string };
  assert.equal(st.status, "evidenced", "transaction with both invoice + settlement should be evidenced");
  dbC2.close();
});

// E — Refund against an invoice → linked and totals net correctly
await check("E2E E: refund against invoice → linked, net to zero in spending", async () => {
  const { db: dbE, ports: portsE } = freshDb();
  const x1 = makeInvoice();
  const docId1 = seedDoc(dbE, "e2e_e_invoice", x1);
  const invRec = recordTransaction(dbE, portsE, docId1, x1);
  assert.ok(invRec, "invoice transaction should be created");

  const x2 = makeRefund();
  const docId2 = seedDoc(dbE, "e2e_e_refund", x2);
  const refundRec = recordTransaction(dbE, portsE, docId2, x2);
  assert.ok(refundRec, "refund transaction should be created");

  // WO12 phase 2: the refund should be linked to the original transaction
  const refundTxn = dbE.prepare("SELECT reverses_transaction_id FROM transactions WHERE id=?").get(refundRec!.transaction_id) as { reverses_transaction_id: string | null };
  assert.equal(refundTxn.reverses_transaction_id, invRec!.transaction_id, "refund should be linked to the original invoice transaction");

  // WO12 phase 2: snapshot totals net the refund against spending
  const vaultE = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-refund-e2e-"));
  const PORT_E = 47960;
  const apiE = createApi(dbE, portsE, { port: PORT_E, token: "test", version: "test", vaultDir: vaultE, ai: noAi });
  await apiE.listen();
  const res = await fetch(`http://127.0.0.1:${PORT_E}/v1/snapshot?period=all`, {
    headers: { Authorization: "Bearer test" },
  });
  const snap = (await res.json()) as { spending_minor: number; income_minor: number };
  await apiE.close();
  assert.equal(snap.spending_minor, 0, "net spending is zero — refund fully reverses the invoice");
  assert.equal(snap.income_minor, 0, "refund is not income — it reversed a spending transaction");
  dbE.close();
});

// F — Remove an evidence document → transaction hides
await check("E2E F: remove evidence document → transaction hidden when all evidence removed", async () => {
  const { db: dbF, ports: portsF } = freshDb();
  seedEntity(dbF, "ent_swiggy_f", "organisation", "Swiggy Limited");

  const x1 = makeInvoice();
  const docId1 = seedDoc(dbF, "e2e_f_invoice", x1);
  const rec = recordTransaction(dbF, portsF, docId1, x1);
  dbF.prepare("UPDATE transactions SET counterparty_entity_id='ent_swiggy_f' WHERE id=?").run(rec!.transaction_id);

  const x2 = makeBankSlip();
  const docId2 = seedDoc(dbF, "e2e_f_slip", x2);
  const matches = findMatches(dbF, x2, docId2);
  assert.ok(matches.length > 0, "should find a match to link");
  linkEvidence(dbF, portsF, matches[0].transaction_id, docId2, x2, matches[0].score);

  // Remove the invoice
  dbF.prepare("UPDATE documents SET lifecycle='removed' WHERE id=?").run(docId1);
  const hasActive = (dbF.prepare(
    `SELECT 1 FROM transaction_documents td
     JOIN documents d ON d.id = td.document_id
     WHERE td.transaction_id = ? AND d.lifecycle = 'active'
     LIMIT 1`,
  ).get(rec!.transaction_id) as unknown) as { 1: number } | undefined;
  assert.ok(hasActive, "transaction still visible when slip is active");

  // Remove the slip too
  dbF.prepare("UPDATE documents SET lifecycle='removed' WHERE id=?").run(docId2);
  const noActive = (dbF.prepare(
    `SELECT 1 FROM transaction_documents td
     JOIN documents d ON d.id = td.document_id
     WHERE td.transaction_id = ? AND d.lifecycle = 'active'
     LIMIT 1`,
  ).get(rec!.transaction_id) as unknown) as { 1: number } | undefined;
  assert.ok(!noActive, "transaction hidden when all evidence removed");
  dbF.close();
});

// ── Matcher signal unit tests (Track C4) ───────────────────────────────────

await check("matcher signal: amount exact + date within 1d + counterparty exact + source match → 0.95+, auto-link", () => {
  const { db: dbM, ports: portsM } = freshDb();
  seedEntity(dbM, "ent_swiggy_m", "organisation", "Swiggy Limited");

  const x1: ExtractionResult = { ...makeInvoice() };
  const docId1 = seedDoc(dbM, "m_sig_a", x1);
  const rec = recordTransaction(dbM, portsM, docId1, x1);
  dbM.prepare("UPDATE transactions SET counterparty_entity_id='ent_swiggy_m' WHERE id=?").run(rec!.transaction_id);

  const x2: ExtractionResult = { ...makeBankSlip() };
  const docId2 = seedDoc(dbM, "m_sig_b", x2);
  const matches = findMatches(dbM, x2, docId2);
  assert.ok(matches.length > 0, "should find a match");
  const best = matches[0];
  assert.ok(best.score >= AUTO_LINK, `score ${best.score} should be >= ${AUTO_LINK} for amount+date+counterparty+ref match`);
  dbM.close();
});

await check("matcher signal: only counterparty fuzzy + different date → < REVIEW_FLOOR", () => {
  const { db: dbN, ports: portsN } = freshDb();
  seedEntity(dbN, "ent_swiggy_n", "organisation", "Swiggy Limited");

  const x1: ExtractionResult = { ...makeInvoice(), amount_minor: 100000 };
  const docId1 = seedDoc(dbN, "m_fuzzy_a", x1);
  const rec = recordTransaction(dbN, portsN, docId1, x1);
  dbN.prepare("UPDATE transactions SET counterparty_entity_id='ent_swiggy_n' WHERE id=?").run(rec!.transaction_id);

  const x2: ExtractionResult = {
    ...makeBankSlip(),
    occurred_at: "2026-08-20",
    amount_minor: 100000,
    currency: "INR",
    counterparty_descriptor: "SWIGGY*BLR 080",
    reference_ids: {},
    payment_rail: "card",
  };
  const docId2 = seedDoc(dbN, "m_fuzzy_b", x2);
  const matches = findMatches(dbN, x2, docId2);
  assert.ok(matches.length > 0, "should find a match by amount + descriptor");
  const best = matches[0];
  // Score: amount(0.40) + date >7d apart(-0.30) + descriptor overlap(0.15) = 0.25
  assert.ok(best.score < REVIEW_FLOOR, `score ${best.score} should be < ${REVIEW_FLOOR}`);
  dbN.close();
});

// ── Statement descriptor normalisation unit tests ──────────────────────────
await check("normaliseDescriptor: various UPI/card descriptors", () => {
  assert.equal(normaliseDescriptor("SWIGGY*BLR 080"), "swiggy");
  assert.equal(normaliseDescriptor("PAYTM*MUMBAI 1234"), "paytm");
  assert.equal(normaliseDescriptor("AMZN*MKPL*IN 5678"), "amzn");
  assert.equal(normaliseDescriptor("SWIGGY"), "swiggy");
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n── ${pass} passed, ${fail} failed\n`);
// Teardown: close server, close DB, remove temp vault — on both success and failure.
api.close().catch(() => {});
db.close();
fs.rmSync(vault, { recursive: true, force: true });
process.exitCode = fail > 0 ? 1 : 0;
