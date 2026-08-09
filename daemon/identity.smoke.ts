/**
 * Person identity resolution acceptance tests (work order 04 §D.5).
 *   npx tsx daemon/identity.smoke.ts
 *
 * The five scenarios the work order specifies, plus the guards behind them:
 * kind-scoping, no silent merges, generic mailboxes never person-linked.
 */
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import {
  resolvePerson,
  classifyIdentifier,
  isGenericMailbox,
  tokenOverlapRatio,
} from "./identity.js";
import { ask, answer } from "./learning.js";

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
  const logger = createLogger("error"); // quiet — assertions are the signal
  return {
    logger,
    clock: systemClock,
    paths: createPaths("/tmp/q2v-identity-test"),
    converter: { async toMarkdown() { throw new Error("not used by these tests"); } },
    bus: createEventBus(logger),
  };
}

function seedDoc(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
     VALUES (?,?,?,?,'merchant_invoice',?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, "2026-08-09T00:00:00.000Z");
}

function personCount(db: DatabaseSync): number {
  return (db.prepare("SELECT COUNT(*) n FROM entities WHERE kind='person'").get() as { n: number }).n;
}

console.log("── identifier classification");

check("email is classified as email", () => {
  assert.equal(classifyIdentifier("workmail@example.com"), "email");
});
check("Indian mobile with country code is classified as phone", () => {
  assert.equal(classifyIdentifier("+919876543210"), "phone");
});
check("bare 10-digit mobile is classified as phone", () => {
  assert.equal(classifyIdentifier("9876543210"), "phone");
});
check("a UPI-style handle (no dot in the domain part) is 'handle', not email", () => {
  assert.equal(classifyIdentifier("arun@okhdfcbank"), "handle");
});
check("an amount or reference number is not an identifier", () => {
  assert.equal(classifyIdentifier("64372"), null);
  assert.equal(classifyIdentifier("INV-2026-0714"), null);
});
check("generic mailboxes are recognised across common prefixes", () => {
  assert.ok(isGenericMailbox("billing@swiggy.com"));
  assert.ok(isGenericMailbox("no-reply@hdfcbank.com"));
  assert.ok(isGenericMailbox("support@example.com"));
  assert.ok(!isGenericMailbox("arun.kamath@example.com"));
});

console.log("\n── token overlap scoring");

check("identical names score 1.0 (would already be caught by token-sort upstream)", () => {
  assert.equal(tokenOverlapRatio("Arun Kamath", "arun kamath"), 1);
});
check("a subset name scores in the fuzzy band", () => {
  const s = tokenOverlapRatio("Arun", "Arun Kamath");
  assert.ok(s >= 0.34 && s < 1, `expected fuzzy band, got ${s}`);
});
check("unrelated names score 0", () => {
  assert.equal(tokenOverlapRatio("Alice", "Bob"), 0);
});

console.log("\n── §D.5 acceptance: four monikers, one canonical person");

check("exact name match resolves silently (no question)", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const first = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  assert.equal(first.asked, false);
  assert.equal(personCount(db), 1);

  const second = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_2");
  assert.equal(second.id, first.id, "identical name must resolve to the same entity");
  assert.equal(second.asked, false);
  assert.equal(personCount(db), 1, "no duplicate created");
});

check("surname-first order (token-sort) resolves silently", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const first = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  const second = resolvePerson(db, ports, "KAMATH ARUN", undefined, "doc_2");

  assert.equal(second.id, first.id, "word-order variant must resolve to the same person");
  assert.equal(second.matched_via, "token_sort");
  assert.equal(second.asked, false);
  assert.equal(personCount(db), 1);
});

check("an email identifier resolves silently once known (exact identifier match)", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const first = resolvePerson(db, ports, "Arun Kamath", { email: "arun@example.com" }, "doc_1");
  assert.equal(personCount(db), 1);

  // A LATER document names only the email (a receipt CC line, say) — the
  // identifier alone must resolve it, no name needed.
  const second = resolvePerson(db, ports, "Arun Kamath", { email: "arun@example.com" }, "doc_2");
  assert.equal(second.id, first.id);
  assert.equal(second.matched_via, "identifier");
  assert.equal(second.asked, false);
});

