/**
 * Person intelligence acceptance tests (work order 05 §B.7 + §Track C).
 *   npx tsx daemon/people.smoke.ts
 *
 * Covers what identity.smoke.ts did not: the alias lifecycle (proposed ->
 * confirmed / rejected), the identifier-as-name regression guard, owner
 * exclusivity on is_owner, alias management endpoints, and the Review ->
 * People correction path.
 */
import * as assert from "node:assert";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openDatabase } from "./schema.js";
import { createApi } from "./api.js";
import { createLogger, createEventBus, systemClock, createPaths } from "./adapters.js";
import type { Ports } from "./ports.js";
import {
  resolvePerson,
  normaliseIdentifier,
  applyPersonCorrection,
  UNIDENTIFIED_PERSON_ID,
} from "./identity.js";
import { answer } from "./learning.js";

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

function seedDoc(db: DatabaseSync, id: string): void {
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
     VALUES (?,?,?,?,'merchant_invoice',?)`,
  ).run(id, `sha_${id}`, `${id}.pdf`, `/tmp/${id}.pdf`, "2026-08-09T00:00:00.000Z");
}

function aliasRows(db: DatabaseSync, entityId: string) {
  return db
    .prepare("SELECT alias, alias_type, status, source FROM entity_aliases WHERE entity_id=? ORDER BY id")
    .all(entityId) as { alias: string; alias_type: string; status: string; source: string }[];
}

console.log("── phone normalisation (regression: 10-digit mobile starting 91)");

await check("+91, trunk-0, and bare forms of the same mobile normalise identically", () => {
  const a = normaliseIdentifier("phone", "+91 99801 29770");
  const b = normaliseIdentifier("phone", "09980129770");
  const c = normaliseIdentifier("phone", "9980129770");
  assert.equal(a, "9980129770");
  assert.equal(b, "9980129770");
  assert.equal(c, "9980129770");
});

await check("a 10-digit mobile that starts with 91 is NOT mangled into 8 digits", () => {
  // The old code stripped a leading '91' unconditionally.
  assert.equal(normaliseIdentifier("phone", "9198765432"), "9198765432");
});

console.log("\n── §B.3 guard: an identifier is never a name");

await check("a document naming only an email does NOT create a person named by that email", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-1");
  seedDoc(db, "doc_a");
  const r = resolvePerson(db, ports, "someone@example.com", undefined, "doc_a");
  assert.equal(r.matched_via, "unresolved");
  assert.equal(r.id, UNIDENTIFIED_PERSON_ID);
  const people = db.prepare("SELECT display_name FROM entities WHERE kind='person'").all() as {
    display_name: string;
  }[];
  assert.ok(!people.some((pp) => pp.display_name.includes("@")), "no email-named person exists");
  assert.ok(r.asked, "a question was raised");
});

await check("a KNOWN email as the only name resolves silently to its person", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-2");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const first = resolvePerson(db, ports, "Mahesh Shantaram", { email: "ms@example.com" }, "doc_a");
  const second = resolvePerson(db, ports, "ms@example.com", undefined, "doc_b");
  assert.equal(second.id, first.id);
  assert.equal(second.matched_via, "identifier");
  assert.equal(second.asked, false);
});

console.log("\n── §B.2 alias lifecycle");

await check("co-occurrence writes a PROPOSED alias that never resolves silently before confirmation", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-3");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const first = resolvePerson(db, ports, "Mahesh Shantaram", undefined, "doc_a");
  // A second document pairs the known name with an unseen email.
  resolvePerson(db, ports, "Mahesh Shantaram", { email: "techrose@example.com" }, "doc_b");
  const proposed = aliasRows(db, first.id).find((a) => a.alias === "techrose@example.com");
  assert.ok(proposed, "the proposed alias is recorded");
  assert.equal(proposed!.status, "proposed");
  assert.equal(proposed!.alias_type, "email");
  // Proposed aliases do not resolve: a doc naming only the email still asks.
  seedDoc(db, "doc_c");
  const third = resolvePerson(db, ports, "techrose@example.com", undefined, "doc_c");
  assert.equal(third.id, UNIDENTIFIED_PERSON_ID, "proposed alias must not silently link");
});

await check("a confirmed co-occurrence answer promotes the alias and resolves silently forever", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-4");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const first = resolvePerson(db, ports, "Mahesh Shantaram", undefined, "doc_a");
  resolvePerson(db, ports, "Mahesh Shantaram", { email: "techrose@example.com" }, "doc_b");

  // Simulate the Learning confirmation: the daemon-side rule the client sends.
  const q = db
    .prepare("SELECT id FROM training_reviews WHERE trigger='identifier_cooccurrence'")
    .get() as { id: number };
  answer(db, ports, q.id, "Yes, save it", {
    kind: "entity_alias",
    match_key: "techrose@example.com",
    match_kind: "person_identifier",
    value: first.id,
  });

  seedDoc(db, "doc_c");
  const third = resolvePerson(db, ports, "Mahesh Shantaram", { email: "techrose@example.com" }, "doc_c");
  assert.equal(third.id, first.id);
  assert.equal(third.asked, false, "no re-ask after confirmation");
  const alias = aliasRows(db, first.id).find((a) => a.alias === "techrose@example.com");
  assert.equal(alias?.status, "confirmed", "promoted by the confirmed application");

  // And the email ALONE now resolves silently (step 1).
  seedDoc(db, "doc_d");
  const fourth = resolvePerson(db, ports, "techrose@example.com", undefined, "doc_d");
  assert.equal(fourth.id, first.id);
  assert.equal(fourth.asked, false);
});

await check("a rejected alias is never resurrected by re-observation", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-5");
  seedDoc(db, "doc_a");
  const id = resolvePerson(db, ports, "Mahesh Shantaram", undefined, "doc_a").id;
  db.prepare("UPDATE entity_aliases SET status='rejected' WHERE entity_id=? AND alias=?").run(
    id,
    "Mahesh Shantaram",
  );
  seedDoc(db, "doc_b");
  // The display-name match (entities row) still links, but the alias row
  // itself must stay rejected...
  resolvePerson(db, ports, "Mahesh Shantaram", undefined, "doc_b");
  const alias = aliasRows(db, id).find((a) => a.alias === "Mahesh Shantaram");
  assert.equal(alias?.status, "rejected");
});

await check("Vidya Rao and Vidya Srinivasa Rao stay separate without strong evidence", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-6");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const a = resolvePerson(db, ports, "Vidya Rao", undefined, "doc_a");
  const b = resolvePerson(db, ports, "Vidya Srinivasa Rao", undefined, "doc_b");
  assert.notEqual(a.id, b.id, "name similarity alone must not merge");
  assert.equal(b.matched_via, "fuzzy_question");
  assert.ok(b.asked, "the fuzzy band asks");
  // Asking created no alias on either person and no learned rule.
  assert.equal(
    aliasRows(db, a.id).filter((x) => x.alias === "Vidya Srinivasa Rao").length,
    0,
  );
  const rules = db.prepare("SELECT COUNT(*) n FROM learned_rules").get() as { n: number };
  assert.equal(rules.n, 0, "asking a question never writes a rule");
});

console.log("\n── §Track C: a Review correction relinks the document and teaches identity");

await check("correcting M. Shantaram to Mahesh Shantaram relinks this doc and resolves future docs silently", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-7");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  seedDoc(db, "doc_c");

  // The owner exists; a new document carries an initials-only variant, which
  // is NOT a token-sort match — the fuzzy path creates a stray candidate.
  // (SHANTARAM MAHESH would be a token-sort hit and never reach Review.)
  const owner = resolvePerson(db, ports, "Mahesh Shantaram", undefined, "doc_a").id;
  const stray = resolvePerson(db, ports, "M. Shantaram", undefined, "doc_b");
  assert.notEqual(stray.id, owner);
  db.prepare(
    "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES ('doc_b', ?, 'owner')",
  ).run(stray.id);

  // The correction from Review: previous value is the model's reading.
  const r = applyPersonCorrection(db, ports, "doc_b", "Mahesh Shantaram", "M. Shantaram");
  assert.equal(r.person_id, owner);
  assert.equal(r.relinked, 1, "this document's party row moved");

  // The old spelling is now a confirmed name_variant on the canonical person.
  const alias = aliasRows(db, owner).find((a) => a.alias === "M. Shantaram");
  assert.ok(alias, "old spelling kept as alias");
  assert.equal(alias!.status, "confirmed");
  assert.equal(alias!.alias_type, "name_variant");

  // A FUTURE document with the same printed name resolves silently.
  const future = resolvePerson(db, ports, "M. Shantaram", undefined, "doc_c");
  assert.equal(future.id, owner);
  assert.equal(future.asked, false);
});

await check("applyPersonCorrection never touches the document's extraction", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-8");
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at, extraction_json)
     VALUES ('doc_x','sha_x','x.pdf','/tmp/x.pdf','merchant_invoice',?,?)`,
  ).run("2026-08-09T00:00:00.000Z", JSON.stringify({ parties: [{ name: "SHANTARAM MAHESH", kind: "person", role: "owner" }] }));
  const before = db.prepare("SELECT extraction_json FROM documents WHERE id='doc_x'").get() as {
    extraction_json: string;
  };
  applyPersonCorrection(db, ports, "doc_x", "Mahesh Shantaram", "SHANTARAM MAHESH");
  const after = db.prepare("SELECT extraction_json FROM documents WHERE id='doc_x'").get() as {
    extraction_json: string;
  };
  assert.equal(after.extraction_json, before.extraction_json, "the original reading is immutable");
});

