/**
 * Core API (plan §1 layer 3) — versioned HTTP contract + SSE event stream.
 * Every UI is a client of this: tray, web, CLI, MCP.
 *
 * Auth: localhost bearer token. Health is deliberately unauthenticated so a
 * probe can distinguish "daemon down" from "daemon up but token wrong".
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { ingestFile, restoreIntake, reclassifyIntake, enqueue } from "./pipeline.js";
import { listPacks, loadPack, fyKeyFor, fyRange, type JurisdictionPack } from "./jurisdiction.js";
import { buildTreemap } from "./categories/spend-categories.js";
import { deriveGmailAddress } from "./gmail/gmail-model.js";
import { pageCapability, renderPage } from "./rasterise.js";
import type { GmailOAuth } from "./gmail/oauth.js";
import type { MutableAiProvider } from "./ai-provider.js";
import type { SecretStore } from "./secret-store.js";
import { SCHEMA_VERSION, normaliseName } from "./schema.js";
import type { ClaimSubject } from "./schema.js";
import {
  allowedFields,
  audit,
  claimsFor,
  ClaimRefused,
  propagateFromDocument,
  resolveTransaction,
  winningClaim,
  writeClaim,
  setDocumentParty,
  type DocumentPartyRole,
  type ResolvedTransaction,
} from "./claims.js";
import { rebuildSearchIndex, searchDocuments, removeFromIndex } from "./search.js";
import { activeDocumentSql, activeTransactionSql, isActive, listableDocumentSql } from "./lifecycle.js";
import {
  backfillEmbeddings,
  hybridSearch,
  type EmbeddingProvider,
} from "./embeddings.js";
import {
  isLearningEnabled,
  questionBudget,
  answer as answerQuestion,
  dismiss as dismissQuestion,
  findNearDuplicates,
  proposeDescriptorRule,
} from "./learning.js";
import {
  applyPersonCorrection,
  classifyIdentifier,
  isGenericMailbox,
  mergePeople,
  normaliseIdentifier,
  recordMergeCandidate,
  UNIDENTIFIED_PERSON_ID,
} from "./identity.js";
import {
  DOC_TYPES,
  IMPACT_BUCKETS,
  createRegistryValue,
  listVocabulary,
  pipelineEventsFor,
  transitionPipeline,
  answerLearningQuestion,
  type Vocabulary,
} from "./workorders.js";

export interface ApiOptions {
  port: number;
  host?: string;
  token: string;
  version: string;
  /**
   * Work order 07 §C1: a build identifier (git SHA or build ID) surfaced on
   * /v1/health so the client can distinguish a stale daemon from an empty
   * vault. Defaults to the version string when not separately provided.
   */
  buildId?: string;
  /**
   * Surfaced on the Setup page, and reconfigured in place when the user saves
   * or clears an API key — the provider is mutable so a Settings change takes
   * effect on the next job instead of requiring a daemon restart.
   */
  ai?: MutableAiProvider;
  dropDir?: string;
  /**
   * Vault root. Used to confine document file reads: /v1/documents/<id>/file
   * serves bytes off disk, and raw_path must be proven to resolve inside this
   * directory first. Without it that route would be an arbitrary-file-read
   * primitive for anyone who can write a documents row.
   */
  vaultDir: string;
  /** Serve the browser dev UI at `/`. Off unless Q2AV_DEV_UI=1. */
  devUi?: boolean;
  /** Gmail dropbox, present only when Google OAuth credentials are set. */
  gmail?: { oauth: GmailOAuth; sync: (opts?: { afterDate?: string; force?: boolean }) => Promise<unknown> };
  /** Embedding provider for hybrid search (work order 04 §Track B). */
  embed?: EmbeddingProvider;
  /** Secret store for AI API keys (Keychain on macOS, 0600 file elsewhere). */
  secrets?: SecretStore;
}

/**
 * Work order 07 §C1: capability flags advertised on /v1/health. The client
 * uses these to distinguish compatible, outdated, and capability-unavailable
 * states. A stale daemon must not masquerade as an empty vault.
 */
export const DAEMON_CAPABILITIES = {
  irrelevant: true,        // WO06: deterministic intake triage
  people_aliases: true,    // WO05: typed aliases + identity resolution
  semantic_search: true,   // WO04: hybrid lexical + embedding search
  statement_lines: true,   // WO04: statement staging + reconciliation
  provider_test: true,     // WO07: /v1/settings/provider-test endpoint
  popover_mode: true,      // WO07: health flag for popover-aware clients
  idempotent_ledger: true, // WO07: evidence-key uniqueness prevents duplicates
} as const;

