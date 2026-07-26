/**
 * Training Mode: a user-enabled mode that asks a short, targeted set of
 * questions about each freshly-ingested document so the app can learn the user's
 * financial world. Answers become reusable "learned rules" (with confidence and
 * supporting evidence) that suppress redundant questions and are applied
 * automatically on future documents. A human-readable RULES.md mirrors what the
 * app has learned.
 *
 * AI (Way A, backend generateObject) generates the questions from the document's
 * content plus the facts already known from confident rules. Never throws for
 * AI/consent problems — a blocked state just means no questions this time (the
 * document is already safely stored).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { generateObject, glaze, z, GlazeAIError } from "@glaze/core/ai";
import { logger } from "@glaze/core/backend";

import {
  AUTO_APPLY_THRESHOLD,
  addManualRule,
  deleteLearnedRule,
  findDocumentById,
  getNextPendingReview,
  getSetting,
  getTrainingReview,
  getTrainingStats,
  listLearnedRules,
  resetTraining,
  saveTrainingReview,
  setDocumentOverride,
  setSetting,
  updateLearnedRule,
  updateTrainingReviewStatus,
  upsertConfirmedRule,
  PERSON_ROLES,
  type LearnedRule,
  type PersonRole,
  type RuleEvidence,
  type RuleType,
} from "./database.js";
import {
  confirmNameForPerson,
  ensurePerson,
  listPeople,
  resolveNameToPersonId,
  setPersonRoles,
} from "./people.js";
import { getVaultRoot } from "./vault.js";

const TRAINING_MODE_KEY = "training_mode";

/**
 * What answering a question teaches. Beyond the reusable rule types, questions
 * can attribute THIS document to a person, confirm a person's identity (a name
 * variant → canonical person), or assign a person's semantic role.
 */
export type QuestionTarget =
  | RuleType
  | "person_attribution"
  | "person_identity"
  | "person_role"
  | "none";

export interface TrainingQuestion {
  id: string;
  prompt: string;
  kind: "single" | "yesno" | "chips" | "text";
  /** Choices for single/chips; empty for yesno/text. */
  options: string[];
  target: QuestionTarget;
  /** The vendor/keyword/source/name-variant this question is about (for rule building). */
  matchKey: string | null;
  /** Short label shown as a chip on the question, e.g. "Owner", "Category". */
  theme: string;
}

export interface TrainingAnswer {
  id: string;
  /** string for single/yesno/text; string[] for chips. */
  value: string | string[];
}

/** A pending review handed to the popup: which file + the questions to ask. */
export interface PendingReview {
  docId: number;
  filename: string;
  questions: TrainingQuestion[];
}

// Bound the AI input so a large document doesn't burn excess credits.
const MAX_DOC_CHARS = 6000;

// ── Mode toggle ─────────────────────────────────────────────────────────

export function isTrainingMode(): boolean {
  return getSetting(TRAINING_MODE_KEY) === "1";
}

export function setTrainingMode(on: boolean): void {
  setSetting(TRAINING_MODE_KEY, on ? "1" : "0");
}

// ── Question generation ─────────────────────────────────────────────────