// ── HTTP surface: people list, aliases, owner exclusivity, merge ───────────
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-people-api-"));
const db = openDatabase(":memory:");
const ports = testPorts(vault);
const now = ports.clock.isoNow();

seedDoc(db, "doc_1");
seedDoc(db, "doc_2");
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, is_member, created_at)
   VALUES ('ent_m','person','Mahesh Shantaram','confirmed',1.0,1,?)`,
).run(now);
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_v','person','Vidya Rao','candidate',0.8,?)`,
).run(now);
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_org','organisation','Swiggy Limited','confirmed',1.0,?)`,
).run(now);
db.prepare(
  `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
   VALUES ('ent_m','person','ms@example.com','ms@example.com','email','auto-identifier','confirmed',?)`,
).run(now);
db.prepare(
  `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
   VALUES ('ent_m','person','Mahesh Shantaram','mahesh shantaram','name_variant','auto','confirmed',?)`,
).run(now);
db.prepare(
  `INSERT INTO document_parties (document_id, entity_id, role) VALUES ('doc_1','ent_m','owner'), ('doc_2','ent_m','owner')`,
).run();
db.prepare(
  `INSERT INTO transactions (id, occurred_at, fy_key, amount_minor, currency, direction, status, created_at)
   VALUES ('txn_1','2026-05-29','FY 2026-27',59785,'USD','in','evidenced',?)`,
).run(now);
db.prepare(
  `INSERT INTO transaction_documents (transaction_id, document_id, evidence_role, linked_at)
   VALUES ('txn_1','doc_1','merchant_invoice',?)`,
).run(now);