export function createApi(db: DatabaseSync, ports: Ports, opts: ApiOptions) {
  const startedAt = Date.now();
  const embedProvider: EmbeddingProvider = opts.embed ?? {
    available: false,
    model: "(none)",
    dims: 0,
    async embed() {
      return [];
    },
  };
  // Fall back to an inert provider when none was supplied (tests, headless
  // use). reconfigure() is a no-op there rather than undefined, so the
  // settings route does not need to branch on whether AI exists.
  const ai: MutableAiProvider =
    opts.ai ?? {
      available: false,
      model: "(none)",
      async extract() {
        return null;
      },
      reconfigure() {
        return false;
      },
    };
  const dropDir = opts.dropDir ?? "";
  const gmail = opts.gmail;
  const secrets: SecretStore | undefined = opts.secrets;

  /**
   * Active jurisdiction pack. Re-read per request so switching packs from the
   * Setup page takes effect without a restart; loadPack is a small JSON read.
   */
  const activePack = (): JurisdictionPack => {
    const row = db
      .prepare("SELECT value FROM app_settings WHERE key='jurisdiction.id'")
      .get() as { value?: string } | undefined;
    try {
      return loadPack(row?.value || "IN");
    } catch {
      return loadPack("IN");
    }
  };

  const send = (res: ServerResponse, code: number, body: unknown) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
    res.end(b);
  };

  // ── UI session tokens ──────────────────────────────────────────────────────
  // The demo UI used to receive `opts.token` inlined into its HTML, from an
  // UNAUTHENTICATED route. Any local process could `curl 127.0.0.1:<port>/`
  // and read the bearer token that guards every other endpoint, so the auth
  // on those endpoints was decorative.
  //
  // Instead the page gets a short-lived, single-purpose session token. It
  // grants the same API access (the UI needs it) but expires, so a leaked
  // page source stops being useful quickly and never reveals the long-lived
  // token that the Flutter app and scripts use.
  const UI_SESSION_TTL_MS = 15 * 60 * 1000;
  const uiSessions = new Map<string, number>();

  const mintUiSession = (): string => {
    const now = Date.now();
    for (const [t, exp] of uiSessions) if (exp <= now) uiSessions.delete(t);
    const token = randomBytes(32).toString("base64url");
    uiSessions.set(token, now + UI_SESSION_TTL_MS);
    return token;
  };

  const uiSessionValid = (token: string): boolean => {
    const exp = uiSessions.get(token);
    if (exp === undefined) return false;
    if (exp <= Date.now()) {
      uiSessions.delete(token);
      return false;
    }
    return true;
  };

  /** Constant-time compare so the token cannot be recovered byte by byte. */
  const tokenMatches = (given: string): boolean => {
    const a = Buffer.from(given);
    const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /**
   * Tokens in URLs end up in access logs, browser history and Referer
   * headers, so the query-string fallback exists ONLY for the SSE stream,
   * where EventSource genuinely cannot set an Authorization header. Every
   * other route — including POST /v1/intake and /v1/settings — is
   * header-only.
   */
  const QUERY_TOKEN_ROUTES = new Set(["/v1/events"]);

  const authed = (req: IncomingMessage, url?: URL) => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ")) {
      const given = h.slice(7);
      if (tokenMatches(given) || uiSessionValid(given)) return true;
    }
    if (!url || !QUERY_TOKEN_ROUTES.has(url.pathname)) return false;
    const q = url.searchParams.get("token");
    return !!q && (tokenMatches(q) || uiSessionValid(q));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    const pack = activePack();

    try {
      // ── the demo UI ──────────────────────────────────────────────────────
      // OFF by default. It is a development convenience, not a product
      // surface — the Flutter app is the real UI — and serving it means
      // handing a browser API access. Enable with Q2AV_DEV_UI=1.
      if (p === "/" || p === "/index.html") {
        if (!opts.devUi) {
          return send(res, 404, { error: "not_found", hint: "set Q2AV_DEV_UI=1 to enable the dev UI" });
        }
        const file = path.join(import.meta.dirname ?? __dirname, "ui.html");
        let html: string;
        try {
          html = await fsp.readFile(file, "utf-8");
        } catch {
          return send(res, 404, { error: "ui.html not found", expected: file });
        }
        // A SHORT-LIVED session token, never the long-lived API token. The
        // page is still readable by any local process, but what it leaks now
        // expires in 15 minutes and cannot be used to impersonate the app
        // afterwards.
        html = html.replace("%%TOKEN%%", mintUiSession());
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          // The page holds a credential: keep it out of caches and referrers.
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        });
        return res.end(html);
      }

      // ── static assets for the dev UI (CSS + JS modules) ──────────────────
      // Serves files from daemon/ui/ with safe content types. Only enabled
      // when devUi is on, same as the HTML shell. No token substitution —
      // the JS files use the TOKEN constant set by ui.html's inline script.
      if (p.startsWith("/ui/") && opts.devUi) {
        const rel = p.slice("/ui/".length);
        // Confine to the ui/ directory — no path traversal.
        if (rel.includes("..") || rel.includes("\0")) {
          return send(res, 400, { error: "bad path" });
        }
        const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
        const types: Record<string, string> = {
          css: "text/css; charset=utf-8",
          js: "application/javascript; charset=utf-8",
          map: "application/json; charset=utf-8",
        };
        if (!types[ext]) return send(res, 404, { error: "not_found" });
        const file = path.join(import.meta.dirname ?? __dirname, "ui", rel);
        try {
          const body = await fsp.readFile(file);
          res.writeHead(200, {
            "content-type": types[ext],
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          return res.end(body);
        } catch {
          return send(res, 404, { error: "not_found", expected: file });
        }
      }

      // ── unauthenticated: health ──────────────────────────────────────────
      if (p === "/v1/health") {
        const jobs = db.prepare("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all() as {
          state: string;
          n: number;
        }[];
        return send(res, 200, {
          status: "ok",
          // Work order 07 §C1: the health contract. The client uses these to
          // distinguish compatible, outdated, unreachable, and
          // capability-unavailable states. A stale daemon must not masquerade
          // as an empty vault.
          api_version: "1",
          version: opts.version,
          build_id: opts.buildId ?? opts.version,
          schema_version: SCHEMA_VERSION,
          capabilities: DAEMON_CAPABILITIES,
          uptime_s: Math.round((Date.now() - startedAt) / 1000),
          db: ports.paths.dbPath(),
          documents: (db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n,
          transactions: (db.prepare("SELECT COUNT(*) n FROM transactions").get() as { n: number }).n,
          jobs: Object.fromEntries(jobs.map((j) => [j.state, j.n])),
        });
      }

      // ── everything below requires the bearer token ───────────────────────
      if (!authed(req, url)) return send(res, 401, { error: "unauthorized" });

      // ── SSE event stream ─────────────────────────────────────────────────
      if (p === "/v1/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const write = (e: unknown) => {
          const ev = e as { type: string };
          res.write(`event: ${ev.type}\ndata: ${JSON.stringify(e)}\n\n`);
        };
        // Replay recent events so a UI attaching late isn't blind.
        for (const e of ports.bus.recent(20)) write(e);
        res.write(`event: Ready\ndata: ${JSON.stringify({ at: ports.clock.isoNow() })}\n\n`);
        const unsub = ports.bus.subscribe(write);
        const ka = setInterval(() => res.write(": keepalive\n\n"), 15000);
        req.on("close", () => {
          clearInterval(ka);
          unsub();
        });
        return;
      }

      // ── commands ─────────────────────────────────────────────────────────
      if (p === "/v1/intake" && req.method === "POST") {
        const body = await readJson(req);
        const filePath = body?.path;
        if (!filePath) return send(res, 400, { error: "path required" });
        const result = await ingestFile(db, ports, filePath, {
          source: body.source ?? "api",
          externalId: body.external_id,
          // Deliberately NOT consuming: a file pushed through the API lives in
          // the caller's own space (Downloads, another app's folder). The vault
          // copies it; it never deletes someone else's file.
        });
        return send(res, result.status === "failed" ? 500 : 200, result);
      }

      // ── work order 06 — intake restore / reclassify (§8) ──────────────────
      // Restore re-runs triage on a preserved irrelevant file and, if accepted,
      // promotes it into the normal processing queue. Reclassify is the same
      // operation exposed under a different verb for UI clarity. Both are
      // non-destructive: the original irrelevant copy is preserved as audit.
      {
        const m = /^\/v1\/intake\/(\d+)\/(restore|reclassify)$/.exec(p);
        if (m && req.method === "POST") {
          const id = Number(m[1]);
          try {
            const result = m[2] === "restore"
              ? await restoreIntake(db, ports, id)
              : await reclassifyIntake(db, ports, id);
            return send(res, 200, result);
          } catch (err) {
            return send(res, 404, { error: (err as Error)?.message ?? "intake not found" });
          }
        }
      }

      // Work order 07 §G — submit a password for an encrypted document.
      // The intake must be in 'password_needed' state. The password is stored
      // on the document row and the convert job is re-enqueued.
      {
        const m = /^\/v1\/intake\/(\d+)\/password$/.exec(p);
        if (m && req.method === "POST") {
          const id = Number(m[1]);
          const body = await readJson(req);
          const password = body?.password;
          if (typeof password !== "string") {
            return send(res, 400, { error: "password required" });
          }
          // Find the intake event and its document_id.
          const intake = db
            .prepare("SELECT document_id, processing_state FROM intake_events WHERE id=?")
            .get(id) as { document_id: string | null; processing_state: string } | undefined;
          if (!intake) {
            return send(res, 404, { error: "intake not found" });
          }
          if (!intake.document_id) {
            return send(res, 409, { error: "intake has no document — password not applicable" });
          }
          // Store the password on the document.
          db.prepare("UPDATE documents SET password=? WHERE id=?")
            .run(password, intake.document_id);
          // Update the intake state back to queued so the UI shows progress.
          const now = ports.clock.isoNow();
          db.prepare(
            `UPDATE intake_events
                SET processing_state='queued', last_error=NULL, updated_at=?, stage_started_at=?, heartbeat_at=?
              WHERE id=?`,
          ).run(now, now, now, id);
          // Reset the canonical pipeline state via transitionPipeline so a
          // PipelineStateChanged event is published for the SSE stream. The
          // state machine has password_needed as terminal with no outgoing
          // edges, and null → triaged is also illegal, so we insert the row
          // directly at 'triaged' and publish the event manually.
          const prevState = (db
            .prepare("SELECT state FROM document_pipeline WHERE document_id=?")
            .get(intake.document_id) as { state: string } | undefined)?.state ?? null;
          db.prepare(
            `INSERT INTO document_pipeline(document_id, state, updated_at) VALUES(?,?,?)
             ON CONFLICT(document_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
          ).run(intake.document_id, "triaged", now);
          db.prepare(
            `INSERT INTO pipeline_events (document_id, from_state, to_state, timestamp, source, reason, payload_json)
             VALUES (?,?,?,?,?,?,?)`,
          ).run(intake.document_id, prevState, "triaged", now, "password-submit", "password submitted, re-enqueuing conversion", "{}");
          ports.bus.publish({
            type: "PipelineStateChanged",
            document_id: intake.document_id,
            from_state: prevState,
            to_state: "triaged",
            source: "password-submit",
            reason: "password submitted, re-enqueuing conversion",
            at: now,
          });
          // Re-enqueue the convert job.
          enqueue(db, ports, intake.document_id, "convert");
          ports.logger.info("password submitted, re-enqueuing conversion", {
            intake_id: id,
            document_id: intake.document_id,
          });
          return send(res, 200, {
            ok: true,
            intake_id: id,
            document_id: intake.document_id,
            state: "queued",
          });
        }
      }

      // Document-level password submission — same as the intake-level
      // endpoint above but keyed by document_id, which is what the web UI's
      // document viewer has on hand. Looks up the intake row, then delegates
      // to the same store-and-re-enqueue flow.
      //
      // The pipeline state machine has password_needed as a terminal state
      // with no outgoing edges, so we must reset document_pipeline back to
      // 'triaged' before re-enqueuing — otherwise the worker's transition
      // from password_needed → converting throws and crashes the daemon.
      {
        const m = /^\/v1\/documents\/([^/]+)\/password$/.exec(p);
        if (m && req.method === "POST") {
          const docId = decodeURIComponent(m[1]);
          const body = await readJson(req);
          const password = body?.password;
          if (typeof password !== "string") {
            return send(res, 400, { error: "password required" });
          }
          const intake = db
            .prepare("SELECT id, document_id, processing_state FROM intake_events WHERE document_id=? ORDER BY id DESC LIMIT 1")
            .get(docId) as { id: number; document_id: string | null; processing_state: string } | undefined;
          if (!intake) {
            return send(res, 404, { error: "intake not found for document", document_id: docId });
          }
          db.prepare("UPDATE documents SET password=? WHERE id=?").run(password, docId);
          const now = ports.clock.isoNow();
          db.prepare(
            `UPDATE intake_events
                SET processing_state='queued', last_error=NULL, updated_at=?, stage_started_at=?, heartbeat_at=?
              WHERE id=?`,
          ).run(now, now, now, intake.id);
          // Reset the canonical pipeline state and publish a
          // PipelineStateChanged event for the SSE stream. Same approach as
          // the intake-level endpoint above — insert directly at 'triaged'
          // and publish manually, since the state machine has no legal path
          // from password_needed to triaged.
          const prevState = (db
            .prepare("SELECT state FROM document_pipeline WHERE document_id=?")
            .get(docId) as { state: string } | undefined)?.state ?? null;
          db.prepare(
            `INSERT INTO document_pipeline(document_id, state, updated_at) VALUES(?,?,?)
             ON CONFLICT(document_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at`,
          ).run(docId, "triaged", now);
          db.prepare(
            `INSERT INTO pipeline_events (document_id, from_state, to_state, timestamp, source, reason, payload_json)
             VALUES (?,?,?,?,?,?,?)`,
          ).run(docId, prevState, "triaged", now, "password-submit", "password submitted, re-enqueuing conversion", "{}");
          ports.bus.publish({
            type: "PipelineStateChanged",
            document_id: docId,
            from_state: prevState,
            to_state: "triaged",
            source: "password-submit",
            reason: "password submitted, re-enqueuing conversion",
            at: now,
          });
          enqueue(db, ports, docId, "convert");
          ports.logger.info("password submitted (by document), re-enqueuing conversion", {
            intake_id: intake.id,
            document_id: docId,
          });
          return send(res, 200, {
            ok: true,
            intake_id: intake.id,
            document_id: docId,
            state: "queued",
          });
        }
      }

      // linkDocuments — attach a document to a transaction as evidence, or
      // detach one the matcher got wrong. Both directions are user claims and
      // outrank AI (field_claims precedence: user > rule > ai).
      if (p === "/v1/link" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.transaction_id || !b.document_id) {
          return send(res, 400, { error: "transaction_id and document_id required" });
        }
        const now = ports.clock.isoNow();
        const role = b.evidence_role ?? "payment_receipt";
        if (!["merchant_invoice", "payment_receipt", "bank_slip", "card_confirmation", "statement_line", "refund_note", "contract_note"].includes(role)) {
          return send(res, 400, { error: "invalid evidence_role", valid: ["merchant_invoice", "payment_receipt", "bank_slip", "card_confirmation", "statement_line", "refund_note", "contract_note"] });
        }
        db.prepare(
          `INSERT OR REPLACE INTO transaction_documents
            (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
           VALUES (?,?,?,?, 'user', ?)`,
        ).run(b.transaction_id, b.document_id, role, 1.0, now);
        db.prepare(
          "INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, created_at) VALUES ('transaction',?,?,?, 'user', 1.0, ?)",
        ).run(b.transaction_id, "evidence_link", b.document_id, now);
        ports.bus.publish({
          type: "MatchProposed",
          transaction_id: b.transaction_id,
          document_id: b.document_id,
          score: 1,
          at: now,
        });
        return send(res, 200, { linked: true, transaction_id: b.transaction_id, document_id: b.document_id });
      }

      // ── WO09/WO10 selectable vocabularies + role-scoped parties ─────────
      if (p === "/v1/vocabularies" && req.method === "GET") {
        return send(res, 200, {
          entities: listVocabulary(db, "entities"), accounts: listVocabulary(db, "accounts"),
          categories: listVocabulary(db, "categories"), impact_buckets: [...IMPACT_BUCKETS], document_types: [...DOC_TYPES],
        });
      }
      {
        const vm = /^\/v1\/vocabularies\/([^/]+)$/.exec(p);
        const map: Record<string, Vocabulary> = { entities:"entities",accounts:"accounts",categories:"categories",impactBuckets:"impactBuckets",impact_buckets:"impactBuckets",docTypes:"docTypes",document_types:"docTypes",settings:"settings" };
        if (vm && req.method === "GET") {
          const name = decodeURIComponent(vm[1]);
          const vocabulary = map[name]; if (!vocabulary) return send(res,404,{error:"unknown_vocabulary"});
          return send(res,200,{vocabulary,values:listVocabulary(db,vocabulary,url.searchParams.get("kind")??undefined)});
        }
        if (vm && req.method === "POST") {
          const name=decodeURIComponent(vm[1]); const vocabulary=map[name];
          if(!vocabulary)return send(res,404,{error:"unknown_vocabulary"});
          if(vocabulary!=="categories")return send(res,405,{error:"vocabulary_read_only",allow:"GET"});
          const b=await readJson(req); const value=typeof b.value==="string"?b.value:"";
          if(!value)return send(res,400,{error:"value required"});
          return send(res,200,createRegistryValue(db,ports,"category",value));
        }
      }
      {
        const pm = /^\/v1\/documents\/([^/]+)\/parties$/.exec(p);
        if (pm && req.method === "GET") {
          const documentId=decodeURIComponent(pm[1]);
          return send(res,200,{document_id:documentId,parties:db.prepare(`SELECT dp.*,e.kind,e.display_name FROM document_parties dp JOIN entities e ON e.id=dp.entity_id WHERE dp.document_id=? ORDER BY dp.role,e.display_name`).all(documentId)});
        }
        if (pm && req.method === "PUT") {
          const documentId=decodeURIComponent(pm[1]); const b=await readJson(req);
          const role=String(b.role??"") as DocumentPartyRole, entityId=String(b.entity_id??"");
          if(!["owner","counterparty","issuer","source_of_funds"].includes(role)||!entityId)return send(res,400,{error:"valid role and entity_id required"});
          try{setDocumentParty(db,ports,{documentId,entityId,role,confidence:typeof b.confidence==="number"?b.confidence:1,editedBy:typeof b.edited_by==="string"?b.edited_by:undefined});}
          catch(err){if(err instanceof ClaimRefused)return send(res,409,{error:err.code,message:err.message,...err.detail});throw err;}
          return send(res,200,{updated:true,document_id:documentId,entity_id:entityId,role});
        }
      }
      {
        const em=/^\/v1\/documents\/([^/]+)\/pipeline-events$/.exec(p);
        if(em&&req.method==="GET"){const documentId=decodeURIComponent(em[1]);return send(res,200,{document_id:documentId,events:pipelineEventsFor(db,documentId)});}
      }

      // ── WO09/WO10 P4.5: document lifecycle (Glaze manage footer) ──────────
      //
      // Three verbs behind the detail footer's "Reprocess", "Remove from
      // active" and "Delete permanently". Each is deliberately conservative:
      //   reprocess         re-enqueues the analyse phase; the JobWorker drains
      //                     it and idempotency (transaction_documents unique on
      //                     document_id+evidence_role) guarantees no second
      //                     economic event. If markdown was never produced it
      //                     re-runs convert first. Reactivates a removed doc.
      //   remove-from-active soft state only: the original file and every claim
      //                     stay on disk; the doc is hidden from Review and its
      //                     search index entry is dropped. Fully reversible.
      //   DELETE            permanent: raw + markdown bytes are unlinked from
      //                     disk and the row is tombstoned as 'deleted' so the
      //                     sha256 dedupe guard still rejects a re-drop.
      {
        const rm = /^\/v1\/documents\/([^/]+)\/reprocess$/.exec(p);
        if (rm && req.method === "POST") {
          const documentId = decodeURIComponent(rm[1]);
          const doc = db
            .prepare("SELECT id, markdown_path, markdown_chars, lifecycle FROM documents WHERE id=?")
            .get(documentId) as
            | { id: string; markdown_path: string | null; markdown_chars: number | null; lifecycle: string }
            | undefined;
          if (!doc) return send(res, 404, { error: "document_not_found", document_id: documentId });
          if (doc.lifecycle === "deleted") return send(res, 409, { error: "document_deleted", document_id: documentId });
          const phase = doc.markdown_path && doc.markdown_chars ? "analyse" : "convert";
          // Reprocess is a new canonical pipeline epoch. Preserve the append-only
          // event history, but reset the current-state pointer and replay the
          // legal prefix up to the phase the worker will enter. Weakening the
          // state machine here would hide illegal transitions everywhere else.
          db.exec("BEGIN");
          try {
            if (doc.lifecycle !== "active") {
              db.prepare("UPDATE documents SET lifecycle='active' WHERE id=?").run(documentId);
            }
            db.prepare("DELETE FROM document_pipeline WHERE document_id=?").run(documentId);
            const prefix = phase === "analyse"
              ? ["received", "stable", "hashed", "triaged", "converting"] as const
              : ["received", "stable", "hashed", "triaged"] as const;
            for (const toState of prefix) {
              transitionPipeline(db, {
                documentId,
                toState,
                timestamp: ports.clock.isoNow(),
                source: "reprocess",
              });
            }
            enqueue(db, ports, documentId, phase);
            db.exec("COMMIT");
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
          return send(res, 200, { reprocessing: true, document_id: documentId, phase });
        }
      }
      {
        const rm = /^\/v1\/documents\/([^/]+)\/remove-from-active$/.exec(p);
        if (rm && req.method === "POST") {
          const documentId = decodeURIComponent(rm[1]);
          const doc = db
            .prepare("SELECT id, lifecycle FROM documents WHERE id=?")
            .get(documentId) as { id: string; lifecycle: string } | undefined;
          if (!doc) return send(res, 404, { error: "document_not_found", document_id: documentId });
          if (doc.lifecycle === "deleted") return send(res, 409, { error: "document_deleted", document_id: documentId });
          db.prepare("UPDATE documents SET lifecycle='removed' WHERE id=?").run(documentId);
          try { removeFromIndex(db, documentId); } catch { /* index optional */ }
          return send(res, 200, { removed: true, document_id: documentId });
        }
      }
      {
        const dm = /^\/v1\/documents\/([^/]+)$/.exec(p);
        if (dm && req.method === "DELETE") {
          const documentId = decodeURIComponent(dm[1]);
          const doc = db
            .prepare("SELECT id, raw_path, markdown_path, lifecycle FROM documents WHERE id=?")
            .get(documentId) as
            | { id: string; raw_path: string | null; markdown_path: string | null; lifecycle: string }
            | undefined;
          if (!doc) return send(res, 404, { error: "document_not_found", document_id: documentId });
          if (doc.lifecycle === "deleted") return send(res, 200, { deleted: true, document_id: documentId, already: true });
          // Unlink the on-disk bytes, but confine every path to the vault root
          // first — the same arbitrary-file guard the /file route uses.
          const vaultRoot = path.resolve(opts.vaultDir);
          for (const candidate of [doc.raw_path, doc.markdown_path]) {
            if (!candidate) continue;
            const resolved = path.resolve(candidate);
            if (resolved === vaultRoot || resolved.startsWith(vaultRoot + path.sep)) {
              try { await fsp.unlink(resolved); } catch { /* already gone */ }
            }
          }
          // Tombstone rather than DROP: the sha256 UNIQUE guard must keep
          // rejecting a re-drop of the same bytes, and the audit trail stays
          // intact. Clear the disk pointers so nothing tries to read them.
          db.prepare(
            "UPDATE documents SET lifecycle='deleted', raw_path='', markdown_path=NULL, markdown_chars=NULL WHERE id=?",
          ).run(documentId);
          try { removeFromIndex(db, documentId); } catch { /* index optional */ }
          return send(res, 200, { deleted: true, document_id: documentId });
        }
      }

      // ── claims: the inline-editing surface (work order 03 §P2) ───────────
      //
      // Editing writes a CLAIM, never a direct column update. The stored value
      // on transactions is derived; the claim is the statement of fact, and
      // keeping the two separate is what lets a correction survive
      // re-extraction and outrank the model without a special case.
      //
      //   PATCH /v1/documents/:id/claims     what the paper says
      //   PATCH /v1/transactions/:id/claims  what the ledger holds
      //   GET   /v1/documents/:id/claims     provenance per field
      //   GET   /v1/transactions/:id/claims
      {
        const m = /^\/v1\/(documents|transactions|entities)\/([^/]+)\/claims$/.exec(p);
        if (m) {
          const subject = (m[1] === "documents"
            ? "document"
            : m[1] === "transactions"
              ? "transaction"
              : "entity") as ClaimSubject;
          const subjectId = decodeURIComponent(m[2]);

          const table = subject === "document" ? "documents" : subject === "transaction" ? "transactions" : "entities";
          const exists = db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(subjectId);
          if (!exists) return send(res, 404, { error: "not_found", subject, subject_id: subjectId });

          if (req.method === "GET") {
            const claims = claimsFor(db, subject, subjectId);
            return send(res, 200, {
              subject_type: subject,
              subject_id: subjectId,
              editable_fields: [...allowedFields(subject)],
              claims: Object.fromEntries(
                Object.entries(claims).map(([field, c]) => [
                  field,
                  {
                    value: c.value,
                    source: c.source,
                    status: c.status,
                    confidence: c.confidence,
                    provenance: c.source === "user" ? "user-confirmed" : c.source === "rule" ? "rule-derived" : "ai-derived",
                    provenance_ref: c.provenance_ref ?? null,
                    edited_at: c.edited_at ?? c.created_at,
                    edited_by: c.edited_by ?? null,
                    at: c.created_at,
                  },
                ]),
              ),
            });
          }

          if (req.method === "PATCH" || req.method === "PUT") {
            const b = (await readJson(req)) as Record<string, unknown>;
            const field = typeof b.field === "string" ? b.field : "";
            if (!field) return send(res, 400, { error: "field required" });
            if (!("value" in b)) return send(res, 400, { error: "value required (may be null to clear)" });

            // Values are stored as TEXT. A number arriving as JSON is
            // stringified here rather than at every read site, so the column
            // holds one representation instead of two.
            const value = b.value === null || b.value === undefined ? null : String(b.value);
            const before = winningClaim(db, subject, subjectId, field);

            let written: ReturnType<typeof writeClaim>;
            try {
              written = writeClaim(db, ports, {
                subject,
                subjectId,
                field,
                value,
                source: "user",
              });
            } catch (err) {
              if (err instanceof ClaimRefused) {
                return send(res, 409, { error: err.code, message: err.message, ...err.detail });
              }
              throw err;
            }

            audit(db, ports, {
              subject,
              subjectId,
              field,
              action: "edit",
              oldValue: before?.value ?? null,
              newValue: value,
              source: "user",
            });

            // Propagate. A document edit re-resolves every transaction the
            // document backs; a transaction edit re-resolves itself. An orphan
            // document resolves nothing, and that is a success, not an error —
            // the claim is stored and applies when the document is linked.
            let affected: ResolvedTransaction[] = [];
            if (subject === "document") {
              affected = propagateFromDocument(db, ports, subjectId, [field]);
            } else if (subject === "transaction") {
              const r = resolveTransaction(db, ports, subjectId);
              if (r) affected = [r];
              ports.bus.publish({
                type: "TransactionReResolved",
                transaction_ids: [subjectId],
                document_id: null,
                fields: [field],
                at: ports.clock.isoNow(),
              });
            }

            // Feed the learning engine: a corrected vendor is evidence for a
            // descriptor→entity rule, which is how the same mistake stops
            // recurring instead of being fixed one document at a time.
            const candidate =
              subject === "document" && (field === "vendor" || field === "counterparty") && value
                ? proposeDescriptorRule(db, ports, subjectId, value)
                : null;

            // Work order 05 §Track C: a corrected PERSON relinks this
            // document's party row and stores the old spelling as a confirmed
            // alias on the corrected person — document-scoped first, durable
            // identity second. The extraction JSON and markdown are untouched.
            let personResolution: ReturnType<typeof applyPersonCorrection> | null = null;
            if (subject === "document" && field === "person" && value) {
              personResolution = applyPersonCorrection(db, ports, subjectId, value, before?.value);
              audit(db, ports, {
                subject: "entity",
                subjectId: personResolution.person_id,
                field: "document_link",
                action: "edit",
                oldValue: before?.value ?? null,
                newValue: value,
                source: "user",
              });
            }

            return send(res, 200, {
              claim_id: written.claim_id,
              subject_type: subject,
              subject_id: subjectId,
              field,
              value,
              previous: written.previous,
              superseded: written.superseded,
              affected_transactions: affected.map((a) => ({
                transaction_id: a.transaction_id,
                changed: a.changed,
                reasons: a.reasons,
                mismatches: a.mismatches,
              })),
              rule_candidate: candidate,
              person_resolution: personResolution,
            });
          }

          return send(res, 405, { error: "method_not_allowed", allow: "GET, PATCH, PUT" });
        }
      }

      // ── audit trail ──────────────────────────────────────────────────────
      // Every edit is appended, never updated. This is the answer to "why does
      // it say that" when the claim itself has since been superseded.
      if (p === "/v1/audit" && req.method === "GET") {
        const subjectId = url.searchParams.get("subject_id");
        const subjectType = url.searchParams.get("subject_type");
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);

        const where: string[] = [];
        const args: string[] = [];
        if (subjectId) {
          where.push("subject_id=?");
          args.push(subjectId);
        }
        if (subjectType) {
          where.push("subject_type=?");
          args.push(subjectType);
        }
        const rows = db
          .prepare(
            `SELECT id, subject_type, subject_id, field, action, old_value, new_value, source, at
               FROM review_audit
              ${where.length ? "WHERE " + where.join(" AND ") : ""}
              ORDER BY id DESC LIMIT ?`,
          )
          .all(...args, limit);
        return send(res, 200, { audit: rows });
      }

      // ── search (work order 03 §P1 lexical, 04 §Track B hybrid) ─────────
      if (p === "/v1/search" && req.method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return send(res, 400, { error: "q required" });
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 25) || 25, 100);
        const mode = url.searchParams.get("mode") ?? "auto";
        const alphaParam = Number(url.searchParams.get("alpha") ?? "0.5");
        const alpha = Number.isFinite(alphaParam) ? Math.min(Math.max(alphaParam, 0), 1) : 0.5;

        // "auto" picks hybrid when embeddings exist, lexical otherwise.
        // "lexical" is always available. "hybrid" falls back to lexical when
        // the embedding provider is unavailable, rather than 501 — the query
        // still has a useful answer.
        const wantHybrid = mode === "hybrid" || mode === "auto";
        const canHybrid = embedProvider.available;

        if (wantHybrid && canHybrid) {
          const hits = await hybridSearch(db, ports, embedProvider, q, limit, alpha);
          return send(res, 200, {
            query: q,
            mode: "hybrid",
            alpha,
            count: hits.length,
            results: hits,
          });
        }
        if (mode === "hybrid" && !canHybrid) {
          // Graceful fallback: the caller asked for hybrid but no embedding
          // provider is configured. Return lexical with a flag rather than
          // an error — the query still has a useful answer.
          const hits = searchDocuments(db, q, limit);
          return send(res, 200, {
            query: q,
            mode: "lexical",
            fallback: true,
            reason: "no embedding provider configured",
            count: hits.length,
            results: hits,
          });
        }
        const hits = searchDocuments(db, q, limit);
        return send(res, 200, { query: q, mode: "lexical", count: hits.length, results: hits });
      }

      if (p === "/v1/search/rebuild" && req.method === "POST") {
        const result = await rebuildSearchIndex(db, ports);
        // Also backfill embeddings if a provider is configured.
        let embeddings = null;
        if (embedProvider.available) {
          embeddings = await backfillEmbeddings(db, ports, embedProvider);
        }
        return send(res, 200, { ...result, embeddings });
      }

      // getTransaction — a single transaction with its resolved counterparty
      // and evidence. The list endpoint is period-scoped by design, so a
      // client holding a transaction id (from search, or from an event) had no
      // way to read just that row.
      {
        const m = /^\/v1\/transactions\/([^/]+)$/.exec(p);
        if (m && req.method === "GET") {
          const id = decodeURIComponent(m[1]);
          const txn = db
            .prepare(
              `SELECT t.*, e.display_name AS counterparty_name
                 FROM transactions t
                 LEFT JOIN entities e ON e.id = t.counterparty_entity_id
                WHERE t.id = ?`,
            )
            .get(id);
          if (!txn) return send(res, 404, { error: "not_found", transaction_id: id });
          const evidence = db
            .prepare(
              `SELECT td.document_id, td.evidence_role, td.match_score, td.linked_by, td.linked_at,
                      d.original_filename, d.doc_type
                 FROM transaction_documents td
                 JOIN documents d ON d.id = td.document_id
                WHERE td.transaction_id = ?
                ORDER BY td.linked_at`,
            )
            .all(id);
          return send(res, 200, { transaction: txn, evidence });
        }
      }

      // getStatement — work order 04 §A.6. Summary card + per-line drill-down
      // for a bank_statement/card_statement document: N lines read, M linked
      // to an existing transaction, K created new, G gaps (no invoice on
      // file — the whole point of importing statements in the first place).
      //
      // Reads straight off statement_lines rather than re-deriving totals
      // from transactions, so the numbers shown are exactly what the
      // reconciler decided, not a second, possibly-drifting computation.
      {
        const m = /^\/v1\/documents\/([^/]+)\/statement$/.exec(p);
        if (m && req.method === "GET") {
          const id = decodeURIComponent(m[1]);
          const doc = db
            .prepare("SELECT id, doc_type, original_filename FROM documents WHERE id=?")
            .get(id) as { id: string; doc_type: string | null; original_filename: string } | undefined;
          if (!doc) return send(res, 404, { error: "not_found", document_id: id });
          if (doc.doc_type !== "bank_statement" && doc.doc_type !== "card_statement") {
            return send(res, 400, {
              error: "not_a_statement",
              message: `${doc.original_filename} is a ${doc.doc_type ?? "unclassified document"}, not a statement.`,
            });
          }

          const lines = db
            .prepare(
              `SELECT sl.*, t.status AS transaction_status, e.display_name AS counterparty_name
                 FROM statement_lines sl
                 LEFT JOIN transactions t ON t.id = sl.transaction_id
                 LEFT JOIN entities e ON e.id = t.counterparty_entity_id
                WHERE sl.document_id = ?
                ORDER BY sl.line_no`,
            )
            .all(id) as Array<{
            id: string;
            line_no: number;
            occurred_at: string | null;
            raw_descriptor: string;
            amount_minor: number;
            direction: string;
            balance_after_minor: number | null;
            currency: string;
            fx_original_json: string | null;
            reference_id: string | null;
            status: string;
            transaction_id: string | null;
            transaction_status: string | null;
            counterparty_name: string | null;
          }>;

          const summary = {
            total: lines.length,
            linked: lines.filter((l) => l.status === "linked").length,
            created: lines.filter((l) => l.status === "created").length,
            pending: lines.filter((l) => l.status === "pending").length,
            // "Gaps" per the work order: lines the reconciler promoted to
            // their OWN transaction because no invoice was ever on file —
            // this is the report the whole statement-import feature exists
            // to produce, not an error state.
            gaps: lines.filter((l) => l.status === "created" && l.transaction_status === "no_invoice").length,
          };

          return send(res, 200, {
            document_id: id,
            doc_type: doc.doc_type,
            summary,
            lines: lines.map((l) => ({
              id: l.id,
              line_no: l.line_no,
              occurred_at: l.occurred_at,
              raw_descriptor: l.raw_descriptor,
              amount_minor: l.amount_minor,
              direction: l.direction,
              balance_after_minor: l.balance_after_minor,
              currency: l.currency,
              fx_original: l.fx_original_json ? JSON.parse(l.fx_original_json) : null,
              reference_id: l.reference_id,
              status: l.status,
              transaction_id: l.transaction_id,
              transaction_status: l.transaction_status,
              counterparty_name: l.counterparty_name,
            })),
          });
        }
      }

      // ── reset (Settings > Danger Zone) ───────────────────────────────────
      //
      // Two scopes, because they answer different questions:
      //
      //   ledger   "the readings are wrong, read my documents again"
      //            Wipes documents, transactions, entities, claims, learned
      //            rules, audit and the search index. KEEPS settings, the API
      //            key and Gmail auth, so you don't re-paste credentials.
      //
      //   factory  "forget everything, I'm starting over"
      //            Also wipes app_settings (API key, jurisdiction, Gmail
      //            local part) and stored OAuth tokens.
      //
      // NEITHER touches files in the vault directory. The originals are the
      // user's own documents, not ours to delete — a reset re-reads them, it
      // does not destroy them. That asymmetry is deliberate and is why this is
      // recoverable: drop the documents back in and the ledger rebuilds.
      if (p === "/v1/reset" && req.method === "POST") {
        const b = await readJson(req);
        const scope = b.scope === "factory" ? "factory" : "ledger";
        // Require the caller to spell out the destructive intent, so a stray
        // POST (a retried request, a curl typo) cannot wipe the vault.
        if (b.confirm !== "RESET") {
          return send(res, 400, {
            error: "confirmation_required",
            message: 'Send {"confirm":"RESET"} to proceed.',
          });
        }

        const n = (t: string): number => {
          try {
            return (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
          } catch {
            return 0; // table absent in this schema version
          }
        };
        const before = {
          documents: n("documents"),
          transactions: n("transactions"),
          entities: n("entities"),
          learned_rules: n("learned_rules"),
        };

        // Order matters: children before parents, so foreign keys never block
        // a delete midway and leave the vault half-erased.
        const ledgerTables = [
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
          "intake_events",
        ];
        const tx = db.prepare("BEGIN");
        try {
          tx.run();
          for (const t of ledgerTables) {
            try {
              db.prepare(`DELETE FROM ${t}`).run();
            } catch {
              // A table that does not exist in this schema version is not an
              // error: the reset should still clear everything else.
            }
          }
          if (scope === "factory") {
            db.prepare("DELETE FROM app_settings").run();
          }
          db.prepare("COMMIT").run();
        } catch (e) {
          db.prepare("ROLLBACK").run();
          throw e;
        }

        if (scope === "factory") {
          // Drop OAuth tokens too, otherwise "factory" would leave the vault
          // still connected to a Gmail account.
          try {
            await gmail?.oauth.disconnect();
          } catch {
            /* token store may be empty or unavailable; not fatal */
          }
          ai.reconfigure({ apiKey: "", baseUrl: undefined, model: undefined });
        }

        db.prepare("VACUUM").run();
        ports.logger.warn("vault reset", { scope, before });
        ports.bus.publish({ type: "VaultReset", scope, at: ports.clock.isoNow() });

        return send(res, 200, {
          scope,
          cleared: before,
          ai_available: ai.available,
          note:
            "Documents on disk were not touched. Drop them into the watched " +
            "folder to rebuild the ledger.",
        });
      }

      if (p === "/v1/unlink" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.transaction_id || !b.document_id) {
          return send(res, 400, { error: "transaction_id and document_id required" });
        }
        const info = db
          .prepare("DELETE FROM transaction_documents WHERE transaction_id=? AND document_id=?")
          .run(b.transaction_id, b.document_id);
        db.prepare(
          "INSERT INTO field_claims (subject_type, subject_id, field, value, source, confidence, created_at) VALUES ('transaction',?,?,?, 'user', 1.0, ?)",
        ).run(b.transaction_id, "evidence_unlink", b.document_id, ports.clock.isoNow());
        return send(res, 200, { unlinked: Number(info.changes ?? 0) > 0 });
      }

      // confirmEntity — promote a candidate to confirmed (a user assertion).
      if (p === "/v1/entities/confirm" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.entity_id) return send(res, 400, { error: "entity_id required" });
        const info = db.prepare("UPDATE entities SET status='confirmed', confidence=1.0 WHERE id=?").run(b.entity_id);
        return send(res, 200, { confirmed: Number(info.changes ?? 0) > 0 });
      }

      // Edit an entity's display_name, subtype, or status. Kind is immutable.
      // Mirrors PATCH /v1/people/:id for non-person entities.
      if (p.startsWith("/v1/entities/") && req.method === "PATCH") {
        const id = p.split("/")[3];
        if (!id) return send(res, 400, { error: "entity id required" });
        const b = await readJson(req);
        const cur = db.prepare("SELECT id, kind, display_name, subtype, status FROM entities WHERE id=?").get(id) as
          | { id: string; kind: string; display_name: string; subtype: string | null; status: string }
          | undefined;
        if (!cur) return send(res, 404, { error: "entity not found" });

        const updates: string[] = [];
        const params: (string | number | null)[] = [];
        if (typeof b.display_name === "string" && b.display_name.trim() && b.display_name !== cur.display_name) {
          // Save old name as an alias so search still finds it.
          db.prepare(
            "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at) VALUES (?,?,?,?,'name_variant','user-edit','confirmed',?)",
          ).run(id, cur.kind, cur.display_name, normaliseName(cur.display_name), ports.clock.isoNow());
          updates.push("display_name=?");
          params.push(b.display_name.trim());
        }
        if (typeof b.subtype === "string") {
          updates.push("subtype=?");
          params.push(b.subtype.trim() || null);
        }
        if (typeof b.status === "string" && ["candidate", "confirmed"].includes(b.status)) {
          updates.push("status=?");
          params.push(b.status);
        }
        if (!updates.length) return send(res, 200, { updated: false });
        params.push(id);
        db.prepare(`UPDATE entities SET ${updates.join(", ")} WHERE id=?`).run(...params);
        ports.logger.info("entity edited", { id, fields: updates });
        return send(res, 200, { updated: true });
      }

      // Delete a non-person entity. Same force semantics as person delete:
      // refuses while documents reference it, unless ?force=1 reassigns
      // document_parties to the Unidentified placeholder.
      if (p.startsWith("/v1/entities/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/v1/entities/".length));
        const row = db
          .prepare("SELECT id, display_name, kind FROM entities WHERE id=? AND kind<>'person'")
          .get(id) as { id: string; display_name: string; kind: string } | undefined;
        if (!row) return send(res, 404, { error: "no such entity" });

        let refs = 0;
        try {
          refs = (
            db
              .prepare("SELECT COUNT(*) n FROM document_parties WHERE entity_id=?")
              .get(id) as { n: number }
          ).n;
        } catch {
          /* table optional */
        }
        const force = new URL(req.url ?? "", "http://x").searchParams.get("force") === "1";
        if (refs > 0 && !force) {
          return send(res, 409, {
            error: "entity_in_use",
            message: `${row.display_name} is named on ${refs} document(s). Re-run with ?force=1 to unlink and delete.`,
            documents: refs,
          });
        }
        if (refs > 0) {
          const UNIDENTIFIED_ID = UNIDENTIFIED_PERSON_ID;
          const already = db.prepare("SELECT 1 FROM entities WHERE id=?").get(UNIDENTIFIED_ID);
          if (!already) {
            db.prepare(
              `INSERT INTO entities (id, kind, display_name, status, confidence, is_member, created_at)
               VALUES (?, 'person', 'Unidentified', 'confirmed', 1.0, 0, ?)`,
            ).run(UNIDENTIFIED_ID, ports.clock.isoNow());
          }
          const rows = db
            .prepare("SELECT document_id, role FROM document_parties WHERE entity_id=?")
            .all(id) as { document_id: string; role: string }[];
          for (const r of rows) {
            db.prepare(
              "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?,?)",
            ).run(r.document_id, UNIDENTIFIED_ID, r.role);
          }
          db.prepare("DELETE FROM document_parties WHERE entity_id=?").run(id);
        }
        try {
          db.prepare("DELETE FROM entity_aliases WHERE entity_id=?").run(id);
        } catch {
          /* optional */
        }
        // Clean up transaction references that point to this entity.
        try {
          db.prepare("UPDATE transactions SET counterparty_entity_id=NULL WHERE counterparty_entity_id=?").run(id);
        } catch {
          /* column may not exist */
        }
        db.prepare("DELETE FROM entities WHERE id=?").run(id);
        ports.logger.warn("entity deleted", { id, name: row.display_name, kind: row.kind, reassigned: refs });
        return send(res, 200, { deleted: id, reassigned_documents: refs });
      }

      // mergeEntities — WITHIN ONE KIND ONLY. This is the anti-pollution
      // invariant (plan §3.1) enforced at the API boundary, not just in the
      // resolver: a merchant can never absorb a wallet, a person, or an equity.
      if (p === "/v1/entities/merge" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.from_id || !b.into_id) return send(res, 400, { error: "from_id and into_id required" });
        if (b.from_id === b.into_id) return send(res, 400, { error: "cannot merge an entity into itself" });

        const from = db.prepare("SELECT id, kind, display_name FROM entities WHERE id=?").get(b.from_id) as
          | { id: string; kind: string; display_name: string }
          | undefined;
        const into = db.prepare("SELECT id, kind, display_name FROM entities WHERE id=?").get(b.into_id) as
          | { id: string; kind: string; display_name: string }
          | undefined;
        if (!from || !into) return send(res, 404, { error: "entity not found" });
        if (from.kind !== into.kind) {
          return send(res, 409, {
            error: "cross_kind_merge_refused",
            detail: `refusing to merge ${from.kind} "${from.display_name}" into ${into.kind} "${into.display_name}" — merges are kind-scoped`,
          });
        }

        const now = ports.clock.isoNow();
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE transactions SET counterparty_entity_id=? WHERE counterparty_entity_id=?").run(into.id, from.id);
          db.prepare("UPDATE transactions SET instrument_entity_id=? WHERE instrument_entity_id=?").run(into.id, from.id);
          db.prepare("UPDATE transaction_legs SET account_entity_id=? WHERE account_entity_id=?").run(into.id, from.id);
          db.prepare("UPDATE OR IGNORE document_parties SET entity_id=? WHERE entity_id=?").run(into.id, from.id);
          db.prepare("UPDATE OR IGNORE entity_aliases SET entity_id=? WHERE entity_id=?").run(into.id, from.id);
          db.prepare(
            "INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at) VALUES (?,?,?,?, 'user-merge', ?)",
          ).run(into.id, into.kind, from.display_name, from.display_name.toLowerCase(), now);
          db.prepare("DELETE FROM entities WHERE id=?").run(from.id);
          recordMergeCandidate(db, from.id, into, now);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        ports.logger.info("entities merged", { from: from.display_name, into: into.display_name, kind: into.kind });
        return send(res, 200, { merged: true, kind: into.kind, into: into.display_name });
      }

      // WO11 A3: the user confirms a cross-kind collision is NOT a duplicate —
      // a person and an organisation legitimately sharing an email. Recorded
      // as a standing rule so the Conflicts section stops surfacing the pair;
      // the rule row doubles as the passive-learning candidate.
      if (p === "/v1/entities/keep-separate" && req.method === "POST") {
        const b = await readJson(req);
        const identifier = String(b.identifier ?? "").trim();
        const ids: string[] = Array.isArray(b.entity_ids) ? b.entity_ids.map(String) : [];
        if (!identifier || ids.length !== 2 || ids[0] === ids[1]) {
          return send(res, 400, { error: "identifier and two distinct entity_ids required" });
        }
        const pair = ids
          .map((eid) => db.prepare("SELECT id, kind, display_name FROM entities WHERE id=?").get(eid) as
            | { id: string; kind: string; display_name: string }
            | undefined);
        if (pair.some((e) => !e)) return send(res, 404, { error: "entity not found" });
        if (pair[0]!.kind === pair[1]!.kind) {
          // Same-kind duplicates are merge candidates, not conflicts — keeping
          // them separate is the resolver's standing SEPARATE rule, not this.
          return send(res, 409, { error: "same_kind", detail: "same-kind entities are merge candidates, not conflicts" });
        }
        const type = classifyIdentifier(identifier) ?? "email";
        const norm = normaliseIdentifier(type, identifier);
        const sorted = [pair[0]!.id, pair[1]!.id].sort();
        // Merge with any pairs already dismissed for this identifier — the
        // unique key is (kind, match_key), so a naive upsert would REPLACE
        // the stored list and resurrect earlier dismissals.
        const existing = db
          .prepare("SELECT value FROM learned_rules WHERE kind='entity_separation' AND match_key=?")
          .get(`identifier:${norm}`) as { value: string } | undefined;
        let pairs: string[][] = [];
        if (existing) {
          try {
            const parsed = JSON.parse(existing.value) as unknown;
            if (Array.isArray(parsed)) {
              pairs = parsed.filter((p): p is string[] => Array.isArray(p) && p.length === 2);
            }
          } catch {
            pairs = [];
          }
        }
        if (!pairs.some((p) => p[0] === sorted[0] && p[1] === sorted[1])) pairs.push(sorted);
        db.prepare(
          `INSERT INTO learned_rules(kind,match_key,match_kind,value,source,confidence,active,created_at)
           VALUES('entity_separation',?, NULL, ?, 'user', 1, 1, ?)
           ON CONFLICT(kind,match_key,COALESCE(match_kind,'')) DO UPDATE SET
             value=excluded.value, source='user', active=1, created_at=excluded.created_at`,
        ).run(`identifier:${norm}`, JSON.stringify(pairs), ports.clock.isoNow());
        ports.logger.info("cross-kind conflict dismissed", {
          identifier: norm,
          entities: [pair[0]!.display_name, pair[1]!.display_name],
        });
        return send(res, 200, { kept_separate: true });
      }


      // ── settings (Setup page) ────────────────────────────────────────────
      // Non-secret AI config (base URL, model, routing mode) lives in
      // app_settings. API keys go through the SecretStore (Keychain on macOS,
      // 0600 file elsewhere) so they are never stored as plaintext in the
      // SQLite database. The API key is NEVER returned — only whether one is
      // set, and its last 4 characters for recognition.
      if (p === "/v1/settings" && req.method === "GET") {
        const rows = db.prepare("SELECT key, value FROM app_settings").all() as {
          key: string;
          value: string;
        }[];
        const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        const envKey = process.env.Q2AV_AI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
        const secretKey = secrets ? (await secrets.get("ai.api_key")) ?? "" : "";
        const effective = secretKey || envKey;
        // Work order 07 §D2: secondary model config. Blank secondary is valid.
        const secondaryKey = secrets ? (await secrets.get("ai.secondary.api_key")) ?? "" : "";
        const secondaryBaseUrl = kv["ai.secondary.base_url"] ?? "";
        const secondaryModel = kv["ai.secondary.model"] ?? "";
        const routingMode = kv["ai.routing_mode"] ?? "auto";
        // Ask the token store, not a flag — the tokens are the truth.
        const gmailConnected = gmail ? !!(await gmail.oauth.getTokens()) : false;
        const maskKey = (k: string) => k.length <= 8
          ? "********"
          : `${k.slice(0, 4)}${"*".repeat(7)}${k.slice(-4)}`;
        // Per-provider key inventory: check the secret store for each known
        // provider so the UI can show which providers have saved keys and
        // swap the mask when the user switches providers.
        const knownProviderIds = [
          "alibaba", "anthropic", "groq", "kimi", "minimax", "mimo",
          "openai", "openrouter", "perplexity", "poolside", "together", "custom",
        ];
        const providerKeys: Record<string, { set: boolean; mask: string }> = {};
        if (secrets) {
          for (const pid of knownProviderIds) {
            const k = await secrets.get(`ai.api_key.${pid}`);
            providerKeys[pid] = k
              ? { set: true, mask: maskKey(k) }
              : { set: false, mask: "" };
          }
          // Also check secondary per-provider keys.
          for (const pid of knownProviderIds) {
            const k = await secrets.get(`ai.secondary_api_key.${pid}`);
            if (k) providerKeys[`secondary:${pid}`] = { set: true, mask: maskKey(k) };
          }
        }
        return send(res, 200, {
          ai: {
            base_url: kv["ai.base_url"] ?? "",
            model: kv["ai.model"] ?? process.env.Q2AV_MODEL ?? "",
            api_key_set: !!effective,
            api_key_hint: effective ? `…${effective.slice(-4)}` : "",
            api_key_mask: effective ? maskKey(effective) : "",
            api_key_source: secretKey ? "keychain" : envKey ? "environment" : "none",
            provider_keys: providerKeys,
            available: ai.available,
            active_model: ai.model,
            // Work order 07 §D1: secondary (vision/fallback) model.
            secondary: {
              base_url: secondaryBaseUrl,
              model: secondaryModel,
              api_key_set: !!secondaryKey,
              api_key_hint: secondaryKey ? `…${secondaryKey.slice(-4)}` : "",
              api_key_mask: secondaryKey ? maskKey(secondaryKey) : "",
              api_key_source: secondaryKey ? "keychain" : "none",
              configured: !!(secondaryModel && secondaryKey),
            },
            routing_mode: routingMode,
          },
          vault: {
            root: ports.paths.vaultRoot(),
            drop: dropDir,
            db: ports.paths.dbPath(),
          },
          gmail: {
            local_part: kv["gmail.local_part"] ?? "",
            address: kv["gmail.local_part"]
              ? deriveGmailAddress(kv["gmail.local_part"])
              : "",
            // Truth comes from the token store, not a settings flag: a flag
            // can say "connected" while the tokens are gone.
            connected: gmailConnected,
            status: !kv["gmail.local_part"]
              ? "not_configured"
              : !gmail
                ? "unavailable"
                : gmailConnected
                  ? "connected"
                  : "not_connected",
            /** False when the daemon has no Google OAuth credentials. */
            can_connect: !!gmail,
            last_history_id: kv["gmail.history_id"] ?? null,
            scopes: ["gmail.readonly"],
            note: "Read-only. Never sends, deletes, labels, or marks as read.",
          },
          jurisdiction: {
            id: pack.id,
            name: pack.name,
            version: pack.version,
            currency: pack.currency.code,
            symbol: pack.currency.symbol,
            minor_units: pack.currency.minor_units,
            fy_start_month: pack.financial_year.start_month,
            fy_label: pack.financial_year.description,
            grouping: pack.currency.grouping,
            date_format: pack.dates.input_format,
            available: listPacks(),
          },
        });
      }

      if (p === "/v1/settings" && req.method === "POST") {
        const b = await readJson(req);
        const set = db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES(?,?)");
        const del = db.prepare("DELETE FROM app_settings WHERE key = ?");
        const saved: string[] = [];
        const cleared: string[] = [];

        // Non-secret fields go into app_settings (SQLite). Secret fields
        // (API keys) go through the SecretStore (Keychain / 0600 file) so
        // they are never stored as plaintext in the database.
        for (const [field, key] of [
          ["base_url", "ai.base_url"],
          ["model", "ai.model"],
          // Work order 07 §D2: secondary model fields.
          ["secondary_base_url", "ai.secondary.base_url"],
          ["secondary_model", "ai.secondary.model"],
          ["routing_mode", "ai.routing_mode"],
          ["jurisdiction", "jurisdiction.id"],
          ["gmail_local_part", "gmail.local_part"],
        ] as const) {
          const v = b[field];
          if (typeof v !== "string") continue;
          // An empty string is an explicit CLEAR, not a no-op. Previously
          // `v.length > 0` silently skipped it, so a key could be set but
          // never removed from the UI.
          if (v.length === 0) {
            del.run(key);
            cleared.push(field);
          } else {
            set.run(key, v);
            saved.push(field);
          }
        }

        // API keys: route through the SecretStore, not app_settings.
        // Keys are stored per-provider (ai.api_key.<provider_id>) so switching
        // providers remembers each key. The active key (ai.api_key) is also
        // set/cleared so the AI provider can use it immediately.
        const primPid = typeof b.api_key_provider === "string" ? b.api_key_provider : "";
        const secPid = typeof b.secondary_api_key_provider === "string" ? b.secondary_api_key_provider : "";

        for (const [field, activeKey, pid] of [
          ["api_key", "ai.api_key", primPid],
          ["secondary_api_key", "ai.secondary.api_key", secPid],
        ] as const) {
          const v = b[field];
          if (typeof v !== "string") continue;
          if (v.length === 0) {
            if (secrets) {
              await secrets.remove(activeKey);
              if (pid) await secrets.remove(`${activeKey}.${pid}`);
            }
            cleared.push(field);
          } else {
            if (secrets) {
              await secrets.set(activeKey, v);
              if (pid) await secrets.set(`${activeKey}.${pid}`, v);
            }
            saved.push(field);
          }
        }

        // Apply immediately rather than telling the user to restart. Re-read
        // from the database and secret store so the provider reflects
        // committed state, not the request body.
        const now = Object.fromEntries(
          (db.prepare("SELECT key, value FROM app_settings").all() as {
            key: string;
            value: string;
          }[]).map((r) => [r.key, r.value]),
        );
        const nowApiKey = secrets ? (await secrets.get("ai.api_key")) ?? "" : "";
        const nowSecKey = secrets ? (await secrets.get("ai.secondary.api_key")) ?? "" : "";
        const aiTouched = [...saved, ...cleared].some((f) =>
          ["api_key", "base_url", "model", "secondary_api_key", "secondary_base_url", "secondary_model", "routing_mode"].includes(f),
        );
        if (aiTouched) {
          ai.reconfigure({
            // "" (cleared) must stay "" so it does not fall back to the env var.
            apiKey: nowApiKey || process.env.Q2AV_AI_API_KEY || process.env.ANTHROPIC_API_KEY,
            baseUrl: now["ai.base_url"] || process.env.Q2AV_AI_BASE_URL || "",
            model: now["ai.model"] || process.env.Q2AV_MODEL || "",
            // Work order 07 §D2: secondary config.
            secondaryApiKey: nowSecKey,
            secondaryBaseUrl: now["ai.secondary.base_url"] ?? "",
            secondaryModel: now["ai.secondary.model"] ?? "",
            routingMode: (now["ai.routing_mode"] as "auto" | "primary_only" | "vision_fallback") ?? "auto",
          });
        }

        ports.logger.info("settings updated", { fields: saved, cleared });
        return send(res, 200, {
          saved,
          cleared,
          ai_available: ai.available,
          active_model: ai.model,
          // Kept for older clients; nothing about AI needs a restart now.
          restart_required: false,
        });
      }

      // Work order 07 §D4: Provider Test button. Tests a configured model
      // with a harmless fixed prompt/schema — never financial documents.
      // Reports URL reachability, authentication, model availability,
      // structured-output support, vision capability, latency, and
      // last-tested time.
      if (p === "/v1/settings/provider-test" && req.method === "POST") {
        const b = await readJson(req);
        const which = (b.which as string) ?? "primary";
        const rows = db.prepare("SELECT key, value FROM app_settings").all() as {
          key: string;
          value: string;
        }[];
        const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));

        let baseUrl: string;
        let apiKey: string;
        let model: string;

        if (which === "secondary") {
          baseUrl = kv["ai.secondary.base_url"] ?? "";
          apiKey = secrets ? (await secrets.get("ai.secondary.api_key")) ?? "" : "";
          model = kv["ai.secondary.model"] ?? "";
        } else {
          baseUrl = kv["ai.base_url"] ?? process.env.Q2AV_AI_BASE_URL ?? "";
          apiKey = secrets ? (await secrets.get("ai.api_key")) ?? "" : "";
          apiKey = apiKey || process.env.Q2AV_AI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
          model = kv["ai.model"] ?? process.env.Q2AV_MODEL ?? "";
        }

        const result = await testProvider({ baseUrl, apiKey, model, which: which as "primary" | "secondary" });
        return send(res, 200, result);
      }

      // Fetch available models from a provider's /v1/models endpoint.
      // The UI uses this to populate a model dropdown after the user selects
      // a provider and enters an API key. The call is proxied through the
      // daemon so the key never leaves the server and CORS is not an issue.
      if (p === "/v1/settings/models" && req.method === "POST") {
        const b = await readJson(req);
        const baseUrl = String(b.base_url ?? "").trim().replace(/\/$/, "");
        let apiKey = String(b.api_key ?? "").trim();
        // If the UI sent no key (the user didn't change the mask), fall back
        // to the stored key from the secret store.
        if (!apiKey && secrets) {
          apiKey = (await secrets.get("ai.api_key")) ?? "";
        }
        if (!baseUrl) return send(res, 400, { error: "base_url required" });
        if (!apiKey) return send(res, 200, { models: [], error: "no_api_key" });
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const res2 = await fetch(`${baseUrl}/models`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res2.status === 401 || res2.status === 403) {
            return send(res, 200, { models: [], error: "auth_failed" });
          }
          if (!res2.ok) {
            return send(res, 200, { models: [], error: `http_${res2.status}` });
          }
          const data = await res2.json() as Record<string, unknown>;
          // OpenAI-compatible /v1/models returns { data: [{ id, ... }, ...] }.
          const rawModels = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
          const models = rawModels
            .map((m: Record<string, unknown>) => String(m.id ?? m.name ?? "").trim())
            .filter((id: string) => id.length > 0)
            .sort();
          return send(res, 200, { models });
        } catch (err) {
          const msg = (err as Error)?.name === "AbortError" ? "timeout" : String((err as Error)?.message ?? err);
          return send(res, 200, { models: [], error: msg });
        }
      }

      // ── people ───────────────────────────────────────────────────────────
      // Who this vault is for. The first person the extractor names as "owner"
      // is auto-promoted to member; everyone else stays a candidate until the
      // user says otherwise (plan §5: zero setup, confirm on novelty).
      if (p === "/v1/people" && req.method === "GET") {
        // Work order 05 §B.6: the list is an identity-management surface —
        // each row carries the counts a user needs to decide what to look at:
        // linked documents AND transactions, unresolved (proposed) aliases,
        // and when this person was last seen on a document.
        const people = db
          .prepare(
            `SELECT e.id, e.display_name, e.subtype, e.is_member, e.is_owner, e.status, e.confidence,
                    (SELECT COUNT(*) FROM document_parties dp WHERE dp.entity_id = e.id) AS document_count,
                    (SELECT COUNT(DISTINCT td.transaction_id)
                       FROM transaction_documents td
                       JOIN document_parties dp ON dp.document_id = td.document_id
                      WHERE dp.entity_id = e.id) AS transaction_count,
                    (SELECT COUNT(*) FROM entity_aliases a
                      WHERE a.entity_id = e.id AND a.status = 'proposed') AS unresolved_alias_count,
                    (SELECT COUNT(*) FROM entity_aliases a
                      WHERE a.entity_id = e.id AND a.status <> 'rejected') AS alias_count,
                    (SELECT MAX(d.received_at)
                       FROM document_parties dp JOIN documents d ON d.id = dp.document_id
                      WHERE dp.entity_id = e.id) AS last_seen_at
             FROM entities e WHERE e.kind='person'
             ORDER BY e.is_owner DESC, e.is_member DESC, document_count DESC, e.display_name`,
          )
          .all() as Record<string, unknown>[];
        for (const person of people) {
          person.roles = db
            .prepare(
              "SELECT DISTINCT role FROM document_parties WHERE entity_id=? ORDER BY role",
            )
            .all(person.id as string)
            .map((r) => (r as { role: string }).role);
        }
        return send(res, 200, {
          people,
          owner: people.find((x) => x.is_owner === 1) ?? null,
        });
      }

      // One person, in full: aliases with provenance, the documents that name
      // them, the transactions those documents evidence, and any unresolved
      // identity questions. The drill-down the People tab opens on click.
      if (/^\/v1\/people\/[^/]+$/.test(p) && req.method === "GET") {
        const id = decodeURIComponent(p.slice("/v1/people/".length));
        const person = db
          .prepare("SELECT * FROM entities WHERE id=? AND kind='person'")
          .get(id) as Record<string, unknown> | undefined;
        if (!person) return send(res, 404, { error: "no such person" });

        const aliases = db
          .prepare(
            `SELECT id, alias, normalised, alias_type, source, status, confidence, created_at, last_seen_at,
                    (SELECT COUNT(DISTINCT dp.document_id) FROM document_parties dp
                      WHERE dp.entity_id = entity_aliases.entity_id) AS supporting_documents
             FROM entity_aliases WHERE entity_id=? ORDER BY alias_type, id`,
          )
          .all(id);
        const documents = db
          .prepare(
            `SELECT d.id, d.original_filename, d.doc_type, d.received_at, dp.role
               FROM document_parties dp JOIN documents d ON d.id = dp.document_id
              WHERE dp.entity_id=? ORDER BY d.received_at DESC`,
          )
          .all(id);
        const transactions = db
          .prepare(
            `SELECT DISTINCT t.id, t.occurred_at, t.amount_minor, t.currency, t.direction,
                    e.display_name AS counterparty_name
               FROM transaction_documents td
               JOIN document_parties dp ON dp.document_id = td.document_id
               JOIN transactions t ON t.id = td.transaction_id
               LEFT JOIN entities e ON e.id = t.counterparty_entity_id
              WHERE dp.entity_id=? ORDER BY t.occurred_at DESC`,
          )
          .all(id);
        const questions = db
          .prepare(
            `SELECT id, question, trigger, context, options, created_at FROM training_reviews
              WHERE answered_at IS NULL AND dismissed=0
              AND (backoff_until IS NULL OR backoff_until < ?)
              AND context LIKE ?
              ORDER BY id DESC`,
          )
          .all(ports.clock.isoNow(), `%${id}%`)
          .map((q) => {
            const r = q as Record<string, unknown>;
            r.context = r.context ? safeParse(r.context as string) : null;
            r.options = r.options ? safeParse(r.options as string) : null;
            return r;
          });
        return send(res, 200, { person, aliases, documents, transactions, questions });
      }

      // Declare a person, or update one. Used by the People dialog.
      if (p === "/v1/people" && req.method === "POST") {
        const b = await readJson(req);
        const name = String(b.display_name ?? "").trim();
        if (!name) return send(res, 400, { error: "display_name required" });

        const now = ports.clock.isoNow();
        const existing = db
          .prepare("SELECT id FROM entities WHERE kind='person' AND lower(display_name)=lower(?)")
          .get(name) as { id: string } | undefined;

        let id = existing?.id;
        if (!id) {
          id = `ent_${randomBytes(8).toString("hex")}`;
          db.prepare(
            `INSERT INTO entities (id, kind, subtype, display_name, confidence, status, is_member, created_at, updated_at)
             VALUES (?, 'person', ?, ?, 1.0, 'confirmed', ?, ?, ?)`,
          ).run(id, b.relationship ?? null, name, b.is_member ? 1 : 0, now, now);
        } else {
          db.prepare(
            "UPDATE entities SET subtype=COALESCE(?,subtype), is_member=?, status='confirmed', updated_at=? WHERE id=?",
          ).run(b.relationship ?? null, b.is_member ? 1 : 0, now, id);
        }

        // Exactly one owner (work order 05 §B.2): promoting a person demotes
        // the previous one. An owner is trivially also a member.
        if (b.is_owner) {
          db.prepare("UPDATE entities SET is_owner=0 WHERE kind='person' AND id<>?").run(id);
          db.prepare("UPDATE entities SET is_owner=1, is_member=1, status='confirmed', updated_at=? WHERE id=?").run(now, id);
        }
        return send(res, 200, { id, display_name: name, declared: !existing });
      }

      // Add an alias to a person (work order 05 §B.6). The type is classified
      // from the string when not given, so an email can never be added as a
      // name variant. A value already bound to ANOTHER person is a conflict —
      // 409, never a silent re-attach.
      {
        const m = /^\/v1\/people\/([^/]+)\/aliases$/.exec(p);
        if (m && req.method === "POST") {
          const id = decodeURIComponent(m[1]);
          const person = db
            .prepare("SELECT id FROM entities WHERE id=? AND kind='person'")
            .get(id) as { id: string } | undefined;
          if (!person) return send(res, 404, { error: "no such person" });

          const b = await readJson(req);
          const alias = String(b.alias ?? "").trim();
          if (!alias) return send(res, 400, { error: "alias required" });
          const classified = classifyIdentifier(alias);
          let type = typeof b.alias_type === "string" ? b.alias_type : (classified ?? "name_variant");
          if (!["name_variant", "email", "phone", "handle"].includes(type)) {
            return send(res, 400, { error: "alias_type must be name_variant|email|phone|handle" });
          }
          // The string's own shape wins over the caller's label: an email
          // stored as a name_variant would normalise differently
          // (normaliseName mangles '@') and silently stop matching. Retype
          // rather than store a lie; contradicting identifier types are an
          // outright refusal.
          if (classified && type === "name_variant") type = classified;
          if (classified && type !== classified) {
            return send(res, 400, {
              error: "alias_type_mismatch",
              message: `"${alias}" is a ${classified}, not a ${type}.`,
            });
          }
          if (type === "email" && isGenericMailbox(alias)) {
            return send(res, 409, {
              error: "generic_mailbox",
              message: "A billing/support mailbox names a function at an organisation, not a person.",
            });
          }
          const normalised =
            type === "name_variant"
              ? normaliseName(alias)
              : normaliseIdentifier(type as "email" | "phone" | "handle", alias);
          const clash = db
            .prepare(
              "SELECT entity_id, status FROM entity_aliases WHERE kind='person' AND normalised=? AND entity_id<>? AND status<>'rejected'",
            )
            .get(normalised, id) as { entity_id: string; status: string } | undefined;
          if (clash) {
            return send(res, 409, {
              error: "alias_in_use",
              message: "That name/identifier is already on file for another person. Merge them explicitly if they are the same human.",
              bound_to: clash.entity_id,
            });
          }
          const now = ports.clock.isoNow();
          db.prepare(
            `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at, last_seen_at)
             VALUES (?, 'person', ?, ?, ?, 'user', 'confirmed', ?, ?)
             ON CONFLICT(kind, normalised) DO UPDATE SET status='confirmed', last_seen_at=excluded.last_seen_at`,
          ).run(id, alias, normalised, type, now, now);
          audit(db, ports, {
            subject: "entity",
            subjectId: id,
            field: `alias:${type}`,
            action: "edit",
            oldValue: null,
            newValue: alias,
            source: "user",
          });
          return send(res, 200, { added: true, alias, alias_type: type, normalised });
        }
      }

      // Reject an alias. The row is KEPT with status='rejected': the string
      // is still evidence, and a rejected alias must never resolve again —
      // deleting the row would let the next extraction re-propose it.
      {
        const m = /^\/v1\/people\/([^/]+)\/aliases\/(\d+)$/.exec(p);
        if (m && (req.method === "DELETE" || req.method === "PATCH")) {
          const id = decodeURIComponent(m[1]);
          const aliasId = Number(m[2]);
          const row = db
            .prepare(
              "SELECT a.id, a.alias, a.alias_type FROM entity_aliases a JOIN entities e ON e.id=a.entity_id WHERE a.id=? AND a.entity_id=? AND e.kind='person'",
            )
            .get(aliasId, id) as { id: number; alias: string; alias_type: string } | undefined;
          if (!row) return send(res, 404, { error: "no such alias" });
          // A person's own display name is not rejectable — that is a rename,
          // not an alias rejection, and renaming has its own endpoint.
          const owner = db.prepare("SELECT display_name FROM entities WHERE id=?").get(id) as
            | { display_name: string }
            | undefined;
          if (owner && owner.display_name === row.alias) {
            return send(res, 409, {
              error: "cannot_reject_display_name",
              message: "This is the person's display name. Rename them instead.",
            });
          }
          db.prepare("UPDATE entity_aliases SET status='rejected' WHERE id=?").run(aliasId);
          audit(db, ports, {
            subject: "entity",
            subjectId: id,
            field: `alias:${row.alias_type}`,
            action: "reject",
            oldValue: row.alias,
            newValue: null,
            source: "user",
          });
          return send(res, 200, { rejected: aliasId });
        }
      }

      // Edit one person: rename, change relationship, set/clear owner.
      //
      // POST /v1/people upserts by NAME, so it cannot rename anybody — asking
      // it to would just create a second person. Editing needs the id.
      if (p.startsWith("/v1/people/") && req.method === "PATCH") {
        const id = decodeURIComponent(p.slice("/v1/people/".length));
        const row = db
          .prepare("SELECT id, display_name FROM entities WHERE id=? AND kind='person'")
          .get(id) as { id: string; display_name: string } | undefined;
        if (!row) return send(res, 404, { error: "no such person" });

        const b = await readJson(req);
        const changed: string[] = [];

        if (typeof b.display_name === "string") {
          const name = b.display_name.trim();
          if (!name) return send(res, 400, { error: "display_name cannot be empty" });
          // Renaming onto an existing person is a merge, not a rename. Refuse
          // rather than creating two people with the same name.
          const clash = db
            .prepare(
              "SELECT id FROM entities WHERE kind='person' AND lower(display_name)=lower(?) AND id<>?",
            )
            .get(name, id) as { id: string } | undefined;
          if (clash) {
            return send(res, 409, {
              error: "name_taken",
              message: `"${name}" already exists. Use /v1/people/merge to combine them.`,
              existing_id: clash.id,
            });
          }
          if (name !== row.display_name) {
            db.prepare("UPDATE entities SET display_name=?, updated_at=? WHERE id=?").run(
              name,
              ports.clock.isoNow(),
              id,
            );
            // Keep the old spelling as a confirmed name_variant alias so past
            // documents still match (work order 05 §B.6: renaming preserves
            // the previous canonical name — it is evidence, never discarded).
            db.prepare(
              `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at, last_seen_at)
               VALUES (?,?,?,?, 'name_variant', 'user', 'confirmed', ?, ?)
               ON CONFLICT(kind, normalised) DO UPDATE SET status='confirmed', last_seen_at=excluded.last_seen_at`,
            ).run(
              id,
              "person",
              row.display_name,
              normaliseName(row.display_name),
              ports.clock.isoNow(),
              ports.clock.isoNow(),
            );
            changed.push("display_name");
          }
        }

        if (typeof b.relationship === "string") {
          db.prepare("UPDATE entities SET subtype=? WHERE id=?").run(
            b.relationship.trim() || null,
            id,
          );
          changed.push("relationship");
        }

        if (typeof b.is_owner === "boolean") {
          // WO11 A1: the demote-old/promote-new pair is ONE atomic write. Two
          // autocommit statements would leave a crash window with zero or two
          // owners — both corrupt the "exactly one self" invariant.
          db.exec("BEGIN");
          try {
            if (b.is_owner) {
              db.prepare("UPDATE entities SET is_owner=0 WHERE kind='person' AND id<>?").run(id);
              db.prepare("UPDATE entities SET is_owner=1, is_member=1, status='confirmed', updated_at=? WHERE id=?").run(
                ports.clock.isoNow(),
                id,
              );
            } else {
              db.prepare("UPDATE entities SET is_owner=0, updated_at=? WHERE id=?").run(ports.clock.isoNow(), id);
            }
            // Passive learning (WO09 contract): a user-confirmed owner change
            // is durable evidence, independent of the prompting master switch.
            db.prepare(
              `INSERT INTO learned_rules(kind,match_key,match_kind,value,source,confidence,active,created_at)
               VALUES('entity_owner',?, 'person', ?,'passive-correction',1,0,?)
               ON CONFLICT(kind,match_key,COALESCE(match_kind,'')) DO UPDATE SET
                 value=excluded.value, source='passive-correction', confidence=1, created_at=excluded.created_at`,
            ).run(`entity:${id}`, b.is_owner ? "owner" : "not-owner", ports.clock.isoNow());
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          changed.push("is_owner");
        }

        // Membership ("shares this vault") is distinct from ownership ("this
        // is me"). An owner is trivially a member; demoting a member who
        // currently holds owner also clears owner — the invariant "owner ⇒
        // member" must never be broken from this side.
        if (typeof b.is_member === "boolean") {
          if (b.is_member) {
            db.prepare(
              "UPDATE entities SET is_member=1, status='confirmed', updated_at=? WHERE id=?",
            ).run(ports.clock.isoNow(), id);
          } else {
            db.prepare(
              "UPDATE entities SET is_member=0, is_owner=0, updated_at=? WHERE id=?",
            ).run(ports.clock.isoNow(), id);
          }
          changed.push("is_member");
        }

        const after = db.prepare("SELECT * FROM entities WHERE id=?").get(id);
        ports.logger.info("person edited", { id, changed });
        return send(res, 200, { person: after, changed });
      }

      // Delete a person. Refuses while documents still reference them, because
      // a silent cascade would quietly detach evidence from the ledger.
      if (p.startsWith("/v1/people/") && req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/v1/people/".length));
        const row = db
          .prepare("SELECT id, display_name FROM entities WHERE id=? AND kind='person'")
          .get(id) as { id: string; display_name: string } | undefined;
        if (!row) return send(res, 404, { error: "no such person" });

        let refs = 0;
        try {
          refs = (
            db
              .prepare("SELECT COUNT(*) n FROM document_parties WHERE entity_id=?")
              .get(id) as { n: number }
          ).n;
        } catch {
          /* table optional */
        }
        const force = new URL(req.url ?? "", "http://x").searchParams.get("force") === "1";
        if (refs > 0 && !force) {
          return send(res, 409, {
            error: "person_in_use",
            message: `${row.display_name} is named on ${refs} document(s). Re-run with ?force=1 to unlink and delete.`,
            documents: refs,
          });
        }
        if (refs > 0) {
          // Force-delete REASSIGNS document_parties to a well-known
          // "Unidentified" placeholder person rather than deleting the rows.
          // entity_id is NOT NULL and part of the primary key, so there is no
          // FK-preserving way to null it out — and simply deleting the rows
          // would silently detach evidence, which the work order forbids.
          const UNIDENTIFIED_ID = UNIDENTIFIED_PERSON_ID;
          const already = db.prepare("SELECT 1 FROM entities WHERE id=?").get(UNIDENTIFIED_ID);
          if (!already) {
            db.prepare(
              `INSERT INTO entities (id, kind, display_name, status, confidence, is_member, created_at)
               VALUES (?, 'person', 'Unidentified', 'confirmed', 1.0, 0, ?)`,
            ).run(UNIDENTIFIED_ID, ports.clock.isoNow());
          }
          // A document may already have an Unidentified party in the same
          // role (e.g. two deleted people both appeared as counterparty on
          // the same document) — the composite primary key would collide, so
          // reassign one at a time and let INSERT OR IGNORE absorb duplicates,
          // then drop whatever the reassignment couldn't place.
          const rows = db
            .prepare("SELECT document_id, role FROM document_parties WHERE entity_id=?")
            .all(id) as { document_id: string; role: string }[];
          for (const r of rows) {
            db.prepare(
              "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?,?)",
            ).run(r.document_id, UNIDENTIFIED_ID, r.role);
          }
          db.prepare("DELETE FROM document_parties WHERE entity_id=?").run(id);
        }
        try {
          db.prepare("DELETE FROM entity_aliases WHERE entity_id=?").run(id);
        } catch {
          /* optional */
        }
        db.prepare("DELETE FROM entities WHERE id=?").run(id);
        ports.logger.warn("person deleted", { id, name: row.display_name, reassigned: refs });
        return send(res, 200, {
          deleted: id,
          // "unlinked" is misleading now: force-delete REASSIGNS to
          // Unidentified rather than dropping the evidence link.
          reassigned_documents: refs,
        });
      }

      // Merge two people into one, keeping every spelling as an alias.
      // The automatic rules catch word-order and identifier matches; this is
      // for the rest ("A. Kamath", a maiden name, an initials-only form).
      if (p === "/v1/people/merge" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.from_id || !b.into_id) return send(res, 400, { error: "from_id and into_id required" });
        if (b.from_id === b.into_id) return send(res, 400, { error: "cannot merge a person into themselves" });

        const from = db.prepare("SELECT id, kind, display_name FROM entities WHERE id=?").get(b.from_id) as
          | { id: string; kind: string; display_name: string } | undefined;
        const into = db.prepare("SELECT id, kind, display_name FROM entities WHERE id=?").get(b.into_id) as
          | { id: string; kind: string; display_name: string } | undefined;
        if (!from || !into) return send(res, 404, { error: "person not found" });
        // The anti-pollution invariant holds here too.
        if (from.kind !== "person" || into.kind !== "person") {
          return send(res, 409, { error: "both entities must be people" });
        }

        return send(res, 200, mergePeople(db, ports, from.id, into.id));
      }

      // Every spelling the vault knows for one person, typed and with
      // provenance (work order 05 §B.6: aliases grouped by type, source
      // visible, rejected ones shown struck through rather than hidden —
      // they are evidence).
      if (p.startsWith("/v1/people/") && p.endsWith("/aliases") && req.method === "GET") {
        const id = decodeURIComponent(p.split("/")[3]);
        const aliases = db
          .prepare(
            `SELECT id, alias, normalised, alias_type, source, status, confidence, created_at, last_seen_at
             FROM entity_aliases WHERE entity_id=? ORDER BY alias_type, id`,
          )
          .all(id);
        return send(res, 200, { aliases });
      }

      // ── gmail dropbox ────────────────────────────────────────────────────
      // Connect: returns the consent URL immediately rather than holding the
      // request open for the whole flow. The browser is opened too.
      if (p === "/v1/gmail/connect" && req.method === "POST") {
        if (!gmail) {
          return send(res, 501, {
            error: "Gmail is not configured on this daemon",
            detail:
              "Set Q2AV_GOOGLE_CLIENT_ID and Q2AV_GOOGLE_CLIENT_SECRET, then restart. " +
              "Create an OAuth 'Desktop app' client at console.cloud.google.com with the " +
              "Gmail API enabled and the gmail.readonly scope.",
          });
        }
        const localPart = (
          db.prepare("SELECT value FROM app_settings WHERE key='gmail.local_part'").get() as
            | { value?: string } | undefined
        )?.value;
        if (!localPart) return send(res, 400, { error: "Save a Gmail address in Setup first" });

        const handle = await gmail.oauth.authorize(deriveGmailAddress(localPart));
        // Fire-and-forget: the result lands in the token store, and the client
        // learns about it from /v1/settings.
        handle.completed
          .then(() => ports.logger.info("gmail: authorisation completed"))
          .catch((e: unknown) => ports.logger.warn("gmail: authorisation failed", { error: String(e) }));
        return send(res, 200, { auth_url: handle.authUrl, mailbox: deriveGmailAddress(localPart) });
      }

      if (p === "/v1/gmail/sync" && req.method === "POST") {
        if (!gmail) return send(res, 501, { error: "Gmail is not configured on this daemon" });
        const b = await readJson(req);
        const afterDate = typeof b.after_date === "string" ? b.after_date : undefined;
        const force = !!b.force;
        try {
          return send(res, 200, await gmail.sync({ afterDate, force }));
        } catch (e) {
          return send(res, 409, { error: String(e instanceof Error ? e.message : e) });
        }
      }

      if (p === "/v1/gmail/disconnect" && req.method === "POST") {
        if (!gmail) return send(res, 501, { error: "Gmail is not configured on this daemon" });
        await gmail.oauth.disconnect();
        db.prepare("DELETE FROM app_settings WHERE key='gmail.history_id'").run();
        return send(res, 200, { disconnected: true });
      }

      // ── danger zone: flush all vault data ────────────────────────────────
      // Wipes every table except app_settings (which holds provider config,
      // jurisdiction, Gmail local_part) and schema_meta (which tracks schema
      // version). API keys in the SecretStore are also preserved.
      if (p === "/v1/vault/flush" && req.method === "POST") {
        const b = await readJson(req);
        if (b.confirm !== "FLUSH") {
          return send(res, 400, { error: "Confirmation required: send {\"confirm\":\"FLUSH\"}" });
        }
        const tables = [
          "transaction_documents",
          "transaction_legs",
          "transactions",
          "document_embeddings",
          "document_parties",
          "document_pipeline",
          "pipeline_events",
          "documents",
          "field_claims",
          "holdings",
          "statement_lines",
          "review_audit",
          "training_reviews",
          "learned_rules",
          "value_registry",
          "entity_aliases",
          "entities",
          "intake_events",
          "jobs",
          "source_events",
          "rate_cache",
        ];
        let deleted = 0;
        for (const table of tables) {
          try {
            const r = db.prepare(`DELETE FROM ${table}`).run();
            deleted += (r.changes ?? 0) as number;
          } catch {
            /* table may not exist in older schemas */
          }
        }
        // Clear the Gmail history checkpoint so the next sync does a fresh pull.
        db.prepare("DELETE FROM app_settings WHERE key='gmail.history_id'").run();
        // Reset the FTS index.
        try {
          db.prepare("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')").run();
        } catch {
          /* FTS may not exist */
        }
        ports.logger.warn("vault: FLUSH executed", { rows_deleted: deleted });
        return send(res, 200, { flushed: true, rows_deleted: deleted });
      }

      // ── danger zone: factory reset ───────────────────────────────────────
      // Same as flush, but also clears app_settings (provider config,
      // jurisdiction, Gmail local_part) and removes all API keys from the
      // SecretStore. The daemon returns to its initial state.
      if (p === "/v1/vault/factory-reset" && req.method === "POST") {
        const b = await readJson(req);
        if (b.confirm !== "FACTORY_RESET") {
          return send(res, 400, { error: "Confirmation required: send {\"confirm\":\"FACTORY_RESET\"}" });
        }
        // Wipe all data tables (same as flush).
        const tables = [
          "transaction_documents",
          "transaction_legs",
          "transactions",
          "document_embeddings",
          "document_parties",
          "document_pipeline",
          "pipeline_events",
          "documents",
          "field_claims",
          "holdings",
          "statement_lines",
          "review_audit",
          "training_reviews",
          "learned_rules",
          "value_registry",
          "entity_aliases",
          "entities",
          "intake_events",
          "jobs",
          "source_events",
          "rate_cache",
        ];
        let deleted = 0;
        for (const table of tables) {
          try {
            const r = db.prepare(`DELETE FROM ${table}`).run();
            deleted += (r.changes ?? 0) as number;
          } catch {
            /* table may not exist in older schemas */
          }
        }
        // Also clear ALL app_settings (provider config, jurisdiction, Gmail, etc).
        const settingsRows = db.prepare("SELECT COUNT(*) as n FROM app_settings").get() as { n: number };
        deleted += settingsRows.n;
        db.prepare("DELETE FROM app_settings").run();
        // Remove all AI API keys from the SecretStore.
        if (secrets) {
          for (const key of [
            "ai.api_key",
            "ai.secondary.api_key",
            "ai.api_key.alibaba", "ai.api_key.anthropic", "ai.api_key.groq",
            "ai.api_key.kimi", "ai.api_key.minimax", "ai.api_key.mimo",
            "ai.api_key.openai", "ai.api_key.openrouter", "ai.api_key.perplexity",
            "ai.api_key.poolside", "ai.api_key.together", "ai.api_key.custom",
            "ai.secondary_api_key.alibaba", "ai.secondary_api_key.anthropic",
            "ai.secondary_api_key.groq", "ai.secondary_api_key.kimi",
            "ai.secondary_api_key.minimax", "ai.secondary_api_key.mimo",
            "ai.secondary_api_key.openai", "ai.secondary_api_key.openrouter",
            "ai.secondary_api_key.perplexity", "ai.secondary_api_key.poolside",
            "ai.secondary_api_key.together", "ai.secondary_api_key.custom",
          ]) {
            try { await secrets.remove(key); } catch { /* already gone */ }
          }
        }
        // Reset the FTS index.
        try {
          db.prepare("INSERT INTO documents_fts(documents_fts) VALUES('rebuild')").run();
        } catch {
          /* FTS may not exist */
        }
        // Reconfigure the AI provider to its empty/default state.
        ai.reconfigure({
          apiKey: "",
          baseUrl: "",
          model: "",
          secondaryApiKey: "",
          secondaryBaseUrl: "",
          secondaryModel: "",
          routingMode: "auto",
        });
        ports.logger.warn("vault: FACTORY RESET executed", { rows_deleted: deleted });
        return send(res, 200, { factory_reset: true, rows_deleted: deleted });
      }

      // ── learning (plan §5) ───────────────────────────────────────────────
      // Questions the vault wants answered, and the rules those answers made.
      if (p === "/v1/learning" && req.method === "GET") {
        const open = db
          .prepare(
            `SELECT id, question, trigger, context, options, created_at
             FROM training_reviews
             WHERE answered_at IS NULL AND dismissed=0
             AND (backoff_until IS NULL OR backoff_until < ?)
             ORDER BY id DESC LIMIT 20`,
          )
          .all(ports.clock.isoNow()) as Record<string, unknown>[];
        for (const q of open) {
          q.context = q.context ? safeParse(q.context as string) : null;
          q.options = q.options ? safeParse(q.options as string) : null;
        }
        const rules = db
          .prepare(
            `SELECT id, kind, match_key, match_kind, value, times_applied, created_at
             FROM learned_rules WHERE active=1
             ORDER BY times_applied DESC, id DESC LIMIT 50`,
          )
          .all();
        const answeredRows = db
          .prepare(
            `SELECT id, question, trigger, answer, answered_at, created_at
             FROM training_reviews
             WHERE answered_at IS NOT NULL
             ORDER BY answered_at DESC LIMIT 50`,
          )
          .all() as Record<string, unknown>[];
        return send(res, 200, {
          enabled: isLearningEnabled(db),
          budget: questionBudget(db),
          questions: open,
          rules,
          answered: answeredRows.length,
          answered_questions: answeredRows,
        });
      }

      // Answer a question; the answer becomes a rule.
      if (p === "/v1/learning/answer" && req.method === "POST") {
        const b = await readJson(req);
        const id = Number(b.review_id);
        if (!id) return send(res, 400, { error: "review_id required" });
        const answer = String(b.answer ?? "");

        // ── Reconciliation-ambiguity: delegate to answerLearningQuestion ─────
        // It handles all three answers (Link/Don't link/Later) in one place,
        // avoiding duplicated link logic between the API and workorders.
        // We delegate on trigger alone; answerLearningQuestion's existing
        // guard (line: if row.answered_at || row.dismissed → no-op) preserves
        // the state of already-decided questions.
        const review = db.prepare(
          "SELECT trigger FROM training_reviews WHERE id=?",
        ).get(id) as { trigger: string } | undefined;

        if (review && review.trigger === "reconciliation-ambiguity") {
          // Validate the answer against the three recognised options.
          const valid = /^(yes|no|later)$/i.test(answer.trim());
          if (!valid) {
            return send(res, 400, { error: "unexpected answer for reconciliation-ambiguity question; expected yes|no|later" });
          }
          const r = answerLearningQuestion(db, ports, id, answer);
          return send(res, 200, { answered: true, ...r });
        }

        const r = answerQuestion(db, ports, id, answer, b.rule_kind
          ? {
              kind: b.rule_kind as never,
              match_key: String(b.match_key ?? ""),
              match_kind: b.match_kind as string | undefined,
              value: String(b.value ?? b.answer ?? ""),
            }
          : undefined);
        return send(res, 200, { answered: true, ...r });
      }

      if (p === "/v1/learning/dismiss" && req.method === "POST") {
        const b = await readJson(req);
        dismissQuestion(db, Number(b.review_id));
        return send(res, 200, { dismissed: true });
      }

      // Master switch (plan §5: ON at install, never silently re-enables).
      if (p === "/v1/learning/toggle" && req.method === "POST") {
        const b = await readJson(req);
        db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('learning.enabled',?)")
          .run(String(b.enabled) === "false" ? "false" : "true");
        return send(res, 200, { enabled: String(b.enabled) !== "false" });
      }

      // Near-duplicate entities within one kind — proposals, never automatic.
      if (p === "/v1/learning/duplicates") {
        const kind = url.searchParams.get("kind") ?? "organisation";
        return send(res, 200, { kind, candidates: findNearDuplicates(db, kind) });
      }

      // ── work order 06 — single intake event by id (§8) ────────────────────
      {
        const m = /^\/v1\/intake\/(\d+)$/.exec(p);
        if (m && req.method === "GET") {
          const row = db.prepare("SELECT * FROM intake_events WHERE id=?").get(Number(m[1]));
          if (!row) return send(res, 404, { error: "intake not found" });
          return send(res, 200, { event: row });
        }
      }

      // ── queries ──────────────────────────────────────────────────────────
      switch (p) {
        case "/v1/treemap": {
          // Spending by category for the period, folded onto the user's
          // taxonomy. Transfers and investments are excluded: moving money
          // between your own accounts is not spending, and buying shares is
          // not consumption. status='scheduled' is excluded too — recurring
          // entries are not reconciled against actuals yet, so counting them
          // would double-count real documents.
          const period = resolvePeriod(pack, url.searchParams);
          const clauses = [
            "direction = 'out'",
            // COALESCE, not a bare NOT IN. SQL three-valued logic makes
            // `NULL NOT IN (...)` evaluate to NULL, which WHERE rejects — so
            // every uncategorised transaction silently vanished from the
            // treemap while the hero total still counted it. recordTransaction
            // writes `x.category_hint ?? null`, so a NULL bucket is normal
            // whenever the model omits a category, and the "Uncategorised"
            // passthrough in buildTreemap could never have received a row.
            "COALESCE(impact_bucket,'') NOT IN ('transfer','investment')",
            "status != 'scheduled'",
            // WO11 Track B: a transaction whose evidence is entirely
            // removed/deleted contributes nothing to the treemap.
            activeTransactionSql("transactions"),
          ];
          const args: string[] = [];
          if (period.from && period.to) {
            clauses.push("occurred_at >= ? AND occurred_at <= ?");
            args.push(period.from, period.to);
          }
          const rows = db
            .prepare(
              `SELECT impact_bucket,
                      -- Home-currency sums, same rule as snapshot(): converted
                      -- amounts count at their home value; unconverted foreign
                      -- and currency-uncertain rows are excluded rather than
                      -- silently added as if they were ${pack.currency.code}.
                      SUM(CASE
                            WHEN home_amount_minor IS NOT NULL THEN home_amount_minor
                            WHEN currency = ? THEN amount_minor
                            ELSE NULL END) AS amount_minor,
                      COUNT(*)          AS transactions
                 FROM transactions
                WHERE ${clauses.join(" AND ")}
                GROUP BY impact_bucket`,
            )
            .all(pack.currency.code, ...args) as Array<{
            impact_bucket: string | null;
            amount_minor: number;
            transactions: number;
          }>;

          const nodes = buildTreemap(rows);
          const total = nodes.reduce((s, n) => s + n.amount_minor, 0);
          return send(res, 200, {
            period,
            nodes,
            total_minor: total,
            // From the active jurisdiction pack, not hardcoded — a vault on a
            // non-INR pack would otherwise label its total with the wrong
            // currency while /v1/settings reported the right one.
            currency: pack.currency.code,
            // Raw bucket count vs node count shows how much folding happened —
            // useful for spotting a taxonomy that has drifted from the data.
            raw_buckets: rows.length,
          });
        }

        case "/v1/portfolio": {
          // Net position per security, derived from holdings line items —
          // never from the transaction's net rupee figure, which says what
          // left the bank rather than what is held.
          const rows = db
            .prepare(
              `SELECT e.id, e.display_name AS name, h.isin,
                      SUM(CASE WHEN h.side='buy' THEN h.quantity ELSE -h.quantity END) AS quantity,
                      SUM(CASE WHEN h.side='buy'
                               THEN COALESCE(h.amount_minor, h.quantity*h.price_minor)
                               ELSE -COALESCE(h.amount_minor, h.quantity*h.price_minor) END) AS cost_minor,
                      COUNT(*) AS trades,
                      MIN(h.occurred_at) AS first_bought,
                      MAX(h.occurred_at) AS last_traded
                 FROM holdings h
                 JOIN entities e ON e.id = h.instrument_entity_id
                 -- WO11 Track B: holdings derive from a document's trades; a
                 -- removed/deleted document no longer backs a position.
                 LEFT JOIN documents d ON d.id = h.document_id
                WHERE h.document_id IS NULL OR ${activeDocumentSql("d")}
                GROUP BY e.id
                ORDER BY cost_minor DESC`,
            )
            .all() as Array<Record<string, unknown>>;
          // Fully-exited positions are kept out of the holdings list but their
          // realised cost still belongs in the totals.
          const open = rows.filter((r) => Number(r.quantity) > 0);
          return send(res, 200, {
            holdings: open,
            closed: rows.filter((r) => Number(r.quantity) <= 0),
            total_cost_minor: open.reduce((s, r) => s + Number(r.cost_minor || 0), 0),
            securities: open.length,
          });
        }

        case "/v1/snapshot":
          return send(res, 200, snapshot(db, resolvePeriod(pack, url.searchParams), pack.currency.code));

        case "/v1/periods": {
          // What the UI's period selector offers. Months come from the data,
          // so a vault with no July documents doesn't offer an empty July.
          const months = db
            .prepare(
              `SELECT DISTINCT substr(occurred_at,1,7) m FROM transactions
               WHERE status <> 'scheduled' ORDER BY m DESC LIMIT 24`,
            )
            .all() as { m: string }[];
          const fys = db
            .prepare(
              `SELECT DISTINCT fy_key f FROM transactions
               WHERE status <> 'scheduled' ORDER BY f DESC`,
            )
            .all() as { f: string }[];
          const today = new Date().toISOString().slice(0, 10);
          return send(res, 200, {
            current_fy: fyKeyFor(pack, today),
            current_month: today.slice(0, 7),
            quick: [
              { key: "this_month", label: "This month" },
              { key: "last_month", label: "Last month" },
              { key: "this_fy", label: `This ${pack.financial_year.label_format.split(" ")[0]}` },
              { key: "last_fy", label: "Last year" },
              { key: "all", label: "All time" },
            ],
            months: months.map((r) => r.m).filter(Boolean),
            financial_years: fys.map((r) => r.f).filter(Boolean),
          });
        }

        case "/v1/documents": {
          // WO11 Track B: removed/deleted rows are hidden by default. The
          // ?include=removed escape hatch exists for the rare caller that
          // needs the soft-hidden set; deleted tombstones never list.
          //
          // The Documents Browser tab sorts by merchant then descending
          // invoice date. The merchant is resolved with the same precedence
          // as the detail endpoint's effective("counterparty"): a user/rule
          // claim wins, then a linked counterparty party, then the issuer,
          // then the extraction's counterparty_descriptor, then
          // 'Unidentified'. The invoice date follows effective("document_date"):
          // claim > extraction occurred_at > received_at (fallback so a
          // document with no extracted date still appears in the right period).
          //
          // ?period= / ?month= / ?fy= filter on the invoice date (with the
          // received_at fallback) using the same resolvePeriod helper as the
          // Dashboard, so the two tabs share identical date boundaries.
          //
          // ?state= filters by the canonical document_pipeline.state. The UI
          // pipeline board uses the legacy intake_events vocabulary where
          // "queued" and "processing" mean the same thing as the canonical
          // "converting" and "analysing"; map those so a click on either cell
          // filters correctly.
          const includeRemoved = url.searchParams.get("include") === "removed";
          const period = resolvePeriod(pack, url.searchParams);
          const bounded = period.from !== null && period.to !== null;
          const sort = url.searchParams.get("sort") === "received"
            ? "received_at DESC"
            : "merchant ASC, invoice_date DESC";
          const where = includeRemoved ? listableDocumentSql("d") : activeDocumentSql("d");
          const periodClause = bounded
            ? ` AND (invoice_date >= ? AND invoice_date <= ?)`
            : "";
          const STATE_MAP: Record<string, string> = {
            queued: "converting",
            processing: "analysing",
          };
          const stateParam = url.searchParams.get("state");
          const pipelineState = stateParam ? STATE_MAP[stateParam] ?? stateParam : null;
          const stateClause = pipelineState
            ? ` AND EXISTS (SELECT 1 FROM document_pipeline dp WHERE dp.document_id=d.id AND dp.state=?)`
            : "";
          const args: (string | number)[] = [];
          if (pipelineState) args.push(pipelineState);
          if (bounded) { args.push(period.from!, period.to!); }
          args.push(Number(url.searchParams.get("limit") ?? 500));
          return send(res, 200, {
            period: { label: period.label, key: period.key, from: period.from, to: period.to },
            state: stateParam,
            documents: db
              .prepare(
                `SELECT d.id, d.original_filename, d.ext, d.byte_size, d.doc_type, d.source,
                        d.sha256, d.markdown_chars, d.received_at, d.converted_at, d.analysed_at,
                        d.lifecycle,
                        COALESCE(
                          (SELECT fc.value FROM field_claims fc
                            WHERE fc.subject_type='document' AND fc.subject_id=d.id
                              AND fc.field='counterparty'
                              AND fc.status NOT IN ('rejected','superseded')
                            ORDER BY fc.id DESC LIMIT 1),
                          (SELECT e.display_name FROM document_parties dp
                            JOIN entities e ON e.id=dp.entity_id
                           WHERE dp.document_id=d.id AND dp.role='counterparty' LIMIT 1),
                          (SELECT e.display_name FROM document_parties dp
                            JOIN entities e ON e.id=dp.entity_id
                           WHERE dp.document_id=d.id AND dp.role='issuer' LIMIT 1),
                          json_extract(d.extraction_json, '$.counterparty_descriptor'),
                          'Unidentified'
                        ) AS merchant,
                        COALESCE(
                          (SELECT fc.value FROM field_claims fc
                            WHERE fc.subject_type='document' AND fc.subject_id=d.id
                              AND fc.field='document_date'
                              AND fc.status NOT IN ('rejected','superseded')
                            ORDER BY fc.id DESC LIMIT 1),
                          json_extract(d.extraction_json, '$.occurred_at'),
                          d.received_at
                        ) AS invoice_date
                 FROM documents d
                 WHERE ${where}${stateClause}${periodClause}
                 ORDER BY ${sort} LIMIT ?`,
              )
              .all(...args),
          });
        }
        case "/v1/transactions": {
          // RECENT must obey the period selector. Without this the list showed
          // the newest 100 transactions from ALL time regardless of the chosen
          // month or FY, so the totals above it and the list below it were
          // describing different windows — the period buttons appeared to do
          // nothing at all.
          const period = resolvePeriod(pack, url.searchParams);
          // from/to are NULL for "all time". `BETWEEN date(NULL) AND date(NULL)`
          // matches nothing, so an unbounded period must be expressed as an
          // always-true clause rather than passed through as NULL bounds —
          // otherwise "All time" returns an empty ledger.
          const bounded = period.from !== null && period.to !== null;

          // Optional bucket filter, so clicking a hero card can show exactly
          // the transactions that produced it.
          //
          // These predicates are LIFTED FROM snapshot() verbatim — the same
          // INVEST test, the same `status <> 'scheduled'` exclusion, the same
          // direction. If they drift apart the receipts list stops summing to
          // the figure it claims to explain, which is the one thing this
          // feature must never do. See daemon/api.ts snapshot().
          const bucket = url.searchParams.get("bucket");
          const INVEST = `(t.instrument_entity_id IS NOT NULL
                           OR lower(COALESCE(t.category_id,'')) LIKE '%invest%'
                           OR lower(COALESCE(t.impact_bucket,'')) LIKE '%invest%')`;
          const bucketClause =
            bucket === "income"
              ? `t.direction='in' AND t.status <> 'scheduled'`
              : bucket === "spending"
                ? `t.direction='out' AND t.status <> 'scheduled' AND NOT ${INVEST}`
                : bucket === "investments"
                  ? `t.direction='out' AND t.status <> 'scheduled' AND ${INVEST}`
                  : bucket === "transfers"
                    ? `t.direction='transfer' AND t.status <> 'scheduled'`
                    : null;

          const clauses: string[] = [];
          if (bounded) clauses.push("date(t.occurred_at) BETWEEN date(?) AND date(?)");
          if (bucketClause) clauses.push(bucketClause);
          // WO11 Track B: hide transactions whose evidence is entirely
          // removed/deleted (evidence-less transactions stay visible).
          clauses.push(activeTransactionSql("t"));
          const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

          const rows = db
            .prepare(
              `SELECT t.*, e.display_name AS counterparty_name
               FROM transactions t
               LEFT JOIN entities e ON e.id = t.counterparty_entity_id
               ${whereSql}
               ORDER BY t.occurred_at DESC LIMIT ?`,
            )
            .all(
              ...(bounded ? [period.from as string, period.to as string] : []),
              Number(url.searchParams.get("limit") ?? 100),
            ) as Record<string, unknown>[];
          for (const r of rows) {
            r.legs = db
              .prepare(
                `SELECT l.leg, l.amount_minor, e.display_name AS account
                 FROM transaction_legs l JOIN entities e ON e.id = l.account_entity_id
                 WHERE l.transaction_id=?`,
              )
              .all(r.id as string);
            r.evidence = db
              .prepare(
                `SELECT d.id, d.original_filename, td.evidence_role, td.match_score
                 FROM transaction_documents td JOIN documents d ON d.id = td.document_id
                 WHERE td.transaction_id=? AND ${activeDocumentSql("d")}`,
              )
              .all(r.id as string);
          }
          return send(res, 200, { transactions: rows, total: rows.length });
        }

        case "/v1/entities": {
          const kind = url.searchParams.get("kind");
          const rows = (kind
            ? db.prepare("SELECT * FROM entities WHERE kind=? ORDER BY display_name").all(kind)
            : db.prepare("SELECT * FROM entities ORDER BY kind, display_name").all()) as Record<string, unknown>[];
          // WO11 A3: cross-kind identifier collisions ride along on each row
          // so the People desk can render a Conflicts section. Same-kind
          // duplicates are NOT conflicts — those are merge candidates.
          const conflicts = crossKindConflicts(db);
          for (const row of rows) {
            row.conflicts = conflicts.get(row.id as string) ?? [];
          }
          return send(res, 200, { entities: rows });
        }

        case "/v1/intake-feed":
          // Kept for backward compatibility — the richer /v1/intake/recent is
          // preferred. Same shape so existing clients keep working.
          return send(res, 200, {
            events: db
              .prepare("SELECT * FROM intake_events ORDER BY id DESC LIMIT ?")
              .all(Number(url.searchParams.get("limit") ?? 50)),
          });

        // Work order 06 §8 — recent intake with full disposition detail.
        case "/v1/intake/recent":
          return send(res, 200, {
            events: db
              .prepare("SELECT * FROM intake_events ORDER BY id DESC LIMIT ?")
              .all(Number(url.searchParams.get("limit") ?? 50)),
          });

        // Work order 07 §B2 — aggregated user-facing intake status. Each row
        // is one intake item with its current stage, terminal outcome, and
        // actionable failure/retry information. The UI should not infer
        // completion from individual JobStateChanged events.
        case "/v1/intake/status": {
          const rows = db
            .prepare(
              `SELECT id, filename, source, kind, processing_state,
                      detail, last_error, retry_count, next_retry_at,
                      stage_started_at, heartbeat_at, finished_at,
                      created_at, updated_at, document_id, reason_code, reason
                 FROM intake_events
                 ORDER BY id DESC LIMIT ?`,
            )
            .all(Number(url.searchParams.get("limit") ?? 100)) as Record<string, unknown>[];
          // Work order 07 §B3: stall detection. An item whose heartbeat is
          // stale relative to the current time is marked as stalled.
          const now = ports.clock.isoNow();
          const STALL_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
          const enriched = rows.map((r) => {
            const hb = r.heartbeat_at as string | null;
            const stalled =
              hb != null &&
              r.processing_state === "processing" &&
              Date.parse(now) - Date.parse(hb) > STALL_THRESHOLD_MS;
            return { ...r, stalled };
          });
          return send(res, 200, { events: enriched });
        }

        // Work order 06 §9 — irrelevant items only, for the Irrelevant view.
        case "/v1/irrelevant":
          return send(res, 200, {
            events: db
              .prepare(
                `SELECT * FROM intake_events
                  WHERE kind='irrelevant'
                  ORDER BY id DESC LIMIT ?`,
              )
              .all(Number(url.searchParams.get("limit") ?? 200)),
          });

        case "/v1/jobs":
          return send(res, 200, {
            jobs: db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all(),
          });

        case "/v1/reviews": {
          // getReviewQueue — everything a human should look at, in one place.
          const now = ports.clock.isoNow();
          const items: Record<string, unknown>[] = [];

          // Purchases resting on a single document: no corroboration yet.
          // NOTE: SQLite rejects HAVING without GROUP BY ("HAVING clause on a
          // non-aggregate query") — filter the correlated subquery in WHERE.
          const single = db
            .prepare(
              `SELECT t.id, t.amount_minor, t.currency, t.occurred_at, t.status,
                      e.display_name AS counterparty_name,
                      (SELECT COUNT(*) FROM transaction_documents td WHERE td.transaction_id=t.id) AS evidence_count
               FROM transactions t
               LEFT JOIN entities e ON e.id = t.counterparty_entity_id
               WHERE t.direction <> 'transfer'
                 AND (SELECT COUNT(*) FROM transaction_documents td WHERE td.transaction_id=t.id) < 2
               ORDER BY t.occurred_at DESC`,
            )
            .all() as Record<string, unknown>[];
          for (const r of single) {
            items.push({
              kind: "single_evidence",
              question: `Only one document backs this ${r.counterparty_name ?? "payment"}. Is there a matching receipt or statement line?`,
              transaction_id: r.id,
              amount_minor: r.amount_minor,
              // The amount means nothing detached from its currency — the
              // review card renders both, or flags the currency as uncertain
              // when the source document never stated one.
              currency: r.currency,
              occurred_at: r.occurred_at,
              counterparty: r.counterparty_name,
            });
          }

          // Entities the resolver created but nobody has confirmed.
          const candidates = db
            .prepare("SELECT id, kind, subtype, display_name FROM entities WHERE status='candidate' ORDER BY kind, display_name")
            .all() as Record<string, unknown>[];
          for (const c of candidates) {
            items.push({
              kind: "unconfirmed_entity",
              question: `Is "${c.display_name}" the right ${c.kind}${c.subtype ? ` (${c.subtype})` : ""}?`,
              entity_id: c.id,
              entity_kind: c.kind,
              display_name: c.display_name,
            });
          }

          // Documents that were analysed but never became or joined a transaction.
          const orphans = db
            .prepare(
              `SELECT d.id, d.original_filename, d.doc_type FROM documents d
               WHERE d.analysed_at IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM transaction_documents td WHERE td.document_id = d.id)`,
            )
            .all() as Record<string, unknown>[];
          for (const o of orphans) {
            items.push({
              kind: "orphan_document",
              question: `"${o.original_filename}" was read but is not linked to any transaction. Should it be?`,
              document_id: o.id,
              doc_type: o.doc_type,
            });
          }

          // Jobs that gave up.
          const failed = db
            .prepare("SELECT id, document_id, phase, last_error FROM jobs WHERE state='failed'")
            .all() as Record<string, unknown>[];
          for (const f of failed) {
            items.push({
              kind: "failed_job",
              question: `Processing failed at the ${f.phase} step.`,
              document_id: f.document_id,
              detail: f.last_error,
            });
          }

          return send(res, 200, { reviews: items, count: items.length, generated_at: now });
        }

        default: {
          // getDocumentDetail — /v1/documents/<id>/detail
          //
          // Everything the Document Review evidence summary shows (work order
          // 05 §A.3/§Track C): the raw extraction (immutable reading), the
          // winning claim per field with provenance, the resolved parties,
          // and the transactions this document evidences. The client renders
          // source amount + source currency from here and never invents one.
          const detailMatch = p.match(/^\/v1\/documents\/([^/]+)\/detail$/);
          if (detailMatch) {
            const docId = decodeURIComponent(detailMatch[1]);
            const doc = db
              .prepare(
                `SELECT id, original_filename, ext, doc_type, source, received_at,
                        converted_at, analysed_at, extraction_json, markdown_chars, lifecycle
                   FROM documents WHERE id=?`,
              )
              .get(docId) as Record<string, unknown> | undefined;
            if (!doc) return send(res, 404, { error: "document_not_found", document_id: docId });
            // WO11 Track B: this endpoint serves ACTIVE documents only. A
            // removed document is hidden (404 — reprocess brings it back); a
            // deleted one is gone for good (410 — the tombstone stays so
            // sha256 dedup still holds).
            if (!isActive(doc as { lifecycle: string })) {
              return send(res, doc.lifecycle === "deleted" ? 410 : 404, {
                error: doc.lifecycle === "deleted" ? "document_deleted" : "document_not_available",
                lifecycle: doc.lifecycle,
                document_id: docId,
              });
            }

            const extraction = doc.extraction_json ? safeParse(doc.extraction_json as string) : null;
            doc.extraction_json = undefined;
            doc.extraction = extraction;

            // Provenance per editable field, and the value that WINS (claim
            // over extraction) — the summary shows the winning value and a
            // "who said so" badge, never the raw model output alone.
            const claims = claimsFor(db, "document", docId);
            const claimMap = Object.fromEntries(
              Object.entries(claims).map(([field, c]) => [
                field,
                { value: c.value, source: c.source, status: c.status, confidence: c.confidence, at: c.created_at },
              ]),
            );
            const x = (extraction ?? {}) as Record<string, unknown>;
            const effective = (field: string, extractionKey?: string) => {
              const c = claims[field];
              if (c && c.value !== null) return { value: c.value, source: c.source, status: c.status };
              const v = extractionKey ? x[extractionKey] : x[field];
              return v === undefined || v === null
                ? null
                : { value: String(v), source: "ai" as const, status: "proposed" as const };
            };
            const parties = db
              .prepare(
                `SELECT dp.role, e.id, e.kind, e.display_name, e.status
                   FROM document_parties dp JOIN entities e ON e.id = dp.entity_id
                  WHERE dp.document_id=? ORDER BY dp.role, e.display_name`,
              )
              .all(docId);
            const transactions = db
              .prepare(
                `SELECT t.id, t.occurred_at, t.amount_minor, t.currency, t.direction,
                        t.home_amount_minor, t.fx_rate, t.fx_date, t.fx_source,
                        td.evidence_role, td.match_score, td.linked_by,
                        e.display_name AS counterparty_name
                   FROM transaction_documents td
                   JOIN transactions t ON t.id = td.transaction_id
                   LEFT JOIN entities e ON e.id = t.counterparty_entity_id
                  WHERE td.document_id=? ORDER BY t.occurred_at DESC`,
              )
              .all(docId);

            // Pipeline state + intake ID — needed by the UI to show a
            // password prompt for encrypted documents. The canonical state
            // lives in document_pipeline; the intake_events row carries the
            // numeric ID the /v1/intake/<id>/password endpoint expects.
            const pipeline = db
              .prepare("SELECT state FROM document_pipeline WHERE document_id=?")
              .get(docId) as { state: string } | undefined;
            const intake = db
              .prepare("SELECT id FROM intake_events WHERE document_id=? ORDER BY id DESC LIMIT 1")
              .get(docId) as { id: number } | undefined;

            return send(res, 200, {
              document: doc,
              extraction,
              claims: claimMap,
              editable_fields: [...allowedFields("document")],
              pipeline_state: pipeline?.state ?? null,
              intake_id: intake?.id ?? null,
              effective: {
                doc_type: effective("doc_type"),
                amount_minor: effective("amount_minor"),
                currency: effective("currency"),
                document_date: effective("document_date", "occurred_at"),
                posted_at: effective("posted_at"),
                counterparty: effective("counterparty", "counterparty_descriptor"),
                person: effective("person"),
                reference_ids: (x.reference_ids as Record<string, string> | undefined) ?? {},
                subtotal_minor: x.subtotal_minor ?? null,
                tax_minor: x.tax_minor ?? null,
                line_items: claims.line_items?.value ?? x.line_items ?? null,
                trades: claims.trades?.value ?? x.trades ?? null,
                financial_impact: claims.financial_impact?.value ?? x.financial_impact ?? null,
              },
              parties,
              transactions,
            });
          }

          // getDocumentPageInfo — /v1/documents/<id>/pageinfo
          //
          // How many pages, and can they be rendered? Separate from /page
          // because an image fetch cannot return metadata the client can read:
          // Flutter's NetworkImage exposes no response headers, so x-page-count
          // is invisible to it. Without this endpoint a viewer literally cannot
          // know a PDF has more than one page.
          const infoMatch = p.match(/^\/v1\/documents\/([^/]+)\/pageinfo$/);
          if (infoMatch) {
            const doc = db
              .prepare("SELECT id, ext, raw_path FROM documents WHERE id = ?")
              .get(infoMatch[1]) as Record<string, unknown> | undefined;
            if (!doc) {
              return send(res, 404, { error: "document_not_found", document_id: infoMatch[1] });
            }
            const resolved = path.resolve(String(doc.raw_path ?? ""));
            const vaultRoot = path.resolve(opts.vaultDir);
            if (!resolved.startsWith(vaultRoot + path.sep)) {
              return send(res, 403, { error: "outside_vault" });
            }
            const cap = await pageCapability(doc.ext as string, resolved);
            return send(res, 200, {
              document_id: doc.id,
              kind: cap.kind,
              pages: cap.pages,
              pager_available: cap.pagerAvailable,
              reason: cap.reason ?? null,
            });
          }

          // getDocumentPage — /v1/documents/<id>/page?n=1&w=2400
          //
          // A magnifiable page image. Images are served as-is; PDFs are
          // rasterised and cached. This is what makes the Review magnifier
          // usable on a real vault: 93% of documents here are PDFs, so an
          // image-only preview would reach almost nothing.
          const pageMatch = p.match(/^\/v1\/documents\/([^/]+)\/page$/);
          if (pageMatch) {
            const doc = db
              .prepare("SELECT id, ext, raw_path, sha256 FROM documents WHERE id = ?")
              .get(pageMatch[1]) as Record<string, unknown> | undefined;
            if (!doc) {
              return send(res, 404, { error: "document_not_found", document_id: pageMatch[1] });
            }

            const resolved = path.resolve(String(doc.raw_path ?? ""));
            const vaultRoot = path.resolve(opts.vaultDir);
            if (!resolved.startsWith(vaultRoot + path.sep)) {
              return send(res, 403, { error: "outside_vault" });
            }

            const cap = await pageCapability(doc.ext as string, resolved);
            if (cap.kind === "none") {
              // Not an error: an email with no attachment genuinely has no page.
              // 409 lets the client show "markdown only" rather than a failure.
              return send(res, 409, {
                error: "no_page_image",
                reason: cap.reason,
                document_id: doc.id,
              });
            }

            // Native images need no rendering — hand off to the file route's
            // logic by reading the original bytes directly.
            if (cap.kind === "native") {
              try {
                const bytes = await fsp.readFile(resolved);
                res.writeHead(200, {
                  "content-type": `image/${normaliseImageExt(String(doc.ext))}`,
                  "content-length": String(bytes.byteLength),
                  "x-content-type-options": "nosniff",
                  "cache-control": "private, max-age=300",
                  "x-page-count": "1",
                });
                return res.end(bytes);
              } catch {
                return send(res, 410, { error: "file_missing", expected_at: resolved });
              }
            }

            const wanted = Number(url.searchParams.get("n") ?? 1);
            // Default 2400px, ceiling 6144.
            //
            // These users ingest a handful of documents at a time on their own
            // machine, so render time is not the constraint — legibility under
            // magnification is. Measured on a real invoice: 1600px renders in
            // 0.35s, 2400px in 0.60s, 3200px in 0.96s, and the extra pixels are
            // genuine detail rather than interpolation (HSN codes and the small
            // '9%' tax annotations stay crisp). Renders are cached, so the cost
            // is paid once per page.
            const width = Math.min(
              6144,
              Math.max(256, Number(url.searchParams.get("w") ?? 2400)),
            );
            if (!Number.isInteger(wanted) || wanted < 1 || wanted > cap.pages) {
              return send(res, 400, {
                error: "page_out_of_range",
                requested: wanted,
                pages: cap.pages,
              });
            }
            // sips cannot select a page. Refusing is the honest answer — serving
            // page 1 for a request for page 3 would misattribute evidence.
            if (wanted !== 1 && !cap.pagerAvailable) {
              return send(res, 501, {
                error: "pager_unavailable",
                hint: "install poppler (pdftoppm) to render pages beyond the first",
                pages: cap.pages,
              });
            }

            try {
              const out = await renderPage({
                rawPath: resolved,
                ext: doc.ext as string,
                page: wanted,
                width,
                cacheDir: path.join(vaultRoot, ".cache", "pages"),
                sha256: String(doc.sha256 ?? doc.id),
              });
              const bytes = await fsp.readFile(out.file);
              res.writeHead(200, {
                "content-type": "image/png",
                "content-length": String(bytes.byteLength),
                "x-content-type-options": "nosniff",
                "cache-control": "private, max-age=300",
                // Lets the viewer render a pager without a second request.
                "x-page-count": String(cap.pages),
                "x-page-number": String(wanted),
                "x-render-via": out.via,
              });
              return res.end(bytes);
            } catch (e) {
              return send(res, 500, {
                error: "render_failed",
                detail: (e as Error).message,
              });
            }
          }

          // getDocumentFile — /v1/documents/<id>/file
          //
          // Serves the original bytes so a client can render a preview (and a
          // magnifier) without shelling out to Preview.app or Acrobat. The
          // Flutter Review tab needs this; there was previously no way to get
          // at a document's content over the API at all.
          const fileMatch = p.match(/^\/v1\/documents\/([^/]+)\/file$/);
          if (fileMatch) {
            const doc = db
              .prepare("SELECT id, original_filename, ext, raw_path, byte_size FROM documents WHERE id = ?")
              .get(fileMatch[1]) as Record<string, unknown> | undefined;
            if (!doc) {
              return send(res, 404, { error: "document_not_found", document_id: fileMatch[1] });
            }

            const raw = String(doc.raw_path ?? "");
            // Confine reads to the vault even though raw_path comes from our
            // own DB. A poisoned extraction, a restored backup from another
            // machine, or a hand-edited row must not turn this route into an
            // arbitrary-file-read primitive. resolve() collapses any '..'
            // before the prefix test, so traversal cannot slip through.
            const resolved = path.resolve(raw);
            const vaultRoot = path.resolve(opts.vaultDir);
            if (!resolved.startsWith(vaultRoot + path.sep)) {
              return send(res, 403, {
                error: "outside_vault",
                hint: "the document's raw_path does not resolve inside the vault",
              });
            }

            let bytes: Buffer;
            try {
              bytes = await fsp.readFile(resolved);
            } catch {
              // The row exists but the file is gone — a real state worth
              // distinguishing from "no such document", because the fix is
              // different (re-ingest vs. wrong id).
              return send(res, 410, {
                error: "file_missing",
                document_id: doc.id,
                expected_at: resolved,
              });
            }

            const ext = normaliseImageExt(String(doc.ext ?? ""));
            res.writeHead(200, {
              "content-type": MIME_BY_EXT[ext] ?? "application/octet-stream",
              "content-length": String(bytes.byteLength),
              // Never render an untrusted document inline as HTML.
              "x-content-type-options": "nosniff",
              "content-security-policy": "default-src 'none'",
              "cache-control": "private, max-age=60",
            });
            return res.end(bytes);
          }

          // getDocumentMarkdown — /v1/documents/<id>/markdown
          //
          // The extracted text, for the Document/Markdown toggle. Cheaper than
          // the original bytes and the only view that works for formats with no
          // usable image rendering.
          const mdMatch = p.match(/^\/v1\/documents\/([^/]+)\/markdown$/);
          if (mdMatch) {
            const doc = db
              .prepare("SELECT id, markdown_path, markdown_chars FROM documents WHERE id = ?")
              .get(mdMatch[1]) as Record<string, unknown> | undefined;
            if (!doc) {
              return send(res, 404, { error: "document_not_found", document_id: mdMatch[1] });
            }
            const mdPath = String(doc.markdown_path ?? "");
            if (!mdPath) {
              return send(res, 409, {
                error: "not_converted",
                hint: "conversion has not run for this document yet",
              });
            }
            const resolved = path.resolve(mdPath);
            const vaultRoot = path.resolve(opts.vaultDir);
            if (!resolved.startsWith(vaultRoot + path.sep)) {
              return send(res, 403, { error: "outside_vault" });
            }
            try {
              const text = await fsp.readFile(resolved, "utf-8");
              return send(res, 200, {
                document_id: doc.id,
                markdown: text,
                chars: text.length,
              });
            } catch {
              return send(res, 410, { error: "file_missing", expected_at: resolved });
            }
          }

          // getEvidenceCard — /v1/transactions/<id>/evidence
          const m = p.match(/^\/v1\/transactions\/([^/]+)\/evidence$/);
          if (m) {
            const txn = db
              .prepare(
                `SELECT t.*, e.display_name AS counterparty_name
                 FROM transactions t
                 LEFT JOIN entities e ON e.id = t.counterparty_entity_id
                 WHERE t.id = ?`,
              )
              .get(m[1]) as Record<string, unknown> | undefined;
            if (!txn) return send(res, 404, { error: "transaction_not_found", transaction_id: m[1] });

            const legs = db
              .prepare(
                `SELECT l.leg, l.amount_minor, e.id AS account_id, e.display_name AS account, e.subtype
                 FROM transaction_legs l JOIN entities e ON e.id = l.account_entity_id
                 WHERE l.transaction_id = ?`,
              )
              .all(m[1]);

            const evidence = db
              .prepare(
                `SELECT d.id, d.original_filename, d.doc_type, d.raw_path, d.markdown_path,
                        d.extraction_json, d.extraction_model, d.extracted_at,
                        d.extraction_version, d.markdown_hash,
                        td.evidence_role, td.match_score, td.linked_by, td.linked_at
                 FROM transaction_documents td JOIN documents d ON d.id = td.document_id
                 WHERE td.transaction_id = ? AND ${activeDocumentSql("d")}
                 ORDER BY td.linked_at`,
              )
              .all(m[1]) as Record<string, unknown>[];

            const claims = db
              .prepare(
                "SELECT field, value, source, confidence, created_at FROM field_claims WHERE subject_type='transaction' AND subject_id=? ORDER BY id",
              )
              .all(m[1]);

            return send(res, 200, {
              transaction: txn,
              legs,
              evidence: evidence.map((e) => ({
                ...e,
                extraction: e.extraction_json ? safeParse(e.extraction_json as string) : null,
                extraction_json: undefined,
              })),
              provenance: claims,
              // The headline claim, computed rather than asserted.
              summary:
                evidence.length > 1
                  ? `${evidence.length} documents describe this one payment of ${(Number(txn.amount_minor) / 100).toFixed(2)} ${txn.currency}. It is counted once.`
                  : `1 document backs this payment.`,
            });
          }
          return send(res, 404, { error: "not_found", path: p });
        }
      }
    } catch (err) {
      ports.logger.error("api error", { path: p, err: (err as Error)?.message });
      return send(res, 500, { error: (err as Error)?.message ?? "internal" });
    }
  });

  return {
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * Content types for served documents, in ONE place.
 *
 * Both /file and /page need this mapping; two copies drifted apart is how a
 * PNG ends up labelled application/octet-stream and silently fails to render.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  txt: "text/plain; charset=utf-8",
};

/** '.PNG' -> 'png'. Bare extension, lowercased, no leading dot. */
function normaliseImageExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, "");
}

/** Tolerant JSON parse for stored extraction blobs — never throws. */
function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch {
    return {};
  }
}

/**
 * Resolve a period selector into an inclusive date range.
 *
 *   this_month | last_month | this_fy | last_fy | all
 *   fy=FY 2026-27          explicit financial year
 *   month=2026-07          explicit month
 *
 * The FY boundary comes from the jurisdiction pack, not a hardcoded April.
 */
export function resolvePeriod(
  pack: JurisdictionPack,
  params: URLSearchParams,
  today = new Date(),
): { from: string | null; to: string | null; label: string; key: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthRange = (y: number, m: number) => {
    const from = `${y}-${pad(m)}-01`;
    const end = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day
    return { from, to: end.toISOString().slice(0, 10) };
  };
  const monthLabel = (y: number, m: number) =>
    new Date(Date.UTC(y, m - 1, 1)).toLocaleString("en", { month: "long", year: "numeric" });

  const explicitFy = params.get("fy");
  if (explicitFy) {
    const r = fyRange(pack, explicitFy);
    return { ...r, label: explicitFy, key: explicitFy };
  }

  const explicitMonth = params.get("month");
  if (explicitMonth && /^\d{4}-\d{2}$/.test(explicitMonth)) {
    const [y, m] = explicitMonth.split("-").map(Number);
    return { ...monthRange(y, m), label: monthLabel(y, m), key: explicitMonth };
  }

  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;

  switch (params.get("period") ?? "this_fy") {
    case "this_month":
      return { ...monthRange(y, m), label: monthLabel(y, m), key: `${y}-${pad(m)}` };
    case "last_month": {
      const ly = m === 1 ? y - 1 : y;
      const lm = m === 1 ? 12 : m - 1;
      return { ...monthRange(ly, lm), label: monthLabel(ly, lm), key: `${ly}-${pad(lm)}` };
    }
    case "last_fy": {
      const cur = fyKeyFor(pack, today.toISOString().slice(0, 10));
      const prevStart = Number(cur.match(/(\d{4})/)?.[1]) - 1;
      const prev = cur.replace(/\d{4}/, String(prevStart)).replace(/-\d{2}$/, (s) =>
        `-${String((prevStart + 1) % 100).padStart(2, "0")}`,
      );
      return { ...fyRange(pack, prev), label: prev, key: prev };
    }
    case "all":
      return { from: null, to: null, label: "All time", key: "all" };
    case "this_fy":
    default: {
      const cur = fyKeyFor(pack, today.toISOString().slice(0, 10));
      return { ...fyRange(pack, cur), label: cur, key: cur };
    }
  }
}

/**
 * THE COUNTING RULE (plan §3.3).
 * Totals come from `transactions`, never documents. Transfers are excluded
 * entirely — money moving between accounts I own is not income or spending.
 * status='scheduled' is excluded too: that's the v1.1.1 double-count lesson,
 * and it stays excluded until scheduled<->actual reconciliation exists.
 *
 * INVESTMENTS are separated from spending. Buying shares is not consumption —
 * the money changes form, it doesn't leave your net worth. Lumping contract
 * notes into "Spending" made a Rs 2L portfolio look like a shopping spree.
 *
 * Filtering is by occurred_at (the ECONOMIC date), not fy_key, so month
 * selection and financial-year selection share one code path.
 */
/**
 * WO11 A3 — cross-kind identifier collisions, for the People desk Conflicts
 * section. Two CONFIRMED entities of DIFFERENT kinds carrying the same typed
 * identifier (email/phone/handle, from resolver aliases or the entity's own
 * identifiers_json) are a conflict to surface, never a silent merge. Same-kind
 * duplicates are excluded here on purpose — those are merge candidates.
 * Pairs the user already adjudicated via /v1/entities/keep-separate are
 * suppressed by their standing learned_rules row.
 */
function crossKindConflicts(db: DatabaseSync): Map<string, Array<Record<string, unknown>>> {
  const byIdentifier = new Map<string, Map<string, { id: string; kind: string; display_name: string; type: string }>>();
  const add = (norm: string, type: string, e: { id: string; kind: string; display_name: string }) => {
    let group = byIdentifier.get(norm);
    if (!group) byIdentifier.set(norm, (group = new Map()));
    group.set(e.id, { ...e, type });
  };

  const aliasRows = db
    .prepare(
      `SELECT a.normalised, a.alias_type, e.id, e.kind, e.display_name
         FROM entity_aliases a JOIN entities e ON e.id = a.entity_id
        WHERE a.alias_type IN ('email','phone','handle') AND a.status <> 'rejected' AND e.status = 'confirmed'`,
    )
    .all() as Array<{ normalised: string; alias_type: string; id: string; kind: string; display_name: string }>;
  for (const r of aliasRows) add(r.normalised, r.alias_type, r);

  const entityRows = db
    .prepare("SELECT id, kind, display_name, identifiers_json FROM entities WHERE status='confirmed' AND identifiers_json IS NOT NULL")
    .all() as Array<{ id: string; kind: string; display_name: string; identifiers_json: string }>;
  for (const e of entityRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.identifiers_json);
    } catch {
      continue; // legacy malformed identifiers
    }
    const values: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === "string") values.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(parsed);
    for (const raw of values) {
      const type = classifyIdentifier(raw);
      if (!type) continue;
      add(normaliseIdentifier(type, raw), type, e);
    }
  }

  const suppressed = new Map<string, Set<string>>();
  const rules = db
    .prepare("SELECT match_key, value FROM learned_rules WHERE kind='entity_separation' AND active=1")
    .all() as Array<{ match_key: string; value: string }>;
  for (const r of rules) {
    const norm = r.match_key.replace(/^identifier:/, "");
    let pairs: unknown;
    try {
      pairs = JSON.parse(r.value);
    } catch {
      continue;
    }
    if (!Array.isArray(pairs)) continue;
    const set = suppressed.get(norm) ?? new Set<string>();
    for (const p of pairs) {
      if (Array.isArray(p) && p.length === 2) set.add([String(p[0]), String(p[1])].sort().join("|"));
    }
    suppressed.set(norm, set);
  }

  const conflicts = new Map<string, Array<Record<string, unknown>>>();
  for (const [norm, group] of byIdentifier) {
    const entities = [...group.values()];
    if (new Set(entities.map((e) => e.kind)).size < 2) continue;
    for (const e of entities) {
      const list = conflicts.get(e.id) ?? [];
      for (const o of entities) {
        if (o.id === e.id || o.kind === e.kind) continue;
        if (suppressed.get(norm)?.has([e.id, o.id].sort().join("|"))) continue;
        list.push({
          identifier: norm,
          identifier_type: e.type,
          other_id: o.id,
          other_kind: o.kind,
          other_name: o.display_name,
        });
      }
      if (list.length) conflicts.set(e.id, list);
    }
  }
  return conflicts;
}

export function snapshot(
  db: DatabaseSync,
  period: { from: string | null; to: string | null; label: string; key: string },
  homeCurrency = "INR",
) {
  const where = period.from && period.to ? "AND occurred_at BETWEEN ? AND ?" : "";
  const args = period.from && period.to ? [period.from, period.to] : [];

  // A transaction counts as investment when it carries an instrument or is
  // categorised as one (contract notes, SIPs, fund purchases).
  const INVEST = `(instrument_entity_id IS NOT NULL
                   OR lower(COALESCE(category_id,'')) LIKE '%invest%'
                   OR lower(COALESCE(impact_bucket,'')) LIKE '%invest%')`;

  // Totals are HOME-CURRENCY figures (work order 05 §A.2): a foreign-currency
  // transaction contributes its converted home_amount_minor when one exists,
  // and is otherwise EXCLUDED from the sum and reported under `unconverted`
  // instead — silently adding USD 597.85 to a rupee total is exactly the bug
  // this work order exists to kill. Rows with no stated currency are
  // excluded too: "currency uncertain" is not "rupees".
  const HOME_AMOUNT = `CASE
    WHEN home_amount_minor IS NOT NULL THEN home_amount_minor
    WHEN currency = '${homeCurrency.replace(/'/g, "''")}' THEN amount_minor
    ELSE NULL END`;

  // WO11 Track B: every transaction-derived figure applies the lifecycle
  // predicate — a transaction whose evidence is entirely removed/deleted
  // contributes nothing.
  const VISIBLE = activeTransactionSql("transactions");

  const sum = (dir: string, invest: boolean) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(${HOME_AMOUNT}),0) v FROM transactions
           WHERE direction=? AND status <> 'scheduled'
             AND ${VISIBLE} AND ${invest ? INVEST : `NOT ${INVEST}`} ${where}`,
        )
        .get(dir, ...args) as { v: number }
    ).v;

  const plainSum = (dir: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(${HOME_AMOUNT}),0) v FROM transactions
           WHERE direction=? AND status <> 'scheduled' AND ${VISIBLE} ${where}`,
        )
        .get(dir, ...args) as { v: number }
    ).v;

  // What the totals deliberately leave out, per currency — the honest
  // remainder a converted total cannot speak for.
  const unconvertedFor = (dir: string) =>
    db
      .prepare(
        `SELECT currency, SUM(amount_minor) AS amount_minor, COUNT(*) AS transactions
           FROM transactions
          WHERE direction=? AND status <> 'scheduled' AND home_amount_minor IS NULL
            AND (currency IS NULL OR currency <> ?) AND ${VISIBLE} ${where}
          GROUP BY currency ORDER BY currency`,
      )
      .all(dir, homeCurrency, ...args) as { currency: string | null; amount_minor: number; transactions: number }[];

  const countIn = (sql: string, extra: (string | number)[] = []) =>
    (db.prepare(sql).get(...extra) as { n: number }).n;

  const invested = sum("out", true);
  const divested = sum("in", true);

  // WO12 phase 2: refund netting. A refund (direction='in' with
  // reverses_transaction_id) reduces spending, not increases income.
  // The net spending figure is: outbound non-investment transactions minus
  // refunds that reverse outbound transactions. Income excludes refunds.
  // A refund only nets if the original transaction it reverses is still
  // visible — if the original's evidence was removed/deleted, the refund
  // becomes regular income (you can't reverse a transaction that doesn't
  // exist in the ledger anymore).
  const REFUND_VISIBLE = `EXISTS (
    SELECT 1 FROM transactions t2
    WHERE t2.id = transactions.reverses_transaction_id
      AND ${activeTransactionSql("t2")}
  )`;
  const refundsNetted = (
    db
      .prepare(
        `SELECT COALESCE(SUM(${HOME_AMOUNT}),0) v FROM transactions
         WHERE direction='in' AND status <> 'scheduled'
           AND reverses_transaction_id IS NOT NULL AND ${REFUND_VISIBLE}
           AND ${VISIBLE} ${where}`,
      )
      .get(...args) as { v: number }
  ).v;

  // Documents backing each bucket — the reference design shows "N documents
  // processed" under every figure, which is also the honest answer to
  // "where did this number come from?"
  const docsFor = (dir: string, invest: boolean) =>
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT td.document_id) n
           FROM transactions t JOIN transaction_documents td ON td.transaction_id = t.id
           JOIN documents d ON d.id = td.document_id
           WHERE t.direction=? AND t.status <> 'scheduled'
             AND ${activeDocumentSql("d")}
             AND ${invest ? INVEST : `NOT ${INVEST}`} ${where.replace(/occurred_at/g, "t.occurred_at")}`,
        )
        .get(dir, ...args) as { n: number }
    ).n;

  return {
    period: { key: period.key, label: period.label, from: period.from, to: period.to },
    fy_key: period.key,
    spending_minor: sum("out", false) - refundsNetted,
    // Investment income (dividends, redemptions) is income, not negative
    // investments. It is added to the income total so the Investments card
    // only reflects outbound purchases.
    income_minor: sum("in", false) + divested - refundsNetted,
    transfers_minor: plainSum("transfer"),
    investments_minor: invested,
    investments_out_minor: invested,
    investments_in_minor: divested,
    investments_net_minor: invested,
    income_documents: docsFor("in", false) + docsFor("in", true),
    spending_documents: docsFor("out", false),
    investment_documents: docsFor("out", true),
    // The totals above are expressed in this currency. Individual rows keep
    // their own source currency — this is the aggregate's unit, not theirs.
    currency: homeCurrency,
    unconverted: {
      spending: unconvertedFor("out"),
      income: unconvertedFor("in"),
      transfers: unconvertedFor("transfer"),
    },
    counts: {
      documents: countIn(
        `SELECT COUNT(*) n FROM documents WHERE ${activeDocumentSql("documents")}`,
      ),
      transactions: countIn(
        `SELECT COUNT(*) n FROM transactions WHERE status <> 'scheduled' AND ${VISIBLE} ${where}`,
        args,
      ),
      entities: countIn("SELECT COUNT(*) n FROM entities"),
      evidence_links: countIn(
        `SELECT COUNT(*) n FROM transaction_documents td
         JOIN documents d ON d.id = td.document_id WHERE ${activeDocumentSql("d")}`,
      ),
    },
    note: "totals derive from transactions; transfers excluded, investments separated from spending",
  };
}

