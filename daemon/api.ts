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
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { ingestFile } from "./pipeline.js";
import { listPacks, loadPack, fyKeyFor, fyRange, type JurisdictionPack } from "./jurisdiction.js";

export interface ApiOptions {
  port: number;
  host?: string;
  token: string;
  version: string;
  /** Surfaced read-only on the Setup page so the user can see what's active. */
  ai?: { available: boolean; model: string };
  dropDir?: string;
}

export function createApi(db: DatabaseSync, ports: Ports, opts: ApiOptions) {
  const startedAt = Date.now();
  const ai = opts.ai ?? { available: false, model: "(none)" };
  const dropDir = opts.dropDir ?? "";

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

  const authed = (req: IncomingMessage, url?: URL) => {
    const h = req.headers.authorization ?? "";
    if (h.startsWith("Bearer ") && h.slice(7) === opts.token) return true;
    // EventSource cannot set headers, so the SSE stream also accepts the token
    // as a query parameter. Localhost-only daemon; the token never leaves the
    // machine, and this is the standard workaround for browser SSE clients.
    return !!url && url.searchParams.get("token") === opts.token;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;
    const pack = activePack();

    try {
      // ── the demo UI (unauthenticated shell; it fetches with the token) ───
      if (p === "/" || p === "/index.html") {
        const file = path.join(import.meta.dirname ?? __dirname, "ui.html");
        let html: string;
        try {
          html = await fsp.readFile(file, "utf-8");
        } catch {
          return send(res, 404, { error: "ui.html not found", expected: file });
        }
        // Inject the live token so the page can call the API without a login.
        html = html.replace("%%TOKEN%%", opts.token);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(html);
      }

      // ── unauthenticated: health ──────────────────────────────────────────
      if (p === "/v1/health") {
        const jobs = db.prepare("SELECT state, COUNT(*) n FROM jobs GROUP BY state").all() as {
          state: string;
          n: number;
        }[];
        return send(res, 200, {
          status: "ok",
          version: opts.version,
          schema_version: 2,
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

      // linkDocuments — attach a document to a transaction as evidence, or
      // detach one the matcher got wrong. Both directions are user claims and
      // outrank AI (field_claims precedence: user > rule > ai).
      if (p === "/v1/link" && req.method === "POST") {
        const b = await readJson(req);
        if (!b.transaction_id || !b.document_id) {
          return send(res, 400, { error: "transaction_id and document_id required" });
        }
        const now = ports.clock.isoNow();
        db.prepare(
          `INSERT OR REPLACE INTO transaction_documents
            (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
           VALUES (?,?,?,?, 'user', ?)`,
        ).run(b.transaction_id, b.document_id, b.evidence_role ?? "payment_receipt", 1.0, now);
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
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        ports.logger.info("entities merged", { from: from.display_name, into: into.display_name, kind: into.kind });
        return send(res, 200, { merged: true, kind: into.kind, into: into.display_name });
      }


      // ── settings (Setup page) ────────────────────────────────────────────
      // AI provider config lives in app_settings so it survives restarts and
      // can be changed from any client. The API key is NEVER returned — only
      // whether one is set, and its last 4 characters for recognition.
      if (p === "/v1/settings" && req.method === "GET") {
        const rows = db.prepare("SELECT key, value FROM app_settings").all() as {
          key: string;
          value: string;
        }[];
        const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        const envKey = process.env.ANTHROPIC_API_KEY ?? "";
        const storedKey = kv["ai.api_key"] ?? "";
        const effective = storedKey || envKey;
        return send(res, 200, {
          ai: {
            base_url: kv["ai.base_url"] ?? "",
            model: kv["ai.model"] ?? process.env.Q2AV_MODEL ?? "claude-sonnet-5",
            api_key_set: !!effective,
            api_key_hint: effective ? `…${effective.slice(-4)}` : "",
            api_key_source: storedKey ? "settings" : envKey ? "environment" : "none",
            available: ai.available,
            active_model: ai.model,
          },
          vault: {
            root: ports.paths.vaultRoot(),
            drop: dropDir,
            db: ports.paths.dbPath(),
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
        const saved: string[] = [];
        for (const [field, key] of [
          ["base_url", "ai.base_url"],
          ["model", "ai.model"],
          ["api_key", "ai.api_key"],
          ["jurisdiction", "jurisdiction.id"],
        ] as const) {
          const v = b[field];
          if (typeof v === "string" && v.length > 0) {
            set.run(key, v);
            saved.push(field);
          }
        }
        ports.logger.info("settings updated", { fields: saved });
        return send(res, 200, {
          saved,
          // Provider is constructed at startup; a restart picks up new values.
          restart_required: saved.some((f) => f !== "model"),
        });
      }

      // ── queries ──────────────────────────────────────────────────────────
      switch (p) {
        case "/v1/snapshot":
          return send(res, 200, snapshot(db, resolvePeriod(pack, url.searchParams)));

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

        case "/v1/documents":
          return send(res, 200, {
            documents: db
              .prepare(
                `SELECT id, original_filename, ext, byte_size, doc_type, source, sha256,
                        markdown_chars, received_at, converted_at, analysed_at
                 FROM documents ORDER BY received_at DESC LIMIT ?`,
              )
              .all(Number(url.searchParams.get("limit") ?? 100)),
          });

        case "/v1/transactions": {
          const rows = db
            .prepare(
              `SELECT t.*, e.display_name AS counterparty_name
               FROM transactions t
               LEFT JOIN entities e ON e.id = t.counterparty_entity_id
               ORDER BY t.occurred_at DESC LIMIT ?`,
            )
            .all(Number(url.searchParams.get("limit") ?? 100)) as Record<string, unknown>[];
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
                 WHERE td.transaction_id=?`,
              )
              .all(r.id as string);
          }
          return send(res, 200, { transactions: rows, total: rows.length });
        }

        case "/v1/entities": {
          const kind = url.searchParams.get("kind");
          const rows = kind
            ? db.prepare("SELECT * FROM entities WHERE kind=? ORDER BY display_name").all(kind)
            : db.prepare("SELECT * FROM entities ORDER BY kind, display_name").all();
          return send(res, 200, { entities: rows });
        }

        case "/v1/intake-feed":
          return send(res, 200, {
            events: db
              .prepare("SELECT * FROM intake_events ORDER BY id DESC LIMIT ?")
              .all(Number(url.searchParams.get("limit") ?? 50)),
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
                        d.extraction_json, td.evidence_role, td.match_score, td.linked_by, td.linked_at
                 FROM transaction_documents td JOIN documents d ON d.id = td.document_id
                 WHERE td.transaction_id = ?
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
export function snapshot(
  db: DatabaseSync,
  period: { from: string | null; to: string | null; label: string; key: string },
) {
  const where = period.from && period.to ? "AND occurred_at BETWEEN ? AND ?" : "";
  const args = period.from && period.to ? [period.from, period.to] : [];

  // A transaction counts as investment when it carries an instrument or is
  // categorised as one (contract notes, SIPs, fund purchases).
  const INVEST = `(instrument_entity_id IS NOT NULL
                   OR lower(COALESCE(category_id,'')) LIKE '%invest%'
                   OR lower(COALESCE(impact_bucket,'')) LIKE '%invest%')`;

  const sum = (dir: string, invest: boolean) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_minor),0) v FROM transactions
           WHERE direction=? AND status <> 'scheduled'
             AND ${invest ? INVEST : `NOT ${INVEST}`} ${where}`,
        )
        .get(dir, ...args) as { v: number }
    ).v;

  const plainSum = (dir: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_minor),0) v FROM transactions
           WHERE direction=? AND status <> 'scheduled' ${where}`,
        )
        .get(dir, ...args) as { v: number }
    ).v;

  const countIn = (sql: string, extra: (string | number)[] = []) =>
    (db.prepare(sql).get(...extra) as { n: number }).n;

  const invested = sum("out", true);
  const divested = sum("in", true);

  return {
    period: { key: period.key, label: period.label, from: period.from, to: period.to },
    fy_key: period.key,
    spending_minor: sum("out", false),
    income_minor: sum("in", false),
    transfers_minor: plainSum("transfer"),
    investments_minor: invested,
    investments_out_minor: invested,
    investments_in_minor: divested,
    investments_net_minor: invested - divested,
    currency: "INR",
    counts: {
      documents: countIn("SELECT COUNT(*) n FROM documents"),
      transactions: countIn(
        `SELECT COUNT(*) n FROM transactions WHERE status <> 'scheduled' ${where}`,
        args,
      ),
      entities: countIn("SELECT COUNT(*) n FROM entities"),
      evidence_links: countIn("SELECT COUNT(*) n FROM transaction_documents"),
    },
    note: "totals derive from transactions; transfers excluded, investments separated from spending",
  };
}
