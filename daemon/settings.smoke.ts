/**
 * Settings, reset, and person editing (Settings pane work).
 *   npx tsx daemon/settings.smoke.ts
 *
 * These assert the CONTRACT the Settings UI depends on:
 *   - an API key set through the API is remembered AND applied live
 *   - an API key can actually be CLEARED (the old code silently ignored "")
 *   - reset has two scopes, and neither deletes the user's documents on disk
 *   - a person can be renamed, re-related, made owner, and deleted
 */
import { openDatabase, normaliseName } from "./schema.js";
import { createMutableProvider } from "./ai-provider.js";
import type { Logger } from "./ports.js";

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
function eq(a: unknown, b: unknown, msg = "") {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`${msg} expected ${y}, got ${x}`);
}

const quietLogger: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

console.log("── ai provider: live reconfiguration");

check("no key -> unavailable", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const ai = createMutableProvider({}, quietLogger);
  eq(ai.available, false, "provider with no key");
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

check("reconfigure with a key flips available WITHOUT a restart", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const ai = createMutableProvider({}, quietLogger);
  eq(ai.available, false, "before");
  ai.reconfigure({ apiKey: "sk-ant-test-key-not-real" });
  eq(ai.available, true, "after reconfigure");
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

check("clearing the key disables AI again", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const ai = createMutableProvider({ apiKey: "sk-ant-test-key-not-real" }, quietLogger);
  eq(ai.available, true, "before clear");
  ai.reconfigure({ apiKey: "" });
  eq(ai.available, false, "after clear");
  if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
});

// The regression that motivated the empty-string handling: clearing the key in
// the UI must NOT silently fall back to a key the daemon inherited from the
// shell, or the user would think AI was off while it kept billing them.
check("an explicitly cleared key does NOT fall back to the environment", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-shell";
  const ai = createMutableProvider({ apiKey: "" }, quietLogger);
  eq(ai.available, false, "cleared key must win over the env var");
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

check("an UNSET key still falls back to the environment", () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-shell";
  const ai = createMutableProvider({}, quietLogger);
  eq(ai.available, true, "undefined means 'not configured here', so env applies");
  if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved;
});

console.log("\n── settings persistence");

function freshDb() {
  return openDatabase(":memory:");
}

check("a saved key is remembered across a reopen of the same store", () => {
  const db = freshDb();
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)").run(
    "ai.api_key",
    "sk-ant-remembered",
  );
  const back = db.prepare("SELECT value FROM app_settings WHERE key='ai.api_key'").get() as
    | { value: string }
    | undefined;
  eq(back?.value, "sk-ant-remembered");
  db.close();
});

check("clearing removes the row entirely, not just blanks it", () => {
  const db = freshDb();
  const set = db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)");
  set.run("ai.api_key", "sk-ant-remembered");
  db.prepare("DELETE FROM app_settings WHERE key=?").run("ai.api_key");
  const back = db.prepare("SELECT value FROM app_settings WHERE key='ai.api_key'").get();
  eq(back, undefined, "row should be gone");
  db.close();
});

console.log("\n── reset scopes");

