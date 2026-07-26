/**
 * Canonical Person intelligence.
 *
 * A real person may appear across documents under several name variants
 * ("Mahesh Shantaram", "Shantaram Mahesh", "M. Shantaram"). This service
 * introduces a canonical Person entity with known aliases, semantic role(s),
 * confidence, and supporting evidence, and resolves raw extracted names onto it.
 *
 * Entity resolution matches a detected name against existing people using exact
 * alias match, reordered first/last names, and initials/shortened variants.
 * High-confidence matches link silently; uncertain ones create a candidate that
 * Training Mode can ask about. User-confirmed fields (name, roles, aliases) are
 * never overwritten by a later AI guess.
 *
 * Never throws — identity work is best-effort on top of an already-stored doc.
 */
import {
  addEvidence,
  canOverwrite,
  countPersons,
  deleteAlias,
  deletePerson,
  findAliasByNormalized,
  findPerson,
  getSnapshotCache,
  insertPerson,
  listAliases,
  listEvidence,
  listDocumentOverrides,
  listNameOverrides,
  listPersons,
  reassignAliases,
  reassignEvidence,
  setSelfPerson,
  updatePerson,
  upsertAlias,
  type FieldSource,
  type PersonAlias,
  type PersonEvidence,
  type PersonRecord,
  type PersonRole,
} from "./database.js";

// ── Name normalization ─────────────────────────────────────────────────────

/** Honorifics / titles that shouldn't affect identity matching. */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "shri", "smt", "sri", "sh", "m/s", "ms."]);

/** Lower-case, strip diacritics and punctuation, and collapse whitespace. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Significant name tokens (titles removed). */
function tokens(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t.length > 0 && !TITLES.has(t));
}

/** True when a and b are the same tokens in a different order (reordered name). */
function isReordered(a: string[], b: string[]): boolean {
  if (a.length < 2 || a.length !== b.length) return false;
  const sortedA = [...a].sort().join(" ");
  const sortedB = [...b].sort().join(" ");
  return sortedA === sortedB && a.join(" ") !== b.join(" ");
}

/**
 * True when one token list is an initials / shortened form of the other while
 * sharing the same final (family) token — e.g. "M Shantaram" ↔ "Mahesh Shantaram".
 */
function isInitialsVariant(a: string[], b: string[]): boolean {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return false;
  if (a[a.length - 1] !== b[b.length - 1]) return false;
  let shortened = false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x.startsWith(y) || y.startsWith(x)) {
      shortened = true;
      continue;
    }
    return false;
  }
  return shortened;
}

export type MatchKind = "matched_alias" | "reordered_name" | "initials";

export interface NameMatch {
  personId: number;
  matchedAlias: string;
  kind: MatchKind;
  score: number;
}

/** Confidence at/above which a detected name is auto-linked to an existing person. */
const AUTO_LINK_SCORE = 0.85;
/** Confidence at/above which we flag a *possible* duplicate for confirmation. */
const SUGGEST_SCORE = 0.6;

/** Best fuzzy match for a raw name among existing aliases, or null. */
export function matchName(rawName: string, aliases = listAliases()): NameMatch | null {
  const norm = normalizeName(rawName);
  if (!norm) return null;

  const exact = aliases.find((a) => a.normalized === norm);
  if (exact) return { personId: exact.personId, matchedAlias: exact.alias, kind: "matched_alias", score: 1 };

  const myTokens = tokens(norm);
  let best: NameMatch | null = null;
  for (const alias of aliases) {
    const aTokens = tokens(alias.normalized);
    let score = 0;
    let kind: MatchKind | null = null;
    if (isReordered(myTokens, aTokens)) {
      score = 0.9;
      kind = "reordered_name";
    } else if (isInitialsVariant(myTokens, aTokens)) {
      score = 0.72;
      kind = "initials";
    }
    if (kind && score > (best?.score ?? 0)) {
      best = { personId: alias.personId, matchedAlias: alias.alias, kind, score };
    }
  }
  return best;
}

