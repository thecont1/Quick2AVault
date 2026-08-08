/**
 * Core API (plan §1 layer 3) — versioned HTTP contract + SSE event stream.
 * Every UI is a client of this: tray, web, CLI, MCP.
 *
 * Auth: localhost bearer token. Health is deliberately unauthenticated so a
 * probe can distinguish "daemon down" from "daemon up but token wrong".
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { ingestFile } from "./pipeline.js";

export interface ApiOptions {
  port: number;
  host?: string;
  token: string;
  version: string;
}

export function createApi(db: DatabaseSync, ports: Ports, opts: ApiOptions) {
  const startedAt = Date.now();

  const send = (res: ServerResponse, code: number, body: unknown) => {
    const b = JSON.stringify(body);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
    res.end(b);
  };

  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    return h.startsWith("Bearer ") && h.slice(7) === opts.token;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    try {
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
      if (!authed(req)) return send(res, 401, { error: "unauthorized" });

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
        });
        return send(res, result.status === "failed" ? 500 : 200, result);
      }

      // ── queries ──────────────────────────────────────────────────────────
      switch (p) {
        case "/v1/snapshot":
          return send(res, 200, snapshot(db, url.searchParams.get("fy")));

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

        case "/v1/reviews":
          return send(res, 200, { reviews: [], count: 0 });

        default:
          return send(res, 404, { error: "not_found", path: p });
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
 * THE COUNTING RULE (plan §3.3).
 * Totals come from `transactions`, never documents. Transfers are excluded
 * entirely — money moving between accounts I own is not income or spending.
 * status='scheduled' is excluded too: that's the v1.1.1 double-count lesson,
 * and it stays excluded until scheduled<->actual reconciliation exists.
 */
export function snapshot(db: DatabaseSync, fy?: string | null) {
  const where = fy ? "AND fy_key = ?" : "";
  const args = fy ? [fy] : [];
  const sum = (dir: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(amount_minor),0) v FROM transactions
           WHERE direction=? AND status <> 'scheduled' ${where}`,
        )
        .get(dir, ...args) as { v: number }
    ).v;

  return {
    fy_key: fy ?? null,
    spending_minor: sum("out"),
    income_minor: sum("in"),
    transfers_minor: sum("transfer"),
    currency: "INR",
    counts: {
      documents: (db.prepare("SELECT COUNT(*) n FROM documents").get() as { n: number }).n,
      transactions: (
        db.prepare("SELECT COUNT(*) n FROM transactions WHERE status <> 'scheduled'").get() as { n: number }
      ).n,
      entities: (db.prepare("SELECT COUNT(*) n FROM entities").get() as { n: number }).n,
      evidence_links: (db.prepare("SELECT COUNT(*) n FROM transaction_documents").get() as { n: number }).n,
    },
    note: "totals derive from transactions; transfers and scheduled rows excluded",
  };
}
