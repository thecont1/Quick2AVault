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
import { ingestFile } from "./pipeline.js";
import { listPacks, loadPack, fyKeyFor, fyRange, type JurisdictionPack } from "./jurisdiction.js";
import { buildTreemap } from "./categories/spend-categories.js";
import { deriveGmailAddress } from "./gmail/gmail-model.js";
import type { GmailOAuth } from "./gmail/oauth.js";
import {
  isLearningEnabled,
  questionBudget,
  answer as answerQuestion,
  dismiss as dismissQuestion,
  findNearDuplicates,
} from "./learning.js";

export interface ApiOptions {
  port: number;
  host?: string;
  token: string;
  version: string;
  /** Surfaced read-only on the Setup page so the user can see what's active. */
  ai?: { available: boolean; model: string };
  dropDir?: string;
  /** Serve the browser dev UI at `/`. Off unless Q2AV_DEV_UI=1. */
  devUi?: boolean;
  /** Gmail dropbox, present only when Google OAuth credentials are set. */
  gmail?: { oauth: GmailOAuth; sync: () => Promise<unknown> };
}

export function createApi(db: DatabaseSync, ports: Ports, opts: ApiOptions) {
  const startedAt = Date.now();
  const ai = opts.ai ?? { available: false, model: "(none)" };
  const dropDir = opts.dropDir ?? "";
  const gmail = opts.gmail;

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
        // Ask the token store, not a flag — the tokens are the truth.
        const gmailConnected = gmail ? !!(await gmail.oauth.getTokens()) : false;
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
        const saved: string[] = [];
        for (const [field, key] of [
          ["base_url", "ai.base_url"],
          ["model", "ai.model"],
          ["api_key", "ai.api_key"],
          ["jurisdiction", "jurisdiction.id"],
          ["gmail_local_part", "gmail.local_part"],
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

      // ── people ───────────────────────────────────────────────────────────
      // Who this vault is for. The first person the extractor names as "owner"
      // is auto-promoted to member; everyone else stays a candidate until the
      // user says otherwise (plan §5: zero setup, confirm on novelty).
      if (p === "/v1/people" && req.method === "GET") {
        const people = db
          .prepare(
            `SELECT e.id, e.display_name, e.subtype, e.is_member, e.status, e.confidence,
                    (SELECT COUNT(*) FROM document_parties dp WHERE dp.entity_id = e.id) AS document_count
             FROM entities e WHERE e.kind='person'
             ORDER BY e.is_member DESC, document_count DESC, e.display_name`,
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
          owner: people.find((x) => x.is_member === 1) ?? null,
        });
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
            `INSERT INTO entities (id, kind, subtype, display_name, confidence, status, is_member, created_at)
             VALUES (?, 'person', ?, ?, 1.0, 'confirmed', ?, ?)`,
          ).run(id, b.relationship ?? null, name, b.is_member ? 1 : 0, now);
        } else {
          db.prepare(
            "UPDATE entities SET subtype=COALESCE(?,subtype), is_member=?, status='confirmed' WHERE id=?",
          ).run(b.relationship ?? null, b.is_member ? 1 : 0, id);
        }

        // Exactly one owner: promoting a person demotes the previous one.
        if (b.is_owner) {
          db.prepare("UPDATE entities SET is_member=0 WHERE kind='person' AND id<>?").run(id);
          db.prepare("UPDATE entities SET is_member=1, status='confirmed' WHERE id=?").run(id);
        }
        return send(res, 200, { id, display_name: name, declared: !existing });
      }

      // Merge two people into one, keeping every spelling as an alias.
      // The automatic rules catch word-order and identifier matches; this is
      // for the rest ("M. Shantaram", a maiden name, an initials-only form).
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

        const now = ports.clock.isoNow();
        db.exec("BEGIN");
        try {
          db.prepare("UPDATE OR IGNORE document_parties SET entity_id=? WHERE entity_id=?").run(into.id, from.id);
          db.prepare("UPDATE OR IGNORE entity_aliases SET entity_id=? WHERE entity_id=?").run(into.id, from.id);
          // The absorbed spelling becomes an alias, so the same variant on a
          // future document resolves without asking again.
          db.prepare(
            `INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, source, created_at)
             VALUES (?, 'person', ?, ?, 'user-merge', ?)`,
          ).run(into.id, from.display_name, from.display_name.toLowerCase(), now);
          // Merging into a non-member keeps membership if either side had it.
          db.prepare(
            "UPDATE entities SET is_member = MAX(is_member, (SELECT is_member FROM entities WHERE id=?)) WHERE id=?",
          ).run(from.id, into.id);
          db.prepare("DELETE FROM entities WHERE id=?").run(from.id);
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        ports.logger.info("people merged", { from: from.display_name, into: into.display_name });
        return send(res, 200, { merged: true, into: into.display_name });
      }

      // Every spelling the vault knows for one person.
      if (p.startsWith("/v1/people/") && p.endsWith("/aliases") && req.method === "GET") {
        const id = p.split("/")[3];
        return send(res, 200, {
          aliases: db
            .prepare("SELECT alias, source, created_at FROM entity_aliases WHERE entity_id=? ORDER BY id")
            .all(id),
        });
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
        try {
          return send(res, 200, await gmail.sync());
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

      // ── learning (plan §5) ───────────────────────────────────────────────
      // Questions the vault wants answered, and the rules those answers made.
      if (p === "/v1/learning" && req.method === "GET") {
        const open = db
          .prepare(
            `SELECT id, question, trigger, context, options, created_at
             FROM training_reviews
             WHERE answered_at IS NULL AND dismissed=0
             ORDER BY id DESC LIMIT 20`,
          )
          .all() as Record<string, unknown>[];
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
        return send(res, 200, {
          enabled: isLearningEnabled(db),
          budget: questionBudget(db),
          questions: open,
          rules,
          answered: (
            db.prepare("SELECT COUNT(*) n FROM training_reviews WHERE answered_at IS NOT NULL")
              .get() as { n: number }
          ).n,
        });
      }

      // Answer a question; the answer becomes a rule.
      if (p === "/v1/learning/answer" && req.method === "POST") {
        const b = await readJson(req);
        const id = Number(b.review_id);
        if (!id) return send(res, 400, { error: "review_id required" });
        const r = answerQuestion(db, ports, id, String(b.answer ?? ""), b.rule_kind
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
          ];
          const args: string[] = [];
          if (period.from && period.to) {
            clauses.push("occurred_at >= ? AND occurred_at <= ?");
            args.push(period.from, period.to);
          }
          const rows = db
            .prepare(
              `SELECT impact_bucket,
                      SUM(amount_minor) AS amount_minor,
                      COUNT(*)          AS transactions
                 FROM transactions
                WHERE ${clauses.join(" AND ")}
                GROUP BY impact_bucket`,
            )
            .all(...args) as Array<{
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

  // Documents backing each bucket — the reference design shows "N documents
  // processed" under every figure, which is also the honest answer to
  // "where did this number come from?"
  const docsFor = (dir: string, invest: boolean) =>
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT td.document_id) n
           FROM transactions t JOIN transaction_documents td ON td.transaction_id = t.id
           WHERE t.direction=? AND t.status <> 'scheduled'
             AND ${invest ? INVEST : `NOT ${INVEST}`} ${where.replace(/occurred_at/g, "t.occurred_at")}`,
        )
        .get(dir, ...args) as { n: number }
    ).n;

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
    income_documents: docsFor("in", false),
    spending_documents: docsFor("out", false),
    investment_documents: docsFor("out", true),
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
