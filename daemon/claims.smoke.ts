/**
 * Claims + resolver acceptance tests (work order 03 §P2).
 *   npx tsx daemon/claims.smoke.ts
 *
 * These are the five acceptance scenarios from the work order, plus the
 * authority invariants the resolver rests on. They run entirely in-memory
 * with no AI calls.
 *
 * Why these five and not "unit tests for claims.ts": each one is a way the
 * naive implementation silently loses a user's correction. Orphan documents
 * have no transaction to write to; statements have too many; settlement and
 * invoice disagree about the amount; re-extraction happily overwrites the fix.
 * A test suite that only checks writeClaim() returns an id would pass while
 * every one of those broke.
 */
import { DatabaseSync } from "node:sqlite";
import * as assert from "node:assert";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import {
  writeClaim,
  winningClaim,
  claimsFor,
  resolveTransaction,
  propagateFromDocument,
  allowedFields,
  ClaimRefused,
  audit,
  setDocumentParty,
} from "./claims.js";
import type { Ports } from "./ports.js";

const logger = createLogger("error");
const ports: Ports = {
  logger,
  clock: systemClock,
  paths: createPaths("/tmp/q2v-claims-smoke"),
  converter: {
    async toMarkdown() {
      return { markdown: "", converter: "stub", converterVersion: "smoke@1" };
    },
  },
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

// ── fixtures ────────────────────────────────────────────────────────────────

function freshDb(): DatabaseSync {
  return openDatabase(":memory:");
}

function seedDoc(
  db: DatabaseSync,
  id: string,
  opts: { amount?: number; date?: string; counterparty?: string; docType?: string } = {},
): string {
  const x = {
    doc_type: opts.docType ?? "merchant_invoice",
    amount_minor: opts.amount ?? 100000,
    currency: "INR",
    occurred_at: opts.date ?? "2026-05-01",
    counterparty_descriptor: opts.counterparty ?? "ACME CORP",
    parties: [{ role: "counterparty", kind: "organisation", name: opts.counterparty ?? "Acme Corp" }],
    confidence: 0.9,
  };
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, ext, byte_size, raw_path, markdown_path,
                            doc_type, source, extraction_json, extraction_version, received_at)
     VALUES (?,?,?,?,?,?,?,?,'test',?,1,?)`,
  ).run(
    id,
    "sha_" + id,
    id + ".pdf",
    ".pdf",
    1024,
    "/tmp/" + id + ".pdf",
    "/tmp/" + id + ".md",
    x.doc_type,
    JSON.stringify(x),
    "2026-05-01T00:00:00Z",
  );
  return id;
}

function seedTxn(db: DatabaseSync, id: string, opts: { amount?: number; date?: string } = {}): string {
  db.prepare(
    `INSERT INTO transactions (id, direction, amount_minor, currency, occurred_at, fy_key, status, created_at)
     VALUES (?, 'out', ?, 'INR', ?, 'FY 2026-27', 'evidenced', ?)`,
  ).run(id, opts.amount ?? 100000, opts.date ?? "2026-05-01", "2026-05-01T00:00:00Z");
  return id;
}

function link(db: DatabaseSync, txnId: string, docId: string, role: string) {
  db.prepare(
    `INSERT OR REPLACE INTO transaction_documents
       (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
     VALUES (?,?,?,1.0,'test',?)`,
  ).run(txnId, docId, role, "2026-05-01T00:00:00Z");
}

function amountOf(db: DatabaseSync, txnId: string): number {
  return (db.prepare("SELECT amount_minor FROM transactions WHERE id=?").get(txnId) as { amount_minor: number })
    .amount_minor;
}

console.log("\nClaims + resolver (work order 03 §P2)\n");

// ── authority invariants ────────────────────────────────────────────────────

check("a user claim outranks an ai claim on the same field", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_a");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "Wrong Ltd", source: "ai" });
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "Right Ltd", source: "user" });
  assert.equal(winningClaim(db, "document", d, "vendor")?.value, "Right Ltd");
  db.close();
});

check("a confirmed user claim is NOT overwritten by a later ai claim", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_b");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "Right Ltd", source: "user" });
  assert.throws(
    () =>
      writeClaim(db, ports, {
        subject: "document",
        subjectId: d,
        field: "vendor",
        value: "Model Guess",
        source: "ai",
      }),
    (e: Error) => e instanceof ClaimRefused && (e as ClaimRefused).code === "confirmed_claim_protected",
  );
  assert.equal(winningClaim(db, "document", d, "vendor")?.value, "Right Ltd");
  db.close();
});

check("import authority sits below user, above ai", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_c");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "AI Co", source: "ai" });
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "Imported Co", source: "import" });
  assert.equal(winningClaim(db, "document", d, "vendor")?.value, "Imported Co");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "User Co", source: "user" });
  assert.equal(winningClaim(db, "document", d, "vendor")?.value, "User Co");
  db.close();
});

check("a field outside the subject's scope is refused, not silently stored", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_d");
  // impact_bucket is transaction-scope; a document cannot claim it.
  assert.throws(
    () =>
      writeClaim(db, ports, {
        subject: "document",
        subjectId: d,
        field: "impact_bucket",
        value: "groceries",
        source: "user",
      }),
    (e: Error) => e instanceof ClaimRefused && (e as ClaimRefused).code === "field_out_of_scope",
  );
  db.close();
});

check("document, transaction and entity scopes expose different fields", () => {
  assert.ok(allowedFields("document").has("doc_type"));
  assert.ok(!allowedFields("document").has("impact_bucket"));
  assert.ok(allowedFields("transaction").has("impact_bucket"));
  assert.ok(allowedFields("entity").has("display_name"));
});

check("setDocumentParty rolls back owner replacement when claim persistence fails", () => {
  const db = freshDb();
  seedDoc(db, "doc_party_txn");
  db.prepare(
    `INSERT INTO entities(id,kind,display_name,status,confidence,created_at)
     VALUES(?, 'person', ?, 'confirmed', 1, ?)`,
  ).run("person_old", "Old Owner", "2026-08-10T00:00:00Z");
  db.prepare(
    `INSERT INTO entities(id,kind,display_name,status,confidence,created_at)
     VALUES(?, 'person', ?, 'confirmed', 1, ?)`,
  ).run("person_new", "New Owner", "2026-08-10T00:00:00Z");
  db.prepare(
    `INSERT INTO document_parties(document_id,entity_id,role,confidence,provenance)
     VALUES(?, ?, 'owner', 1, 'user-confirmed')`,
  ).run("doc_party_txn", "person_old");
  db.exec(`
    CREATE TRIGGER refuse_party_claim
    BEFORE INSERT ON field_claims
    WHEN NEW.subject_type='document_party'
    BEGIN SELECT RAISE(ABORT, 'forced claim failure'); END;
  `);

  try {
    assert.throws(
      () => setDocumentParty(db, ports, {
        documentId: "doc_party_txn",
        entityId: "person_new",
        role: "owner",
      }),
      /forced claim failure/,
    );
    const owners = db.prepare(
      "SELECT entity_id FROM document_parties WHERE document_id=? AND role='owner'",
    ).all("doc_party_txn") as Array<{ entity_id: string }>;
    assert.deepEqual(owners.map((row) => row.entity_id), ["person_old"]);
  } finally {
    db.close();
  }
});

// ── acceptance 1: edit vendor → linked transaction's counterparty updates ────

check("ACCEPTANCE 1 — editing a document vendor re-resolves the linked txn", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_v", { counterparty: "SWIGGY*BLR 080" });
  const t = seedTxn(db, "txn_v");
  link(db, t, d, "merchant_invoice");

  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_sw','organisation','Swiggy Limited','confirmed',1.0,?)`,
  ).run("2026-05-01T00:00:00Z");

  writeClaim(db, ports, {
    subject: "document",
    subjectId: d,
    field: "counterparty",
    value: "Swiggy Limited",
    source: "user",
  });
  const results = propagateFromDocument(db, ports, d, ["counterparty"]);

  assert.equal(results.length, 1, "one linked transaction should re-resolve");
  const cp = db.prepare("SELECT counterparty_entity_id FROM transactions WHERE id=?").get(t) as {
    counterparty_entity_id: string | null;
  };
  assert.equal(cp.counterparty_entity_id, "ent_sw", "counterparty should point at the corrected entity");
  db.close();
});