const questionSchema = z.object({
  shouldAsk: z
    .boolean()
    .describe(
      "false when the document is already fully understood from the known facts and its clear content — " +
        "do NOT interrupt the user just to ask something",
    ),
  questions: z
    .array(
      z.object({
        prompt: z.string().describe("A short, practical question, easy to answer in the moment"),
        kind: z
          .enum(["single", "yesno", "chips", "text"])
          .describe("Prefer single/yesno/chips over text; use text only when no small option set fits"),
        options: z
          .array(z.string())
          .describe("2-5 concise choices for 'single' or 'chips'; empty array for 'yesno' and 'text'"),
        target: z
          .enum([
            "vendor_category",
            "person_variant",
            "keyword_doctype",
            "source_scope",
            "person_attribution",
            "person_identity",
            "person_role",
            "none",
          ])
          .describe(
            "What answering this teaches: vendor_category = future docs from a vendor get a category; " +
              "person_variant = a name variant maps to a canonical person; keyword_doctype = a keyword/layout " +
              "implies a document type; source_scope = an account/source is business vs personal; " +
              "person_attribution = who THIS document belongs to; person_identity = whether a detected name is " +
              "the same real person as an existing one (offer the existing names as options); person_role = the " +
              "role a person plays (self, spouse, client, supplier, tax_officer, owner, tenant, landlord, insurer, " +
              "employee, consultant, bank_rm, accountant, other); none = general confirmation with no reusable rule",
          ),
        matchKey: z
          .string()
          .nullable()
          .describe(
            "For vendor_category/person_variant/keyword_doctype/source_scope: the exact vendor/name variant/" +
              "keyword/account this is about. For person_identity: the detected name in THIS document. For " +
              "person_role: the person's name this role applies to. null for person_attribution and none.",
          ),
        theme: z.string().describe("Very short label, e.g. 'Owner', 'Category', 'Expense type', 'Vendor rule'"),
      }),
    )
    .max(5)
    .describe("At most 5 questions, prioritising the single most useful unresolved ambiguity for this document"),
});

/** Describe the facts already known from confident rules, for the AI prompt. */
function knownFactsText(rules: LearnedRule[]): string {
  if (rules.length === 0) return "(none yet)";
  const label: Record<RuleType, string> = {
    vendor_category: "Vendor category",
    person_variant: "Name variant → person",
    keyword_doctype: "Keyword → document type",
    source_scope: "Account/source scope",
  };
  return rules
    .map((r) => `- ${label[r.ruleType]}: "${r.matchKey}" → ${r.value} (confidence ${r.confidence})`)
    .join("\n");
}

/** Rules whose match key appears in the document text or filename. */
function matchRules(rules: LearnedRule[], haystack: string): LearnedRule[] {
  return rules.filter((r) => r.matchKey.length >= 2 && haystack.includes(r.matchKey));
}

/**
 * Prepare Training Mode for a freshly-ingested document: apply any confident
 * rules silently, then generate targeted questions for what's still ambiguous.
 * Stores a review row (pending when there are questions, "auto" when the doc is
 * already understood). Returns whether the user should be prompted.
 */
