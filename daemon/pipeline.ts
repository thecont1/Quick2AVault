/**
 * Pipeline — P0 intake (sync, no AI) and P1 conversion (queued, no AI).
 * Plan §2. P2 analysis (Claude) plugs into the same `jobs` table.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import type { AiProvider } from "./ai-provider.js";
import { EXTRACTION_VERSION } from "./extraction-contract.js";
import { recordTransaction } from "./ledger.js";
import { findMatches, linkEvidence, AUTO_LINK, REVIEW_FLOOR } from "./matcher.js";
import { ask } from "./learning.js";

export interface IntakeResult {
  status: "added" | "duplicate" | "failed";
  document_id?: string;
  sha256?: string;
  existing_document_id?: string;
  archived_to?: string;
  error?: string;
}

export interface IngestOptions {
  source?: string;
  externalId?: string;
  /**
   * Remove the source file once a VERIFIED copy exists in the vault.
   *
   * Only ever true for files that arrived in the watched Drop folder. A file
   * pushed through POST /v1/intake lives somewhere the user owns (Downloads,
   * Desktop, another app's folder) and must never be deleted.
   */
  consumeSource?: boolean;
}

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const dateKey = (d: Date) => d.toISOString().slice(0, 10);

/** Strip characters that break Finder or shell round-trips, keep it readable. */
function safeName(name: string): string {
  return name.replace(/[/\\:\x00-\x1f]/g, "-").replace(/^\.+/, "").trim() || "document";
}

/**
 * A free path in `dir` for `filename`, appending " (2)", " (3)" on collision.
 * Two different invoices can legitimately share a name ("invoice.pdf"), and
 * silently overwriting one would destroy a user's document.
 */