// ── acceptance 2: sole-evidence amount edit moves the total ──────────────────

check("ACCEPTANCE 2 — editing the amount on a sole-evidence doc moves the ledger", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_amt", { amount: 243800 });
  const t = seedTxn(db, "txn_amt", { amount: 243800 });
  link(db, t, d, "merchant_invoice");

  assert.equal(amountOf(db, t), 243800);
  writeClaim(db, ports, {
    subject: "document",
    subjectId: d,
    field: "amount_minor",
    value: "81200",
    source: "user",
  });
  propagateFromDocument(db, ports, d, ["amount_minor"]);
  assert.equal(amountOf(db, t), 81200, "the corrected amount should reach the transaction");
  db.close();
});

// ── acceptance 3: settlement wins over invoice ──────────────────────────────

check("ACCEPTANCE 3 — settlement beats a corrected invoice; mismatch is surfaced", () => {
  const db = freshDb();
  const invoice = seedDoc(db, "doc_inv", { amount: 100000 });
  const card = seedDoc(db, "doc_card", { amount: 100000, docType: "card_confirmation" });
  const t = seedTxn(db, "txn_multi", { amount: 100000 });
  link(db, t, invoice, "merchant_invoice");
  link(db, t, card, "card_confirmation");

  // The user corrects the INVOICE to a different amount.
  writeClaim(db, ports, {
    subject: "document",
    subjectId: invoice,
    field: "amount_minor",
    value: "95000",
    source: "user",
  });
  const [r] = propagateFromDocument(db, ports, invoice, ["amount_minor"]);

  assert.equal(amountOf(db, t), 100000, "canonical amount must stay at the SETTLEMENT figure");
  assert.equal(
    winningClaim(db, "document", invoice, "amount_minor")?.value,
    "95000",
    "the document must still show the corrected value",
  );
  assert.ok(
    r.mismatches.some((m) => m.field === "amount_minor" && m.document_id === invoice),
    "the disagreement must be reported, not swallowed",
  );
  db.close();
});

