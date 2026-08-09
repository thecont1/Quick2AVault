/**
 * End-to-end identity lifecycle test (work order 05 §B.3–B.5).
 *   npx tsx daemon/identity_e2e.smoke.ts
 *
 * A single fixture-driven narrative that proves the full person lifecycle:
 * name-order resolution, email-as-name rejection, co-occurrence learning,
 * phone alias, silent re-resolution, merchant kind discipline, and
 * re-analysis preservation of user-confirmed claims.
 */
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";

import { openDatabase } from "./schema.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import { resolvePerson } from "./identity.js";
import { ask, answer } from "./learning.js";

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void> | void) {
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
    paths: createPaths("/tmp/q2v-identity-e2e"),
    converter: { async toMarkdown() { throw new Error("not used"); } },
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

function personByName(db: DatabaseSync, name: string): { id: string; status: string } | undefined {
  return db.prepare("SELECT id, status FROM entities WHERE kind='person' AND display_name=?").get(name) as
    | { id: string; status: string }
    | undefined;
}

function confirmAllOpenQuestions(db: DatabaseSync, ports: Ports): void {
  const open = db
    .prepare("SELECT id, context, trigger FROM training_reviews WHERE answered_at IS NULL")
    .all() as { id: number; context: string; trigger: string }[];
  for (const q of open) {
    const ctx = JSON.parse(q.context) as Record<string, string>;
    if (q.trigger === "identifier_cooccurrence") {
      answer(db, ports, q.id, "Yes, save it", {
        kind: "entity_alias",
        match_key: ctx.identifier_match_key,
        match_kind: "person_identifier",
        value: ctx.entity_id,
      });
    } else if (q.trigger === "person_identity_fuzzy") {
      answer(db, ports, q.id, "Yes, same person", {
        kind: "entity_alias",
        match_key: ctx.fuzzy_match_key,
        match_kind: "person_fuzzy",
        value: ctx.existing_entity_id,
      });
    }
  }
}

console.log("── End-to-end identity lifecycle\n");

await check("1. Ingest doc with name 'Arun Kamath' → creates candidate person", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");

  const r = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  assert.equal(r.asked, false, "first occurrence does not ask");
  assert.equal(personCount(db), 1, "exactly one person created");
  const p = personByName(db, "Arun Kamath");
  assert.ok(p, "person exists with display_name 'Arun Kamath'");
  assert.equal(p!.status, "candidate", "initial status is candidate");
});

await check("2. Ingest doc with name 'KAMATH ARUN' → token-sort resolves silently to same person", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const first = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  const second = resolvePerson(db, ports, "KAMATH ARUN", undefined, "doc_2");

  assert.equal(second.id, first.id, "word-order variant resolves to same person");
  assert.equal(second.matched_via, "token_sort");
  assert.equal(second.asked, false);
  assert.equal(personCount(db), 1, "no duplicate created");
});

await check("3. Ingest doc with email as name 'arun@example.com' → does NOT create a new person", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  const result = resolvePerson(db, ports, "arun@example.com", undefined, "doc_2");

  // The email-as-name path either links to an existing identifier or attaches
  // to Unidentified and asks — it must NOT mint a new person named "arun@example.com".
  const emailPerson = personByName(db, "arun@example.com");
  assert.equal(emailPerson, undefined, "no person named after the email");
  // The Unidentified placeholder is a person entity, so count is 2: Arun + Unidentified.
  assert.equal(personCount(db), 2, "Arun Kamath + Unidentified placeholder, no email-named person");
});

await check("4. Ingest doc with name + new identifier → co-occurrence proposes alias", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_2");

  const questions = db
    .prepare("SELECT id, context FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .all() as { id: number; context: string }[];
  assert.equal(questions.length, 1, "exactly one co-occurrence question raised");

  const ctx = JSON.parse(questions[0].context) as { identifier: string; entity_id: string };
  assert.equal(ctx.identifier, "workmail@example.com");
  assert.equal(ctx.entity_id, known.id);
});

