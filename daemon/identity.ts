/**
 * Person identity resolution (work order 04, Track D).
 *
 * Goal: a person is ONE entity however they appear — "Arun Kamath",
 * "KAMATH ARUN", "arun@example.com", "workmail@example.com" all resolve
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
  if (type === "phone") {
    const digits = raw.replace(/[^\d]/g, "");
    // Strip the country/Trunk prefix ONLY when the length says it is one:
    // 12 digits starting 91 = +91 mobile, 11 starting 0 = trunk-dialling
    // form. The naive "always strip a leading 91" corrupts a genuine
    // 10-digit mobile that happens to start with 91 into 8 digits, and two
    // different people would then collide on the mangled string.
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
    return digits;
  }
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
 * "Arun" vs "Arun Kamath" → 1 shared / 2 union = 0.5 (fuzzy band).
 * "A Kamath" vs "Arun Kamath" → 1/2 shared token ("kamath") = 0.5.
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
  matched_via: "identifier" | "alias" | "token_sort" | "fuzzy_question" | "created" | "unresolved";
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
  // Only CONFIRMED aliases resolve silently (work order 05 §B.4 step 1). A
  // proposed alias is a hypothesis awaiting one Learning confirmation; a
  // rejected one must never match again.
  return db
    .prepare(
      "SELECT entity_id FROM entity_aliases WHERE kind='person' AND alias_type=? AND normalised=? AND status='confirmed'",
    )
    .get(type, norm) as { entity_id: string } | undefined;
}

/**
 * Write an alias, honouring the lifecycle (work order 05 §B.2).
 *
 * Upsert semantics on the (kind, normalised) unique key: a re-observation
 * bumps last_seen_at rather than duplicating the row, and a stronger source
 * (user-taught or rule-learned) PROMOTES a proposed alias to confirmed. A
 * rejected alias is never resurrected — the user already said no.
 */
