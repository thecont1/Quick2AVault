/**
 * Statement imports — deterministic table parsing (work order 04 §Track A).
 *
 * "Deterministic first, AI for judgment" (repo-wide rule, restated in this
 * work order because the holdings bug already proved what happens when it is
 * skipped): a 100-line statement is a worse version of the 21-security
 * contract-note truncation. This module parses the GFM markdown table AnyDoc
 * renders WITHOUT any AI call — column mapping by header-name matching, row
 * extraction, and a running-balance continuity check. AI (statements-ai.ts,
 * added when a layout this cannot map arrives) is for confirming an
 * unfamiliar column header or classifying a line — never for reading the
 * numbers themselves.
 */
import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import type { ExtractionResult, StatementLineExtraction } from "./extraction-contract.js";
import { findMatches, linkEvidence, AUTO_LINK, REVIEW_FLOOR } from "./matcher.js";
import { recordTransaction } from "./ledger.js";

const newId = (p: string) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

export interface ParsedStatementHeader {
  institution: string | null;
  account_ref: string | null;
  period_from: string | null;
  period_to: string | null;
  opening_balance_minor: number | null;
  closing_balance_minor: number | null;
  currency: string;
}

export interface ParsedStatement {
  header: ParsedStatementHeader;
  lines: StatementLineExtraction[];
  /** Column headers that were found but could not be mapped — surfaced so a
   *  human (or the AI column-mapping fallback) can see exactly what confused
   *  the parser, rather than a silent empty result. */
  unmapped_columns: string[];
  /** True when every required column (date, descriptor, one of debit/credit
   *  or a signed amount) was found. False means AI column-mapping should run
   *  before this statement is trusted. */
  column_mapping_confident: boolean;
}

// Column header aliases, case-insensitive, matched after stripping
// punctuation. Indian bank/card statements vary this a great deal —
// "Narration" vs "Description" vs "Particulars" vs "Transaction Details" are
// all the same column on different banks' exports.
const HEADER_ALIASES: Record<string, string[]> = {
  date: ["date", "txn date", "transaction date", "value date", "posting date"],
  descriptor: ["narration", "description", "particulars", "transaction details", "details", "remarks"],
  debit: ["debit", "withdrawal", "withdrawal amt", "dr", "amount (dr)"],
  credit: ["credit", "deposit", "deposit amt", "cr", "amount (cr)"],
  amount: ["amount", "transaction amount"],
  direction: ["dr/cr", "type", "cr/dr"],
  balance: ["balance", "running balance", "closing balance", "available balance"],
  // A reference/UTR/RRN column is what lets a statement line cross AUTO_LINK
  // against an invoice that also captured the same code (§A.4) — without it
  // every settlement falls into the review band on descriptor+amount+date
  // alone. Real Indian bank exports print this column under any of these
  // names depending on the rail (NEFT/RTGS: UTR; card: RRN/auth code; UPI:
  // UPI Ref No).
  reference: ["ref no", "reference", "reference no", "utr", "utr no", "rrn", "cheque no", "upi ref no", "chq/ref no"],
};

function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[.:*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyColumn(header: string): string | null {
  const norm = normaliseHeader(header);
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(norm)) return field;
  }
  return null;
}

/** Parse "1,42,356.28" or "142356.28" or "-643.72" into integer minor units. Never a float. */
function parseAmountToMinor(raw: string): number | null {
  const cleaned = raw.replace(/[₹$,\s]/g, "").trim();
  if (!cleaned) return null;
  const neg = /^\(.*\)$/.test(cleaned) || cleaned.startsWith("-");
  const stripped = cleaned.replace(/^[-(]|[)]$/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) return null;
  const [whole, frac = ""] = stripped.split(".");
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, "0").slice(0, 2));
  return neg ? -minor : minor;
}