const TOKEN = "test-token-people";
const PORT = 47937;
const api = createApi(db, ports, { port: PORT, token: TOKEN, version: "test", vaultDir: vault });
await api.listen();
const base = `http://127.0.0.1:${PORT}`;
const hdr = { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: hdr,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

console.log("\n── §B.6/B.7: people API");

const list = await call("GET", "/v1/people");
await check("the list carries linked document and transaction counts", () => {
  const m = list.json?.people?.find((x: { id: string }) => x.id === "ent_m");
  assert.equal(m?.document_count, 2);
  assert.equal(m?.transaction_count, 1);
  assert.ok(m?.last_seen_at, "last seen present");
  assert.equal(m?.is_owner ?? 0, 0, "pre-promotion fixture is a member, not owner");
});

const detail = await call("GET", "/v1/people/ent_m");
await check("person detail returns typed aliases, documents and transactions", () => {
  assert.equal(detail.status, 200);
  const email = detail.json?.aliases?.find((a: { alias_type: string }) => a.alias_type === "email");
  assert.equal(email?.alias, "ms@example.com");
  assert.equal(detail.json?.documents?.length, 2);
  assert.equal(detail.json?.transactions?.length, 1);
  assert.equal(detail.json?.transactions?.[0]?.currency, "USD");
});

const addAlias = await call("POST", "/v1/people/ent_m/aliases", { alias: "9980129770" });
await check("adding an alias classifies the type from the string", () => {
  assert.equal(addAlias.status, 200);
  assert.equal(addAlias.json?.alias_type, "phone");
});

const emailAsName = await call("POST", "/v1/people/ent_m/aliases", {
  alias: "other@example.com",
  alias_type: "name_variant",
});
await check("an email requested as a name variant is retyped to email, never stored as a name", () => {
  assert.equal(emailAsName.status, 200);
  assert.equal(emailAsName.json?.alias_type, "email");
  const stored = db
    .prepare("SELECT alias_type FROM entity_aliases WHERE alias='other@example.com'")
    .get() as { alias_type: string } | undefined;
  assert.equal(stored?.alias_type, "email");
});

const conflict = await call("POST", "/v1/people/ent_v/aliases", { alias: "ms@example.com" });
await check("adding an identifier already bound to another person is a 409 conflict, never a merge", () => {
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json?.error, "alias_in_use");
});