function writeAlias(
  db: DatabaseSync,
  ports: Ports,
  entityId: string,
  alias: string,
  normalised: string,
  type: IdentifierType | "name_variant",
  source: string,
  status: "proposed" | "confirmed" = "confirmed",
): void {
  const now = ports.clock.isoNow();
  const existing = db
    .prepare("SELECT id, entity_id, status FROM entity_aliases WHERE kind='person' AND normalised=?")
    .get(normalised) as { id: number; entity_id: string; status: string } | undefined;

  if (existing) {
    if (existing.status === "rejected") return; // a 'no' is durable
    if (existing.entity_id !== entityId) {
      // Two people claiming one identifier is a conflict the resolver asks
      // about; the writer never arbitrates it.
      return;
    }
    // The FIRST-SEEN spelling stays as the display alias — it is evidence,
    // and silently rewriting it would falsify the record of what documents
    // actually printed. Only the lifecycle fields move.
    db.prepare(
      `UPDATE entity_aliases SET last_seen_at=?,
         status = CASE WHEN ?='confirmed' AND status='proposed' THEN 'confirmed' ELSE status END
       WHERE id=?`,
    ).run(now, status, existing.id);
    return;
  }
  db.prepare(
    `INSERT INTO entity_aliases (entity_id, kind, alias, normalised, alias_type, source, status, created_at, last_seen_at)
     VALUES (?, 'person', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entityId, alias, normalised, type, source, status, now, now);
}

/**
 * Look up a taught identifier→person rule directly, bypassing applyRule().
 *
 * applyRule() always runs the key through normaliseName() before comparing —
 * correct for name-shaped keys (idempotent: re-normalising an already
 * normalised name is a no-op), but WRONG for an identifier: normaliseName
 * strips '@' and '.', so "workmail@example.com" becomes "workmail example com"
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

  // ── 0. the "name" is itself an identifier ─────────────────────────────────
  // A regression observed on a live vault: the extractor handed over
  // "arun@example.com" as a person NAME, and a second human called
  // "arun@example.com" was born next to the real Arun Kamath. An
  // email/phone/handle is never a name. If the identifier is known, link
  // silently; otherwise attach the document to the Unidentified placeholder
  // and ASK — one weak string must never mint a person (work order 05 §B.3).
  // classifyIdentifier anchors on the WHOLE string, so a hit here means the
  // "name" is exactly an email/phone/handle and nothing else. (Do NOT gate on
  // token counts: normaliseName mangles "arun@x.in" into name-like tokens, so a
  // token check never fires — that was the live regression.)
  const nameAsIdentifier = classifyIdentifier(trimmed);
  if (nameAsIdentifier) {
    if (!(nameAsIdentifier === "email" && isGenericMailbox(trimmed))) {
      const idNorm = normaliseIdentifier(nameAsIdentifier, trimmed);
      const hit = findByExactIdentifier(db, nameAsIdentifier, idNorm);
      if (hit) {
        return { id: hit.entity_id, matched_via: "identifier", asked: false, conflict: false };
      }
    }
    const placeholder = unidentifiedPerson(db, ports);
    ask(db, ports, {
      trigger: "unidentified_person",
      question: `A document names only "${trimmed}" — no human name. Who is this?`,
      context: {
        document_id: documentId,
        identifier: trimmed,
        identifier_type: nameAsIdentifier ?? "unknown",
        placeholder_entity_id: placeholder,
      },
      options: ["Assign to an existing person", "This is a new person", "Not a person"],
    });
    return { id: placeholder, matched_via: "unresolved", asked: true, conflict: false };
  }

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
    // can teach it — "workmail@example.com" shares zero tokens with "Arun
    // Kamath". Propose it via ONE confirmation; silent thereafter because
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
        // writeAlias promotes the proposed row (written when first asked) to
        // confirmed, so the question is never re-asked.
        writeAlias(db, ports, deterministic.id, raw, idNorm, type, "learned");
        continue;
      }
      // Record the observation as a PROPOSED alias before asking: the People
      // tab's unresolved-alias count and the alias editor read these rows,
      // and the evidence survives even if the question is never answered.
      // Proposed aliases never resolve silently (findByExactIdentifier).
      writeAlias(db, ports, deterministic.id, raw, idNorm, type, "auto-cooccurrence", "proposed");
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
      "SELECT e.id, e.display_name, e.status FROM entity_aliases a JOIN entities e ON e.id=a.entity_id WHERE a.kind='person' AND a.normalised=? AND a.status='confirmed'",
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

export const UNIDENTIFIED_PERSON_ID = "ent_unidentified_person";

/**
 * The placeholder person for documents that name no identifiable human.
 * Shared with api.ts's force-delete path, which reassigns evidence here too —
 * one well-known id, so "who is unattached?" is one WHERE clause.
 */
export function unidentifiedPerson(db: DatabaseSync, ports: Ports): string {
  const existing = db.prepare("SELECT 1 FROM entities WHERE id=?").get(UNIDENTIFIED_PERSON_ID);
  if (!existing) {
    db.prepare(
      `INSERT INTO entities (id, kind, display_name, status, confidence, is_member, created_at)
       VALUES (?, 'person', 'Unidentified', 'confirmed', 1.0, 0, ?)`,
    ).run(UNIDENTIFIED_PERSON_ID, ports.clock.isoNow());
  }
  return UNIDENTIFIED_PERSON_ID;
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

/**
 * Apply a user-confirmed person correction from Document Review
 * (work order 05 §Track C).
 *
 * The edit is DOCUMENT-SCOPED first: only this document's party link moves.
 * But the user's answer is also a confirmed fact about the person, so the
 * old printed spelling is retained as a CONFIRMED name_variant alias on the
 * corrected person — that is what makes the next document carrying the same
 * string resolve silently instead of being corrected again.
 *
 * The document's own extraction JSON and markdown are never touched; the
 * correction lives in document_parties + entity_aliases + field_claims.
 */
export function applyPersonCorrection(
  db: DatabaseSync,
  ports: Ports,
  documentId: string,
  correctedName: string,
  previousName?: string | null,
): { person_id: string; display_name: string; created: boolean; relinked: number } {
  const name = correctedName.trim();
  if (!name) throw new Error("cannot correct to an empty person name");

  // Resolve the TARGET deterministically — never fuzzy, never cross-kind.
  const norm = normaliseName(name);
  const target = findDeterministicNameMatch(db, name, norm);
  let personId: string;
  let created = false;
  if (target) {
    personId = target.id;
    // A user correction confirms the person too.
    db.prepare("UPDATE entities SET status='confirmed', updated_at=? WHERE id=?").run(
      ports.clock.isoNow(),
      personId,
    );
  } else {
    personId = newId("ent");
    db.prepare(
      `INSERT INTO entities (id, kind, display_name, confidence, status, is_member, created_at, updated_at)
       VALUES (?, 'person', ?, 1.0, 'confirmed', 0, ?, ?)`,
    ).run(personId, name, ports.clock.isoNow(), ports.clock.isoNow());
    writeAlias(db, ports, personId, name, norm, "name_variant", "user");
    created = true;
  }

  // Relink THIS document's person parties away from the previously-resolved
  // person. Only rows whose entity matches the previous name move — a
  // document naming two people keeps the other one untouched.
  let relinked = 0;
  if (previousName?.trim()) {
    const prevNorm = normaliseName(previousName);
    const prevRows = db
      .prepare(
        `SELECT dp.entity_id, dp.role FROM document_parties dp
           JOIN entities e ON e.id = dp.entity_id
         WHERE dp.document_id=? AND e.kind='person' AND e.id<>?
           AND (lower(e.display_name)=lower(?)
                OR EXISTS (SELECT 1 FROM entity_aliases a
                            WHERE a.entity_id=e.id AND a.kind='person' AND a.normalised=?))`,
      )
      .all(documentId, personId, previousName.trim(), prevNorm) as { entity_id: string; role: string }[];
    for (const r of prevRows) {
      db.prepare(
        "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?,?)",
      ).run(documentId, personId, r.role);
      db.prepare(
        "DELETE FROM document_parties WHERE document_id=? AND entity_id=? AND role=?",
      ).run(documentId, r.entity_id, r.role);
      relinked++;
    }
  } else {
    // No prior name known (field was empty): attach in the weakest role.
    db.prepare(
      "INSERT OR IGNORE INTO document_parties (document_id, entity_id, role) VALUES (?,?, 'owner')",
    ).run(documentId, personId);
  }

  // The old spelling is now KNOWN to name this person. Keep it as a
  // confirmed alias so re-analysis and future documents resolve silently.
  if (previousName?.trim() && normaliseName(previousName) !== norm) {
    const prevNorm = normaliseName(previousName);
    // The resolver may already have created a stray candidate carrying this
    // spelling (the fuzzy path does exactly that). A USER correction
    // outranks it: move the alias row to the confirmed person rather than
    // leaving the evidence stranded on the candidate. This is not a merge —
    // the stray entity and its other documents remain for explicit review.
    db.prepare(
      `UPDATE entity_aliases SET entity_id=?, status='confirmed', last_seen_at=?
       WHERE kind='person' AND normalised=? AND entity_id<>?`,
    ).run(personId, ports.clock.isoNow(), prevNorm, personId);
    writeAlias(db, ports, personId, previousName.trim(), prevNorm, "name_variant", "user");
  }

  ports.logger.info("person correction applied", {
    document_id: documentId,
    person_id: personId,
    created,
    relinked,
  });
  return { person_id: personId, display_name: name, created, relinked };
}