// ── Read-time resolution (fast, no writes) ─────────────────────────────────

/** normalized alias → personId, for instant snapshot aggregation. */
export function buildAliasIndex(): Map<string, number> {
  const map = new Map<string, number>();
  for (const a of listAliases()) map.set(a.normalized, a.personId);
  return map;
}

/** Resolve a raw name to a persisted person id via exact alias, or null. */
export function resolveNameToPersonId(name: string | null, index = buildAliasIndex()): number | null {
  if (!name) return null;
  return index.get(normalizeName(name)) ?? null;
}

// ── Ingestion-time resolution (creates / links people) ─────────────────────

const MATCH_KIND_DETAIL: Record<MatchKind, string> = {
  matched_alias: "Exact alias match",
  reordered_name: "Reordered first/last name",
  initials: "Initials / shortened variant",
};

/** The outcome of resolving a detected name, with an optional review signal. */
export interface PersonResolution {
  personId: number | null;
  /** Set when the identity link is uncertain and should be reviewed. */
  uncertain?: { detected: string; suggested: string | null; score: number; reason: string };
}

/**
 * Resolve a detected name to a canonical person, creating or linking as needed
 * and recording evidence. High-confidence variants attach to the existing
 * person; uncertain ones create a candidate flagged as a possible duplicate and
 * return an `uncertain` signal so the caller can route it to the Review Queue.
 */
export function resolvePersonForName(
  rawName: string,
  ctx: { docId?: number; filename?: string } = {},
): PersonResolution {
  const name = rawName.trim();
  const norm = normalizeName(name);
  if (!norm) return { personId: null };
  const where = ctx.filename ? `"${ctx.filename}"` : "a document";

  const existing = findAliasByNormalized(norm);
  if (existing) {
    addEvidence({
      personId: existing.personId,
      kind: "matched_alias",
      detail: `Matched known name "${name}" in ${where}`,
      docId: ctx.docId ?? null,
    });
    return { personId: existing.personId };
  }

  const match = matchName(name);
  if (match && match.score >= AUTO_LINK_SCORE) {
    upsertAlias({ personId: match.personId, alias: name, normalized: norm, source: "ai_inferred" });
    addEvidence({
      personId: match.personId,
      kind: match.kind,
      detail: `${MATCH_KIND_DETAIL[match.kind]}: "${name}" ↔ "${match.matchedAlias}" (in ${where})`,
      docId: ctx.docId ?? null,
    });
    return { personId: match.personId };
  }

  // No confident match → new candidate person.
  const uncertain = match != null && match.score >= SUGGEST_SCORE;
  const person = insertPerson({
    displayName: name,
    confidence: uncertain ? 0.5 : 0.7,
    nameSource: "ai_inferred",
    status: "candidate",
  });
  upsertAlias({ personId: person.id, alias: name, normalized: norm, source: "ai_inferred" });
  addEvidence({
    personId: person.id,
    kind: "ai_inferred",
    detail: `First identified as "${name}" in ${where}`,
    docId: ctx.docId ?? null,
  });
  if (uncertain && match) {
    const other = findPerson(match.personId);
    if (other) {
      addEvidence({
        personId: person.id,
        kind: "ai_inferred",
        detail: `Possibly the same person as "${other.displayName}" — confirm in Training Mode`,
        docId: ctx.docId ?? null,
      });
      return {
        personId: person.id,
        uncertain: {
          detected: name,
          suggested: other.displayName,
          score: match.score,
          reason: `“${name}” might be the same person as “${other.displayName}” (${MATCH_KIND_DETAIL[match.kind].toLowerCase()}).`,
        },
      };
    }
  }
  return { personId: person.id };
}

// ── Linked-document counts (resolved from the cached attribution) ───────────

interface CachedAttr {
  docId: number;
  person: string | null;
}

