/**
 * MCP adapter (plan §1 layer 4, §9 "Agents").
 *
 * A thin CLIENT of the Core API — it holds no database handle and duplicates
 * no logic. That is the whole point of the daemon architecture: the agent
 * interface is another face on the same brain.
 *
 * Run:
 *   Q2AV_URL=http://127.0.0.1:4477 Q2AV_TOKEN=... npx tsx daemon/mcp-server.ts
 *
 * Claude Desktop / Hermes config:
 *   { "command": "npx", "args": ["tsx", "<abs>/daemon/mcp-server.ts"],
 *     "env": { "Q2AV_URL": "...", "Q2AV_TOKEN": "..." } }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.Q2AV_URL ?? "http://127.0.0.1:4477").replace(/\/$/, "");
const TOKEN = process.env.Q2AV_TOKEN ?? "";

const rupees = (minor: number | null | undefined) =>
  minor === null || minor === undefined
    ? "—"
    : `₹${(minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

async function api<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${path} -> HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }
  return (await res.json()) as T;
}

const TOOLS = [
  {
    name: "get_snapshot",
    description:
      "Financial totals for a period. Totals derive from transactions, never documents: two documents describing one payment count once, and transfers between your own accounts are excluded from spending entirely.",
    inputSchema: {
      type: "object",
      properties: { fy: { type: "string", description: 'Financial year, e.g. "FY 2026-27". Omit for all time.' } },
    },
  },
  {
    name: "list_transactions",
    description:
      "List transactions with their legs (which account moved) and evidence (which documents prove them). Optionally filter by direction or counterparty.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["out", "in", "transfer"] },
        counterparty: { type: "string", description: "Substring match on counterparty name." },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "query_documents",
    description: "List documents in the vault with conversion and analysis status.",
    inputSchema: {
      type: "object",
      properties: {
        doc_type: { type: "string", description: "e.g. merchant_invoice, card_confirmation" },
        limit: { type: "number", default: 50 },
      },
    },
  },
  {
    name: "explain_document",
    description:
      "Explain one document: what was extracted from it, which transaction it evidences, and which other documents evidence the same rupee.",
    inputSchema: {
      type: "object",
      properties: { document_id: { type: "string" } },
      required: ["document_id"],
    },
  },
  {
    name: "get_evidence_card",
    description:
      "Full evidence card for a transaction: every document backing it, the legs, and the match scores. This is how you answer 'prove it'.",
    inputSchema: {
      type: "object",
      properties: { transaction_id: { type: "string" } },
      required: ["transaction_id"],
    },
  },
  {
    name: "list_entities",
    description:
      "List entities by kind. Four kinds exist and never merge: person, organisation (counterparties), account (stores of funds you own), instrument (things you hold).",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["person", "organisation", "account", "instrument"] } },
    },
  },
  {
    name: "find_gaps",
    description:
      "Find holes in the ledger: payments with no invoice, invoices awaiting settlement, and documents that failed to become transactions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_review_queue",
    description:
      "Everything that needs a human decision: transactions resting on a single document, unconfirmed entities, orphaned documents, and failed jobs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "link_evidence",
    description:
      "Attach a document to a transaction as evidence. Use when the matcher missed a pair. A user link outranks any AI guess.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        document_id: { type: "string" },
        evidence_role: {
          type: "string",
          description: "merchant_invoice | card_confirmation | bank_slip | payment_receipt | statement_line",
        },
      },
      required: ["transaction_id", "document_id"],
    },
  },
  {
    name: "merge_entities",
    description:
      "Merge two entities OF THE SAME KIND (two spellings of one merchant, two names for one account). Cross-kind merges are refused by design: a merchant, a wallet and an equity sharing a name are different things.",
    inputSchema: {
      type: "object",
      properties: {
        from_id: { type: "string", description: "Entity to absorb (disappears)." },
        into_id: { type: "string", description: "Entity to keep." },
      },
      required: ["from_id", "into_id"],
    },
  },
] as const;

const server = new Server(
  { name: "quick2avault", version: "2.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as never }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const a = (req.params.arguments ?? {}) as Record<string, never>;
  try {
    const text = await dispatch(name, a);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

async function dispatch(name: string, a: Record<string, never>): Promise<string> {
  switch (name) {
    case "get_snapshot": {
      const q = a.fy ? `?fy=${encodeURIComponent(a.fy)}` : "";
      const s = await api<Snapshot>(`/v1/snapshot${q}`);
      return [
        `Period: ${s.fy_key ?? "all time"}`,
        ``,
        `  Spending   ${rupees(s.spending_minor)}`,
        `  Income     ${rupees(s.income_minor)}`,
        `  Transfers  ${rupees(s.transfers_minor)}  (excluded from spending — money moved between your own accounts)`,
        ``,
        `  ${s.counts.documents} documents → ${s.counts.transactions} transactions, ${s.counts.evidence_links} evidence links, ${s.counts.entities} entities`,
      ].join("\n");
    }

    case "list_transactions": {
      const r = await api<{ transactions: Txn[] }>(`/v1/transactions?limit=${a.limit ?? 50}`);
      let rows = r.transactions;
      if (a.direction) rows = rows.filter((t) => t.direction === a.direction);
      if (a.counterparty) {
        const q = String(a.counterparty).toLowerCase();
        rows = rows.filter((t) => (t.counterparty_name ?? "").toLowerCase().includes(q));
      }
      if (!rows.length) return "No matching transactions.";
      return rows.map((t) => renderTxn(t)).join("\n\n");
    }

    case "query_documents": {
      const r = await api<{ documents: Doc[] }>(`/v1/documents?limit=${a.limit ?? 50}`);
      let docs = r.documents;
      if (a.doc_type) docs = docs.filter((d) => d.doc_type === a.doc_type);
      if (!docs.length) return "No matching documents.";
      return docs
        .map(
          (d) =>
            `${d.id}  ${d.original_filename}\n    type=${d.doc_type ?? "?"}  source=${d.source}  ` +
            `markdown=${d.markdown_chars ?? 0} chars  analysed=${d.analysed_at ? "yes" : "no"}`,
        )
        .join("\n");
    }

    case "explain_document": {
      const docs = await api<{ documents: Doc[] }>(`/v1/documents?limit=500`);
      const doc = docs.documents.find((d) => d.id === a.document_id);
      if (!doc) return `No document ${a.document_id}.`;
      const txns = await api<{ transactions: Txn[] }>(`/v1/transactions?limit=500`);
      const owning = txns.transactions.find((t) => t.evidence?.some((e) => e.id === doc.id));

      const out = [`Document ${doc.id}`, `  file      ${doc.original_filename}`, `  type      ${doc.doc_type ?? "?"}`, `  source    ${doc.source}`];
      if (!owning) {
        out.push("", "Not linked to any transaction yet.");
        return out.join("\n");
      }
      out.push("", `Evidences transaction ${owning.id}:`, renderTxn(owning));
      const siblings = (owning.evidence ?? []).filter((e) => e.id !== doc.id);
      if (siblings.length) {
        out.push(
          "",
          `Same rupee, other evidence:`,
          ...siblings.map((s) => `  ${s.evidence_role.padEnd(20)} ${s.original_filename}`),
        );
      }
      return out.join("\n");
    }

    case "get_evidence_card": {
      const c = await api<EvidenceCard>(`/v1/transactions/${encodeURIComponent(String(a.transaction_id))}/evidence`);
      const t = c.transaction;
      const out = [
        `${t.direction.toUpperCase()}  ${rupees(t.amount_minor)}   ${t.occurred_at}   ${t.counterparty_name ?? "(no counterparty — transfer)"}`,
        `  ${t.fy_key}   rail=${t.payment_rail ?? "?"}   status=${t.status}`,
        ``,
        `Money movement:`,
        ...c.legs.map((l) => `  ${l.leg.padEnd(6)} ${rupees(l.amount_minor).padStart(12)}   ${l.account}${l.subtype ? `  [${l.subtype}]` : ""}`),
        ``,
        `Evidence (${c.evidence.length}):`,
      ];
      for (const e of c.evidence) {
        out.push(`  ${e.evidence_role.padEnd(20)} ${e.original_filename}`);
        out.push(`    linked by ${e.linked_by}${e.match_score ? ` at score ${Number(e.match_score).toFixed(2)}` : ""}`);
        const refs = (e.extraction as { reference_ids?: Record<string, string> } | null)?.reference_ids;
        if (refs && Object.keys(refs).length) {
          out.push(`    refs: ${Object.entries(refs).map(([k, v]) => `${k}=${v}`).join("  ")}`);
        }
      }
      if (c.provenance?.length) {
        out.push(``, `Provenance (user > rule > ai):`);
        for (const p of c.provenance) out.push(`  ${p.field.padEnd(16)} ${String(p.value).padEnd(24)} [${p.source}]`);
      }
      out.push(``, c.summary);
      return out.join("\n");
    }

    case "get_review_queue": {
      const r = await api<{ reviews: ReviewItem[]; count: number }>(`/v1/reviews`);
      if (!r.count) return "Review queue is empty — nothing needs your attention.";
      const byKind: Record<string, ReviewItem[]> = {};
      for (const x of r.reviews) (byKind[x.kind] ??= []).push(x);
      return Object.entries(byKind)
        .map(([k, list]) =>
          [`${k} (${list.length})`, ...list.map((x) => `    ${x.question}${x.amount_minor ? `  [${rupees(x.amount_minor)}]` : ""}`)].join("\n"),
        )
        .join("\n\n");
    }

    case "link_evidence": {
      const r = await api<{ linked: boolean }>(`/v1/link`, {
        method: "POST",
        body: JSON.stringify({
          transaction_id: a.transaction_id,
          document_id: a.document_id,
          evidence_role: a.evidence_role,
        }),
      });
      return r.linked
        ? `Linked. This document is now evidence for that transaction — the rupee is still counted once.`
        : `Link failed.`;
    }

    case "merge_entities": {
      try {
        const r = await api<{ merged: boolean; kind: string; into: string }>(`/v1/entities/merge`, {
          method: "POST",
          body: JSON.stringify({ from_id: a.from_id, into_id: a.into_id }),
        });
        return `Merged into "${r.into}" (${r.kind}).`;
      } catch (err) {
        const m = (err as Error).message;
        if (m.includes("cross_kind_merge_refused")) {
          return `Refused: merges are kind-scoped. A merchant, a wallet, a person and an instrument that share a name are different things and never merge.`;
        }
        throw err;
      }
    }

    case "list_entities": {
      const q = a.kind ? `?kind=${encodeURIComponent(a.kind)}` : "";
      const r = await api<{ entities: Ent[] }>(`/v1/entities${q}`);
      if (!r.entities.length) return "No entities.";
      const byKind: Record<string, Ent[]> = {};
      for (const e of r.entities) (byKind[e.kind] ??= []).push(e);
      return Object.entries(byKind)
        .map(([k, list]) =>
          [`${k} (${list.length})`, ...list.map((e) => `    ${e.display_name}${e.subtype ? `  [${e.subtype}]` : ""}`)].join("\n"),
        )
        .join("\n\n");
    }

    case "find_gaps": {
      const [t, d] = await Promise.all([
        api<{ transactions: Txn[] }>(`/v1/transactions?limit=500`),
        api<{ documents: Doc[] }>(`/v1/documents?limit=500`),
      ]);
      const noInvoice = t.transactions.filter((x) => x.status === "no_invoice");
      const awaiting = t.transactions.filter((x) => x.status === "awaiting_settlement");
      const single = t.transactions.filter((x) => x.direction !== "transfer" && (x.evidence?.length ?? 0) < 2);
      const unanalysed = d.documents.filter((x) => !x.analysed_at);
      const orphaned = d.documents.filter(
        (x) => x.analysed_at && !t.transactions.some((y) => y.evidence?.some((e) => e.id === x.id)),
      );

      const out: string[] = [];
      const section = (title: string, lines: string[]) => {
        if (lines.length) out.push(`${title} (${lines.length})`, ...lines.map((l) => `    ${l}`), "");
      };
      section("Payments with no invoice", noInvoice.map((x) => `${rupees(x.amount_minor)}  ${x.occurred_at}  ${x.counterparty_name ?? ""}`));
      section("Invoices awaiting settlement", awaiting.map((x) => `${rupees(x.amount_minor)}  ${x.occurred_at}  ${x.counterparty_name ?? ""}`));
      section(
        "Single-evidence transactions (no corroborating document)",
        single.map((x) => `${rupees(x.amount_minor)}  ${x.occurred_at}  ${x.counterparty_name ?? ""}`),
      );
      section("Documents not yet analysed", unanalysed.map((x) => x.original_filename));
      section("Analysed but not linked to any transaction", orphaned.map((x) => `${x.original_filename}  (${x.doc_type ?? "?"})`));
      return out.length ? out.join("\n").trim() : "No gaps found — every document is accounted for.";
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function renderTxn(t: Txn, full = false): string {
  const head =
    `${t.direction.toUpperCase().padEnd(8)} ${rupees(t.amount_minor).padStart(12)}   ${t.occurred_at}   ` +
    `${t.counterparty_name ?? "(no counterparty — transfer between your own accounts)"}`;
  const lines = [head, `  id ${t.id}   ${t.fy_key}   rail=${t.payment_rail ?? "?"}   status=${t.status}`];
  for (const l of t.legs ?? []) lines.push(`  ${l.leg.padEnd(6)} ${rupees(l.amount_minor).padStart(12)}   ${l.account}`);
  for (const e of t.evidence ?? [])
    lines.push(`  evidence  ${e.evidence_role.padEnd(20)} ${e.original_filename}${full && e.match_score ? `  (match ${Number(e.match_score).toFixed(2)})` : ""}`);
  if (full && (t.evidence?.length ?? 0) > 1)
    lines.push(`  → ${t.evidence!.length} documents describe this ONE payment; it is counted once.`);
  return lines.join("\n");
}

interface Snapshot {
  fy_key: string | null;
  spending_minor: number;
  income_minor: number;
  transfers_minor: number;
  counts: { documents: number; transactions: number; entities: number; evidence_links: number };
}
interface Txn {
  id: string;
  direction: string;
  amount_minor: number;
  occurred_at: string;
  fy_key: string;
  payment_rail: string | null;
  status: string;
  counterparty_name: string | null;
  legs?: { leg: string; amount_minor: number; account: string }[];
  evidence?: { id: string; original_filename: string; evidence_role: string; match_score?: number }[];
}
interface Doc {
  id: string;
  original_filename: string;
  doc_type: string | null;
  source: string;
  markdown_chars: number | null;
  analysed_at: string | null;
}
interface Ent {
  id: string;
  kind: string;
  subtype: string | null;
  display_name: string;
}
interface EvidenceCard {
  transaction: Txn;
  legs: { leg: string; amount_minor: number; account: string; subtype: string | null }[];
  evidence: {
    id: string;
    original_filename: string;
    evidence_role: string;
    match_score?: number;
    linked_by: string;
    extraction: unknown;
  }[];
  provenance: { field: string; value: string; source: string; confidence: number }[];
  summary: string;
}
interface ReviewItem {
  kind: string;
  question: string;
  amount_minor?: number;
  transaction_id?: string;
  document_id?: string;
  entity_id?: string;
}

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the MCP wire protocol.
console.error(`quick2avault MCP server ready (daemon ${BASE})`);