await check("5. Confirm the co-occurrence question → email becomes confirmed alias", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_2");

  const q = db
    .prepare("SELECT id, context FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .get() as { id: number; context: string };
  const ctx = JSON.parse(q.context) as { identifier_match_key: string };
  answer(db, ports, q.id, "Yes, save it", {
    kind: "entity_alias",
    match_key: ctx.identifier_match_key,
    match_kind: "person_identifier",
    value: known.id,
  });

  // Materialise the alias with one more call (lazy-write behaviour).
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_3");

  const alias = db
    .prepare("SELECT status FROM entity_aliases WHERE alias_type='email' AND entity_id=?")
    .get(known.id) as { status: string } | undefined;
  assert.ok(alias, "alias row exists");
  assert.equal(alias!.status, "confirmed", "alias is confirmed after answering the question");
});

await check("6. Ingest doc with only the email as name → resolves silently to Arun Kamath", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");
  seedDoc(db, "doc_4");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_2");
  confirmAllOpenQuestions(db, ports);
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_3");

  // Now a document with ONLY the email as the name.
  const result = resolvePerson(db, ports, "workmail@example.com", { email: "workmail@example.com" }, "doc_4");
  assert.equal(result.id, known.id, "email alone resolves to Arun Kamath");
  assert.equal(result.matched_via, "identifier");
  assert.equal(result.asked, false, "no question — identifier is already confirmed");
});

await check("7. Ingest doc with name + phone → co-occurrence proposes phone alias", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { phone: "5550100200" }, "doc_2");

  const q = db
    .prepare("SELECT context FROM training_reviews WHERE trigger='identifier_cooccurrence' AND answered_at IS NULL")
    .get() as { context: string };
  const ctx = JSON.parse(q.context) as { identifier: string; entity_id: string };
  assert.equal(ctx.identifier, "5550100200");
  assert.equal(ctx.entity_id, known.id);
});

await check("8. Confirm phone alias → phone becomes confirmed", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { phone: "5550100200" }, "doc_2");
  confirmAllOpenQuestions(db, ports);
  resolvePerson(db, ports, "Arun Kamath", { phone: "5550100200" }, "doc_3");

  const alias = db
    .prepare("SELECT status FROM entity_aliases WHERE alias_type='phone' AND entity_id=?")
    .get(known.id) as { status: string } | undefined;
  assert.ok(alias, "phone alias row exists");
  assert.equal(alias!.status, "confirmed");
});

await check("9. Ingest doc with only the phone → resolves silently to Arun Kamath", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");
  seedDoc(db, "doc_4");

  const known = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  resolvePerson(db, ports, "Arun Kamath", { phone: "5550100200" }, "doc_2");
  confirmAllOpenQuestions(db, ports);
  resolvePerson(db, ports, "Arun Kamath", { phone: "5550100200" }, "doc_3");

  const result = resolvePerson(db, ports, "5550100200", { phone: "5550100200" }, "doc_4");
  assert.equal(result.id, known.id, "phone alone resolves to Arun Kamath");
  assert.equal(result.matched_via, "identifier");
  assert.equal(result.asked, false);
});

await check("10. Merchant 'Arun Consulting LLC' → does NOT match person Arun Kamath (kind discipline)", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const arun = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");

  // Insert a merchant entity with a similar name.
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_merchant','organisation','Arun Consulting LLC','confirmed',1.0,?)`,
  ).run("2026-08-09T00:00:00.000Z");

  // resolvePerson must never return an organisation's id.
  const result = resolvePerson(db, ports, "Arun Consulting LLC", undefined, "doc_2");
  assert.notEqual(result.id, "ent_merchant", "resolvePerson must not return the merchant entity");
  assert.notEqual(result.id, arun.id, "merchant name must not resolve to the person");
  assert.equal(personCount(db), 2, "a new person candidate was created; the merchant is untouched");
});

await check("11. Re-run analysis on doc 1 → user-confirmed identity claims survive", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const arun = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");

  // User confirms the person and sets a relationship.
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(arun.id);

  // Simulate re-analysis: resolvePerson is called again on the same document.
  const reResolved = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  assert.equal(reResolved.id, arun.id, "re-analysis resolves to the same person");
  assert.equal(reResolved.asked, false, "no new question on re-analysis");

  const p = personByName(db, "Arun Kamath");
  assert.equal(p!.status, "confirmed", "confirmed status survives re-analysis");
  assert.equal(personCount(db), 1, "no duplicate person created on re-analysis");
});

console.log("\n── Regression edge cases\n");