export async function prepareTraining(docId: number): Promise<{ shouldAsk: boolean }> {
  const doc = findDocumentById(docId);
  if (!doc) return { shouldAsk: false };

  let content = "";
  try {
    content = await fs.readFile(doc.markdownPath, "utf-8");
  } catch {
    content = "";
  }
  const excerpt = content.slice(0, MAX_DOC_CHARS).trim();
  const haystack = `${doc.originalFilename}\n${content}`.toLowerCase();

  const allRules = listLearnedRules();
  const matched = matchRules(allRules, haystack);

  // Silently apply confident (auto-apply) rules that match this document.
  const autoApplied = matched.filter((r) => r.autoApply);
  for (const rule of autoApplied) {
    if (rule.ruleType === "person_variant") {
      // Canonicalise the name variant onto its person so the snapshot reflects it.
      confirmNameForPerson(rule.matchKey, ensurePerson(rule.value, "learned_rule"), "learned_rule", { docId });
    }
    // vendor_category / keyword_doctype / source_scope act as known facts that
    // keep us from re-asking; they need no per-document write here.
  }

  // Known canonical people (with roles + aliases) offered as options and used to
  // suppress redundant identity/role questions.
  const people = listPeople();
  const peopleContext =
    people.length === 0
      ? "(none yet)"
      : people
          .map((p) => {
            const roles = p.roles.length ? ` [roles: ${p.roles.join(", ")}${p.isSelf ? ", SELF" : ""}]` : p.isSelf ? " [SELF]" : "";
            const aliases = p.aliases.length > 1 ? ` (aka ${p.aliases.map((a) => a.alias).filter((a) => a !== p.displayName).join(", ")})` : "";
            return `- ${p.displayName}${aliases}${roles}`;
          })
          .join("\n");

  let result: z.infer<typeof questionSchema>;
  try {
    const { object } = await generateObject({
      model: glaze("fast"),
      schema: questionSchema,
      system:
        "You help a personal-finance app learn about the user's documents by preparing a SHORT set of " +
        "questions about one specific document. Ask only questions that would materially improve future " +
        "classification, attribution, categorisation, automation, or PERSON IDENTITY. Never ask something " +
        "already answered by the known facts or known people. If the document is already clear and well covered, " +
        "set shouldAsk to false and return no questions. Prefer multiple-choice (single), yes/no, or chips; use " +
        "free text only as a last resort. Keep questions concrete and about THIS document. Never invent people " +
        "or facts.\n\n" +
        "PERSON INTELLIGENCE — prioritise these when identity is ambiguous:\n" +
        "• If a person named in this document looks like it MIGHT be the same real person as an existing known " +
        "person (e.g. reordered first/last name, or initials), ask a person_identity question with matchKey = the " +
        "detected name and options = the candidate existing name(s) plus 'No, a different person'.\n" +
        "• If a person clearly involved in this document has no role yet, ask a person_role question with " +
        "matchKey = that person's name and options drawn from: self, spouse, client, supplier, tax_officer, owner, " +
        "tenant, landlord, insurer, employee, consultant, bank_rm, accountant, other.\n" +
        "Do NOT ask identity/role questions about people whose identity and role are already known.",
      prompt:
        `Document filename: ${doc.originalFilename}\n` +
        `Detected foreign currency: ${doc.foreignCurrency ?? "none"} (status: ${doc.currencyStatus})\n\n` +
        `Facts already known from confident rules:\n${knownFactsText(matched)}\n\n` +
        `Known canonical people (offer these as identity/attribution options; don't re-ask their known roles):\n${peopleContext}\n\n` +
        "Prepare 3-5 questions (or fewer, or none) about the document below. For any question whose answer " +
        "should become a reusable rule, set target and matchKey accordingly (e.g. the vendor name).\n\n" +
        `Document content:\n${excerpt || "(no extractable content)"}`,
    });
    result = object;
  } catch (error) {
    if (error instanceof GlazeAIError) {
      logger.info("training", "Question generation blocked", { state: error.state, docId });
    } else {
      logger.warn("training", "Question generation failed", { error: String(error), docId });
    }
    // Record the review as auto (nothing to ask) so we don't nag later.
    saveTrainingReview({ docId, status: "auto", questions: "[]" });
    return { shouldAsk: false };
  }

  const questions: TrainingQuestion[] = (result.shouldAsk ? result.questions : [])
    .slice(0, 5)
    .map((q, i) => ({
      id: `q${i + 1}`,
      prompt: q.prompt.trim(),
      kind: q.kind,
      options: (q.options ?? []).map((o) => o.trim()).filter(Boolean),
      target: q.target,
      matchKey: q.matchKey?.trim() ? q.matchKey.trim() : null,
      theme: q.theme?.trim() || "Question",
    }))
    .filter((q) => q.prompt.length > 0);

  if (questions.length === 0) {
    saveTrainingReview({ docId, status: "auto", questions: "[]" });
    logger.info("training", "Document already understood — no questions", { docId });
    return { shouldAsk: false };
  }

  saveTrainingReview({ docId, status: "pending", questions: JSON.stringify(questions) });
  logger.info("training", "Prepared training questions", { docId, count: questions.length });
  return { shouldAsk: true };
}

// ── Answer handling ─────────────────────────────────────────────────────

function answerToString(value: string | string[]): string {
  return Array.isArray(value) ? value.filter(Boolean).join(", ") : String(value ?? "").trim();
}

/** Human labels for roles, and their reverse lookup for parsing answers. */
export const ROLE_LABEL: Record<PersonRole, string> = {
  self: "Self",
  spouse: "Spouse",
  client: "Client",
  supplier: "Supplier",
  tax_officer: "Tax officer",
  owner: "Owner",
  tenant: "Tenant",
  landlord: "Landlord",
  insurer: "Insurer",
  employee: "Employee",
  consultant: "Consultant",
  bank_rm: "Bank relationship manager",
  accountant: "Accountant",
  other: "Other",
};

const ROLE_BY_LABEL = new Map<string, PersonRole>(
  PERSON_ROLES.flatMap((r) => [
    [r, r] as [string, PersonRole],
    [ROLE_LABEL[r].toLowerCase(), r] as [string, PersonRole],
  ]),
);