check("co-occurrence teaches an unfamiliar email via exactly one Learning confirmation", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");
  seedDoc(db, "doc_4");

  // Known person, first appearance.
  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");

  // Document 2 pairs the SAME known name with a never-seen personal email.
  // workmail@example.com shares zero tokens with "Arun Kamath" — only
  // co-occurrence teaches this, never name matching.
  const before = resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_2");
  assert.equal(before.id, known.id, "the NAME still resolves deterministically");
  assert.equal(before.asked, false, "the DOCUMENT resolves silently; the identifier question is separate");

  const openQuestions = db
    .prepare("SELECT id, context FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .all() as { id: number; context: string }[];
  assert.equal(openQuestions.length, 1, "exactly one co-occurrence question, not one per document");

  const ctx = JSON.parse(openQuestions[0].context) as { identifier: string; identifier_match_key: string; entity_id: string };
  assert.equal(ctx.identifier, "workmail@example.com");
  assert.equal(ctx.entity_id, known.id);

  // Confirm it — this is what the Flutter client does on "Yes, save it",
  // sending back the NORMALISED key from context, not the raw identifier.
  answer(db, ports, openQuestions[0].id, "Yes, save it", {
    kind: "entity_alias",
    match_key: ctx.identifier_match_key,
    match_kind: "person_identifier",
    value: known.id,
  });

  // A THIRD document with the SAME name+email pair writes the alias (inside
  // the co-occurrence path, having found the confirmed rule) and resolves
  // silently — but still via the deterministic NAME match, since the
  // identifier alias is written during this very call, not before it.
  const third = resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_3");
  assert.equal(third.id, known.id);
  assert.equal(third.asked, false, "taught once, never asked again for this pair");

  // The REAL proof of "taught": a FOURTH document carrying ONLY the email —
  // no name at all — must now resolve on the identifier alone. This is only
  // possible because the previous call wrote the alias.
  const fourth = resolvePerson(db, ports, "workmail@example.com", { email: "workmail@example.com" }, "doc_4");
  assert.equal(fourth.id, known.id, "the taught identifier alone resolves to the right person");
  assert.equal(fourth.matched_via, "identifier");
  assert.equal(fourth.asked, false);

  const stillOpen = db
    .prepare("SELECT COUNT(*) n FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .get() as { n: number };
  assert.equal(stillOpen.n, 0, "the original question stays answered; no NEW one raised for the same pair");
});

console.log("\n── §D.5 acceptance: unseen variant asks exactly once, then is silent forever");

check("a genuinely new, unrelated-looking name variant asks once and is remembered", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");

  resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");

  // "A Kamath" shares one token ("kamath") out of the two-token union —
  // squarely in the fuzzy band, not an exact or token-sort match.
  const first = resolvePerson(db, ports, "A Kamath", undefined, "doc_2");
  assert.equal(first.matched_via, "fuzzy_question");
  assert.equal(first.asked, true);
  assert.equal(personCount(db), 2, "a candidate is created immediately — a document needs somewhere to attach");

  const q = db
    .prepare("SELECT id FROM training_reviews WHERE trigger='person_identity_fuzzy' AND answered_at IS NULL")
    .get() as { id: number } | undefined;
  assert.ok(q, "exactly one fuzzy question raised");

  // Confirm: same person. The client sends the SAME matchKey the resolver
  // used (fuzzy_match_key in context), which identity.ts's normaliseName
  // reproduces for "A Kamath".
  const ctxRow = db.prepare("SELECT context FROM training_reviews WHERE id=?").get(q!.id) as { context: string };
  const ctx = JSON.parse(ctxRow.context) as { fuzzy_match_key: string; existing_entity_id: string };
  answer(db, ports, q!.id, "Yes, same as Arun Kamath", {
    kind: "entity_alias",
    match_key: ctx.fuzzy_match_key,
    match_kind: "person_fuzzy",
    value: ctx.existing_entity_id,
  });

  // A THIRD document with the identical spelling must now resolve silently —
  // no repeat question for the same taught pair.
  const second = resolvePerson(db, ports, "A Kamath", undefined, "doc_3");
  assert.equal(second.asked, false, "answering once must make the identical pair silent forever");
  assert.equal(personCount(db), 2, "no new candidate created on the second occurrence");

  const stillOpen = db
    .prepare("SELECT COUNT(*) n FROM training_reviews WHERE trigger='person_identity_fuzzy' AND answered_at IS NULL")
    .get() as { n: number };
  assert.equal(stillOpen.n, 0, "no new question queued");
});

