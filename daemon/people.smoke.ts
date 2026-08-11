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
  const a = normaliseIdentifier("phone", "+91 55501 00200");
  const b = normaliseIdentifier("phone", "05550100200");
  const c = normaliseIdentifier("phone", "5550100200");
  assert.equal(a, "5550100200");
  assert.equal(b, "5550100200");
  assert.equal(c, "5550100200");
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
  const first = resolvePerson(db, ports, "Arun Kamath", { email: "arun@example.com" }, "doc_a");
  const second = resolvePerson(db, ports, "arun@example.com", undefined, "doc_b");
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
  const first = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_a");
  // A second document pairs the known name with an unseen email.
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_b");
  const proposed = aliasRows(db, first.id).find((a) => a.alias === "workmail@example.com");
  assert.ok(proposed, "the proposed alias is recorded");
  assert.equal(proposed!.status, "proposed");
  assert.equal(proposed!.alias_type, "email");
  // Proposed aliases do not resolve: a doc naming only the email still asks.
  seedDoc(db, "doc_c");
  const third = resolvePerson(db, ports, "workmail@example.com", undefined, "doc_c");
  assert.equal(third.id, UNIDENTIFIED_PERSON_ID, "proposed alias must not silently link");
});

await check("a confirmed co-occurrence answer promotes the alias and resolves silently forever", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-4");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const first = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_a");
  resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_b");

  // Simulate the Learning confirmation: the daemon-side rule the client sends.
  const q = db
    .prepare("SELECT id FROM training_reviews WHERE trigger='identifier_cooccurrence'")
    .get() as { id: number };
  answer(db, ports, q.id, "Yes, save it", {
    kind: "entity_alias",
    match_key: "workmail@example.com",
    match_kind: "person_identifier",
    value: first.id,
  });

  seedDoc(db, "doc_c");
  const third = resolvePerson(db, ports, "Arun Kamath", { email: "workmail@example.com" }, "doc_c");
  assert.equal(third.id, first.id);
  assert.equal(third.asked, false, "no re-ask after confirmation");
  const alias = aliasRows(db, first.id).find((a) => a.alias === "workmail@example.com");
  assert.equal(alias?.status, "confirmed", "promoted by the confirmed application");

  // And the email ALONE now resolves silently (step 1).
  seedDoc(db, "doc_d");
  const fourth = resolvePerson(db, ports, "workmail@example.com", undefined, "doc_d");
  assert.equal(fourth.id, first.id);
  assert.equal(fourth.asked, false);
});

await check("a rejected alias is never resurrected by re-observation", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-5");
  seedDoc(db, "doc_a");
  const id = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_a").id;
  db.prepare("UPDATE entity_aliases SET status='rejected' WHERE entity_id=? AND alias=?").run(
    id,
    "Arun Kamath",
  );
  seedDoc(db, "doc_b");
  // The display-name match (entities row) still links, but the alias row
  // itself must stay rejected...
  resolvePerson(db, ports, "Arun Kamath", undefined, "doc_b");
  const alias = aliasRows(db, id).find((a) => a.alias === "Arun Kamath");
  assert.equal(alias?.status, "rejected");
});

await check("Nisha Patel and Nisha Deepak Patel stay separate without strong evidence", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-6");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  const a = resolvePerson(db, ports, "Nisha Patel", undefined, "doc_a");
  const b = resolvePerson(db, ports, "Nisha Deepak Patel", undefined, "doc_b");
  assert.notEqual(a.id, b.id, "name similarity alone must not merge");
  assert.equal(b.matched_via, "fuzzy_question");
  assert.ok(b.asked, "the fuzzy band asks");
  // Asking created no alias on either person and no learned rule.
  assert.equal(
    aliasRows(db, a.id).filter((x) => x.alias === "Nisha Deepak Patel").length,
    0,
  );
  const rules = db.prepare("SELECT COUNT(*) n FROM learned_rules").get() as { n: number };
  assert.equal(rules.n, 0, "asking a question never writes a rule");
});

console.log("\n── §Track C: a Review correction relinks the document and teaches identity");