/** DD-MM-YYYY (the jurisdiction's stated input format) or DD/MM/YYYY -> ISO. */
function parseDateToIso(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = `20${y}`;
  const dd = d.padStart(2, "0");
  const mm = mo.padStart(2, "0");
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${y}-${mm}-${dd}`;
}

/**
 * Split a GFM pipe-table into header + data rows. Tolerates a leading/
 * trailing pipe and the `---` separator row AnyDoc always emits.
 */
function splitTableRows(markdown: string): { header: string[]; rows: string[][] } | null {
  const lines = markdown.split("\n").map((l) => l.trim());
  const tableStart = lines.findIndex((l) => l.startsWith("|") && l.endsWith("|"));
  if (tableStart === -1) return null;

  const cells = (line: string): string[] =>
    line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());

  const header = cells(lines[tableStart]);
  // The separator row ("|---|---|...") always follows the header in GFM.
  let dataStart = tableStart + 1;
  if (lines[dataStart] && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[dataStart])) {
    dataStart++;
  }

  const rows: string[][] = [];
  for (let i = dataStart; i < lines.length; i++) {
    const l = lines[i];
    if (!l.startsWith("|") || !l.endsWith("|")) break; // table ended
    rows.push(cells(l));
  }
  if (rows.length === 0) return null;
  return { header, rows };
}

/**
 * Deterministic parse of a statement's markdown into staged lines.
 *
 * Never AI. Returns column_mapping_confident=false rather than guessing when
 * the header row does not resolve — the caller decides whether to fall back
 * to AI-assisted mapping (statements-ai.ts) or flag for human review.
 */
export function parseStatementMarkdown(markdown: string, jurisdictionCurrency = "INR"): ParsedStatement {
  const table = splitTableRows(markdown);
  const header: ParsedStatementHeader = {
    institution: null,
    account_ref: null,
    period_from: null,
    period_to: null,
    opening_balance_minor: null,
    closing_balance_minor: null,
    currency: jurisdictionCurrency,
  };

  // Header metadata (institution, account, period, opening balance) is prose
  // above the table, not part of it — pulled with narrow, specific patterns
  // rather than a generic "first line" guess, which is exactly the kind of
  // heuristic that silently mis-reads a differently laid-out bank export.
  // Account numbers are usually masked with leading X's/asterisks and only
  // the trailing digits are real — "XXXX-XXXX-9876" should extract "9876",
  // not the leading masked block. Anchor on the LAST run of digits.
  const acctMatch = markdown.match(/account\s*(?:no\.?|number|ref)?\s*[:\-]?\s*[\dXx\-]*?(\d{4,})(?!\d)/i);
  if (acctMatch) header.account_ref = acctMatch[1];
  const periodMatch = markdown.match(
    /(?:statement\s*period|period)\s*[:\-]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\s*(?:to|-)\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})/i,
  );
  if (periodMatch) {
    header.period_from = parseDateToIso(periodMatch[1]);
    header.period_to = parseDateToIso(periodMatch[2]);
  }
  const openingMatch = markdown.match(/opening\s*balance\s*[:\-]?\s*(?:rs\.?|inr|₹)?\s*([\d,.\-()]+)/i);
  if (openingMatch) header.opening_balance_minor = parseAmountToMinor(openingMatch[1]);
  const closingMatch = markdown.match(/closing\s*balance\s*[:\-]?\s*(?:rs\.?|inr|₹)?\s*([\d,.\-()]+)/i);
  if (closingMatch) header.closing_balance_minor = parseAmountToMinor(closingMatch[1]);

  if (!table) {
    return { header, lines: [], unmapped_columns: [], column_mapping_confident: false };
  }

  const colMap = new Map<number, string>();
  const unmapped: string[] = [];
  table.header.forEach((h, i) => {
    const field = classifyColumn(h);
    if (field) colMap.set(i, field);
    else if (h) unmapped.push(h);
  });

  const hasDate = [...colMap.values()].includes("date");
  const hasDescriptor = [...colMap.values()].includes("descriptor");
  const hasAmountSignal =
    [...colMap.values()].includes("debit") ||
    [...colMap.values()].includes("credit") ||
    [...colMap.values()].includes("amount");
  const confident = hasDate && hasDescriptor && hasAmountSignal;

  if (!confident) {
    return { header, lines: [], unmapped_columns: unmapped, column_mapping_confident: false };
  }

  const lines: StatementLineExtraction[] = [];
  table.rows.forEach((row, idx) => {
    const get = (field: string): string | undefined => {
      for (const [i, f] of colMap) if (f === field) return row[i];
      return undefined;
    };

    const dateRaw = get("date");
    const descriptor = get("descriptor");
    if (!dateRaw && !descriptor) return; // a stray blank/footer row inside the table

    const occurred_at = dateRaw ? parseDateToIso(dateRaw) : null;

    let amount_minor: number | null = null;
    let direction: "out" | "in" | null = null;

    const debitRaw = get("debit");
    const creditRaw = get("credit");
    if (debitRaw && parseAmountToMinor(debitRaw)) {
      amount_minor = Math.abs(parseAmountToMinor(debitRaw)!);
      direction = "out";
    } else if (creditRaw && parseAmountToMinor(creditRaw)) {
      amount_minor = Math.abs(parseAmountToMinor(creditRaw)!);
      direction = "in";
    } else {
      const amtRaw = get("amount");
      if (amtRaw) {
        const parsed = parseAmountToMinor(amtRaw);
        if (parsed !== null) {
          amount_minor = Math.abs(parsed);
          const dirRaw = get("direction");
          if (dirRaw) {
            direction = /^(dr|debit|d)$/i.test(dirRaw.trim()) ? "out" : "in";
          } else {
            direction = parsed < 0 ? "out" : "in";
          }
        }
      }
    }

    if (amount_minor === null || direction === null || !descriptor) return; // unusable row, skip rather than invent

    const balRaw = get("balance");
    const balance_after_minor = balRaw ? parseAmountToMinor(balRaw) : null;
    const reference_id = get("reference")?.trim() || null;

    lines.push({
      line_no: idx + 1,
      occurred_at,
      raw_descriptor: descriptor,
      amount_minor,
      direction,
      balance_after_minor: balance_after_minor ?? undefined,
      currency: jurisdictionCurrency,
      reference_id,
    });
  });

  return { header, lines, unmapped_columns: unmapped, column_mapping_confident: confident };
}

/**
 * Integrity check (§A.5). sum(lines, signed) must equal closing − opening.
 * Returns null when either balance is missing — nothing to check against.
 */
export function checkBalanceIntegrity(
  header: ParsedStatementHeader,
  lines: StatementLineExtraction[],
): { ok: boolean; expected: number; actual: number; delta: number } | null {
  if (header.opening_balance_minor === null || header.closing_balance_minor === null) return null;
  const signedSum = lines.reduce(
    (acc, l) => acc + (l.direction === "in" ? l.amount_minor : -l.amount_minor),
    0,
  );
  const expected = header.closing_balance_minor - header.opening_balance_minor;
  const delta = signedSum - expected;
  return { ok: delta === 0, expected, actual: signedSum, delta };
}

/**
 * Idempotency key for one statement line (§A.3): (account, date, amount,
 * normalised descriptor). Re-importing the same statement, or an overlapping
 * month from a second statement, must stage nothing twice.
 */
export function lineIdempotencyKey(
  accountEntityId: string | null,
  occurredAt: string | null,
  amountMinor: number,
  direction: "out" | "in",
  descriptor: string,
): string {
  const normDesc = descriptor.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return [accountEntityId ?? "?", occurredAt ?? "?", amountMinor, direction, normDesc].join("|");
}

/**
 * §A.4 — reconcile one staged line against the ledger, exactly as the matcher
 * already does for any other document. A statement line becomes a synthetic,
 * minimal ExtractionResult so findMatches()/linkEvidence()/recordTransaction()
 * — already tested, already the single source of matching truth — run
 * unmodified rather than duplicating their scoring logic here.
 *
 *   score >= AUTO_LINK    line SETTLES an existing invoice-only transaction;
 *                         it graduates out of 'awaiting_settlement'.
 *   score >= REVIEW_FLOOR review queue (handled by the caller: same as any
 *                         other MatchProposed event).
 *   score <  REVIEW_FLOOR NEW transaction, evidence_role='statement_line',
 *                         status left as ledger.ts sets it. This case IS the
 *                         gap report: a card charge with no invoice on file.
 */
export function reconcileStagedLine(
  db: DatabaseSync,
  ports: Ports,
  lineId: string,
): { outcome: "linked" | "created" | "review" | "skipped"; transaction_id: string | null; score?: number } {
  const row = db
    .prepare("SELECT * FROM statement_lines WHERE id=?")
    .get(lineId) as
    | {
        id: string;
        document_id: string;
        occurred_at: string | null;
        raw_descriptor: string;
        amount_minor: number;
        direction: "out" | "in";
        currency: string;
        status: string;
        reference_id: string | null;
      }
    | undefined;
  if (!row) throw new Error(`statement line ${lineId} not found`);
  if (row.status !== "pending") {
    return { outcome: "skipped", transaction_id: null };
  }

  // A synthetic extraction carrying just enough for the matcher and the
  // ledger writer: amount/currency/date/direction/descriptor. Settlement
  // documents are decisive per the resolver's role-class precedence (work
  // order 03), so evidence_role must resolve to 'statement_line', which is
  // already in claims.ts's SETTLEMENT_ROLES.
  const synthetic: ExtractionResult = {
    doc_type: "statement_line",
    occurred_at: row.occurred_at,
    posted_at: row.occurred_at,
    amount_minor: row.amount_minor,
    currency: row.currency,
    direction: row.direction,
    payment_rail: null,
    // Person/counterparty resolution is deliberately NOT threaded through
    // synthetic parties here — recordTransaction() resolves the counterparty
    // from counterparty_descriptor via its own entity-resolution path exactly
    // as it does for a bank_slip/card_confirmation document, so no fabricated
    // party is needed just to satisfy the shape.
    parties: [],
    // A reference id on the statement line is a STRONG_KEYS match for
    // matcher.ts — printed under whatever label the invoice used (order_no,
    // approval_code, utr, ...), so it is offered under all of them; matcher.ts
    // also checks cross-key overlap via its own reference_ids values, which
    // covers the case where the labels genuinely differ.
    reference_ids: row.reference_id
      ? {
          utr: row.reference_id,
          approval_code: row.reference_id,
          auth_code: row.reference_id,
          order_no: row.reference_id,
        }
      : {},
    counterparty_descriptor: row.raw_descriptor,
    source_of_funds_text: null,
    destination_of_funds_text: null,
    purpose_text: row.raw_descriptor,
    category_hint: null,
    is_wallet_topup: false,
    confidence: 0.9, // statement lines are settlement-grade, not a guess
    notes: null,
  };

  const candidates = findMatches(db, synthetic, row.document_id);
  const best = candidates[0];

  if (best && best.score >= AUTO_LINK) {
    linkEvidence(db, ports, best.transaction_id, row.document_id, synthetic, best.score);
    db.prepare("UPDATE statement_lines SET status='linked', transaction_id=? WHERE id=?").run(
      best.transaction_id,
      lineId,
    );
    return { outcome: "linked", transaction_id: best.transaction_id, score: best.score };
  }

  if (best && best.score >= REVIEW_FLOOR) {
    ports.bus.publish({
      type: "MatchProposed",
      transaction_id: best.transaction_id,
      document_id: row.document_id,
      score: best.score,
      at: ports.clock.isoNow(),
    });
    // Left 'pending' — a human decides via the review queue, same as any
    // other ambiguous match. Re-running reconciliation later is safe: the
    // idempotency key means nothing is created twice regardless.
    return { outcome: "review", transaction_id: best.transaction_id, score: best.score };
  }

  // No match at all: this IS the gap the work order calls the point of the
  // exercise. Promote to a new transaction with no invoice on file.
  const rec = recordTransaction(db, ports, row.document_id, synthetic);
  if (!rec) {
    return { outcome: "skipped", transaction_id: null };
  }
  db.prepare("UPDATE transactions SET status='no_invoice' WHERE id=?").run(rec.transaction_id);
  db.prepare("UPDATE statement_lines SET status='created', transaction_id=? WHERE id=?").run(
    rec.transaction_id,
    lineId,
  );
  return { outcome: "created", transaction_id: rec.transaction_id };
}

/** Reconcile every still-pending line staged from one document, in line order. */
export function reconcileStatement(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
): { linked: number; created: number; review: number } {
  const pending = db
    .prepare("SELECT id FROM statement_lines WHERE document_id=? AND status='pending' ORDER BY line_no")
    .all(documentId) as { id: string }[];

  const totals = { linked: 0, created: 0, review: 0 };
  for (const { id } of pending) {
    const r = reconcileStagedLine(db, ports, id);
    if (r.outcome === "linked") totals.linked++;
    else if (r.outcome === "created") totals.created++;
    else if (r.outcome === "review") totals.review++;
  }
  return totals;
}

/**
 * Stage a parsed statement's lines into statement_lines. Idempotent by
 * construction: INSERT OR IGNORE on the UNIQUE idempotency_key means a
 * second import of the same file, or an overlapping statement, inserts
 * nothing new for lines already staged.
 *
 * Returns how many lines were newly staged vs already present, so the UI
 * summary card (§A.6) can report "N lines read, K already known" honestly.
 */
export function stageStatementLines(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  parsed: ParsedStatement,
  accountEntityId: string | null,
): { staged: number; already_present: number } {
  const now = ports.clock.isoNow();
  let staged = 0;
  let already_present = 0;

  for (const line of parsed.lines) {
    const key = lineIdempotencyKey(
      accountEntityId,
      line.occurred_at,
      line.amount_minor,
      line.direction,
      line.raw_descriptor,
    );
    const existing = db.prepare("SELECT id FROM statement_lines WHERE idempotency_key=?").get(key);
    if (existing) {
      already_present++;
      continue;
    }
    const id = newId("stln");
    db.prepare(
      `INSERT INTO statement_lines
        (id, document_id, line_no, occurred_at, raw_descriptor, amount_minor, direction,
         balance_after_minor, currency, fx_original_json, reference_id, status, account_entity_id,
         idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
    ).run(
      id,
      documentId,
      line.line_no,
      line.occurred_at,
      line.raw_descriptor,
      line.amount_minor,
      line.direction,
      line.balance_after_minor ?? null,
      line.currency ?? parsed.header.currency,
      line.fx_original ? JSON.stringify(line.fx_original) : null,
      line.reference_id ?? null,
      accountEntityId,
      key,
      now,
    );
    staged++;
  }

  ports.logger.info("statement staged", { document_id: documentId, staged, already_present });
  return { staged, already_present };
}