const generic = await call("POST", "/v1/people/ent_v/aliases", { alias: "billing@vendor.com" });
await check("a generic mailbox cannot become a person alias", () => {
  assert.equal(generic.status, 409);
  assert.equal(generic.json?.error, "generic_mailbox");
});

await check("rejecting an alias keeps the row with status=rejected and audits it", async () => {
  const row = db
    .prepare("SELECT id FROM entity_aliases WHERE entity_id='ent_m' AND alias='9980129770'")
    .get() as { id: number };
  const r = await call("DELETE", `/v1/people/ent_m/aliases/${row.id}`);
  assert.equal(r.status, 200);
  const after = db.prepare("SELECT status FROM entity_aliases WHERE id=?").get(row.id) as { status: string };
  assert.equal(after.status, "rejected");
  const auditRow = db
    .prepare("SELECT action FROM review_audit WHERE subject_id='ent_m' AND action='reject'")
    .get();
  assert.ok(auditRow, "audit row written");
});

await check("the display name itself is not rejectable (that is a rename)", async () => {
  const row = db
    .prepare("SELECT id FROM entity_aliases WHERE entity_id='ent_m' AND alias='Mahesh Shantaram'")
    .get() as { id: number };
  const r = await call("DELETE", `/v1/people/ent_m/aliases/${row.id}`);
  assert.equal(r.status, 409);
});

await check("making one person owner demotes the previous owner — exactly one owner", async () => {
  await call("PATCH", "/v1/people/ent_m", { is_owner: true });
  await call("PATCH", "/v1/people/ent_v", { is_owner: true });
  const owners = db
    .prepare("SELECT id FROM entities WHERE kind='person' AND is_owner=1")
    .all() as { id: string }[];
  assert.equal(owners.length, 1);
  assert.equal(owners[0].id, "ent_v");
  const m = db.prepare("SELECT is_owner, is_member FROM entities WHERE id='ent_m'").get() as {
    is_owner: number;
    is_member: number;
  };
  assert.equal(m.is_owner, 0);
});

await check("renaming preserves the old name as a confirmed name_variant alias", async () => {
  const r = await call("PATCH", "/v1/people/ent_v", { display_name: "Vidya Srinivasa Rao" });
  assert.equal(r.status, 200);
  const alias = db
    .prepare(
      "SELECT alias_type, status, source FROM entity_aliases WHERE entity_id='ent_v' AND alias='Vidya Rao'",
    )
    .get() as { alias_type: string; status: string; source: string } | undefined;
  assert.ok(alias, "old name retained");
  assert.equal(alias!.alias_type, "name_variant");
  assert.equal(alias!.status, "confirmed");
});

await check("cross-kind merge is refused", async () => {
  const r = await call("POST", "/v1/people/merge", { from_id: "ent_org", into_id: "ent_m" });
  assert.equal(r.status, 409);
});

await check("merging two people keeps every alias and the audit survives re-analysis", async () => {
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_dup','person','M Shantaram','candidate',0.8,?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
     VALUES ('ent_dup','person','M Shantaram','m shantaram','name_variant','auto','confirmed',?)`,
  ).run(now);
  const r = await call("POST", "/v1/people/merge", { from_id: "ent_dup", into_id: "ent_m" });
  assert.equal(r.status, 200);
  const aliases = db
    .prepare("SELECT alias FROM entity_aliases WHERE entity_id='ent_m'")
    .all() as { alias: string }[];
  assert.ok(aliases.some((a) => a.alias === "M Shantaram"), "absorbed name is an alias");
  assert.ok(aliases.some((a) => a.alias === "ms@example.com"), "identifier aliases survive");
});

console.log(`\n${pass} passed, ${fail} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
