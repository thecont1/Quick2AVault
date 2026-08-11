/**
 * Reconciliation matcher (plan §4) — the money shot.
 *
 * When a second document describes a payment we already recorded (invoice +
 * card alert), we must produce ONE transaction with TWO evidence rows, not two
 * transactions. This is the double-count the whole project exists to kill.
 *
 * Scoring is hand-tuned at launch; corrections feed learned_rules later.
 *   >= 0.90  auto-link (logged, undoable)
 *   0.60-0.90 review queue
 *   <  0.60  separate transactions
 */
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { normaliseDescriptor } from "./schema.js";
import type { ExtractionResult } from "./extraction-contract.js";
import { evidenceRole } from "./ledger.js";

export const AUTO_LINK = 0.9;
export const REVIEW_FLOOR = 0.6;

export interface MatchCandidate {
  transaction_id: string;
  score: number;
  reasons: string[];
}

interface TxnRow {
  id: string;
  occurred_at: string;
  amount_minor: number;
  currency: string | null;
  direction: string;
  counterparty_name: string | null;
}

/** Reference IDs that identify one payment across two documents. */
const STRONG_KEYS = ["approval_code", "auth_code", "utr", "order_no", "order_id", "invoice_no", "wallet_ref", "wallet_txn_ref"];

/**
 * Score an extraction against existing transactions.
 * Signals: amount, date window (rail-aware), descriptor, source of funds,
 * and shared reference IDs — the last being near-decisive.
 */
export function findMatches(db: DatabaseSync, x: ExtractionResult, excludeDocId: string): MatchCandidate[] {
  if (x.amount_minor === null) return [];

  // Currency is a PRE-FILTER, but a nullable one (work order 05 §A.2): a
  // document that does not state a currency must still be allowed to match —
  // the amount+date+reference signals carry the score — while two KNOWN but
  // different currencies are never the same payment. INR is no longer
  // assumed for a missing currency.
  const rows = db
    .prepare(
      `SELECT t.id, t.occurred_at, t.amount_minor, t.currency, t.direction,
              e.display_name AS counterparty_name
       FROM transactions t
       LEFT JOIN entities e ON e.id = t.counterparty_entity_id
       WHERE t.amount_minor = ?
         AND (t.currency = ? OR t.currency IS NULL OR ? IS NULL)`,
    )
    .all(x.amount_minor, x.currency || null, x.currency || null) as unknown as TxnRow[];

  const out: MatchCandidate[] = [];

  for (const t of rows) {
    // A transfer and a purchase are never the same event, even for equal amounts.
    const xIsTransfer = x.is_wallet_topup || x.direction === "transfer";
    const tIsTransfer = t.direction === "transfer";
    if (xIsTransfer !== tIsTransfer) continue;

    // Don't link a document to a transaction it already evidences.
    const already = db
      .prepare("SELECT 1 FROM transaction_documents WHERE transaction_id=? AND document_id=?")
      .get(t.id, excludeDocId);
    if (already) continue;

    const reasons: string[] = [];
    let score = 0;

    // Amount is a prefilter above, so an exact match is assumed — but it is
    // still the largest single signal.
    score += 0.4;
    reasons.push(`amount exact ${(x.amount_minor / 100).toFixed(2)}`);

    // Date window: cards settle 0-3 days after the economic date, UPI 0-1.
    const xd = x.occurred_at ? Date.parse(x.occurred_at) : NaN;
    const td = Date.parse(t.occurred_at);
    if (Number.isFinite(xd) && Number.isFinite(td)) {
      const days = Math.abs(xd - td) / 86400000;
      const window = x.payment_rail === "card" ? 3 : 1;
      if (days === 0) {
        score += 0.25;
        reasons.push("same date");
      } else if (days <= window) {
        score += 0.15;
        reasons.push(`within ${days}d settlement window`);
      } else if (days > 7) {
        score -= 0.3;
        reasons.push(`${days}d apart`);
      }
    }

    // Reference IDs — decisive when shared. An approval code appearing on both
    // a merchant invoice and a bank alert is the same authorisation.
    const docRefs = db
      .prepare(
        `SELECT d.extraction_json FROM transaction_documents td
         JOIN documents d ON d.id = td.document_id
         WHERE td.transaction_id = ?`,
      )
      .all(t.id) as { extraction_json: string | null }[];

    let sharedKey: string | null = null;
    for (const r of docRefs) {
      if (!r.extraction_json) continue;
      let prior: ExtractionResult;
      try {
        prior = JSON.parse(r.extraction_json) as ExtractionResult;
      } catch {
        continue;
      }
      for (const k of STRONG_KEYS) {
        const a = normRef(x.reference_ids?.[k]);
        const b = normRef(prior.reference_ids?.[k]);
        if (a && b && a === b) {
          sharedKey = `${k}=${a}`;
          break;
        }
      }
      // Cross-key: an order number recorded under a different label still matches.
      if (!sharedKey) {
        const mine = new Set(Object.values(x.reference_ids ?? {}).map(normRef).filter(Boolean) as string[]);
        for (const v of Object.values(prior.reference_ids ?? {})) {
          const n = normRef(v);
          if (n && n.length >= 6 && mine.has(n)) {
            sharedKey = `shared ref ${n}`;
            break;
          }
        }
      }
      if (sharedKey) break;
    }
    if (sharedKey) {
      score += 0.35;
      reasons.push(sharedKey);
    }

    // Counterparty descriptor, normalised: "SWIGGY*BLR 080" -> "swiggy"
    const xName = normaliseDescriptor(x.counterparty_descriptor ?? "");
    const tName = normaliseDescriptor(t.counterparty_name ?? "");
    if (xName && tName) {
      if (xName === tName) {
        score += 0.15;
        reasons.push(`descriptor "${xName}"`);
      } else if (xName.includes(tName) || tName.includes(xName)) {
        score += 0.1;
        reasons.push(`descriptor overlap "${xName}"~"${tName}"`);
      }
    }

    out.push({ transaction_id: t.id, score: Math.min(1, Math.max(0, score)), reasons });
  }

  return out.sort((a, b) => b.score - a.score);
}

function normRef(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/[^a-z0-9]/g, "");
  return s.length >= 4 ? s : null;
}

/**
 * Attach a document to an existing transaction as additional evidence.
 * Many documents, one rupee.
 */
export function linkEvidence(
  db: DatabaseSync,
  ports: Pick<Ports, "clock" | "bus" | "logger">,
  transactionId: string,
  documentId: string,
  x: ExtractionResult,
  score: number,
  linkedBy: string = "matcher",
): boolean {
  const now = ports.clock.isoNow();
  const info = db.prepare(
    `INSERT OR IGNORE INTO transaction_documents
      (transaction_id, document_id, evidence_role, match_score, linked_by, linked_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(transactionId, documentId, evidenceRole(x), score, linkedBy, now);

  const inserted = Number(info.changes ?? 0) > 0;

  if (inserted) {
    // A card confirmation proves settlement; an invoice alone does not.
    if (x.doc_type === "card_confirmation" || x.doc_type === "bank_slip") {
      db.prepare("UPDATE transactions SET status='evidenced', posted_at=COALESCE(posted_at,?) WHERE id=?")
        .run(x.occurred_at ?? null, transactionId);
    }

    ports.bus.publish({
      type: "MatchProposed",
      transaction_id: transactionId,
      document_id: documentId,
      score,
      at: now,
    });
    ports.logger.info("evidence linked", { transactionId, documentId, score: score.toFixed(2), linkedBy });
  }
  return inserted;
}