function readCachedAttributions(): CachedAttr[] {
  const cache = getSnapshotCache();
  if (!cache) return [];
  try {
    const parsed = JSON.parse(cache.json) as { attributions?: { docId: number; person: string | null }[] };
    if (!Array.isArray(parsed.attributions)) return [];
    return parsed.attributions.map((a) => ({ docId: Number(a.docId), person: a.person ?? null }));
  } catch {
    return [];
  }
}

/** personId → number of documents currently attributed to that person. */
export function documentPersonCounts(index = buildAliasIndex()): Map<number, number> {
  const overrides = new Map(listDocumentOverrides().map((o) => [o.docId, o.person]));
  const counts = new Map<number, number>();
  for (const attr of readCachedAttributions()) {
    const effective = overrides.has(attr.docId) ? overrides.get(attr.docId)! : attr.person;
    const pid = resolveNameToPersonId(effective, index);
    if (pid != null) counts.set(pid, (counts.get(pid) ?? 0) + 1);
  }
  return counts;
}

// ── Rich person entities (for the People UI) ───────────────────────────────

export interface PersonEntity {
  id: number;
  displayName: string;
  roles: PersonRole[];
  isSelf: boolean;
  confidence: number;
  nameSource: FieldSource;
  rolesSource: FieldSource;
  status: "candidate" | "confirmed";
  aliases: { id: number; alias: string; source: FieldSource }[];
  evidence: { kind: string; detail: string; docId: number | null }[];
  linkedDocumentCount: number;
}

export function listPeople(): PersonEntity[] {
  const index = buildAliasIndex();
  const counts = documentPersonCounts(index);
  const aliasesByPerson = new Map<number, PersonAlias[]>();
  for (const a of listAliases()) {
    const arr = aliasesByPerson.get(a.personId) ?? [];
    arr.push(a);
    aliasesByPerson.set(a.personId, arr);
  }
  return listPersons().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    roles: p.roles,
    isSelf: p.isSelf,
    confidence: p.confidence,
    nameSource: p.nameSource,
    rolesSource: p.rolesSource,
    status: p.status,
    aliases: (aliasesByPerson.get(p.id) ?? []).map((a) => ({ id: a.id, alias: a.alias, source: a.source })),
    evidence: listEvidenceFor(p.id),
    linkedDocumentCount: counts.get(p.id) ?? 0,
  }));
}

function listEvidenceFor(personId: number): { kind: string; detail: string; docId: number | null }[] {
  const rows: PersonEvidence[] = listEvidence(personId);
  return rows.slice(0, 12).map((e) => ({ kind: e.kind, detail: e.detail, docId: e.docId }));
}

// ── Management (all user actions → confirmed sources) ──────────────────────

/** Ensure a person exists whose canonical name is `name`; returns its id. */
export function ensurePerson(name: string, source: FieldSource = "user_confirmed"): number {
  const norm = normalizeName(name);
  const existing = findAliasByNormalized(norm);
  if (existing) return existing.personId;
  const person = insertPerson({
    displayName: name.trim(),
    confidence: source === "ai_inferred" ? 0.7 : 1,
    nameSource: source,
    status: source === "ai_inferred" ? "candidate" : "confirmed",
  });
  upsertAlias({ personId: person.id, alias: name.trim(), normalized: norm, source });
  return person.id;
}

export function renamePerson(id: number, name: string): void {
  const person = findPerson(id);
  if (!person || !name.trim()) return;
  updatePerson(id, { displayName: name.trim(), nameSource: "user_confirmed", status: "confirmed", confidence: 1 });
  // The new display name is itself a confirmed alias.
  upsertAlias({ personId: id, alias: name.trim(), normalized: normalizeName(name), source: "user_confirmed" });
  addEvidence({ personId: id, kind: "manual", detail: `Renamed to "${name.trim()}"` });
}

export function setPersonRoles(id: number, roles: PersonRole[]): void {
  if (!findPerson(id)) return;
  updatePerson(id, { roles, rolesSource: "user_confirmed", status: "confirmed" });
  addEvidence({ personId: id, kind: "manual", detail: `Roles set: ${roles.length ? roles.join(", ") : "(none)"}` });
}