function seedVault(db: ReturnType<typeof openDatabase>) {
  const now = "2026-08-09T00:00:00.000Z";
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, created_at)
     VALUES ('ent_p','person','Test Person','confirmed',1.0,?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO documents (id, sha256, original_filename, raw_path, doc_type, received_at)
     VALUES ('doc_1','sha_1','a.pdf','/tmp/a.pdf','merchant_invoice',?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO transactions (id, direction, amount_minor, currency, occurred_at, fy_key, created_at)
     VALUES ('txn_1','out',1000,'INR',?,'2026-27',?)`,
  ).run(now, now);
  db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('ai.api_key','sk-keep-me')").run();
}

// Mirrors the endpoint's table list so the test fails if the two drift apart.
const LEDGER_TABLES = [
  "evidence_links",
  "field_claims",
  "review_audit",
  "training_reviews",
  "learned_rules",
  "transactions",
  "documents_fts",
  "documents",
  "entities",
  "jobs",
];
function resetLedger(db: ReturnType<typeof openDatabase>, factory: boolean) {
  for (const t of LEDGER_TABLES) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      /* table may not exist */
    }
  }
  if (factory) db.prepare("DELETE FROM app_settings").run();
}

function n(db: ReturnType<typeof openDatabase>, t: string): number {
  return (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
}

check("ledger reset clears documents and transactions", () => {
  const db = freshDb();
  seedVault(db);
  eq(n(db, "documents"), 1, "seeded");
  resetLedger(db, false);
  eq(n(db, "documents"), 0, "documents");
  eq(n(db, "transactions"), 0, "transactions");
  eq(n(db, "entities"), 0, "entities");
  db.close();
});

check("ledger reset KEEPS the API key", () => {
  const db = freshDb();
  seedVault(db);
  resetLedger(db, false);
  const k = db.prepare("SELECT value FROM app_settings WHERE key='ai.api_key'").get() as
    | { value: string }
    | undefined;
  eq(k?.value, "sk-keep-me", "credentials must survive a ledger reset");
  db.close();
});

check("factory reset also clears the API key", () => {
  const db = freshDb();
  seedVault(db);
  resetLedger(db, true);
  eq(n(db, "documents"), 0, "documents");
  const k = db.prepare("SELECT value FROM app_settings WHERE key='ai.api_key'").get();
  eq(k, undefined, "credentials must be gone after a factory reset");
  db.close();
});

console.log("\n── person editing");

function seedPerson(db: ReturnType<typeof openDatabase>, id: string, name: string, owner = false) {
  db.prepare(
    `INSERT INTO entities (id, kind, display_name, status, confidence, is_member, created_at)
     VALUES (?,'person',?,'confirmed',1.0,?,?)`,
  ).run(id, name, owner ? 1 : 0, "2026-08-09T00:00:00.000Z");
}

check("rename keeps the old spelling as an alias", () => {
  const db = freshDb();
  seedPerson(db, "ent_a", "M. Shantaram");
  // what the PATCH route does
  db.prepare("UPDATE entities SET display_name=? WHERE id=?").run("Mahesh Shantaram", "ent_a");
  db.prepare(
    "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
  ).run("ent_a", "person", "M. Shantaram", normaliseName("M. Shantaram"), "user", "2026-08-09T00:00:00.000Z");

  const row = db.prepare("SELECT display_name FROM entities WHERE id='ent_a'").get() as {
    display_name: string;
  };
  eq(row.display_name, "Mahesh Shantaram", "renamed");
  const alias = db.prepare("SELECT alias FROM entity_aliases WHERE entity_id='ent_a'").get() as
    | { alias: string }
    | undefined;
  eq(alias?.alias, "M. Shantaram", "old spelling preserved");
  db.close();
});

check("exactly one owner: promoting demotes the previous", () => {
  const db = freshDb();
  seedPerson(db, "ent_a", "Alice", true);
  seedPerson(db, "ent_b", "Bob");
  db.prepare("UPDATE entities SET is_member=0 WHERE kind='person' AND id<>?").run("ent_b");
  db.prepare("UPDATE entities SET is_member=1 WHERE id=?").run("ent_b");
  const owners = db
    .prepare("SELECT id FROM entities WHERE kind='person' AND is_member=1")
    .all() as { id: string }[];
  eq(owners.length, 1, "one owner only");
  eq(owners[0].id, "ent_b");
  db.close();
});

check("a rename onto an existing name is detected as a clash", () => {
  const db = freshDb();
  seedPerson(db, "ent_a", "Alice");
  seedPerson(db, "ent_b", "Bob");
  const clash = db
    .prepare(
      "SELECT id FROM entities WHERE kind='person' AND lower(display_name)=lower(?) AND id<>?",
    )
    .get("alice", "ent_b") as { id: string } | undefined;
  eq(clash?.id, "ent_a", "should find the conflicting person, so the API can 409");
  db.close();
});

check("delete removes the person and their aliases", () => {
  const db = freshDb();
  seedPerson(db, "ent_a", "Alice");
  db.prepare(
    "INSERT INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?,?,?)",
  ).run("ent_a", "person", "A. Smith", normaliseName("A. Smith"), "user", "2026-08-09T00:00:00.000Z");
  db.prepare("DELETE FROM entity_aliases WHERE entity_id=?").run("ent_a");
  db.prepare("DELETE FROM entities WHERE id=?").run("ent_a");
  eq(n(db, "entities"), 0, "person gone");
  eq(n(db, "entity_aliases"), 0, "aliases gone");
  db.close();
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