/** Convert answer value(s) into recognised PersonRole keys. */
function parseRoles(value: string | string[]): PersonRole[] {
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const out = new Set<PersonRole>();
  for (const item of raw) {
    const key = ROLE_BY_LABEL.get(item.trim().toLowerCase());
    if (key) out.add(key);
  }
  return Array.from(out);
}

/**
 * Turn a document's answers into learned rules and apply their effects, then
 * refresh RULES.md. Returns how many rules were newly learned vs reinforced.
 */
export async function saveAnswers(
  docId: number,
  answers: TrainingAnswer[],
): Promise<{ learned: number; reinforced: number }> {
  const doc = findDocumentById(docId);
  const filename = doc?.originalFilename ?? `document ${docId}`;

  // Recover the questions we asked so answers can be mapped to rule targets.
  const stored = readReviewQuestions(docId);
  const byId = new Map(stored.map((q) => [q.id, q]));

  let learned = 0;
  let reinforced = 0;

  for (const ans of answers) {
    const q = byId.get(ans.id);
    if (!q) continue;
    const value = answerToString(ans.value);
    if (!value) continue;

    const lowered = value.toLowerCase();
    const isNegative =
      lowered === "unidentified" ||
      lowered === "not sure" ||
      lowered === "unknown" ||
      lowered === "none" ||
      lowered.startsWith("no,") ||
      lowered === "no";

    if (q.target === "person_attribution") {
      // Attribute THIS document. Empty / "unidentified" / "not sure" → unpinned to unidentified.
      if (isNegative && lowered !== "no") {
        setDocumentOverride(docId, null);
      } else {
        ensurePerson(value); // ensure a canonical person exists so it resolves
        setDocumentOverride(docId, value);
      }
      continue;
    }

    if (q.target === "person_identity") {
      // "Is <matchKey> the same person as X?" — matchKey = the detected name.
      const detected = q.matchKey?.trim();
      if (!detected) continue;
      if (isNegative) {
        // Different person → give the detected name its own canonical identity.
        const pid = ensurePerson(detected);
        setDocumentOverride(docId, detected);
        void pid;
      } else {
        // Same as the chosen existing person → link + learn the mapping.
        const personId = ensurePerson(value);
        confirmNameForPerson(detected, personId, "user_confirmed", { docId });
        setDocumentOverride(docId, value);
        const res = upsertConfirmedRule({
          ruleType: "person_variant",
          matchKey: detected,
          value,
          evidence: [{ filename, docId, phrase: detected }],
        });
        if (res.isNew) learned += 1;
        else reinforced += 1;
      }
      continue;
    }

    if (q.target === "person_role") {
      // Assign role(s) to the named person. value may be a comma-joined chip list.
      const targetName = q.matchKey?.trim() || value;
      const personId = resolveNameToPersonId(targetName) ?? ensurePerson(targetName);
      const roles = parseRoles(Array.isArray(ans.value) ? ans.value : value);
      if (roles.length > 0) {
        setPersonRoles(personId, roles);
        learned += 1;
      }
      continue;
    }

    if (q.target === "none" || !q.matchKey) continue;

    const evidence: RuleEvidence[] = [{ filename, docId, phrase: q.matchKey }];
    const { isNew } = upsertConfirmedRule({
      ruleType: q.target,
      matchKey: q.matchKey,
      value,
      evidence,
    });
    if (isNew) learned += 1;
    else reinforced += 1;

    // A name-variant rule also links the variant onto its canonical person.
    if (q.target === "person_variant") {
      confirmNameForPerson(q.matchKey, ensurePerson(value), "user_confirmed", { docId });
    }
  }

  updateTrainingReviewStatus(docId, "answered", JSON.stringify(answers));
  await writeRulesMarkdown();
  logger.info("training", "Saved training answers", { docId, learned, reinforced });
  return { learned, reinforced };
}

export function skipReview(docId: number): void {
  updateTrainingReviewStatus(docId, "skipped", null);
  logger.info("training", "Skipped training for document", { docId });
}