export function markSelf(id: number): void {
  const person = findPerson(id);
  if (!person) return;
  setSelfPerson(id);
  const roles: PersonRole[] = person.roles.includes("self") ? person.roles : ["self", ...person.roles];
  updatePerson(id, { roles, rolesSource: "user_confirmed", confidence: 1 });
  addEvidence({ personId: id, kind: "manual", detail: `Marked as Self` });
}

export function addPersonAlias(id: number, alias: string): void {
  const norm = normalizeName(alias);
  if (!findPerson(id) || !norm) return;
  upsertAlias({ personId: id, alias: alias.trim(), normalized: norm, source: "user_confirmed" });
  updatePerson(id, { status: "confirmed" });
  addEvidence({ personId: id, kind: "manual", detail: `Alias added: "${alias.trim()}"` });
}

export function removePersonAlias(aliasId: number): void {
  deleteAlias(aliasId);
}

/**
 * Merge `fromId` into `toId`: all aliases, evidence, and roles move to the
 * target, then the source person is deleted. User-driven → target confirmed.
 */
export function mergePersons(fromId: number, toId: number): void {
  if (fromId === toId) return;
  const from = findPerson(fromId);
  const to = findPerson(toId);
  if (!from || !to) return;
  reassignAliases(fromId, toId);
  reassignEvidence(fromId, toId);
  // Union roles, keeping the target's role source authority.
  const roles = Array.from(new Set([...to.roles, ...from.roles])) as PersonRole[];
  const rolesSource: FieldSource = canOverwrite(to.rolesSource, from.rolesSource) ? from.rolesSource : to.rolesSource;
  updatePerson(toId, {
    roles,
    rolesSource: to.roles.length || from.roles.length ? (rolesSource === "ai_inferred" ? "user_confirmed" : rolesSource) : to.rolesSource,
    status: "confirmed",
    confidence: 1,
  });
  addEvidence({ personId: toId, kind: "merge", detail: `Merged "${from.displayName}" into "${to.displayName}"` });
  deletePerson(fromId);
}

/**
 * Split selected aliases out of `id` into a brand-new canonical person (to undo
 * a mistaken merge). The first moved alias becomes the new display name.
 */
export function splitPerson(id: number, aliasIds: number[]): PersonRecord | null {
  const source = findPerson(id);
  if (!source) return null;
  const aliases = listAliases(id).filter((a) => aliasIds.includes(a.id));
  if (aliases.length === 0) return null;
  const primary = aliases[0];
  const created = insertPerson({
    displayName: primary.alias,
    confidence: 1,
    nameSource: "user_confirmed",
    status: "confirmed",
  });
  for (const a of aliases) {
    upsertAlias({ personId: created.id, alias: a.alias, normalized: a.normalized, source: "user_confirmed" });
  }
  addEvidence({ personId: created.id, kind: "split", detail: `Split out of "${source.displayName}"` });
  addEvidence({ personId: id, kind: "split", detail: `Split "${primary.alias}" into a separate person` });
  return created;
}

export function deletePersonEntity(id: number): void {
  deletePerson(id);
}

/**
 * Confirm that `rawName` refers to canonical person `personId` (Training answer
 * or a learned identity rule). Attaches the alias and merges any candidate that
 * had already been created for that name.
 */
export function confirmNameForPerson(
  rawName: string,
  personId: number,
  source: FieldSource = "user_confirmed",
  ctx: { docId?: number } = {},
): void {
  const norm = normalizeName(rawName);
  if (!findPerson(personId) || !norm) return;
  const existing = findAliasByNormalized(norm);
  if (existing && existing.personId !== personId) {
    // A candidate person was already created for this name — fold it in.
    mergePersons(existing.personId, personId);
  }
  upsertAlias({ personId, alias: rawName.trim(), normalized: norm, source });
  updatePerson(personId, { status: "confirmed", confidence: 1 });
  addEvidence({
    personId,
    kind: "training_answer",
    detail: `Confirmed "${rawName.trim()}" is this person`,
    docId: ctx.docId ?? null,
  });
}

