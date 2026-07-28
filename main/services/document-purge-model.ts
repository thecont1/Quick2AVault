import type { DatabaseSync } from "node:sqlite";

export interface DocumentPurgeResult {
  deletedDocuments: number;
}

export interface PurgeDocumentsResult {
  ok: boolean;
  deletedDocuments?: number;
  message?: string;
}

/**
 * Clear document-derived state in one transaction while preserving preferences,
 * learned rules, exchange-rate cache, recurring entries, and Gmail connection
 * settings. Gmail's cursor/import provenance is reset so connected mail can be
 * imported again after the vault starts fresh.
 */
export function purgeDocumentRows(database: DatabaseSync): DocumentPurgeResult {
  const row = database.prepare("SELECT COUNT(*) AS count FROM documents").get() as {
    count: number;
  };
  const deletedDocuments = Number(row.count);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const table of [
      "document_field_reviews",
      "review_audit",
      "document_overrides",
      "training_reviews",
      "contract_note_trades",
      "contract_notes",
      "duplicate_events",
      "person_evidence",
      "person_aliases",
      "persons",
      "person_name_overrides",
      "gmail_imports",
      "snapshot_cache",
      "documents",
    ]) {
      database.exec(`DELETE FROM ${table}`);
    }
    database
      .prepare(
        "DELETE FROM app_settings WHERE key IN ('gmail.history_id', 'gmail.last_sync', 'gmail.last_error')",
      )
      .run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return { deletedDocuments };
}