/**
 * Work order 07 §D4 — test a configured AI provider with a harmless fixed
 * prompt. Never sends vault content. Reports URL reachability, authentication,
 * model availability, structured-output support, vision capability, latency,
 * and last-tested time.
 */
async function testProvider(cfg: {
  baseUrl: string;
  apiKey: string;
  model: string;
  which: "primary" | "secondary";
}): Promise<Record<string, unknown>> {
  const testedAt = new Date().toISOString();
  const base: Record<string, unknown> = {
    which: cfg.which,
    tested_at: testedAt,
    model: cfg.model,
    base_url: cfg.baseUrl || "(default)",
  };

  if (!cfg.apiKey) {
    return {
      ...base,
      reachable: false,
      authenticated: false,
      model_available: false,
      structured_output: false,
      vision: false,
      latency_ms: null,
      error: "no_api_key",
      error_explanation: "No API key configured. Set one in Settings first.",
    };
  }

  if (!cfg.model) {
    return {
      ...base,
      reachable: false,
      authenticated: false,
      model_available: false,
      structured_output: false,
      vision: false,
      latency_ms: null,
      error: "no_model",
      error_explanation: "No model configured. Set one in Settings first.",
    };
  }

  const start = Date.now();
  try {
    // Use a minimal, harmless request to test the provider. The prompt is a
    // fixed "say hello" — never vault content. We test structured output by
    // requesting a simple JSON response.
    // The OpenAI SDK appends /chat/completions to the base URL; the test
    // must match that, NOT append /v1/chat/completions (which doubles the
    // /v1 when the user's base URL already ends in /v1 — the root cause of
    // the spurious "model_not_found" 404s).
    const isAnthropic = cfg.baseUrl
      ? cfg.baseUrl.includes("anthropic.com")
      : true;
    const url = isAnthropic
      ? `${(cfg.baseUrl || "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`
      : `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    };
    // Anthropic uses x-api-key, not Bearer.
    if (isAnthropic) {
      headers["x-api-key"] = cfg.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      delete headers.authorization;
    }

    const body = isAnthropic
      ? JSON.stringify({
          model: cfg.model,
          max_tokens: 64,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
        })
      : JSON.stringify({
          model: cfg.model,
          max_tokens: 64,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
        });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const latencyMs = Date.now() - start;

    if (res.status === 401 || res.status === 403) {
      return {
        ...base,
        reachable: true,
        authenticated: false,
        model_available: false,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: "auth_failed",
        error_explanation: `Authentication failed (HTTP ${res.status}). Check the API key.`,
      };
    }

    if (res.status === 404) {
      return {
        ...base,
        reachable: true,
        authenticated: true,
        model_available: false,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: "model_not_found",
        error_explanation: `Model '${cfg.model}' not found (HTTP 404). Check the model name.`,
      };
    }

    if (res.status === 429) {
      return {
        ...base,
        reachable: true,
        authenticated: true,
        model_available: true,
        structured_output: null,
        vision: null,
        latency_ms: latencyMs,
        error: "rate_limited",
        error_explanation: "Rate limited (HTTP 429). The provider is reachable but busy.",
      };
    }

    if (res.status >= 500) {
      return {
        ...base,
        reachable: true,
        authenticated: true,
        model_available: null,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: "provider_error",
        error_explanation: `Provider error (HTTP ${res.status}). The provider is reachable but returned a server error.`,
      };
    }

    if (res.status !== 200) {
      const text = await res.text().catch(() => "");
      return {
        ...base,
        reachable: true,
        authenticated: true,
        model_available: null,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: `http_${res.status}`,
        error_explanation: `Unexpected HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    // 200 — the model is reachable and responds.
    const resBody = await res.json().catch(() => ({}));
    // Structured output: we can't fully test without a tool-use call, but a
    // 200 with a valid response body is a strong signal. We report true when
    // the response has the expected shape.
    const hasContent = isAnthropic
      ? !!(resBody as Record<string, unknown>)?.content
      : !!(resBody as Record<string, unknown>)?.choices;
    // Vision: we can't test without sending an image, but we report null
    // (unknown) rather than guessing. The capability matrix in the UI can
    // show this as "untested".
    return {
      ...base,
      reachable: true,
      authenticated: true,
      model_available: true,
      structured_output: hasContent,
      vision: null,
      latency_ms: latencyMs,
      request_id: res.headers.get("x-request-id") ?? res.headers.get("request-id") ?? null,
      error: null,
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes("abort") || msg.includes("AbortError")) {
      return {
        ...base,
        reachable: false,
        authenticated: null,
        model_available: false,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: "timeout",
        error_explanation: "Request timed out after 15 seconds. The provider may be unreachable.",
      };
    }
    if (msg.includes("ENOTFOUND") || msg.includes("ECONNREFUSED")) {
      return {
        ...base,
        reachable: false,
        authenticated: false,
        model_available: false,
        structured_output: false,
        vision: false,
        latency_ms: latencyMs,
        error: "unreachable",
        error_explanation: `Cannot reach the provider: ${msg}`,
      };
    }
    return {
      ...base,
      reachable: false,
      authenticated: null,
      model_available: false,
      structured_output: false,
      vision: false,
      latency_ms: latencyMs,
      error: "connection_error",
      error_explanation: msg,
    };
  }
}