// ── Automatic de-duplication of AI candidates ──────────────────────────────

/** Merge one AI candidate into another without escalating its source/confidence. */
function autoMerge(fromId: number, toId: number, detail: string): void {
  reassignAliases(fromId, toId);
  reassignEvidence(fromId, toId);
  addEvidence({ personId: toId, kind: "reordered_name", detail });
  deletePerson(fromId);
}

/**
 * Collapse AI candidate people that are clearly the same person (reordered
 * first/last name variants — high confidence). Never touches user-confirmed
 * people, roles, or Self. Idempotent: once merged there are no more duplicates.
 */
export function consolidateCandidateDuplicates(): void {
  const persons = listPersons().filter(
    (p) => p.status === "candidate" && p.nameSource === "ai_inferred" && !p.isSelf,
  );
  const aliasesByPerson = new Map<number, PersonAlias[]>();
  for (const a of listAliases()) {
    if (!persons.some((p) => p.id === a.personId)) continue;
    const arr = aliasesByPerson.get(a.personId) ?? [];
    arr.push(a);
    aliasesByPerson.set(a.personId, arr);
  }
  for (let i = 0; i < persons.length; i += 1) {
    const keep = persons[i];
    const keepAliases = aliasesByPerson.get(keep.id);
    if (!keepAliases) continue; // merged away in a previous iteration
    for (let j = i + 1; j < persons.length; j += 1) {
      const other = persons[j];
      const otherAliases = aliasesByPerson.get(other.id);
      if (!otherAliases) continue;
      const same = keepAliases.some((x) =>
        otherAliases.some((y) => isReordered(tokens(x.normalized), tokens(y.normalized))),
      );
      if (same) {
        autoMerge(other.id, keep.id, `Same person as "${other.displayName}" (reordered name)`);
        keepAliases.push(...otherAliases);
        aliasesByPerson.delete(other.id);
      }
    }
  }
}

// ── One-time migration: seed people from existing name data ────────────────

/**
 * Populate the persons table the first time from prior AI attributions and the
 * user's earlier renames/merges, so the People area is immediately useful
 * without waiting for a snapshot refresh.
 */
export function seedPeopleFromExisting(): void {
  if (countPersons() > 0) return;

  const overrides = listNameOverrides(); // { from → to } (user renames / merges)
  const overrideMap = new Map(overrides.map((o) => [o.from, o.to]));
  const overrideTargets = new Set(overrides.map((o) => o.to));

  const follow = (name: string): string => {
    let current = name;
    const seen = new Set<string>();
    while (overrideMap.has(current) && !seen.has(current)) {
      seen.add(current);
      current = overrideMap.get(current)!;
    }
    return current;
  };

  const names = new Set<string>();
  for (const attr of readCachedAttributions()) if (attr.person) names.add(attr.person);
  for (const o of overrides) {
    names.add(o.from);
    names.add(o.to);
  }
  for (const ov of listDocumentOverrides()) if (ov.person) names.add(ov.person);
  if (names.size === 0) return;

  const groups = new Map<string, Set<string>>();
  for (const name of names) {
    const root = follow(name);
    const set = groups.get(root) ?? new Set<string>();
    set.add(name);
    groups.set(root, set);
  }

  for (const [root, members] of groups) {
    const userTouched = members.size > 1 || overrideTargets.has(root);
    const person = insertPerson({
      displayName: root,
      confidence: userTouched ? 1 : 0.7,
      nameSource: userTouched ? "user_confirmed" : "ai_inferred",
      status: userTouched ? "confirmed" : "candidate",
    });
    for (const member of members) {
      const norm = normalizeName(member);
      if (!norm) continue;
      const source: FieldSource = member === root ? (userTouched ? "user_confirmed" : "ai_inferred") : "user_confirmed";
      upsertAlias({ personId: person.id, alias: member, normalized: norm, source });
    }
    addEvidence({ personId: person.id, kind: "ai_inferred", detail: "Imported from existing document history" });
  }
}