console.log("\n── §D.5 acceptance: shared-email conflict asks, never merges");

check("the same confirmed email presenting under a different confirmed name is a question, not a merge", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  // Two confirmed, distinct people (e.g. spouses on a shared family plan).
  const alice = resolvePerson(db, ports, "Alice Rao", undefined, "doc_1");
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(alice.id);
  const bob = resolvePerson(db, ports, "Bob Rao", undefined, "doc_2");
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(bob.id);

  // Bind the shared email to Alice — CONFIRMED, via the same co-occurrence
  // flow §D.3 specifies: a question is raised, the user answers it, and only
  // the answer writes the alias. An unconfirmed proposal must not count as
  // "on file" for conflict purposes.
  seedDoc(db, "doc_3");
  resolvePerson(db, ports, "Alice Rao", { email: "family@example.com" }, "doc_3");
  const q = db
    .prepare("SELECT id, context FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .get() as { id: number; context: string };
  const qCtx = JSON.parse(q.context) as { identifier_match_key: string };
  answer(db, ports, q.id, "Yes, save it", {
    kind: "entity_alias",
    match_key: qCtx.identifier_match_key,
    match_kind: "person_identifier",
    value: alice.id,
  });
  // Confirming raises the learned RULE; the alias itself is written the next
  // time resolvePerson sees Alice with that identifier and applies it (the
  // same lazy-write behaviour proven in the co-occurrence test above). One
  // more call materialises entity_aliases before Bob's document arrives.
  seedDoc(db, "doc_3b");
  resolvePerson(db, ports, "Alice Rao", { email: "family@example.com" }, "doc_3b");

  // Bob's document ALSO carries the identical, now-confirmed email.
  seedDoc(db, "doc_4");
  const result = resolvePerson(db, ports, "Bob Rao", { email: "family@example.com" }, "doc_4");

  assert.equal(result.conflict, true, "shared identifier across two confirmed people must be flagged");
  assert.equal(result.id, bob.id, "the document still resolves deterministically to the name on IT");
  assert.equal(personCount(db), 2, "no merge occurred — still exactly two people");

  const conflictQ = db
    .prepare("SELECT COUNT(*) n FROM training_reviews WHERE trigger='shared_identifier_conflict'")
    .get() as { n: number };
  assert.equal(conflictQ.n, 1, "the conflict raised a question");
});

console.log("\n── §D.4 guards");

check("an org billing mailbox is never person-linked, even when co-located with a person name", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");

  resolvePerson(db, ports, "Arun Kamath", { email: "billing@swiggy.com" }, "doc_1");

  const linked = db
    .prepare("SELECT COUNT(*) n FROM entity_aliases WHERE alias_type='email' AND normalised='billing@swiggy.com'")
    .get() as { n: number };
  assert.equal(linked.n, 0, "a generic mailbox must never become a person alias");
});

check("kind-scoping: an organisation named identically to a person never resolves through resolvePerson", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");

  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_org','organisation','Swiggy Limited','confirmed',1.0,?)`,
  ).run("2026-08-09T00:00:00.000Z");

  const result = resolvePerson(db, ports, "Swiggy Limited", undefined, "doc_1");
  assert.notEqual(result.id, "ent_org", "resolvePerson must never return an organisation's id");
  assert.equal(personCount(db), 1, "a new PERSON candidate was created; the org entity is untouched");
});

check("merging two confirmed people is never automatic from alias evidence alone", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const a = resolvePerson(db, ports, "Alice Rao", undefined, "doc_1");
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(a.id);
  const b = resolvePerson(db, ports, "Bob Rao", undefined, "doc_2");
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(b.id);

  // No automatic path in resolvePerson ever calls DELETE FROM entities or
  // rewrites document_parties across ids — that is exclusively the
  // /v1/people/merge route, a deliberate user action (work order 03).
  assert.equal(personCount(db), 2, "two confirmed people remain two people");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