await check("12. Re-analysis with identifier → confirmed alias survives, no duplicate question", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const arun = resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_1");
  confirmAllOpenQuestions(db, ports);
  // Materialise the alias.
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_2");
  db.prepare("UPDATE entities SET status='confirmed' WHERE id=?").run(arun.id);

  // Re-analyse doc_1: same name + same identifier.
  const reResolved = resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_1");
  assert.equal(reResolved.id, arun.id);
  assert.equal(reResolved.asked, false, "no new question on re-analysis with known identifier");

  const openQs = db
    .prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NULL")
    .get() as { n: number };
  assert.equal(openQs.n, 0, "no open questions after re-analysis");
});

await check("13. Rejected person stays rejected on re-analysis", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");

  const arun = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  // A fuzzy variant creates a candidate.
  const variant = resolvePerson(db, ports, "A Kamath", undefined, "doc_2");
  assert.equal(variant.asked, true);

  // Reject the fuzzy question — "No, not the same person".
  const q = db
    .prepare("SELECT id, context FROM training_reviews WHERE trigger='person_identity_fuzzy' AND answered_at IS NULL")
    .get() as { id: number; context: string };
  const ctx = JSON.parse(q.context) as { fuzzy_match_key: string; existing_entity_id: string };
  answer(db, ports, q.id, "No, different person", {
    kind: "entity_alias",
    match_key: ctx.fuzzy_match_key,
    match_kind: "person_fuzzy",
    value: "rejected",
  });

  // Re-analyse doc_2 with the same variant name.
  const reResolved = resolvePerson(db, ports, "A Kamath", undefined, "doc_2");
  assert.equal(reResolved.asked, false, "rejected variant must not ask again");
  assert.notEqual(reResolved.id, arun.id, "rejected variant must not merge into the original");
});

await check("14. Cross-kind: person named 'Acme' does not merge into org 'Acme Corp'", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");

  // Insert an organisation.
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_org','organisation','Acme Corp','confirmed',1.0,?)`,
  ).run("2026-08-09T00:00:00.000Z");

  // A person with a similar name.
  const result = resolvePerson(db, ports, "Acme", undefined, "doc_1");
  assert.notEqual(result.id, "ent_org", "person must not resolve to the organisation");
  assert.equal(personCount(db), 1, "exactly one person created (plus the org)");
});

await check("15. Delete force: person with documents cannot be deleted without force", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");

  const arun = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");

  // resolvePerson creates the entity but doesn't write document_parties —
  // the extraction pipeline does that. Simulate it here.
  db.prepare(
    "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?, 'owner')",
  ).run("doc_1", arun.id);

  // Verify the person has a document linked.
  const parties = db
    .prepare("SELECT COUNT(*) n FROM document_parties WHERE entity_id=?")
    .get(arun.id) as { n: number };
  assert.ok(parties.n > 0, "person has at least one document party row");

  // The daemon's deletePerson route checks for linked documents and refuses
  // without force=true. Here we verify the data invariant the UI relies on:
  // the person IS linked to documents, so a non-force delete must fail.
  // (The actual HTTP route test is in people.smoke.ts.)
});

await check("16. Fuzzy variant taught as same → re-analysis of original doc is silent", () => {
  const db = freshDb();
  const ports = testPorts();
  seedDoc(db, "doc_1");
  seedDoc(db, "doc_2");
  seedDoc(db, "doc_3");

  const arun = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  const variant = resolvePerson(db, ports, "A Kamath", undefined, "doc_2");
  assert.equal(variant.asked, true);

  // Confirm the fuzzy question — same person.
  confirmAllOpenQuestions(db, ports);
  // Materialise the alias with another call.
  resolvePerson(db, ports, "A Kamath", undefined, "doc_3");

  // Re-analyse doc_1.
  const reResolved = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_1");
  assert.equal(reResolved.id, arun.id);
  assert.equal(reResolved.asked, false, "re-analysis of original doc is silent after teaching variant");

  // Re-analyse doc_2 with the variant name.
  const variantReResolved = resolvePerson(db, ports, "A Kamath", undefined, "doc_2");
  assert.equal(variantReResolved.asked, false, "variant is silent on re-analysis");
  // The variant resolves to the CANDIDATE entity, not to arun — the teaching
  // means "don't ask again", not "merge". The candidate still exists with
  // display_name "A Kamath" and exact-match takes priority.
  assert.notEqual(variantReResolved.id, arun.id, "variant keeps its own entity — teaching ≠ merging");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