await check("correcting A. Kamath to Arun Kamath relinks this doc and resolves future docs silently", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-7");
  seedDoc(db, "doc_a");
  seedDoc(db, "doc_b");
  seedDoc(db, "doc_c");

  // The owner exists; a new document carries an initials-only variant, which
  // is NOT a token-sort match — the fuzzy path creates a stray candidate.
  // (KAMATH ARUN would be a token-sort hit and never reach Review.)
  const owner = resolvePerson(db, ports, "Arun Kamath", undefined, "doc_a").id;
  const stray = resolvePerson(db, ports, "A. Kamath", undefined, "doc_b");
  assert.notEqual(stray.id, owner);
  db.prepare(
    "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES ('doc_b', ?, 'owner')",
  ).run(stray.id);

  // The correction from Review: previous value is the model's reading.
  const r = applyPersonCorrection(db, ports, "doc_b", "Arun Kamath", "A. Kamath");
  assert.equal(r.person_id, owner);
  assert.equal(r.relinked, 1, "this document's party row moved");

  // The old spelling is now a confirmed name_variant on the canonical person.
  const alias = aliasRows(db, owner).find((a) => a.alias === "A. Kamath");
  assert.ok(alias, "old spelling kept as alias");
  assert.equal(alias!.status, "confirmed");
  assert.equal(alias!.alias_type, "name_variant");

  // A FUTURE document with the same printed name resolves silently.
  const future = resolvePerson(db, ports, "A. Kamath", undefined, "doc_c");
  assert.equal(future.id, owner);
  assert.equal(future.asked, false);
});

await check("applyPersonCorrection never touches the document's extraction", () => {
  const db = openDatabase(":memory:");
  const ports = testPorts("/tmp/q2v-people-8");
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at, extraction_json)
     VALUES ('doc_x','sha_x','x.pdf','/tmp/x.pdf','merchant_invoice',?,?)`,
  ).run("2026-08-09T00:00:00.000Z", JSON.stringify({ parties: [{ name: "KAMATH ARUN", kind: "person", role: "owner" }] }));
  const before = db.prepare("SELECT extraction_json FROM documents WHERE id='doc_x'").get() as {
    extraction_json: string;
  };
  applyPersonCorrection(db, ports, "doc_x", "Arun Kamath", "KAMATH ARUN");
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
   VALUES ('ent_m','person','Arun Kamath','confirmed',1.0,1,?)`,
).run(now);
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_v','person','Nisha Patel','candidate',0.8,?)`,
).run(now);
db.prepare(
  `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
   VALUES ('ent_org','organisation','Swiggy Limited','confirmed',1.0,?)`,
).run(now);
db.prepare(
  `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
   VALUES ('ent_m','person','arun@example.com','arun@example.com','email','auto-identifier','confirmed',?)`,
).run(now);
db.prepare(
  `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
   VALUES ('ent_m','person','Arun Kamath','arun kamath','name_variant','auto','confirmed',?)`,
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
  assert.equal(email?.alias, "arun@example.com");
  assert.equal(detail.json?.documents?.length, 2);
  assert.equal(detail.json?.transactions?.length, 1);
  assert.equal(detail.json?.transactions?.[0]?.currency, "USD");
});

const addAlias = await call("POST", "/v1/people/ent_m/aliases", { alias: "5550100200" });
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

const conflict = await call("POST", "/v1/people/ent_v/aliases", { alias: "arun@example.com" });
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
    .prepare("SELECT id FROM entity_aliases WHERE entity_id='ent_m' AND alias='5550100200'")
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
    .prepare("SELECT id FROM entity_aliases WHERE entity_id='ent_m' AND alias='Arun Kamath'")
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
  const r = await call("PATCH", "/v1/people/ent_v", { display_name: "Nisha Deepak Patel" });
  assert.equal(r.status, 200);
  const alias = db
    .prepare(
      "SELECT alias_type, status, source FROM entity_aliases WHERE entity_id='ent_v' AND alias='Nisha Patel'",
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
     VALUES ('ent_dup','person','A Kamath','candidate',0.8,?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at)
     VALUES ('ent_dup','person','A Kamath','a kamath','name_variant','auto','confirmed',?)`,
  ).run(now);
  const r = await call("POST", "/v1/people/merge", { from_id: "ent_dup", into_id: "ent_m" });
  assert.equal(r.status, 200);
  const aliases = db
    .prepare("SELECT alias FROM entity_aliases WHERE entity_id='ent_m'")
    .all() as { alias: string }[];
  assert.ok(aliases.some((a) => a.alias === "A Kamath"), "absorbed name is an alias");
  assert.ok(aliases.some((a) => a.alias === "arun@example.com"), "identifier aliases survive");
  // WO11 A2: the merge emits a passive-learning candidate, not a standing rule.
  const rule = db
    .prepare("SELECT value, source, active FROM learned_rules WHERE kind='entity_merge' AND match_key='entity:ent_dup'")
    .get() as { value: string; source: string; active: number } | undefined;
  assert.ok(rule, "entity_merge passive candidate missing");
  assert.equal(rule!.value, "ent_m");
  assert.equal(rule!.source, "passive-correction");
  assert.equal(rule!.active, 0);
});

await check("WO11 A2: /v1/entities/merge emits the same passive-learning candidate", async () => {
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_gm1','organisation','Merged Org','confirmed',1.0,?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_gm2','organisation','Merged Org Ltd','confirmed',1.0,?)`,
  ).run(now);
  const r = await call("POST", "/v1/entities/merge", { from_id: "ent_gm1", into_id: "ent_gm2" });
  assert.equal(r.status, 200);
  const rule = db
    .prepare("SELECT value, source, active, match_kind FROM learned_rules WHERE kind='entity_merge' AND match_key='entity:ent_gm1'")
    .get() as { value: string; source: string; active: number; match_kind: string } | undefined;
  assert.ok(rule, "entity_merge passive candidate missing for generic merge");
  assert.equal(rule!.value, "ent_gm2");
  assert.equal(rule!.match_kind, "organisation");
  assert.equal(rule!.source, "passive-correction");
  assert.equal(rule!.active, 0);
});

