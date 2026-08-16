/**
 * Maintenance operations — batch housekeeping for the vault.
 *
 * Currently: duplicate flush. A forced Gmail resync re-delivers every
 * attachment; the sha256 dedupe guard sets the re-arrivals aside under
 * Duplicates/<date>/ with an intake_events row of kind='duplicate'. This
 * module lists those groups and flushes them under one of two policies:
 *
 *   keep_originals  — delete the archived copies + intake rows; the original
 *                     documents are untouched (nothing is re-processed).
 *   promote_newest  — same flush, then re-process every affected document
 *                     with the current pipeline. Copies are byte-identical
 *                     (same sha256), so "process the newest copy" is exactly
 *                     reprocessing the document; if an original was deleted,
 *                     the duplicate copy would revive it.
 */
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { enqueueReprocess } from "./pipeline.js";

export interface DuplicateGroup {
  sha256: string;
  original_filename: string | null;
  document_id: string | null;
  document_lifecycle: string | null;
  copies: number;
  files: { filename: string; created_at: string }[];
  /** intake_events ids captured at listing time — the flush deletes ONLY
   *  these rows, so copies that arrive during the flush survive for a
   *  later sync. */
  eventIds: number[];
}

export function listDuplicateGroups(db: DatabaseSync): DuplicateGroup[] {
  const rows = db
    .prepare(
      `SELECT i.id AS event_id, i.sha256, i.filename, i.created_at,
              d.original_filename AS original_filename, d.id AS document_id,
              d.lifecycle AS document_lifecycle
        FROM intake_events i
        LEFT JOIN documents d ON d.sha256 = i.sha256
       WHERE i.kind='duplicate' AND i.sha256 IS NOT NULL
       ORDER BY i.created_at DESC`,
    )
    .all() as {
    event_id: number;
    sha256: string;
    filename: string;
    created_at: string;
    original_filename: string | null;
    document_id: string | null;
    document_lifecycle: string | null;
  }[];

  const groups = new Map<string, DuplicateGroup>();
  for (const r of rows) {
    let g = groups.get(r.sha256);
    if (!g) {
      g = {
        sha256: r.sha256,
        original_filename: r.original_filename,
        document_id: r.document_id,
        document_lifecycle: r.document_lifecycle,
        copies: 0,
        files: [],
        eventIds: [],
      };
      groups.set(r.sha256, g);
    }
    g.copies++;
    g.files.push({ filename: r.filename, created_at: r.created_at });
    g.eventIds.push(r.event_id);
  }
  return [...groups.values()].sort((a, b) => b.copies - a.copies || a.sha256.localeCompare(b.sha256));
}

/** All files under Duplicates/ (any depth), with their content hash. */
async function duplicateFilesOnDisk(dupRoot: string): Promise<{ file: string; sha256: string }[]> {
  const out: { file: string; sha256: string }[] = [];
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no Duplicates/ tree yet
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else if (e.isFile()) {
        const buf = await fsp.readFile(p);
        out.push({ file: p, sha256: crypto.createHash("sha256").update(buf).digest("hex") });
      }
    }
  };
  await walk(dupRoot);
  return out;
}

export interface FlushResult {
  groups: number;
  copies: number;
  deleted_files: number;
  reprocessed: number;
  skipped_deleted: number;
  skipped_orphan: number;
}

/**
 * Flush duplicate archive copies. Never touches documents, transactions, or
 * the originals' intake trail — only kind='duplicate' rows and the matching
 * files under Duplicates/.
 */
export async function flushDuplicates(
  db: DatabaseSync,
  ports: Ports,
  policy: "keep_originals" | "promote_newest",
): Promise<FlushResult> {
  const groups = listDuplicateGroups(db);
  const result: FlushResult = {
    groups: groups.length,
    copies: groups.reduce((n, g) => n + g.copies, 0),
    deleted_files: 0,
    reprocessed: 0,
    skipped_deleted: 0,
    skipped_orphan: 0,
  };
  if (groups.length === 0) return result;

  const shaSet = new Set(groups.map((g) => g.sha256));

  // 1) Delete the archived files. On-disk names may carry uniquePath
  //    " (2)" suffixes, so match by content hash, never by name.
  const dupRoot = ports.paths.duplicatesDir("");
  for (const { file, sha256 } of await duplicateFilesOnDisk(dupRoot)) {
    if (shaSet.has(sha256)) {
      await fsp.rm(file, { force: true });
      result.deleted_files++;
    }
  }

  // 2) Drop ONLY the duplicate intake rows captured at listing time (the
  //    flush result message is the audit). Rows inserted during the
  //    awaited filesystem walk — including new copies of already-known
  //    hashes — must survive for a later sync.
  const idSet = new Set<number>();
  for (const g of groups) for (const id of g.eventIds) idSet.add(id);
  if (idSet.size > 0) {
    const ids = [...idSet];
    const holes = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM intake_events WHERE id IN (${holes})`).run(...ids);
  }

  // 3) Policy (b): re-process each affected document with the current
  //    pipeline. Copies are byte-identical, so reprocessing the original IS
  //    processing the newest copy.
  if (policy === "promote_newest") {
    for (const g of groups) {
      if (!g.document_id) {
        result.skipped_orphan++;
        ports.logger.warn("duplicate flush: no live document for group", {
          sha256: g.sha256,
          filename: g.original_filename,
        });
        continue;
      }
      try {
        enqueueReprocess(db, ports, g.document_id);
        result.reprocessed++;
      } catch (err) {
        result.skipped_deleted++;
        ports.logger.warn("duplicate flush: reprocess skipped", {
          document_id: g.document_id,
          err: (err as Error)?.message,
        });
      }
    }
  }

  ports.logger.info("duplicates flushed", { policy, ...result });
  return result;
}