async function uniquePath(dir: string, filename: string): Promise<string> {
  const base = safeName(filename);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  for (let n = 2; ; n++) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem} (${n})${ext}`);
    } catch {
      return candidate;
    }
  }
}

/** Move a file, falling back to copy+unlink across filesystems (EXDEV). */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EXDEV") throw err;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/**
 * P0 — synchronous intake. Hash, dedupe, ARCHIVE, record, emit, enqueue P1.
 * Target <100ms. Never does AI work. Raw is write-only after this point.
 *
 * Archiving is half the product: the vault ORGANISES documents, it does not
 * just read them. Originals land in Raw/<date>/ under their own filenames, and
 * the Drop folder is emptied so it stays an inbox rather than a junk drawer.
 */
export async function ingestFile(
  db: DatabaseSync,
  ports: Ports,
  filePath: string,
  opts: IngestOptions = {},
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
      // A duplicate still gets out of the inbox, but is NEVER deleted — it is
      // set aside so the user can confirm the vault already has it.
      let archivedTo: string | undefined;
      if (opts.consumeSource) {
        const dupDir = path.join(ports.paths.vaultRoot(), "Duplicates");
        await fs.mkdir(dupDir, { recursive: true });
        const dest = await uniquePath(dupDir, filename);
        await moveFile(filePath, dest);
        archivedTo = dest;
        ports.logger.info("duplicate set aside", { filename, dest });
      }
      return { status: "duplicate", sha256, existing_document_id: existing.id, archived_to: archivedTo };
    }

    const ext = path.extname(filename).toLowerCase();
    const id = newId("doc");
    const rawDir = ports.paths.rawDir(dateKey(ports.clock.now()));

    // Keep the ORIGINAL filename. Raw/ is meant to be browsable in Finder;
    // "doc_9f2f5429.pdf" tells a human nothing, "Proton Mail invoice
    // 21145650.pdf" tells them everything.
    const rawPath = await uniquePath(rawDir, filename);
    await fs.writeFile(rawPath, buf);

    // Verify the copy before touching the source. A truncated write followed
    // by an unlink would destroy the user's only copy of a document.
    const written = await fs.readFile(rawPath);
    const writtenHash = crypto.createHash("sha256").update(written).digest("hex");
    if (writtenHash !== sha256) {
      throw new Error(`archive verification failed for ${filename} (hash mismatch)`);
    }

    db.prepare(
      `INSERT INTO documents (id, sha256, original_filename, ext, byte_size, raw_path, source, received_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(id, sha256, filename, ext, buf.length, rawPath, source, now);

    if (opts.externalId) {
      db.prepare("INSERT OR REPLACE INTO source_events(source,external_id,document_id,created_at) VALUES(?,?,?,?)")
        .run(source, opts.externalId, id, now);
    }

    // Only now, with a verified copy in the vault, is it safe to empty the
    // inbox. Files pushed via the API are left where they are.
    if (opts.consumeSource) {
      try {
        await fs.unlink(filePath);
        ports.logger.info("filed", { filename, into: rawPath });
      } catch (err) {
        ports.logger.warn("archived but could not clear source", {
          filename,
          err: (err as Error)?.message,
        });
      }
    }

    recordIntake(db, ports, "added", filename, sha256, id, source, null);
    ports.bus.publish({ type: "DocumentReceived", document_id: id, filename, sha256, at: now });
    enqueue(db, ports, id, "convert");

    return { status: "added", document_id: id, sha256, archived_to: rawPath };
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    ports.logger.error("P0 intake failed", { filename, err: msg });
    recordIntake(db, ports, "failed", filename, undefined, undefined, source, msg);
    // A failed file stays in Drop on purpose: it is visible, retryable on the
    // next scan, and never silently swallowed.
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

/**
 * How many times a job may run before it is parked as `failed`.
 * Named because the retry threshold was previously an inline `>= 2` compared
 * against a STALE pre-increment counter, which quietly allowed one extra try.
 */
const MAX_JOB_ATTEMPTS = 3;

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
  const doc = db
    .prepare("SELECT id, raw_path, ext, original_filename FROM documents WHERE id=?")
    .get(documentId) as
    | { id: string; raw_path: string; ext: string; original_filename: string }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  const md = await ports.converter.toMarkdown(doc.raw_path, doc.ext ?? "");
  if (md === null) throw new Error(`conversion returned null for ${doc.ext}`);

  const mdDir = ports.paths.markdownDir(dateKey(ports.clock.now()));
  // Mirror the original filename so Markdown/ is browsable alongside Raw/.
  const stem = path.basename(doc.original_filename, path.extname(doc.original_filename));
  const mdPath = await uniquePath(mdDir, `${stem}.md`);
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
 * Re-file a document's archive copies under its ECONOMIC date once analysis
 * knows it.
 *
 * At P0 we only know when the file arrived, so it lands in Raw/<received>/.
 * But a user hunting for "that Airtel bill from June" thinks in transaction
 * dates, not the day they happened to drag it in. Once P2 extracts
 * occurred_at, the originals move to Raw/<occurred>/ and Markdown/<occurred>/.
 *
 * Never destructive: on any failure the existing paths are left untouched.
 */
async function refileByEconomicDate(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  occurredAt: string,
): Promise<void> {
  const day = occurredAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;

  const doc = db
    .prepare("SELECT raw_path, markdown_path FROM documents WHERE id=?")
    .get(documentId) as { raw_path: string; markdown_path: string | null } | undefined;
  if (!doc) return;

  try {
    let newRaw = doc.raw_path;
    if (doc.raw_path && path.basename(path.dirname(doc.raw_path)) !== day) {
      const dir = ports.paths.rawDir(day);
      const dest = await uniquePath(dir, path.basename(doc.raw_path));
      await moveFile(doc.raw_path, dest);
      newRaw = dest;
    }

    let newMd = doc.markdown_path;
    if (doc.markdown_path && path.basename(path.dirname(doc.markdown_path)) !== day) {
      const dir = ports.paths.markdownDir(day);
      const dest = await uniquePath(dir, path.basename(doc.markdown_path));
      await moveFile(doc.markdown_path, dest);
      newMd = dest;
    }

    if (newRaw !== doc.raw_path || newMd !== doc.markdown_path) {
      db.prepare("UPDATE documents SET raw_path=?, markdown_path=? WHERE id=?")
        .run(newRaw, newMd, documentId);
      ports.logger.info("re-filed under transaction date", {
        document_id: documentId,
        date: day,
      });
    }
  } catch (err) {
    ports.logger.warn("re-file failed; archive left as-is", {
      document_id: documentId,
      err: (err as Error)?.message,
    });
  }
}

/**
 * P2 — analysis. Claude reads canonical markdown v1 and returns extraction
 * JSON. Then: match against existing transactions (many documents, one rupee)
 * or record a new one.
 *
 * AI never rewrites the markdown. Its only product is the JSON stored on
 * documents.extraction_json.
 */
export async function runAnalyseJob(
  db: DatabaseSync,
  ports: Ports,
  ai: AiProvider,
  documentId: string,
): Promise<void> {
  const doc = db
    .prepare("SELECT id, original_filename, markdown_path, markdown_chars FROM documents WHERE id=?")
    .get(documentId) as
    | { id: string; original_filename: string; markdown_path: string | null; markdown_chars: number | null }
    | undefined;
  if (!doc) throw new Error(`document ${documentId} not found`);

  if (!ai.available) {
    ports.logger.info("analyse: no AI provider, skipping", { document_id: documentId });
    return;
  }
  if (!doc.markdown_path || !doc.markdown_chars) {
    ports.logger.warn("analyse: no markdown to analyse", { document_id: documentId });
    return;
  }

  const markdown = await fs.readFile(doc.markdown_path, "utf-8");
  const x = await ai.extract(markdown, doc.original_filename);
  const now = ports.clock.isoNow();

  if (!x) {
    // Extraction failure must not corrupt the ledger — the document stays in
    // the vault, unanalysed, and can be retried or reviewed.
    db.prepare("UPDATE documents SET analysed_at=? WHERE id=?").run(now, documentId);
    ports.logger.warn("analyse: extraction returned nothing", { document_id: documentId });
    return;
  }

  db.prepare("UPDATE documents SET extraction_json=?, extraction_version=?, doc_type=?, analysed_at=? WHERE id=?")
    .run(JSON.stringify(x), EXTRACTION_VERSION, x.doc_type, now, documentId);

  ports.bus.publish({
    type: "AnalysisComplete",
    document_id: documentId,
    extraction_version: EXTRACTION_VERSION,
    at: now,
  });

  if (x.doc_type === "irrelevant" || x.amount_minor === null) {
    ports.logger.info("analyse: no money movement", { document_id: documentId, doc_type: x.doc_type });
    return;
  }

  // File the archive under the ECONOMIC date now that we know it, so Finder
  // folders match how the user thinks about their documents.
  if (x.occurred_at) {
    await refileByEconomicDate(db, ports, documentId, x.occurred_at);
  }

  // ── the money shot: match before recording ──────────────────────────────
  const candidates = findMatches(db, x, documentId);
  const best = candidates[0];

  if (best && best.score >= AUTO_LINK) {
    linkEvidence(db, ports, best.transaction_id, documentId, x, best.score);
    ports.logger.info("AUTO-LINKED — two documents, one rupee", {
      document_id: documentId,
      transaction_id: best.transaction_id,
      score: best.score.toFixed(2),
      reasons: best.reasons.join("; "),
    });
    return;
  }

  if (best && best.score >= REVIEW_FLOOR) {
    // Ambiguous: record separately but surface the proposal rather than
    // silently guessing. Under-linking is recoverable; over-linking hides money.
    ports.bus.publish({
      type: "MatchProposed",
      transaction_id: best.transaction_id,
      document_id: documentId,
      score: best.score,
      at: now,
    });
    ports.logger.info("match proposed for review", {
      document_id: documentId,
      score: best.score.toFixed(2),
      reasons: best.reasons.join("; "),
    });
  }

  const rec = recordTransaction(db, ports, documentId, x);
  if (rec) {
    ports.logger.info("transaction recorded", {
      transaction_id: rec.transaction_id,
      direction: rec.direction,
      amount: (rec.amount_minor / 100).toFixed(2),
      new_entities: rec.created_entities,
    });

    // ── curiosity engine (plan §5) ────────────────────────────────────────
    // Ask ONLY on novelty, and only within budget. Every question here would
    // otherwise be a silent guess the user never gets to correct.
    if (rec.created_entities > 0 && x.counterparty_descriptor) {
      const cp = x.parties.find((pp) => pp.role === "counterparty" && pp.kind === "organisation");
      // Only ask when the raw bank descriptor and the resolved entity name are
      // ACTUALLY different. They are frequently identical, which produced
      // questions like `Is "PAYTM MONEY LIMITED" the same as PAYTM MONEY
      // LIMITED?` — a tautology that burns the curiosity budget, trains the
      // user to dismiss the review queue, and teaches the ledger nothing.
      // Compare on the same normalised form used for matching, so casing and
      // punctuation differences alone do not count as novelty either.
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (cp && norm(x.counterparty_descriptor) !== norm(cp.name)) {
        ask(db, ports, {
          trigger: "unseen_entity",
          question: `Is "${x.counterparty_descriptor}" the same as ${cp.name}?`,
          context: { document_id: documentId, entity_name: cp.name, descriptor: x.counterparty_descriptor },
          options: ["Yes, always", "No, keep separate"],
        });
      }
    }

    // A wallet-shaped payment that we did NOT book as a transfer is exactly
    // the ambiguity §3.1 warns about — worth one question, once.
    if (!rec.direction.startsWith("transfer") && x.is_wallet_topup) {
      ask(db, ports, {
        trigger: "load_vs_spend",
        question: `Was this ${x.counterparty_descriptor ?? "payment"} a wallet top-up rather than a purchase?`,
        context: { document_id: documentId, transaction_id: rec.transaction_id },
        options: ["Top-up (transfer)", "Purchase (spending)"],
      });
    }
  }
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
    private ai: AiProvider,
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
      // ATOMIC CLAIM. Read-then-write let two daemons claim the same job:
      // both SELECT the same pending row, both UPDATE it to running, and the
      // document is analysed twice — two API calls, two transactions, a
      // double-counted rupee. Double-starts are routine in practice (launch
      // agent plus a manual run, crash-restart overlap).
      //
      // The conditional UPDATE is the guard: `AND state='pending'` means only
      // one writer can win, and SQLite serialises the writes. The loser sees
      // changes === 0 and moves on.
      const now = this.ports.clock.isoNow();
      let job: { id: number; document_id: string; phase: string; attempts: number } | undefined;

      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = this.db
          .prepare("SELECT id, document_id, phase, attempts FROM jobs WHERE state='pending' ORDER BY id LIMIT 1")
          .get() as { id: number; document_id: string; phase: string; attempts: number } | undefined;
        if (!candidate) return;

        const claim = this.db
          .prepare("UPDATE jobs SET state='running', started_at=?, attempts=attempts+1 WHERE id=? AND state='pending'")
          .run(now, candidate.id);
        if (Number(claim.changes) === 1) {
          job = candidate;
          break;
        }
        // Lost the race — another worker took it. Try the next pending job.
      }
      if (!job) return;

      // The row was incremented by the claim, so this run is attempt N+1.
      // Thresholding on the stale pre-increment value gave one extra retry
      // than MAX_ATTEMPTS specified.
      const attemptNo = job.attempts + 1;
      this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "running", at: now });

      try {
        if (job.phase === "convert") {
          await runConvertJob(this.db, this.ports, job.id, job.document_id);
        } else if (job.phase === "analyse") {
          await runAnalyseJob(this.db, this.ports, this.ai, job.document_id);
        }
        const fin = this.ports.clock.isoNow();
        this.db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(fin, job.id);
        this.ports.bus.publish({ type: "JobStateChanged", job_id: job.id, phase: job.phase, state: "done", at: fin });
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        const state = attemptNo >= MAX_JOB_ATTEMPTS ? "failed" : "pending";
        // Clear started_at when going back in the queue, so a requeued job
        // does not look like it has been running since its first attempt.
        this.db
          .prepare("UPDATE jobs SET state=?, last_error=?, finished_at=?, started_at=CASE WHEN ?='pending' THEN NULL ELSE started_at END WHERE id=?")
          .run(state, msg, this.ports.clock.isoNow(), state, job.id);
        this.ports.logger.error("job failed", { job: job.id, phase: job.phase, attempts: attemptNo, max: MAX_JOB_ATTEMPTS, err: msg });
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
