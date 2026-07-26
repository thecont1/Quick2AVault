/**
 * Local document database (node:sqlite, built-in).
 *
 * Stores one record per ingested file so we can detect duplicates and show a
 * history of everything the vault has processed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { app, logger } from "@glaze/core/backend";

export interface DocumentRecord {
  id: number;
  hash: string;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
}

export interface NewDocument {
  hash: string;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;

  const userData = app.getPath("userData");
  fs.mkdirSync(userData, { recursive: true });
  const dbPath = path.join(userData, "quick2afvault.db");

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL UNIQUE,
      original_filename TEXT NOT NULL,
      file_type TEXT NOT NULL,
      date_ingested TEXT NOT NULL,
      date_folder TEXT NOT NULL,
      markdown_success INTEGER NOT NULL,
      raw_path TEXT NOT NULL,
      markdown_path TEXT NOT NULL
    );
  `);
  // Single-row cache of the most recent AI financial snapshot.
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );
  `);
  // Manual corrections the user makes to the AI's attribution:
  //  - person_name_overrides maps one person name onto another (rename / merge).
  //  - document_overrides pins a single document to a person (NULL = unidentified).
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_name_overrides (
      from_name TEXT PRIMARY KEY,
      to_name TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_overrides (
      doc_id INTEGER PRIMARY KEY,
      person TEXT
    );
  `);
  logger.info("database", "Document database ready", { dbPath });
  return db;
}

type Row = Record<string, unknown>;

function mapRow(row: Row): DocumentRecord {
  return {
    id: Number(row.id),
    hash: String(row.hash),
    originalFilename: String(row.original_filename),
    fileType: String(row.file_type),
    dateIngested: String(row.date_ingested),
    dateFolder: String(row.date_folder),
    markdownSuccess: Number(row.markdown_success) === 1,
    rawPath: String(row.raw_path),
    markdownPath: String(row.markdown_path),
  };
}

/** Return an existing record for this content hash, or null if unseen. */
export function findByHash(hash: string): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE hash = ?").get(hash) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function insertDocument(doc: NewDocument): DocumentRecord {
  const stmt = getDb().prepare(`
    INSERT INTO documents
      (hash, original_filename, file_type, date_ingested, date_folder, markdown_success, raw_path, markdown_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    doc.hash,
    doc.originalFilename,
    doc.fileType,
    doc.dateIngested,
    doc.dateFolder,
    doc.markdownSuccess ? 1 : 0,
    doc.rawPath,
    doc.markdownPath,
  );
  return { id: Number(info.lastInsertRowid), ...doc };
}

export function listDocuments(limit = 200): DocumentRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM documents ORDER BY id DESC LIMIT ?")
    .all(limit) as Row[];
  return rows.map(mapRow);
}

export function findDocumentById(id: number): DocumentRecord | null {
  const row = getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  return row ? mapRow(row) : null;
}

export function getStats(): { total: number; converted: number } {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(markdown_success), 0) AS converted FROM documents",
    )
    .get() as Row;
  return { total: Number(row.total), converted: Number(row.converted) };
}

// ── Snapshot cache ──────────────────────────────────────────────────────

export interface SnapshotCacheRow {
  json: string;
  generatedAt: string;
}

/** Return the cached financial snapshot (raw JSON + timestamp), or null. */
export function getSnapshotCache(): SnapshotCacheRow | null {
  const row = getDb()
    .prepare("SELECT json, generated_at FROM snapshot_cache WHERE id = 1")
    .get() as Row | undefined;
  return row ? { json: String(row.json), generatedAt: String(row.generated_at) } : null;
}

/** Insert or replace the single cached snapshot row. */
export function saveSnapshotCache(json: string, generatedAt: string): void {
  getDb()
    .prepare(
      `INSERT INTO snapshot_cache (id, json, generated_at)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET json = excluded.json, generated_at = excluded.generated_at`,
    )
    .run(json, generatedAt);
}

// ── Manual attribution corrections ──────────────────────────────────────

/** All person-name remappings (rename / merge), as { from → to } pairs. */
export function listNameOverrides(): { from: string; to: string }[] {
  const rows = getDb().prepare("SELECT from_name, to_name FROM person_name_overrides").all() as Row[];
  return rows.map((r) => ({ from: String(r.from_name), to: String(r.to_name) }));
}

/** Remap one person name onto another (used for both rename and merge). */
export function setNameOverride(from: string, to: string): void {
  if (!from || !to || from === to) return;
  getDb()
    .prepare(
      `INSERT INTO person_name_overrides (from_name, to_name)
       VALUES (?, ?)
       ON CONFLICT(from_name) DO UPDATE SET to_name = excluded.to_name`,
    )
    .run(from, to);
  // If the target already pointed elsewhere, keep chains from looping back.
  getDb().prepare("DELETE FROM person_name_overrides WHERE from_name = ? AND to_name = ?").run(to, from);
}

/** Per-document attribution pins. `person === null` forces "unidentified". */
export function listDocumentOverrides(): { docId: number; person: string | null }[] {
  const rows = getDb().prepare("SELECT doc_id, person FROM document_overrides").all() as Row[];
  return rows.map((r) => ({ docId: Number(r.doc_id), person: r.person == null ? null : String(r.person) }));
}

/** Pin a document to a person, or to "unidentified" when person is null. */
export function setDocumentOverride(docId: number, person: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO document_overrides (doc_id, person)
       VALUES (?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET person = excluded.person`,
    )
    .run(docId, person);
}

/** Clear a document's manual pin so it follows the AI attribution again. */
export function removeDocumentOverride(docId: number): void {
  getDb().prepare("DELETE FROM document_overrides WHERE doc_id = ?").run(docId);
}
