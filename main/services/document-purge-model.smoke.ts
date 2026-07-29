import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { purgeDocumentRows } from "./document-purge-model.js";

const purgedTables = [
  "documents",
  "snapshot_cache",
  "person_name_overrides",
  "document_overrides",
  "gmail_imports",
  "training_reviews",
  "document_field_reviews",
  "review_audit",
  "persons",
  "person_aliases",
  "person_evidence",
  "duplicate_events",
  "contract_notes",
  "contract_note_trades",
] as const;
const preservedTables = [
  "app_settings",
  "learned_rules",
  "rate_cache",
  "recurring_entries",
] as const;

const db = new DatabaseSync(":memory:");
for (const table of [...purgedTables, ...preservedTables].filter(
  (table) => table !== "app_settings",
)) {
  db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT INTO ${table} (id, value) VALUES (1, ?)`).run(table);
}
db.exec("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)");
db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("training.mode", "1");
db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?)").run("gmail.history_id", "42");

const result = purgeDocumentRows(db);
assert.equal(result.deletedDocuments, 1);
for (const table of purgedTables) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  assert.equal(Number(row.count), 0, `${table} must be purged`);
}
for (const table of preservedTables.filter((table) => table !== "app_settings")) {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  assert.equal(Number(row.count), 1, `${table} must be preserved`);
}
assert.equal(
  (
    db.prepare("SELECT value FROM app_settings WHERE key = ?").get("training.mode") as {
      value: string;
    }
  ).value,
  "1",
  "ordinary app settings must be preserved",
);
assert.equal(
  db.prepare("SELECT value FROM app_settings WHERE key = ?").get("gmail.history_id"),
  undefined,
  "Gmail history must reset so purged mail can be imported again",
);

console.log("document purge model smoke: ok");