// ── acceptance 4: orphan document ───────────────────────────────────────────

check("ACCEPTANCE 4 — an orphan doc stores the claim; linking later applies it", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_orphan", { amount: 50000 });

  writeClaim(db, ports, {
    subject: "document",
    subjectId: d,
    field: "amount_minor",
    value: "42000",
    source: "user",
  });
  const none = propagateFromDocument(db, ports, d, ["amount_minor"]);
  assert.equal(none.length, 0, "an orphan resolves no transactions and that is not an error");
  assert.equal(winningClaim(db, "document", d, "amount_minor")?.value, "42000", "the claim survives");

  // Link it later — the stored claim must now take effect.
  const t = seedTxn(db, "txn_late", { amount: 50000 });
  link(db, t, d, "merchant_invoice");
  resolveTransaction(db, ports, t);
  assert.equal(amountOf(db, t), 42000, "linking applies the previously stored claim");
  db.close();
});

// ── acceptance 5: confirmed claims survive re-extraction ────────────────────

check("ACCEPTANCE 5 — a confirmed claim survives re-extraction", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_re", { amount: 100000 });
  const t = seedTxn(db, "txn_re", { amount: 100000 });
  link(db, t, d, "merchant_invoice");

  writeClaim(db, ports, {
    subject: "document",
    subjectId: d,
    field: "amount_minor",
    value: "77000",
    source: "user",
  });
  propagateFromDocument(db, ports, d, ["amount_minor"]);
  assert.equal(amountOf(db, t), 77000);

  // Simulate re-extraction: the model writes a fresh opinion over the same
  // document. This is the exact path that used to destroy corrections.
  db.prepare("UPDATE documents SET extraction_json=? WHERE id=?").run(
    JSON.stringify({ doc_type: "merchant_invoice", amount_minor: 100000, currency: "INR", confidence: 0.9 }),
    d,
  );
  assert.throws(
    () =>
      writeClaim(db, ports, {
        subject: "document",
        subjectId: d,
        field: "amount_minor",
        value: "100000",
        source: "ai",
      }),
    (e: Error) => e instanceof ClaimRefused,
  );
  resolveTransaction(db, ports, t);
  assert.equal(amountOf(db, t), 77000, "the correction must still stand after re-extraction");
  db.close();
});

// ── idempotency + audit ─────────────────────────────────────────────────────

check("re-resolving with no new claims changes nothing", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_idem", { amount: 60000 });
  const t = seedTxn(db, "txn_idem", { amount: 60000 });
  link(db, t, d, "merchant_invoice");

  const first = resolveTransaction(db, ports, t);
  const second = resolveTransaction(db, ports, t);
  assert.equal(second?.changed.length, 0, "a second resolve must be a no-op");
  assert.ok(first !== null);
  db.close();
});

check("an edit appends to review_audit rather than replacing history", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_aud");
  audit(db, ports, {
    subject: "document",
    subjectId: d,
    field: "vendor",
    action: "edit",
    oldValue: "A",
    newValue: "B",
  });
  audit(db, ports, {
    subject: "document",
    subjectId: d,
    field: "vendor",
    action: "edit",
    oldValue: "B",
    newValue: "C",
  });
  const rows = db.prepare("SELECT old_value, new_value FROM review_audit WHERE subject_id=? ORDER BY id").all(d) as {
    old_value: string;
    new_value: string;
  }[];
  assert.equal(rows.length, 2, "both edits must be retained");
  assert.equal(rows[0].new_value, "B");
  assert.equal(rows[1].new_value, "C");
  db.close();
});

check("editing the same field twice retires the first claim", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_twice");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "First", source: "user" });
  const second = writeClaim(db, ports, {
    subject: "document",
    subjectId: d,
    field: "vendor",
    value: "Second",
    source: "user",
  });
  assert.equal(second.superseded, 1, "the earlier user claim must be superseded, not left live");

  const live = db
    .prepare(
      `SELECT COUNT(*) n FROM field_claims
        WHERE subject_id=? AND field='vendor' AND status NOT IN ('rejected','superseded')`,
    )
    .get(d) as { n: number };
  assert.equal(live.n, 1, "exactly one live claim per field");
  assert.equal(winningClaim(db, "document", d, "vendor")?.value, "Second");
  db.close();
});

check("claimsFor returns one winning claim per field", () => {
  const db = freshDb();
  const d = seedDoc(db, "doc_many");
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "V1", source: "ai" });
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "vendor", value: "V2", source: "user" });
  writeClaim(db, ports, { subject: "document", subjectId: d, field: "doc_type", value: "merchant_invoice", source: "user" });
  const all = claimsFor(db, "document", d);
  assert.equal(Object.keys(all).length, 2, "two fields, not three claims");
  assert.equal(all.vendor.value, "V2");
  db.close();
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
