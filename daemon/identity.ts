/**
 * Person identity resolution (work order 04, Track D).
 *
 * Goal: a person is ONE entity however they appear — "Mahesh Shantaram",
 * "SHANTARAM MAHESH", "ms@thecontrarian.in", "techrose@gmail.com" all resolve
 * to the same canonical person, silently once known.
 *
 * ledger.ts already has kind-scoped name resolution (exact, alias, token-sort)
 * for every entity kind. This module adds the PERSON-specific identity layer
 * on top: typed identifiers (email/phone match exact, not fuzzy), a fuzzy
 * name band that asks instead of silently merging weak evidence, and
 * co-occurrence learning that teaches an unfamiliar identifier from a single
 * confirmation rather than re-asking every time it recurs.
 *
 * Resolution order (§D.2), most confident first:
 *   1. Exact identifier (email/phone) → link silently
 *   2. Exact normalised alias → silent
 *   3. Token-sorted name equality (kind='person' only) → silent
 *   4. Fuzzy band → Learning question (novelty trigger, budgeted)
 *   5. No match → create candidate person; Learning may ask
 *
 * Every confirmation writes an alias, so a lesson learned once is never
 * re-asked — the same principle the rest of the curiosity engine follows.
 */
import * as crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { Ports } from "./ports.js";
import { normaliseName } from "./schema.js";
import { ask, applyRule } from "./learning.js";

const newId = (p: string) => `${p}_${crypto.randomBytes(8).toString("hex")}`;

export type IdentifierType = "email" | "phone" | "handle";

/** Classify a raw identifier string. Anything else is not identity-bearing. */
export function classifyIdentifier(raw: string): IdentifierType | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "email";
  // Indian mobile: optional +91/0 prefix, 10 digits. Deliberately narrow —
  // a false positive here would treat an account number or a reference id
  // as a phone number and start matching people on it.
  const digits = v.replace(/[^\d]/g, "");
  if (/^(\+?91|0)?\d{10}$/.test(v.replace(/[\s-]/g, "")) && digits.length >= 10 && digits.length <= 12) {
    return "phone";
  }
  // UPI handles and @-prefixed usernames, e.g. "mahesh@okhdfcbank" is
  // actually a payment handle, not an email — the '@' domain does not look
  // like a DNS name (no dot). Kept distinct from email precisely so a UPI
  // handle is never treated as an email address.
  if (/^[^\s@]+@[^\s@.]+$/.test(v)) return "handle";
  return null;
}

/** Comparable form for exact identifier matching. */
export function normaliseIdentifier(type: IdentifierType, raw: string): string {
  if (type === "phone") return raw.replace(/[^\d]/g, "").replace(/^91/, "").replace(/^0/, "");
  return raw.trim().toLowerCase();
}

// Generic mailboxes name a FUNCTION at an organisation, not a human, however
// the extractor classified the party. Linking one to a person would let
// "billing@swiggy.com" silently attach to whichever person account it first
// appears against — and the SAME generic address recurs across countless
// unrelated organisations, so it would eventually merge unrelated people too.
const GENERIC_MAILBOX = /^(billing|orders?|no-?reply|noreply|support|contact|info|hello|accounts?|admin|sales|help|service|care|feedback|notifications?)@/i;

export function isGenericMailbox(email: string): boolean {
  return GENERIC_MAILBOX.test(email.trim());
}

/** Normalised, filtered token set for overlap scoring (mirrors ledger.ts's token-sort). */
function tokens(s: string): string[] {
  return normaliseName(s)
    .split(" ")
    .filter((t) => t.length > 1);
}

/**
 * Jaccard overlap of name tokens, 0..1. Token-sort equality (ledger.ts step 3)
 * is the ratio-1.0 case; this scores everything below that.
 *
 * "Mahesh" vs "Mahesh Shantaram" → 1 shared / 2 union = 0.5 (fuzzy band).
 * "M Shantaram" vs "Mahesh Shantaram" → 1/2 shared token ("shantaram") = 0.5.
 * "Alice" vs "Bob" → 0 (no match at all).
 */
export function tokenOverlapRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : shared / union;
}