/** Read back the questions stored for a document's review. */
function readReviewQuestions(docId: number): TrainingQuestion[] {
  const rec = getTrainingReview(docId);
  if (!rec) return [];
  try {
    const parsed = JSON.parse(rec.questions) as TrainingQuestion[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── RULES.md mirror ─────────────────────────────────────────────────────

const TYPE_HEADINGS: Record<RuleType, string> = {
  vendor_category: "Vendor → Category",
  person_variant: "Name variant → Person",
  keyword_doctype: "Keyword / layout → Document type",
  source_scope: "Account / source → Business vs Personal",
};

/** Regenerate the human-readable RULES.md from the current learned rules. */
export async function writeRulesMarkdown(): Promise<void> {
  const rules = listLearnedRules();
  const stats = getTrainingStats();
  const lines: string[] = [];
  lines.push("# Quick2Afvault — Learned Rules");
  lines.push("");
  lines.push("_Auto-generated by Training Mode. What the app has learned about your documents._");
  lines.push("");
  lines.push(`- Documents reviewed: ${stats.reviewed}`);
  lines.push(`- Rules learned: ${stats.ruleCount}`);
  lines.push(`- Last updated: ${new Date().toLocaleString()}`);
  lines.push("");

  if (rules.length === 0) {
    lines.push("No rules learned yet. Turn on Training Mode and drop a document to start teaching the app.");
  } else {
    for (const type of Object.keys(TYPE_HEADINGS) as RuleType[]) {
      const group = rules.filter((r) => r.ruleType === type);
      if (group.length === 0) continue;
      lines.push(`## ${TYPE_HEADINGS[type]}`);
      lines.push("");
      for (const r of group) {
        const applied = r.autoApply ? "auto-applied" : `needs ${AUTO_APPLY_THRESHOLD - r.confidence} more to auto-apply`;
        const origin = r.source === "manual" ? "added manually" : "confirmed by you";
        lines.push(`- **${r.matchKey}** → ${r.value}  _(confidence ${r.confidence}, ${origin}, ${applied})_`);
        if (r.evidence.length > 0) {
          const files = Array.from(new Set(r.evidence.map((e) => e.filename))).slice(0, 6);
          lines.push(`  - Evidence: ${files.join(", ")}`);
        }
      }
      lines.push("");
    }
  }

  const target = path.join(getVaultRoot(), "RULES.md");
  try {
    await fs.mkdir(getVaultRoot(), { recursive: true });
    await fs.writeFile(target, lines.join("\n"), "utf-8");
  } catch (error) {
    logger.warn("training", "Failed to write RULES.md", { error: String(error) });
  }
}

// ── Pending review access (for the popup) ────────────────────────────────

export function nextPendingReview(): PendingReview | null {
  const rec = getNextPendingReview();
  if (!rec) return null;
  const doc = findDocumentById(rec.docId);
  let questions: TrainingQuestion[] = [];
  try {
    const parsed = JSON.parse(rec.questions) as TrainingQuestion[];
    if (Array.isArray(parsed)) questions = parsed;
  } catch {
    questions = [];
  }
  return {
    docId: rec.docId,
    filename: doc?.originalFilename ?? `Document ${rec.docId}`,
    questions,
  };
}

// ── Settings-facing rule management ──────────────────────────────────────

export function listRules(): LearnedRule[] {
  return listLearnedRules();
}

export async function addRule(input: { ruleType: RuleType; matchKey: string; value: string }): Promise<LearnedRule> {
  const rule = addManualRule(input);
  if (rule.ruleType === "person_variant") {
    confirmNameForPerson(rule.matchKey, ensurePerson(rule.value, "manual"), "manual");
  }
  await writeRulesMarkdown();
  return rule;
}

export async function editRule(id: number, patch: { value?: string; autoApply?: boolean }): Promise<void> {
  updateLearnedRule(id, patch);
  await writeRulesMarkdown();
}

export async function removeRule(id: number): Promise<void> {
  deleteLearnedRule(id);
  await writeRulesMarkdown();
}

export async function resetTrainingProgress(): Promise<void> {
  resetTraining();
  await writeRulesMarkdown();
}
