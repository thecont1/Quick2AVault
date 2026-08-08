/**
 * Pipeline — P0 intake (sync, no AI) and P1 conversion (queued, no AI).
 * Plan §2. P2 analysis (Claude) plugs into the same `jobs` table.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";

export interface IntakeResult {
  status: "added" | "duplicate" | "failed";
  document_id?: string;
  sha256?: string;
  existing_document_id?: string;
  error?: string;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * P0 — synchronous intake. Hash, dedupe, store raw, record, emit, enqueue P1.
 * Target <100ms. Never does AI work. Raw is write-only after this point.
 */
export async function ingestFile(
  db: DatabaseSync,
  ports: Ports,
  filePath: string,
  opts: { source?: string; externalId?: string } = {},
): Promise<IntakeResult> {
  const source = opts.source ?? "folder";
  const filename = path.basename(filePath);
  const now = ports.clock.isoNow();

  try {
    // Source-level idempotency (e.g. the same Gmail message or invoice number)
    if (opts.externalId) {
      const seen = db
        .prepare("SELECT document_id FROM source_events WHERE source=? AND external_id=?")
        .get(source, opts.externalId) as { document_id?: string } | undefined;
      if (seen) {
        recordIntake(db, ports, "duplicate", filename, undefined, seen.document_id, source, "external_id seen");
        return { status: "duplicate", existing_document_id: seen.document_id };
      }
    }

    const buf = await fs.readFile(filePath);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

    // Content-level dedupe — the same bytes never become two documents.
    const existing = db.prepare("SELECT id FROM documents WHERE sha256=?").get(sha256) as
      | { id: string }
      | undefined;
    if (existing) {
      recordIntake(db, ports, "duplicate", filename, sha256, existing.id, source, "sha256 match");
      ports.bus.publish({
        type: "DocumentDuplicate",
        sha256,
        filename,
        existing_document_id: existing.id,
        at: now,
      });
      return { status: "duplicate", sha256, existing_document_id: existing.id };
    }

    const ext = path.extname(filename).toLowerCase();
    const id = newId("doc");
    const rawDir = ports.paths.rawDir(dateKey(ports.clock.now()));
    const rawPath = path.join(rawDir, `${id}${ext}`);
    await fs.writeFile(rawPath, buf);

    db.prepare(
      `INSERT INTO documents (id, sha256, original_filename, ext, byte_size, raw_path, source, received_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, sha256, filename, ext, buf.length, rawPath, source, now);

    if (opts.externalId) {
      db.prepare("INSERT OR REPLACE INTO source_events(source,external_id,document_id,created_at) VALUES(?,?,?,?)")
        .run(source, opts.externalId, id, now);
    }

    recordIntake(db, ports, "added", filename, sha256, id, source, null);
    ports.bus.publish({ type: "DocumentReceived", document_id: id, filename, sha256, at: now });
    enqueue(db, ports, id, "convert");

    return { status: "added", document_id: id, sha256 };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ports.logger.error("P0 intake failed", { filename, err: msg });
    recordIntake(db, ports, "failed", filename, undefined, undefined, source, msg);
    return { status: "failed", error: msg };
  }
}

function recordIntake(
  db: DatabaseSync,
  ports: Ports,
  kind: "added" | "duplicate" | "irrelevant" | "failed",
  filename: string,
  sha256?: string,
  documentId?: string,
  source = "folder",
  detail: string | null = null,
) {
  db.prepare(
    `INSERT INTO intake_events (kind, filename, sha256, document_id, source, detail, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(kind, filename, sha256 ?? null, documentId ?? null, source, detail, ports.clock.isoNow());
}

export function enqueue(db: DatabaseSync, ports: Ports, documentId: string, phase: "convert" | "analyse" | "reconcile") {
  const info = db
    .prepare("INSERT INTO jobs (document_id, phase, state, created_at) VALUES (?,?,'pending',?)")
    .run(documentId, phase, ports.clock.isoNow());
  ports.bus.publish({
    type: "JobStateChanged",
    job_id: Number(info.lastInsertRowid),
    phase,
    state: "pending",
    at: ports.clock.isoNow(),
  });
}

/**
 * P1 — conversion. anydoc/plaintext -> canonical markdown v1.
 * AI never rewrites this text; it is the audit trail for every later claim.
 */
export async function runConvertJob(db: DatabaseSync, ports: Ports, jobId: number, documentId: string): Promise<void> {
  const doc = db.prepare("SELECT id, raw_path, ext FROM documents WHERE id=?").get(documentId) as
    | { id: string; raw_path: string; ext: string }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  const md = await ports.converter.toMarkdown(doc.raw_path, doc.ext ?? "");
  if (md === null) throw new Error(`conversion returned null for ${doc.ext}`);

  const mdDir = ports.paths.markdownDir(dateKey(ports.clock.now()));
  const mdPath = path.join(mdDir, `${documentId}.md`);
  await fs.writeFile(mdPath, md, "utf-8");

  const now = ports.clock.isoNow();
  db.prepare("UPDATE documents SET markdown_path=?, markdown_chars=?, converted_at=? WHERE id=?")
    .run(mdPath, md.length, now, documentId);

  ports.bus.publish({ type: "MarkdownReady", document_id: documentId, markdown_path: mdPath, chars: md.length, at: now });

  // P2 is queued but only runs when an AI provider is configured; the worker
  // marks it done-with-note otherwise, so the pipeline never wedges.
  enqueue(db, ports, documentId, "analyse");
}

/**
 * Worker loop over the durable `jobs` table. Crash-safe: a job left in
 * 'running' by a killed process is reclaimed on next launch.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private db: DatabaseSync,
    private ports: Ports,
    private intervalMs = 400,
  ) {}

  /** Reclaim jobs orphaned by a crash. Call once at startup. */
  reclaim(): number {
    const info = this.db
      .prepare("UPDATE jobs SET state='pending', last_error='reclaimed after restart' WHERE state='running'")
      .run();
    const n = Number(info.changes ?? 0);
    if (n > 0) this.ports.logger.warn("reclaimed orphaned jobs", { count: n });
    return n;
  }

  start() {
    if (this.timer) return;
    this.reclaim();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.ports.logger.info("job worker started", { intervalMs: this.intervalMs });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = this.db
        .prepare("SELECT id, document_id, phase, attempts FROM jobs WHERE state='pending' ORDER BY id LIMIT 1")
        .get() as { id: number; document_id: string; phase: string; attempts: number } | undefined;
      if (!job) return;

      const now = this.ports.clock.isoNow();
      this.db.prepare("UPDATE jobs SET state='running', started_at=?, attempts=attempts+1 WHERE id=?").run(now, job.id);
      this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "running", at: now });

      try {
        if (job.phase === "convert") {
          await runConvertJob(this.db, this.ports, job.id, job.document_id);
        } else if (job.phase === "analyse") {
          // P2 lands next; without a provider we complete with a note rather
          // than failing, so the queue keeps draining.
          this.ports.logger.info("analyse: no AI provider configured, skipping", { document_id: job.document_id });
        }
        const fin = this.ports.clock.isoNow();
        this.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(fin, job.id);
        this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "done", at: fin });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        const state = job.attempts >= 2 ? "failed" : "pending";
        this.db.prepare("UPDATE jobs SET state=?, last_error=?, finished_at=? WHERE id=?")
          .run(state, msg, this.ports.clock.isoNow(), job.id);
        this.ports.logger.error("job failed", { job: job.id, phase: job.phase, attempts: job.attempts, err: msg });
      }
    } finally {
      this.busy = false;
    }
  }

  /** Drain the queue — used by tests and the CLI so runs are deterministic. */
  async drain(maxTicks = 200): Promise<void> {
    this.reclaim();
    for (let i = 0; i < maxTicks; i++) {
      const pending = this.db.prepare("SELECT COUNT(*) n FROM jobs WHERE state='pending'").get() as { n: number };
      if (!pending.n) return;
      await this.tick();
    }
  }
}