/** Lower bound (inclusive) of the fuzzy band. Below this, treat as no match. */
const FUZZY_FLOOR = 0.34;
/** Upper bound (exclusive) — at/above this, token-sort (ledger.ts) already matched silently. */
const FUZZY_CEIL = 1.0;

export interface PersonResolution {
  id: string;
  /** How the id was reached, for logging and for the acceptance tests. */
  matched_via: "identifier" | "alias" | "token_sort" | "fuzzy_question" | "created";
  /** A Learning question was raised (fuzzy band, co-occurrence, or a shared-identifier conflict). */
  asked: boolean;
  /** A shared identifier pointed at TWO different confirmed people — never auto-merged. */
  conflict: boolean;
}

type PersonRow = { id: string; display_name: string; status: string };

function findByExactIdentifier(
  db: DatabaseSync,
  type: IdentifierType,
  norm: string,
): { entity_id: string } | undefined {
  return db
    .prepare(
      "SELECT entity_id FROM entity_aliases WHERE kind='person' AND alias_type=? AND normalised=?",
    )
    .get(type, norm) as { entity_id: string } | undefined;
}

function writeAlias(
  db: DatabaseSync,
  ports: Ports,
  entityId: string,
  alias: string,
  normalised: string,
  type: IdentifierType | "name_variant",
  source: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, created_at)
     VALUES (?, 'person', ?, ?, ?, ?, ?)`,
  ).run(entityId, alias, normalised, type, source, ports.clock.isoNow());
}

/**
 * Look up a taught identifier→person rule directly, bypassing applyRule().
 *
 * applyRule() always runs the key through normaliseName() before comparing —
 * correct for name-shaped keys (idempotent: re-normalising an already
 * normalised name is a no-op), but WRONG for an identifier: normaliseName
 * strips '@' and '.', so "techrose@gmail.com" becomes "techrose gmail com"
 * and never matches the literal key the rule was stored under. Identifier
 * rules are keyed on normaliseIdentifier()'s form instead, and looked up the
 * same way every time.
 */
function appliedIdentifierRule(
  db: DatabaseSync,
  ports: Ports,
  idNorm: string,
  matchKind: "person_identifier",
): string | null {
  const rule = db
    .prepare(
      `SELECT id, value FROM learned_rules
       WHERE kind='entity_alias' AND match_key=? AND match_kind=? AND active=1`,
    )
    .get(idNorm, matchKind) as { id: number; value: string } | undefined;
  if (!rule) return null;
  db.prepare("UPDATE learned_rules SET times_applied=times_applied+1, last_applied_at=? WHERE id=?").run(
    ports.clock.isoNow(),
    rule.id,
  );
  return rule.value;
}

/**
 * Resolve one extracted person party to a canonical entity, applying the
 * full §D.2 order. Always returns an id — even the fuzzy-question path
 * creates a candidate immediately (a document still needs SOMEWHERE to
 * attach), it just also raises a question the user can answer to merge it.
 */
export function resolvePerson(
  db: DatabaseSync,
  ports: Ports,
  name: string,
  identifiers: Record<string, string> | undefined,
  documentId: string,
  subtype?: string,
): PersonResolution {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("cannot resolve an empty person name");
  const norm = normaliseName(trimmed);
  const idValues = Object.values(identifiers ?? {}).filter(Boolean);

  // ── 1. exact identifier (email/phone/handle) ──────────────────────────────
  for (const raw of idValues) {
    const type = classifyIdentifier(raw);
    if (!type) continue;
    // A generic mailbox never identifies a specific human — it is a function
    // at an organisation, and skipping it here is what stops "billing@" from
    // silently welding together every person who ever used that vendor.
    if (type === "email" && isGenericMailbox(raw)) continue;

    const idNorm = normaliseIdentifier(type, raw);
    const hit = findByExactIdentifier(db, type, idNorm);
    if (!hit) continue;

    // Shared-identifier conflict: this identifier is already bound to person
    // E, but the NAME on this document, on its own deterministic merits
    // (exact or token-sort), points at a DIFFERENT confirmed person. Family
    // members share email addresses and phones — silently accepting the
    // identifier match would merge two real, distinct people. Ask instead.
    const nameMatch = findDeterministicNameMatch(db, trimmed, norm);
    if (nameMatch && nameMatch.id !== hit.entity_id) {
      const boundPerson = db
        .prepare("SELECT display_name, status FROM entities WHERE id=?")
        .get(hit.entity_id) as { display_name: string; status: string } | undefined;
      if (boundPerson?.status === "confirmed" && nameMatch.status === "confirmed") {
        ask(db, ports, {
          trigger: "shared_identifier_conflict",
          question: `"${raw}" is on file for ${boundPerson.display_name}, but this document names ${nameMatch.display_name}. Same identifier, different person — who does it belong to here?`,
          context: {
            document_id: documentId,
            identifier: raw,
            identifier_type: type,
            bound_to: hit.entity_id,
            named_as: nameMatch.id,
          },
          options: [boundPerson.display_name, nameMatch.display_name, "Someone else"],
        });
        // Do not silently pick a side. Attach to the deterministic name match
        // for THIS document (never invent a merge), and let the question
        // resolve the identifier's true owner later.
        writeAlias(db, ports, nameMatch.id, trimmed, norm, "name_variant", "auto");
        return { id: nameMatch.id, matched_via: "alias", asked: true, conflict: true };
      }
    }

    writeAlias(db, ports, hit.entity_id, trimmed, norm, "name_variant", "auto-identifier");
    return { id: hit.entity_id, matched_via: "identifier", asked: false, conflict: false };
  }

  // ── 2 & 3. exact normalised alias, then token-sorted name ─────────────────
  const deterministic = findDeterministicNameMatch(db, trimmed, norm);
  if (deterministic) {
    // §D.3 co-occurrence learning: this document pairs a KNOWN person with
    // an identifier the vault has never seen for anyone. Only co-occurrence
    // can teach it — "techrose@gmail.com" shares zero tokens with "Mahesh
    // Shantaram". Propose it via ONE confirmation; silent thereafter because
    // the confirmed answer writes the alias, and step 1 above matches on it
    // from then on.
    for (const raw of idValues) {
      const type = classifyIdentifier(raw);
      if (!type || (type === "email" && isGenericMailbox(raw))) continue;
      const idNorm = normaliseIdentifier(type, raw);
      if (findByExactIdentifier(db, type, idNorm)) continue; // already known, nothing to teach

      const learned = appliedIdentifierRule(db, ports, idNorm, "person_identifier");
      if (learned === deterministic.id) {
        // Already taught and confirmed for this exact pair — apply silently.
        writeAlias(db, ports, deterministic.id, raw, idNorm, type, "learned");
        continue;
      }
      ask(db, ports, {
        trigger: "identifier_cooccurrence",
        question: `This document also lists "${raw}" for ${deterministic.display_name}. Save it as theirs?`,
        context: {
          document_id: documentId,
          identifier: raw,
          identifier_type: type,
          entity_id: deterministic.id,
          // The NORMALISED form, so the client's answer round-trips the
          // exact key appliedIdentifierRule() looks up by — sending the raw
          // string back would silently fail to match on the next occurrence.
          identifier_match_key: idNorm,
        },
        options: ["Yes, save it", "No, not theirs"],
      });
    }
    return { id: deterministic.id, matched_via: deterministic.via, asked: false, conflict: false };
  }

  // ── 4. fuzzy band ──────────────────────────────────────────────────────────
  const candidates = (
    db.prepare("SELECT id, display_name, status FROM entities WHERE kind='person'").all() as PersonRow[]
  )
    .map((e) => ({ ...e, score: tokenOverlapRatio(trimmed, e.display_name) }))
    .filter((e) => e.score >= FUZZY_FLOOR && e.score < FUZZY_CEIL)
    .sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    const best = candidates[0];
    // A lesson learned once is never re-asked: if this exact pair was already
    // confirmed (either direction — "yes, same person" merges the alias in,
    // "no" is remembered as a standing rule too so the identical pair does
    // not keep re-surfacing), apply the standing answer silently.
    const taught = applyRule(db, ports, "entity_alias", norm, "person_fuzzy");
    if (taught === best.id) {
      writeAlias(db, ports, best.id, trimmed, norm, "name_variant", "learned-fuzzy");
      return { id: best.id, matched_via: "alias", asked: false, conflict: false };
    }
    if (taught === "SEPARATE") {
      // Taught as a distinct person — fall through to candidate creation.
    } else {
      const id = createCandidate(db, ports, trimmed, identifiers, subtype);
      ask(db, ports, {
        trigger: "person_identity_fuzzy",
        question: `Is "${trimmed}" the same person as ${best.display_name}?`,
        context: {
          document_id: documentId,
          candidate_entity_id: id,
          existing_entity_id: best.id,
          score: best.score,
          // The exact key applyRule looked up above — the client must send
          // this same string back as match_key or the taught rule silently
          // fails to be found on the next occurrence of this pair.
          fuzzy_match_key: norm,
        },
        options: [`Yes, same as ${best.display_name}`, "No, a different person"],
      });
      return { id, matched_via: "fuzzy_question", asked: true, conflict: false };
    }
  }

  // ── 5. no match — create a candidate ──────────────────────────────────────
  const id = createCandidate(db, ports, trimmed, identifiers, subtype);
  return { id, matched_via: "created", asked: false, conflict: false };
}

function findDeterministicNameMatch(
  db: DatabaseSync,
  name: string,
  norm: string,
): { id: string; display_name: string; status: string; via: "alias" | "token_sort" } | undefined {
  // 2. exact normalised alias (any type — a name_variant alias IS an exact
  //    match once normalised, so this also covers a previously-seen spelling).
  const viaAlias = db
    .prepare(
      "SELECT e.id, e.display_name, e.status FROM entity_aliases a JOIN entities e ON e.id=a.entity_id WHERE a.kind='person' AND a.normalised=?",
    )
    .get(norm) as { id: string; display_name: string; status: string } | undefined;
  if (viaAlias) return { ...viaAlias, via: "alias" };

  // Exact display_name match, case-insensitive.
  const direct = db
    .prepare("SELECT id, display_name, status FROM entities WHERE kind='person' AND lower(display_name)=lower(?)")
    .get(name) as { id: string; display_name: string; status: string } | undefined;
  if (direct) return { ...direct, via: "alias" };

  // 3. token-sorted equality — word order (surname-first statements) is the
  // single most common real-world variant.
  const sortedTokens = (s: string) => tokens(s).slice().sort().join(" ");
  const mine = sortedTokens(name);
  if (mine.length === 0) return undefined;
  const rows = db.prepare("SELECT id, display_name, status FROM entities WHERE kind='person'").all() as PersonRow[];
  for (const e of rows) {
    if (sortedTokens(e.display_name) === mine) return { ...e, via: "token_sort" };
  }
  return undefined;
}

function createCandidate(
  db: DatabaseSync,
  ports: Ports,
  name: string,
  identifiers: Record<string, string> | undefined,
  subtype?: string,
): string {
  const id = newId("ent");
  db.prepare(
    `INSERT INTO entities (id, kind, subtype, display_name, identifiers_json, confidence, status, created_at)
     VALUES (?, 'person', ?, ?, ?, 0.8, 'candidate', ?)`,
  ).run(id, subtype ?? null, name, identifiers ? JSON.stringify(identifiers) : null, ports.clock.isoNow());
  writeAlias(db, ports, id, name, normaliseName(name), "name_variant", "auto");

  // Identifiers carried on THIS SAME document are decisive from the start —
  // a fresh person who arrives with an email attached should resolve on that
  // email next time without waiting for a separate co-occurrence question.
  // Generic mailboxes are excluded for the same reason step 1 excludes them:
  // they name a function, not this specific human.
  for (const raw of Object.values(identifiers ?? {})) {
    const type = classifyIdentifier(raw);
    if (!type) continue;
    if (type === "email" && isGenericMailbox(raw)) continue;
    writeAlias(db, ports, id, raw, normaliseIdentifier(type, raw), type, "auto-identifier");
  }
  ports.logger.info("person candidate created", { id, name });
  return id;
}
