/**
 * WO11 Track B — the document lifecycle contract, enforced in one place.
 *
 * The schema (documents.lifecycle) has three states: 'active' (visible),
 * 'removed' (soft-hidden; file and claims preserved), 'deleted' (bytes
 * unlinked, row tombstoned so sha256 dedup still holds). The contract says a
 * removed or deleted document stops contributing to every transaction-derived
 * surface — totals, treemaps, lists, holdings. Until now each endpoint decided
 * for itself (and most forgot). This module is the ONLY definition of what
 * counts as visible:
 *
 *   - isActive()              for a row already in memory
 *   - activeDocumentSql()     the same predicate as a SQL fragment
 *   - activeTransactionSql()  transaction-level visibility via its evidence
 *
 * Code-review rule (WO11 §8): any new query that touches transactions or
 * document_parties joins through here — never hand-write a lifecycle check.
 */
export const ACTIVE_LIFECYCLE_STATES = ["active"] as const;

export const isActive = (row: { lifecycle: string }): boolean =>
  (ACTIVE_LIFECYCLE_STATES as readonly string[]).includes(row.lifecycle);

/** SQL fragment: the lifecycle states a document row must be in to count. */
export function activeDocumentSql(alias: string): string {
  const states = ACTIVE_LIFECYCLE_STATES.map((s) => `'${s}'`).join(",");
  return `${alias}.lifecycle IN (${states})`;
}

/**
 * SQL predicate: a transaction survives lifecycle filtering iff it has NO
 * evidence rows at all (a manual or scheduled entry has nothing to hide
 * behind) or at least ONE evidence link backed by an active document. A
 * transaction whose evidence is entirely removed/deleted disappears from
 * totals and lists — that is the schema contract.
 */
export function activeTransactionSql(alias: string): string {
  return `(NOT EXISTS (SELECT 1 FROM transaction_documents td WHERE td.transaction_id = ${alias}.id)
        OR EXISTS (SELECT 1 FROM transaction_documents td
                   JOIN documents d ON d.id = td.document_id
                   WHERE td.transaction_id = ${alias}.id AND ${activeDocumentSql("d")}))`;
}