// ── WO11 Track A: owner passive learning + cross-kind conflicts ────────────

await check("an owner change writes a passive-learning candidate", async () => {
  await call("PATCH", "/v1/people/ent_m", { is_owner: true });
  const rule = db
    .prepare("SELECT value, source, active FROM learned_rules WHERE kind='entity_owner' AND match_key='entity:ent_m'")
    .get() as { value: string; source: string; active: number } | undefined;
  assert.ok(rule, "entity_owner rule missing");
  assert.equal(rule!.value, "owner");
  assert.equal(rule!.source, "passive-correction");
  assert.equal(rule!.active, 0, "a candidate, not an applied rule");
  // Clearing the owner flips the same candidate, in place.
  await call("PATCH", "/v1/people/ent_m", { is_owner: false });
  const after = db
    .prepare("SELECT value FROM learned_rules WHERE kind='entity_owner' AND match_key='entity:ent_m'")
    .get() as { value: string };
  assert.equal(after.value, "not-owner");
});

await check("/v1/entities surfaces a cross-kind collision on both rows", async () => {
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, identifiers_json, created_at)
     VALUES ('ent_xp','person','Shared Person','confirmed',1.0,?,?)`,
  ).run(JSON.stringify({ email: "shared@example.com" }), now);
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, identifiers_json, created_at)
     VALUES ('ent_xo','organisation','Shared Org Ltd','confirmed',1.0,?,?)`,
  ).run(JSON.stringify({ email: "shared@example.com" }), now);
  const r = await call("GET", "/v1/entities");
  const rows = r.json.entities as Array<{ id: string; conflicts?: Array<{ other_id: string; identifier: string }> }>;
  const person = rows.find((e) => e.id === "ent_xp");
  const org = rows.find((e) => e.id === "ent_xo");
  assert.ok(person?.conflicts?.some((c) => c.other_id === "ent_xo" && c.identifier === "shared@example.com"),
    JSON.stringify(person?.conflicts));
  assert.ok(org?.conflicts?.some((c) => c.other_id === "ent_xp"), "the conflict is visible from both sides");
});

await check("keep-separate dismisses the conflict and writes a standing rule", async () => {
  const r = await call("POST", "/v1/entities/keep-separate", {
    identifier: "shared@example.com",
    entity_ids: ["ent_xp", "ent_xo"],
  });
  assert.equal(r.status, 200);
  const rule = db
    .prepare("SELECT value, active FROM learned_rules WHERE kind='entity_separation' AND match_key='identifier:shared@example.com'")
    .get() as { value: string; active: number } | undefined;
  assert.ok(rule, "standing rule missing");
  assert.equal(rule!.active, 1);
  const after = await call("GET", "/v1/entities");
  const rows = after.json.entities as Array<{ id: string; conflicts?: unknown[] }>;
  assert.equal(rows.find((e) => e.id === "ent_xp")?.conflicts?.length, 0);
  assert.equal(rows.find((e) => e.id === "ent_xo")?.conflicts?.length, 0);
});

await check("dismissing a second pair on the same identifier preserves the first", async () => {
  // A third kind carrying the same identifier: dismissing (person, account)
  // must not resurrect the already-dismissed (person, organisation) pair —
  // the learned_rules value is a LIST of pairs, merged on conflict.
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, identifiers_json, created_at)
     VALUES ('ent_xa','account','Shared Account','confirmed',1.0,?,?)`,
  ).run(JSON.stringify({ email: "shared@example.com" }), now);
  const mid = await call("GET", "/v1/entities");
  const midRows = mid.json.entities as Array<{ id: string; conflicts?: Array<{ other_id: string }> }>;
  const xp = midRows.find((e) => e.id === "ent_xp");
  assert.ok(xp?.conflicts?.some((c) => c.other_id === "ent_xa"), "new pair surfaces");
  assert.ok(!xp?.conflicts?.some((c) => c.other_id === "ent_xo"), "old pair stays dismissed");

  const r = await call("POST", "/v1/entities/keep-separate", {
    identifier: "shared@example.com",
    entity_ids: ["ent_xp", "ent_xa"],
  });
  assert.equal(r.status, 200);
  const pairs = JSON.parse(
    (db.prepare("SELECT value FROM learned_rules WHERE kind='entity_separation' AND match_key='identifier:shared@example.com'").get() as { value: string }).value,
  ) as string[][];
  assert.equal(pairs.length, 2, `both pairs preserved, got ${JSON.stringify(pairs)}`);
  const after = await call("GET", "/v1/entities");
  const rows = after.json.entities as Array<{ id: string; conflicts?: Array<{ other_id: string }> }>;
  assert.equal(rows.find((e) => e.id === "ent_xp")?.conflicts?.length, 0, "both person pairs dismissed");
  // The org/account pair was never dismissed — suppression is per-pair, so
  // it correctly remains.
  const xa = rows.find((e) => e.id === "ent_xa");
  assert.equal(xa?.conflicts?.length, 1);
  assert.equal(xa?.conflicts?.[0]?.other_id, "ent_xo");
});

await check("keep-separate refuses a same-kind pair (that is a merge candidate)", async () => {
  const r = await call("POST", "/v1/entities/keep-separate", {
    identifier: "same@example.com",
    entity_ids: ["ent_m", "ent_v"],
  });
  assert.equal(r.status, 409);
  assert.equal(r.json?.error, "same_kind", "the same-kind refusal branch, not a generic 409");
});

await check("the dismissal survives a full daemon restart (file-backed vault)", async () => {
  // The API smoke above runs on :memory:; durability needs a real file. Boot
  // a throwaway daemon on a file-backed vault, seed a collision, dismiss it,
  // close everything, reopen the same file with a fresh daemon, and confirm
  // the conflict does not resurface.
  const restartVault = fs.mkdtempSync(path.join(os.tmpdir(), "q2v-people-restart-"));
  const dbFile = path.join(restartVault, "vault.db");
  const boot = async (port: number) => {
    const conn = openDatabase(dbFile);
    const instance = createApi(conn, testPorts(restartVault), {
      port,
      token: TOKEN,
      version: "test",
      vaultDir: restartVault,
    });
    await instance.listen();
    return { conn, instance };
  };
  const get = async (port: number) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/entities`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return (await r.json()) as { entities: Array<{ id: string; conflicts?: unknown[] }> };
  };
  try {
    const first = await boot(47938);
    const nowIso = new Date().toISOString();
    for (const [id, kind] of [["ent_rp", "person"], ["ent_ro", "organisation"]] as const) {
      first.conn
        .prepare(
          `INSERT INTO entities (id, kind, display_name, status, confidence, identifiers_json, created_at)
           VALUES (?,?,?,'confirmed',1.0,?,?)`,
        )
        .run(id, kind, `Restart ${kind}`, JSON.stringify({ email: "restart@example.com" }), nowIso);
    }
    const before = await get(47938);
    assert.ok(before.entities.find((e) => e.id === "ent_rp")?.conflicts?.length, "collision seeded");
    await fetch(`http://127.0.0.1:47938/v1/entities/keep-separate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ identifier: "restart@example.com", entity_ids: ["ent_rp", "ent_ro"] }),
    });
    await first.instance.close();
    first.conn.close();

    const second = await boot(47939);
    try {
      const after = await get(47939);
      assert.equal(after.entities.find((e) => e.id === "ent_rp")?.conflicts?.length ?? 0, 0,
        "the conflict must NOT resurface after a restart");
      assert.equal(after.entities.find((e) => e.id === "ent_ro")?.conflicts?.length ?? 0, 0);
    } finally {
      await second.instance.close();
      second.conn.close();
    }
  } finally {
    fs.rmSync(restartVault, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
await api.close();
fs.rmSync(vault, { recursive: true, force: true });
if (fail > 0) process.exit(1);
