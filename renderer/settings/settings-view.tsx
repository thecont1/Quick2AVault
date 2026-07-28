import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  EmptyState,
  EmptyStateDescription,
  EmptyStateTitle,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Separator,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  Toolbar,
  ToolbarContent,
  ToolbarTitle,
  toast,
} from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import type { NativeThemeInfo } from "@glaze/core/ipc";
import {
  ArrowRight,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  Coins,
  Copy,
  ExternalLink,
  FileSearch,
  FolderOpen,
  GraduationCap,
  Hash,
  Info,
  Pencil,
  Plus,
  Repeat,
  RotateCcw,
  Scissors,
  Star,
  Trash2,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import {
  financialYearKey,
  formatDatePref,
  fyLabel,
  IMPACT_BUCKETS,
  IMPACT_LABEL,
  INDIA_DEFAULTS,
  MONTH_NAMES,
  type DateFormat,
  type FinancePrefs,
  type ImpactBucket,
} from "../finance";

interface DocumentRecord {
  id: number;
  originalFilename: string;
  fileType: string;
  dateIngested: string;
  dateFolder: string;
  markdownSuccess: boolean;
  rawPath: string;
  markdownPath: string;
}

interface DocRef {
  docId: number;
  filename: string;
}

interface PersonSummary {
  name: string;
  documentCount: number;
  documents: DocRef[];
}

interface SnapshotData {
  people: PersonSummary[];
  unidentified: { documentCount: number; documents: DocRef[] } | null;
}

interface SnapshotResponse {
  snapshot: SnapshotData | null;
}

// Must match the sentinels handled by the people:reassignDoc backend handler.
const REASSIGN_AUTO = "__auto__";
const REASSIGN_UNIDENTIFIED = "__unidentified__";

const TYPE_LABEL: Record<string, string> = {
  pdf: "PDF",
  xlsx: "Spreadsheet",
  csv: "CSV",
  txt: "Text",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A small document-with-dollar app mark used in the Settings header. */
function AppLogo() {
  return (
    <span className="flex items-center justify-center rounded-[9px] bg-accent text-accent-contrast size-6 shrink-0">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-3.5"
        aria-hidden="true"
      >
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
        <path d="M14 3v5h5" />
        <path d="M12 11.5v5.5" />
        <path d="M13.6 12.6c-.4-.5-1-.7-1.6-.7-1 0-1.7.5-1.7 1.2 0 .8.7 1 1.7 1.2 1 .2 1.7.5 1.7 1.3 0 .7-.8 1.2-1.8 1.2-.7 0-1.3-.3-1.6-.8" />
      </svg>
    </span>
  );
}

// ── Training Mode ─────────────────────────────────────────────────────────

type RuleType =
  | "vendor_category"
  | "person_variant"
  | "keyword_doctype"
  | "source_scope"
  | "accounting_treatment"
  | "impact_bucket";

interface RuleEvidence {
  filename: string;
  phrase?: string;
  docId?: number;
}

interface LearnedRule {
  id: number;
  ruleType: RuleType;
  matchKey: string;
  value: string;
  confidence: number;
  source: "confirmed" | "manual";
  autoApply: boolean;
  evidence: RuleEvidence[];
}

interface TrainingStats {
  reviewed: number;
  ruleCount: number;
  mode: boolean;
  /** True while Training Mode is still on its first-run default (never toggled). */
  isDefault?: boolean;
}

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  vendor_category: "Vendor → Category",
  person_variant: "Name variant → Person",
  keyword_doctype: "Keyword → Doc type",
  source_scope: "Account → Business / Personal",
  accounting_treatment: "Vendor → Accounting treatment",
  impact_bucket: "Vendor → Financial impact",
};
const RULE_TYPES = Object.keys(RULE_TYPE_LABEL) as RuleType[];

/** A single learned rule with inline value editing, evidence, and controls. */
function RuleRow({
  rule,
  onEdit,
  onDelete,
  onToggleAuto,
}: {
  rule: LearnedRule;
  onEdit: (value: string) => void;
  onDelete: () => void;
  onToggleAuto: (autoApply: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(rule.value);
  const [showEvidence, setShowEvidence] = useState(false);
  const evidenceFiles = Array.from(new Set(rule.evidence.map((e) => e.filename))).filter(Boolean);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== rule.value) onEdit(next);
    setEditing(false);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-panel bg-control-subtle px-3 py-2">
      <div className="flex items-center gap-2">
        <Badge color="secondary" className="shrink-0">
          {RULE_TYPE_LABEL[rule.ruleType]}
        </Badge>
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <Text variant="small" className="truncate max-w-[110px]" title={rule.matchKey}>
            {rule.matchKey}
          </Text>
          <ArrowRight className="size-3 text-tertiary shrink-0" />
          {editing ? (
            <Input
              autoFocus
              size="small"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="flex-1"
            />
          ) : (
            <Text variant="small" className="font-medium truncate" title={rule.value}>
              {rule.value}
            </Text>
          )}
        </div>
        {editing ? (
          <Button size="small" variant="accent" onClick={commit}>
            <Check className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="small"
            variant="transparent"
            iconOnly
            onClick={() => setEditing(true)}
            title="Edit value"
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        <Button size="small" variant="transparent" iconOnly onClick={onDelete} title="Delete rule">
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge color="secondary" className="tabular-nums">
          Confidence {rule.confidence}
        </Badge>
        <button
          type="button"
          onClick={() => onToggleAuto(!rule.autoApply)}
          className={cn(
            "px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors",
            rule.autoApply
              ? "bg-accent text-accent-contrast border-transparent"
              : "bg-control-subtle text-secondary border-panel hover:bg-control",
          )}
          title={
            rule.autoApply
              ? "Applied automatically — click to require asking"
              : "Click to auto-apply"
          }
        >
          {rule.autoApply ? "Auto-applies" : "Ask first"}
        </button>
        <Text variant="small" color="tertiary">
          {rule.source === "manual" ? "Added manually" : "Confirmed by you"}
        </Text>
        {evidenceFiles.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex items-center gap-0.5 text-secondary hover:text-primary transition-colors"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", showEvidence && "rotate-90")}
            />
            <Text variant="small" color="secondary">
              {evidenceFiles.length} source{evidenceFiles.length === 1 ? "" : "s"}
            </Text>
          </button>
        ) : null}
      </div>
      {showEvidence && evidenceFiles.length > 0 ? (
        <div className="flex flex-col gap-0.5 pl-1 border-l border-panel">
          {evidenceFiles.map((f) => (
            <Text key={f} variant="small" color="tertiary" className="truncate pl-2" title={f}>
              {f}
            </Text>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrainingSection() {
  const queryClient = useQueryClient();
  const [addType, setAddType] = useState<RuleType>("vendor_category");
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);

  const statsQuery = useQuery({
    queryKey: ["trainingStats"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<TrainingStats>("training:getStats"),
  });
  const rulesQuery = useQuery({
    queryKey: ["trainingRules"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<LearnedRule[]>("training:listRules"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["trainingStats"] });
    queryClient.invalidateQueries({ queryKey: ["trainingRules"] });
  };

  const setMode = useMutation({
    mutationFn: (on: boolean) => window.glazeAPI.glaze.ipc.invoke("training:setMode", on),
    onSuccess: invalidate,
    onError: (error) => toast.error(`Couldn't change Training Mode: ${error}`),
  });
  const addRule = useMutation({
    mutationFn: (vars: { ruleType: RuleType; matchKey: string; value: string }) =>
      window.glazeAPI.glaze.ipc.invoke(
        "training:addRule",
        vars.ruleType,
        vars.matchKey,
        vars.value,
      ),
    onSuccess: () => {
      setAddKey("");
      setAddValue("");
      invalidate();
    },
    onError: (error) => toast.error(`Couldn't add rule: ${error}`),
  });
  const updateRule = useMutation({
    mutationFn: (vars: { id: number; patch: { value?: string; autoApply?: boolean } }) =>
      window.glazeAPI.glaze.ipc.invoke("training:updateRule", vars.id, vars.patch),
    onSuccess: invalidate,
    onError: (error) => toast.error(`Couldn't update rule: ${error}`),
  });
  const deleteRule = useMutation({
    mutationFn: (id: number) => window.glazeAPI.glaze.ipc.invoke("training:deleteRule", id),
    onSuccess: invalidate,
    onError: (error) => toast.error(`Couldn't delete rule: ${error}`),
  });
  const reset = useMutation({
    mutationFn: () => window.glazeAPI.glaze.ipc.invoke("training:reset"),
    onSuccess: () => {
      setConfirmReset(false);
      invalidate();
    },
    onError: (error) => toast.error(`Couldn't reset training: ${error}`),
  });

  const stats = statsQuery.data;
  const rules = rulesQuery.data ?? [];
  const modeOn = stats?.mode ?? false;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <GraduationCap className="size-4 text-secondary" />
        <Text variant="strong" className="flex-1">
          Training Mode
        </Text>
        <div className="flex gap-1">
          {[
            { label: "Off", on: false },
            { label: "On", on: true },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => setMode.mutate(opt.on)}
              className={cn(
                "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                modeOn === opt.on
                  ? "bg-accent text-accent-contrast border-transparent"
                  : "bg-control-subtle text-secondary border-panel hover:bg-control",
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <Text variant="small" color="tertiary">
        When on, the orb asks a few quick questions about each new document and learns reusable
        rules. Confirmed rules are applied automatically and won't be asked again. A readable
        summary is saved to RULES.md in your vault. You can turn Training Mode off any time once the
        app has learned enough about your financial world.
      </Text>

      {/* First-run note: explain why it's on by default, without feeling sneaky. */}
      {modeOn && stats?.isDefault ? (
        <div className="flex items-start gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-2">
          <GraduationCap className="size-4 text-accent shrink-0 mt-0.5" />
          <Text variant="small" color="secondary">
            Training Mode is on to help Quick2Afvault learn your financial world faster from your
            first documents. Leave it on for a while, then turn it off here whenever you'd like.
          </Text>
        </div>
      ) : null}

      {/* Progress */}
      <div className="flex gap-2">
        <div className="flex-1 rounded-lg border border-panel bg-control-subtle px-3 py-2">
          <Text variant="small" color="tertiary">
            Documents reviewed
          </Text>
          <Text variant="strong" className="tabular-nums">
            {stats?.reviewed ?? 0}
          </Text>
        </div>
        <div className="flex-1 rounded-lg border border-panel bg-control-subtle px-3 py-2">
          <Text variant="small" color="tertiary">
            Rules learned
          </Text>
          <Text variant="strong" className="tabular-nums">
            {stats?.ruleCount ?? 0}
          </Text>
        </div>
      </div>

      {/* Learned rules */}
      {rules.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {rules.map((rule) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              onEdit={(value) => updateRule.mutate({ id: rule.id, patch: { value } })}
              onDelete={() => deleteRule.mutate(rule.id)}
              onToggleAuto={(autoApply) => updateRule.mutate({ id: rule.id, patch: { autoApply } })}
            />
          ))}
        </div>
      ) : (
        <Text variant="small" color="secondary">
          No rules learned yet. Turn on Training Mode and drop a document to start teaching the app.
        </Text>
      )}

      {/* Add a rule manually */}
      <div className="flex flex-col gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-2.5">
        <Text variant="small" color="secondary">
          Add a rule manually
        </Text>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Select value={addType} onValueChange={(v) => setAddType(v as RuleType)}>
            <SelectTrigger size="small" variant="filled" className="w-[170px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {RULE_TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            size="small"
            value={addKey}
            onChange={(e) => setAddKey(e.target.value)}
            placeholder="Match (e.g. vendor)"
            className="flex-1 min-w-[120px]"
          />
          <Input
            size="small"
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            placeholder="Result (e.g. category)"
            className="flex-1 min-w-[120px]"
          />
          <Button
            size="small"
            variant="accent"
            disabled={!addKey.trim() || !addValue.trim() || addRule.isPending}
            onClick={() => addRule.mutate({ ruleType: addType, matchKey: addKey, value: addValue })}
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </div>

      {/* Reset */}
      <div className="flex items-center gap-2">
        {confirmReset ? (
          <>
            <Text variant="small" color="secondary" className="flex-1">
              Delete all learned rules and review history?
            </Text>
            <Button
              size="small"
              variant="accent"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
            >
              Confirm reset
            </Button>
            <Button size="small" variant="transparent" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="small" variant="transparent" onClick={() => setConfirmReset(true)}>
            <RotateCcw className="size-3.5" />
            Reset Training progress
          </Button>
        )}
      </div>
    </section>
  );
}

// ── Canonical People ───────────────────────────────────────────────────────

type PersonRole =
  | "self"
  | "spouse"
  | "client"
  | "supplier"
  | "tax_officer"
  | "owner"
  | "tenant"
  | "landlord"
  | "insurer"
  | "employee"
  | "consultant"
  | "bank_rm"
  | "accountant"
  | "other";

type FieldSource = "ai_inferred" | "learned_rule" | "user_confirmed" | "manual";

const ROLE_LABEL: Record<PersonRole, string> = {
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
  bank_rm: "Bank RM",
  accountant: "Accountant",
  other: "Other",
};
const ALL_ROLES = Object.keys(ROLE_LABEL) as PersonRole[];

const SOURCE_LABEL: Record<FieldSource, string> = {
  ai_inferred: "AI inferred",
  learned_rule: "Learned rule",
  user_confirmed: "Confirmed by you",
  manual: "Set manually",
};

interface PersonEntity {
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

/** A single canonical person: name, roles, aliases, evidence, and controls. */
function PersonCard({
  person,
  others,
  onRename,
  onSetRoles,
  onMarkSelf,
  onAddAlias,
  onRemoveAlias,
  onSplitAlias,
  onMerge,
  onDelete,
}: {
  person: PersonEntity;
  others: PersonEntity[];
  onRename: (name: string) => void;
  onSetRoles: (roles: PersonRole[]) => void;
  onMarkSelf: () => void;
  onAddAlias: (alias: string) => void;
  onRemoveAlias: (aliasId: number) => void;
  onSplitAlias: (aliasId: number) => void;
  onMerge: (targetId: number) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(person.displayName);
  const [newAlias, setNewAlias] = useState("");
  const [showRoles, setShowRoles] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const commitRename = () => {
    const next = renameValue.trim();
    if (next && next !== person.displayName) onRename(next);
    setRenaming(false);
  };
  const toggleRole = (role: PersonRole) => {
    const next = person.roles.includes(role)
      ? person.roles.filter((r) => r !== role)
      : [...person.roles, role];
    onSetRoles(next);
  };
  const commitAlias = () => {
    const next = newAlias.trim();
    if (next) onAddAlias(next);
    setNewAlias("");
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-2.5">
      {/* Header: name + primary badges */}
      <div className="flex items-center gap-2">
        {person.isSelf ? (
          <Star className="size-3.5 text-accent shrink-0" fill="currentColor" />
        ) : null}
        {renaming ? (
          <>
            <Input
              autoFocus
              size="small"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="flex-1"
            />
            <Button size="small" variant="accent" onClick={commitRename}>
              <Check className="size-3.5" />
            </Button>
            <Button size="small" variant="transparent" iconOnly onClick={() => setRenaming(false)}>
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Text className="flex-1 truncate font-medium" title={person.displayName}>
              {person.displayName}
            </Text>
            <Badge color="secondary" className="tabular-nums shrink-0">
              {person.linkedDocumentCount} doc{person.linkedDocumentCount === 1 ? "" : "s"}
            </Badge>
            <Button
              size="small"
              variant="transparent"
              iconOnly
              onClick={() => setRenaming(true)}
              title="Rename"
            >
              <Pencil className="size-3.5" />
            </Button>
          </>
        )}
      </div>

      {/* Roles */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {person.roles.length > 0 ? (
          person.roles.map((r) => (
            <Badge key={r} color={r === "self" ? "blue" : "secondary"}>
              {ROLE_LABEL[r]}
            </Badge>
          ))
        ) : (
          <Text variant="small" color="tertiary">
            No role assigned
          </Text>
        )}
        <button
          type="button"
          onClick={() => setShowRoles((v) => !v)}
          className="flex items-center gap-0.5 text-secondary hover:text-primary transition-colors ml-auto"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", showRoles && "rotate-90")} />
          <Text variant="small" color="secondary">
            Edit roles
          </Text>
        </button>
      </div>
      {showRoles ? (
        <div className="flex flex-wrap gap-1 rounded-lg border border-panel bg-control px-2 py-2">
          {ALL_ROLES.map((role) => {
            const active = person.roles.includes(role);
            return (
              <button
                key={role}
                type="button"
                onClick={() => toggleRole(role)}
                className={cn(
                  "px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors",
                  active
                    ? "bg-accent text-accent-contrast border-transparent"
                    : "bg-control-subtle text-secondary border-panel hover:bg-control",
                )}
              >
                {ROLE_LABEL[role]}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Aliases */}
      <div className="flex flex-col gap-1">
        <Text variant="small" color="tertiary">
          Name variants
        </Text>
        <div className="flex flex-wrap gap-1">
          {person.aliases.map((a) => (
            <span
              key={a.id}
              className="group flex items-center gap-1 rounded-full border border-panel bg-control px-2 py-0.5"
              title={SOURCE_LABEL[a.source]}
            >
              <Text variant="small" className="truncate max-w-[140px]">
                {a.alias}
              </Text>
              {person.aliases.length > 1 ? (
                <>
                  <button
                    type="button"
                    onClick={() => onSplitAlias(a.id)}
                    className="text-tertiary hover:text-primary transition-colors"
                    title="Split into a separate person"
                  >
                    <Scissors className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveAlias(a.id)}
                    className="text-tertiary hover:text-primary transition-colors"
                    title="Remove variant"
                  >
                    <X className="size-3" />
                  </button>
                </>
              ) : null}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            size="small"
            value={newAlias}
            onChange={(e) => setNewAlias(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitAlias();
            }}
            placeholder="Add a name variant"
            className="flex-1"
          />
          <Button
            size="small"
            variant="transparent"
            iconOnly
            onClick={commitAlias}
            disabled={!newAlias.trim()}
            title="Add variant"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Footer: confidence + source + actions */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge color="secondary" className="tabular-nums">
          {Math.round(person.confidence * 100)}% confident
        </Badge>
        <Text variant="small" color="tertiary">
          {SOURCE_LABEL[person.nameSource]}
        </Text>
        {person.evidence.length > 0 ? (
          <button
            type="button"
            onClick={() => setShowEvidence((v) => !v)}
            className="flex items-center gap-0.5 text-secondary hover:text-primary transition-colors"
          >
            <Info className="size-3.5" />
            <Text variant="small" color="secondary">
              Why
            </Text>
          </button>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {!person.isSelf ? (
            <Button
              size="small"
              variant="transparent"
              onClick={onMarkSelf}
              title="Mark this person as yourself"
            >
              <Star className="size-3.5" />
              Self
            </Button>
          ) : null}
          {others.length > 0 ? (
            <Select value="" onValueChange={(v) => onMerge(Number(v))}>
              <SelectTrigger size="small" variant="filled" className="w-[130px]">
                <SelectValue placeholder="Merge into…" />
              </SelectTrigger>
              <SelectContent>
                {others.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {confirmDelete ? (
            <>
              <Button size="small" variant="accent" onClick={onDelete}>
                Delete
              </Button>
              <Button
                size="small"
                variant="transparent"
                iconOnly
                onClick={() => setConfirmDelete(false)}
              >
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button
              size="small"
              variant="transparent"
              iconOnly
              onClick={() => setConfirmDelete(true)}
              title="Delete person"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      {showEvidence && person.evidence.length > 0 ? (
        <div className="flex flex-col gap-0.5 pl-1 border-l border-panel">
          {person.evidence.map((e, i) => (
            <Text key={i} variant="small" color="tertiary" className="pl-2">
              {e.detail}
            </Text>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PeopleSection() {
  const queryClient = useQueryClient();
  const peopleQuery = useQuery({
    queryKey: ["people"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<PersonEntity[]>("people:list"),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["people"] });
    queryClient.invalidateQueries({ queryKey: ["snapshot"] });
  };

  const rename = useMutation({
    mutationFn: (v: { id: number; name: string }) =>
      window.glazeAPI.glaze.ipc.invoke("people:rename", v.id, v.name),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't rename: ${e}`),
  });
  const setRoles = useMutation({
    mutationFn: (v: { id: number; roles: PersonRole[] }) =>
      window.glazeAPI.glaze.ipc.invoke("people:setRoles", v.id, v.roles),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't set roles: ${e}`),
  });
  const markSelf = useMutation({
    mutationFn: (id: number) => window.glazeAPI.glaze.ipc.invoke("people:markSelf", id),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't mark Self: ${e}`),
  });
  const addAlias = useMutation({
    mutationFn: (v: { id: number; alias: string }) =>
      window.glazeAPI.glaze.ipc.invoke("people:addAlias", v.id, v.alias),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't add variant: ${e}`),
  });
  const removeAlias = useMutation({
    mutationFn: (aliasId: number) =>
      window.glazeAPI.glaze.ipc.invoke("people:removeAlias", aliasId),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't remove variant: ${e}`),
  });
  const splitAlias = useMutation({
    mutationFn: (v: { id: number; aliasId: number }) =>
      window.glazeAPI.glaze.ipc.invoke("people:split", v.id, [v.aliasId]),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't split: ${e}`),
  });
  const merge = useMutation({
    mutationFn: (v: { fromId: number; toId: number }) =>
      window.glazeAPI.glaze.ipc.invoke("people:merge", v.fromId, v.toId),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't merge: ${e}`),
  });
  const remove = useMutation({
    mutationFn: (id: number) => window.glazeAPI.glaze.ipc.invoke("people:delete", id),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't delete: ${e}`),
  });

  const people = peopleQuery.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-secondary" />
        <Text variant="strong" className="flex-1">
          People
        </Text>
      </div>
      <Text variant="small" color="tertiary">
        Canonical people the app has discovered. Merge duplicates, split a mistaken merge, add name
        variants, assign roles, and mark yourself as Self — used to resolve future documents.
        Changes apply to the Financial Snapshot instantly.
      </Text>
      {people.length === 0 ? (
        <Text variant="small" color="secondary">
          No people identified yet. Open the Financial Snapshot from the orb and tap Refresh to
          analyze your documents.
        </Text>
      ) : (
        <div className="flex flex-col gap-1.5">
          {people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              others={people.filter((p) => p.id !== person.id)}
              onRename={(name) => rename.mutate({ id: person.id, name })}
              onSetRoles={(roles) => setRoles.mutate({ id: person.id, roles })}
              onMarkSelf={() => markSelf.mutate(person.id)}
              onAddAlias={(alias) => addAlias.mutate({ id: person.id, alias })}
              onRemoveAlias={(aliasId) => removeAlias.mutate(aliasId)}
              onSplitAlias={(aliasId) => splitAlias.mutate({ id: person.id, aliasId })}
              onMerge={(toId) => merge.mutate({ fromId: person.id, toId })}
              onDelete={() => remove.mutate(person.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Review Queue ────────────────────────────────────────────────────────────

type ReviewField =
  | "person"
  | "doc_type"
  | "vendor"
  | "doc_date"
  | "fin_year"
  | "amount"
  | "fx"
  | "accounting";
type ReviewStatus = "low_confidence" | "conflict" | "missing" | "confirmed" | "corrected";

const TREATMENT_LABEL: Record<string, string> = {
  current_period_expense: "Current-period expense",
  prepaid_expense: "Prepaid expense",
  accrued_expense: "Accrued expense",
  deferred_revenue: "Deferred revenue",
  recognized_revenue: "Recognized revenue",
  reimbursement: "Reimbursement",
  needs_accounting_review: "Needs accounting review",
};

interface QueueFieldRef {
  field: ReviewField;
  status: ReviewStatus;
}

interface ReviewQueueItem {
  docId: number;
  filename: string;
  fileType: string;
  dateIngested: string;
  pendingFields: QueueFieldRef[];
}

interface FieldReview {
  field: ReviewField;
  extractedValue: string | null;
  confidence: number;
  source: string;
  reason: string;
  suggestedValue: string | null;
  finalValue: string | null;
  status: ReviewStatus;
}

interface ReviewAuditEntry {
  field: ReviewField;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  at: string;
}

interface ReviewDetail {
  docId: number;
  filename: string;
  fields: FieldReview[];
  audit: ReviewAuditEntry[];
}

interface ResolveResult {
  ok: boolean;
  message?: string;
}

interface DuplicateEvent {
  id: number;
  filename: string;
  duplicateOfDocId: number | null;
  detectedAt: string;
  status: "new" | "acknowledged";
  reason: string;
}

const FIELD_LABEL: Record<ReviewField, string> = {
  person: "Person",
  doc_type: "Document type",
  vendor: "Vendor / institution",
  doc_date: "Document date",
  fin_year: "Financial year",
  amount: "Primary amount",
  fx: "Currency conversion",
  accounting: "Accounting hint",
};

const STATUS_META: Record<
  ReviewStatus,
  { label: string; color: "yellow" | "red" | "orange" | "green" | "blue" }
> = {
  low_confidence: { label: "Low confidence", color: "yellow" },
  conflict: { label: "Conflict", color: "red" },
  missing: { label: "Missing", color: "orange" },
  confirmed: { label: "Confirmed", color: "green" },
  corrected: { label: "Corrected", color: "blue" },
};

const REVIEW_SOURCE_LABEL: Record<string, string> = {
  ai_inferred: "AI inferred",
  learned_rule: "Learned rule",
  user_confirmed: "You confirmed",
  manual: "You set",
};

const PENDING = new Set<ReviewStatus>(["low_confidence", "conflict", "missing"]);

/** One field within a document's review detail, with confirm / correct / defer. */
function FieldReviewRow({
  review,
  onResolve,
}: {
  review: FieldReview;
  onResolve: (action: "confirm" | "correct" | "defer", value?: string) => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState(review.suggestedValue ?? review.extractedValue ?? "");
  const meta = STATUS_META[review.status];
  const pending = PENDING.has(review.status);

  const commit = () => {
    const next = draft.trim();
    if (next) onResolve("correct", next);
    setCorrecting(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Text variant="small" className="font-medium flex-1">
          {FIELD_LABEL[review.field]}
        </Text>
        <Badge color={meta.color}>{meta.label}</Badge>
      </div>

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <Text variant="small" color="tertiary" className="w-20 shrink-0">
            Extracted
          </Text>
          <Text variant="small" className="flex-1 min-w-0 break-words">
            {review.finalValue ?? review.extractedValue ?? "—"}
          </Text>
        </div>
        <div className="flex items-baseline gap-2">
          <Text variant="small" color="tertiary" className="w-20 shrink-0">
            Confidence
          </Text>
          <Text variant="small" color="secondary" className="tabular-nums">
            {Math.round(review.confidence * 100)}% ·{" "}
            {REVIEW_SOURCE_LABEL[review.source] ?? review.source}
          </Text>
        </div>
        {review.reason ? (
          <div className="flex items-baseline gap-2">
            <Text variant="small" color="tertiary" className="w-20 shrink-0">
              Why
            </Text>
            <Text variant="small" color="secondary" className="flex-1 min-w-0 break-words">
              {review.reason}
            </Text>
          </div>
        ) : null}
        {pending && review.suggestedValue ? (
          <div className="flex items-baseline gap-2">
            <Text variant="small" color="tertiary" className="w-20 shrink-0">
              Suggested
            </Text>
            <Text variant="small" className="flex-1 min-w-0 break-words font-medium">
              {review.suggestedValue}
            </Text>
          </div>
        ) : null}
      </div>

      {correcting ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            size="small"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              review.field === "person" ? "Correct name, or “Unidentified”" : "Correct value"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setCorrecting(false);
            }}
            className="flex-1"
          />
          <Button size="small" variant="accent" onClick={commit}>
            <Check className="size-3.5" />
            Save
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-wrap">
          {pending ? (
            <>
              {review.suggestedValue ? (
                <Button size="small" variant="accent" onClick={() => onResolve("confirm")}>
                  <Check className="size-3.5" />
                  Confirm
                </Button>
              ) : null}
              <Button size="small" variant="transparent" onClick={() => setCorrecting(true)}>
                <Pencil className="size-3.5" />
                Correct
              </Button>
              <Button size="small" variant="transparent" onClick={() => onResolve("defer")}>
                <Clock className="size-3.5" />
                Later
              </Button>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1 text-green-11">
                <CheckCircle2 className="size-3.5" />
                <Text variant="small" color="secondary">
                  {review.status === "corrected" ? "Corrected" : "Confirmed"}
                </Text>
              </span>
              <Button size="small" variant="transparent" onClick={() => setCorrecting(true)}>
                <Pencil className="size-3.5" />
                Change
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Expanded detail for one document: every tracked field + an audit trail. */
function DocumentReviewCard({ docId }: { docId: number }) {
  const queryClient = useQueryClient();
  const [showAudit, setShowAudit] = useState(false);

  const detailQuery = useQuery({
    queryKey: ["reviewDetail", docId],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<ReviewDetail | null>("reviews:detail", docId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["reviewDetail", docId] });
    queryClient.invalidateQueries({ queryKey: ["reviewQueue"] });
    queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    queryClient.invalidateQueries({ queryKey: ["vaultDocuments"] });
  };

  const resolve = useMutation({
    mutationFn: (vars: {
      field: ReviewField;
      action: "confirm" | "correct" | "defer";
      value?: string;
    }) =>
      window.glazeAPI.glaze.ipc.invoke<ResolveResult>(
        "reviews:resolve",
        docId,
        vars.field,
        vars.action,
        vars.value,
      ),
    onSuccess: (result) => {
      if (result?.message) toast(result.message);
      invalidate();
    },
    onError: (error) => toast.error(`Couldn't save: ${error}`),
  });

  const confirmAll = useMutation({
    mutationFn: () =>
      window.glazeAPI.glaze.ipc.invoke<{ confirmed: number }>("reviews:confirmAll", docId),
    onSuccess: (result) => {
      if (result?.confirmed)
        toast(`Confirmed ${result.confirmed} field${result.confirmed === 1 ? "" : "s"}`);
      invalidate();
    },
    onError: (error) => toast.error(`Couldn't confirm all: ${error}`),
  });

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <div className="px-3 py-2">
        <Text variant="small" color="tertiary">
          Loading…
        </Text>
      </div>
    );
  }

  const pendingWithSuggestion = detail.fields.some(
    (f) => PENDING.has(f.status) && f.suggestedValue,
  );

  return (
    <div className="flex flex-col gap-2 border-t border-panel bg-panel/40 px-3 py-3">
      {pendingWithSuggestion ? (
        <Button
          size="small"
          variant="accent"
          className="self-start"
          onClick={() => confirmAll.mutate()}
        >
          <CheckCheck className="size-3.5" />
          Confirm all suggestions
        </Button>
      ) : null}

      {detail.fields
        .filter((f) => f.field !== "accounting")
        .map((f) => (
          <FieldReviewRow
            key={f.field}
            review={f}
            onResolve={(action, value) => resolve.mutate({ field: f.field, action, value })}
          />
        ))}

      {/* Accounting hint is advisory — surface it here, but resolve it in the
          Documents browser's Evidence Card (with a proper treatment picker). */}
      {detail.fields
        .filter((f) => f.field === "accounting")
        .map((f) => (
          <div key={f.field} className="flex flex-col gap-1 rounded-lg bg-control-subtle px-3 py-2">
            <div className="flex items-center gap-2">
              <Text variant="small-strong" className="flex-1">
                Accounting hint
              </Text>
              <Badge color={STATUS_META[f.status].color}>{STATUS_META[f.status].label}</Badge>
            </div>
            <Text variant="small" color="secondary">
              Suggested treatment: {TREATMENT_LABEL[f.finalValue ?? f.extractedValue ?? ""] ?? "—"}
              {f.reason ? ` — ${f.reason}` : ""}
            </Text>
            <Text variant="small" color="tertiary">
              Open this document in the browser to confirm or change the treatment.
            </Text>
          </div>
        ))}

      {detail.audit.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setShowAudit((v) => !v)}
            className="flex items-center gap-0.5 text-secondary hover:text-primary transition-colors self-start"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", showAudit && "rotate-90")}
            />
            <Text variant="small" color="secondary">
              Audit trail ({detail.audit.length})
            </Text>
          </button>
          {showAudit ? (
            <div className="flex flex-col gap-1 pl-1 border-l border-panel">
              {detail.audit.map((a, i) => (
                <Text key={i} variant="small" color="tertiary" className="pl-2">
                  {formatDate(a.at)} · {FIELD_LABEL[a.field]} {a.action}
                  {a.newValue ? ` → "${a.newValue}"` : a.oldValue ? ` (was "${a.oldValue}")` : ""}
                </Text>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** Logged exact-duplicate drops — kept ignored or deleted from history. */
function DuplicatesReviewBlock() {
  const queryClient = useQueryClient();
  const dupQuery = useQuery({
    queryKey: ["duplicateEvents"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<DuplicateEvent[]>("duplicates:list"),
  });

  useEffect(() => {
    const unsubscribe = window.glazeAPI.glaze.ipc.on("duplicates:changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["duplicateEvents"] });
    });
    return unsubscribe;
  }, [queryClient]);

  const resolve = useMutation({
    mutationFn: (input: { id: number; action: "acknowledge" | "delete" }) =>
      window.glazeAPI.glaze.ipc.invoke("duplicates:resolve", input.id, input.action),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["duplicateEvents"] }),
  });

  const events = dupQuery.data ?? [];
  if (events.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Text variant="small-strong" color="secondary">
        Duplicates ({events.length})
      </Text>
      <Text variant="small" color="secondary">
        Exact copies of documents already in your vault — never reprocessed.
      </Text>
      <div className="flex flex-col gap-2">
        {events.map((e) => (
          <div
            key={e.id}
            className="flex flex-col gap-2 rounded-lg border border-panel px-3 py-2.5"
          >
            <div className="flex items-center gap-2">
              <Copy className="size-4 shrink-0 text-secondary" />
              <Text
                variant="small"
                className="flex-1 min-w-0 truncate font-medium"
                title={e.filename}
              >
                {e.filename}
              </Text>
              {e.status === "acknowledged" ? (
                <Badge color="secondary">Kept ignored</Badge>
              ) : (
                <Badge color="yellow">New</Badge>
              )}
            </div>
            <Text variant="small" color="secondary" className="break-words">
              {e.reason}
            </Text>
            <div className="flex items-center gap-1.5">
              {e.duplicateOfDocId != null ? (
                <Button
                  size="small"
                  variant="transparent"
                  onClick={() =>
                    window.glazeAPI.glaze.ipc.invoke("window:openDocuments", e.duplicateOfDocId)
                  }
                >
                  <ExternalLink className="size-3.5" />
                  Inspect original
                </Button>
              ) : null}
              {e.status === "new" ? (
                <Button
                  size="small"
                  variant="transparent"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: e.id, action: "acknowledge" })}
                >
                  Keep ignored
                </Button>
              ) : null}
              <Button
                size="small"
                variant="transparent"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate({ id: e.id, action: "delete" })}
              >
                <Trash2 className="size-3.5" />
                Delete entry
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewQueueSection() {
  const [openDocId, setOpenDocId] = useState<number | null>(null);

  const queueQuery = useQuery({
    queryKey: ["reviewQueue"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<ReviewQueueItem[]>("reviews:queue"),
  });

  const items = queueQuery.data ?? [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Text variant="strong" className="flex-1">
          Review Queue
        </Text>
        {items.length > 0 ? (
          <Badge color="orange" className="tabular-nums">
            {items.length} to review
          </Badge>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-3">
          <CheckCircle2 className="size-4 text-green-11 shrink-0" />
          <Text variant="small" color="secondary">
            You&apos;re all caught up — nothing needs review.
          </Text>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Text variant="small" color="secondary">
            Documents the app wasn&apos;t sure about. Confirm, correct, or defer each field.
          </Text>
          <div className="flex flex-col gap-2">
            {items.map((item) => {
              const open = openDocId === item.docId;
              return (
                <div key={item.docId} className="rounded-lg border border-panel overflow-hidden">
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => setOpenDocId(open ? null : item.docId)}
                      className="flex-1 min-w-0 flex items-center gap-2 px-3 py-2.5 hover:bg-control-subtle transition-colors text-left"
                    >
                      <ClipboardList className="size-4 text-secondary shrink-0" />
                      <div className="flex flex-col min-w-0 flex-1 gap-1">
                        <Text
                          variant="small"
                          className="font-medium truncate"
                          title={item.filename}
                        >
                          {item.filename}
                        </Text>
                        <div className="flex flex-wrap gap-1">
                          {item.pendingFields.map((f) => (
                            <Badge key={f.field} color={STATUS_META[f.status].color}>
                              {FIELD_LABEL[f.field]}
                            </Badge>
                          ))}
                        </div>
                      </div>
                      <ChevronRight
                        className={cn(
                          "size-4 text-tertiary shrink-0 transition-transform",
                          open && "rotate-90",
                        )}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        window.glazeAPI.glaze.ipc.invoke("window:openDocuments", item.docId)
                      }
                      title="Open in Document Browser"
                      className="flex items-center px-3 border-l border-panel text-tertiary hover:text-primary hover:bg-control-subtle transition-colors"
                    >
                      <ExternalLink className="size-4" />
                    </button>
                  </div>
                  {open ? <DocumentReviewCard docId={item.docId} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <DuplicatesReviewBlock />
    </section>
  );
}

const DATE_FORMATS: DateFormat[] = ["DD-MM-YYYY", "DD MMM YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

// ── Impact mapping preferences ──────────────────────────────────────────────

interface ImpactPrefs {
  softwareInvoice: ImpactBucket;
  grocery: ImpactBucket;
  marketplace: ImpactBucket;
}

const SOFTWARE_CHOICES: ImpactBucket[] = [
  "business_expense",
  "software_utility_expense",
  "personal_expense",
];
const GROCERY_CHOICES: ImpactBucket[] = [
  "household_expense",
  "shared_family_expense",
  "personal_expense",
];
const MARKETPLACE_CHOICES: ImpactBucket[] = [
  "shopping_discretionary",
  "household_expense",
  "business_expense",
];

function ImpactPreferencesSection() {
  const queryClient = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ["impactPrefs"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<ImpactPrefs>("impactPrefs:get"),
  });
  const prefs = prefsQuery.data;

  const update = useMutation({
    mutationFn: (patch: Partial<ImpactPrefs>) =>
      window.glazeAPI.glaze.ipc.invoke<ImpactPrefs>("impactPrefs:set", patch),
    onSuccess: (next) => {
      queryClient.setQueryData(["impactPrefs"], next);
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (error) => toast.error(`Couldn't save preferences: ${error}`),
  });

  if (!prefs) return null;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <TrendingUp className="size-4 text-secondary" />
        <Text variant="strong" className="flex-1">
          Impact mapping
        </Text>
      </div>
      <Text variant="small" color="tertiary">
        Some documents can map to different financial buckets depending on your household and
        working life. These preferences steer how the app classifies them.
      </Text>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Software / AI provider invoices
          </Text>
          <Select
            value={prefs.softwareInvoice}
            onValueChange={(v) => update.mutate({ softwareInvoice: v as ImpactBucket })}
          >
            <SelectTrigger size="small" variant="filled" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOFTWARE_CHOICES.map((b) => (
                <SelectItem key={b} value={b}>
                  {IMPACT_LABEL[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Grocery / supermarket bills
          </Text>
          <Select
            value={prefs.grocery}
            onValueChange={(v) => update.mutate({ grocery: v as ImpactBucket })}
          >
            <SelectTrigger size="small" variant="filled" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROCERY_CHOICES.map((b) => (
                <SelectItem key={b} value={b}>
                  {IMPACT_LABEL[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Marketplace purchases (Amazon, Flipkart, …)
          </Text>
          <Select
            value={prefs.marketplace}
            onValueChange={(v) => update.mutate({ marketplace: v as ImpactBucket })}
          >
            <SelectTrigger size="small" variant="filled" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MARKETPLACE_CHOICES.map((b) => (
                <SelectItem key={b} value={b}>
                  {IMPACT_LABEL[b]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>
  );
}

// ── Manual recurring entries ────────────────────────────────────────────────

interface RecurringEntry {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  startDate: string | null;
  endDate: string | null;
  person: string | null;
  impactBucket: ImpactBucket;
  scope: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const FREQUENCY_OPTIONS = ["monthly", "quarterly", "annually", "weekly", "custom"] as const;
const SCOPE_OPTIONS = ["business", "personal", "shared"] as const;
const SCOPE_LABEL: Record<string, string> = {
  business: "Business",
  personal: "Personal",
  shared: "Shared",
};
const FREQUENCY_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
  weekly: "Weekly",
  custom: "Custom",
};

function RecurringEntriesSection() {
  const queryClient = useQueryClient();
  const entriesQuery = useQuery({
    queryKey: ["recurring"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<RecurringEntry[]>("recurring:list"),
  });
  const entries = entriesQuery.data ?? [];

  const addMutation = useMutation({
    mutationFn: (input: unknown) => window.glazeAPI.glaze.ipc.invoke("recurring:add", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => toast.error(`Couldn't add entry: ${error}`),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => window.glazeAPI.glaze.ipc.invoke("recurring:delete", id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recurring"] });
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    },
    onError: (error) => toast.error(`Couldn't delete entry: ${error}`),
  });

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    amount: "",
    currency: "INR",
    frequency: "monthly" as (typeof FREQUENCY_OPTIONS)[number],
    startDate: "",
    endDate: "",
    person: "",
    impactBucket: "household_expense" as ImpactBucket,
    scope: "personal" as (typeof SCOPE_OPTIONS)[number],
    notes: "",
  });

  const resetDraft = () =>
    setDraft({
      name: "",
      amount: "",
      currency: "INR",
      frequency: "monthly",
      startDate: "",
      endDate: "",
      person: "",
      impactBucket: "household_expense",
      scope: "personal",
      notes: "",
    });

  const commitAdd = () => {
    if (!draft.name.trim() || !draft.amount) return;
    addMutation.mutate({
      name: draft.name.trim(),
      amount: Number(draft.amount),
      currency: draft.currency.trim().toUpperCase() || "INR",
      frequency: draft.frequency,
      startDate: draft.startDate || null,
      endDate: draft.endDate || null,
      person: draft.person.trim() || null,
      impactBucket: draft.impactBucket,
      scope: draft.scope,
      notes: draft.notes.trim() || null,
    });
    setAdding(false);
    resetDraft();
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Repeat className="size-4 text-secondary" />
        <Text variant="strong" className="flex-1">
          Recurring entries
        </Text>
        <Button size="small" variant="transparent" onClick={() => setAdding(!adding)}>
          <Plus className="size-3.5" />
          {adding ? "Cancel" : "Add"}
        </Button>
      </div>
      <Text variant="small" color="tertiary">
        Income and expenses that don't always arrive as documents (salary, rent, SIPs, school fees,
        subscriptions, EMIs). These show up in your financial picture alongside document-derived
        events, clearly marked as manual.
      </Text>

      {adding ? (
        <div className="rounded-lg border border-panel bg-control-subtle p-3 flex flex-col gap-2.5">
          <Input
            size="small"
            placeholder="Name (e.g. Salary, Rent)"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <Input
              size="small"
              type="number"
              placeholder="Amount"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
              className="w-24"
            />
            <Input
              size="small"
              placeholder="Currency"
              value={draft.currency}
              onChange={(e) => setDraft({ ...draft, currency: e.target.value })}
              className="w-20"
            />
            <Select
              value={draft.frequency}
              onValueChange={(v) =>
                setDraft({ ...draft, frequency: v as (typeof FREQUENCY_OPTIONS)[number] })
              }
            >
              <SelectTrigger size="small" variant="filled" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCY_OPTIONS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FREQUENCY_LABEL[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <Input
              size="small"
              type="date"
              placeholder="Start date"
              value={draft.startDate}
              onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
              className="w-40"
            />
            <Input
              size="small"
              type="date"
              placeholder="End date (optional)"
              value={draft.endDate}
              onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
              className="w-40"
            />
          </div>
          <Input
            size="small"
            placeholder="Person (optional)"
            value={draft.person}
            onChange={(e) => setDraft({ ...draft, person: e.target.value })}
          />
          <div className="flex items-center gap-1.5 flex-wrap">
            <Select
              value={draft.impactBucket}
              onValueChange={(v) => setDraft({ ...draft, impactBucket: v as ImpactBucket })}
            >
              <SelectTrigger size="small" variant="filled" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMPACT_BUCKETS.map((b) => (
                  <SelectItem key={b} value={b}>
                    {IMPACT_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={draft.scope}
              onValueChange={(v) =>
                setDraft({ ...draft, scope: v as (typeof SCOPE_OPTIONS)[number] })
              }
            >
              <SelectTrigger size="small" variant="filled" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {SCOPE_LABEL[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            size="small"
            placeholder="Notes (optional)"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
          <div className="flex gap-1.5">
            <Button size="small" variant="accent" onClick={commitAdd}>
              Save
            </Button>
            <Button
              size="small"
              variant="transparent"
              onClick={() => {
                setAdding(false);
                resetDraft();
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {entries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 rounded-lg border border-panel bg-control-subtle px-3 py-2.5"
            >
              <div className="flex flex-col min-w-0 flex-1">
                <Text variant="small-strong" className="truncate" title={e.name}>
                  {e.name}
                </Text>
                <Text variant="small" color="tertiary" className="truncate">
                  {e.amount} {e.currency} · {FREQUENCY_LABEL[e.frequency] ?? e.frequency} ·{" "}
                  {IMPACT_LABEL[e.impactBucket]}
                  {e.person ? ` · ${e.person}` : ""}
                </Text>
              </div>
              <Button
                size="small"
                variant="transparent"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(e.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        !adding && (
          <Text variant="small" color="secondary">
            No recurring entries yet. Add salary, rent, SIPs, subscriptions, and other regular items
            that don't always arrive as documents.
          </Text>
        )
      )}
    </section>
  );
}

/** Editable finance / locale preferences (India defaults on first run). */
function FinancePreferencesSection() {
  const queryClient = useQueryClient();
  const prefsQuery = useQuery({
    queryKey: ["financePrefs"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<FinancePrefs>("prefs:get"),
  });
  const prefs = prefsQuery.data ?? INDIA_DEFAULTS;

  const update = useMutation({
    mutationFn: (patch: Partial<FinancePrefs>) =>
      window.glazeAPI.glaze.ipc.invoke<FinancePrefs>("prefs:set", patch),
    onSuccess: (next) => {
      queryClient.setQueryData(["financePrefs"], next);
      // FY / date / currency formatting is derived from prefs across the app.
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
    onError: (error) => toast.error(`Couldn't save preferences: ${error}`),
  });

  const month = prefs.fyStartMonth;
  const fyMar = fyLabel(financialYearKey("2026-03-31", month));
  const fyApr = fyLabel(financialYearKey("2026-04-01", month));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Coins className="size-4 text-secondary" />
        <Text variant="strong" className="flex-1">
          Finance &amp; locale
        </Text>
      </div>
      <Text variant="small" color="tertiary">
        How the app reads and shows money, dates, and financial years. Prefilled with India
        defaults; change them any time — they drive display and the financial-year classification
        everywhere.
      </Text>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Currency
          </Text>
          <Input
            size="small"
            value={prefs.currency}
            onChange={(e) =>
              queryClient.setQueryData(["financePrefs"], { ...prefs, currency: e.target.value })
            }
            onBlur={(e) =>
              update.mutate({ currency: e.target.value.trim().toUpperCase() || "INR" })
            }
            className="w-28"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Financial year starts
          </Text>
          <Select
            value={String(month)}
            onValueChange={(v) => update.mutate({ fyStartMonth: Number(v) })}
          >
            <SelectTrigger size="small" variant="filled" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MONTH_NAMES.map((name, i) => (
                <SelectItem key={name} value={String(i + 1)}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Date format
          </Text>
          <Select
            value={prefs.dateFormat}
            onValueChange={(v) => update.mutate({ dateFormat: v as DateFormat })}
          >
            <SelectTrigger size="small" variant="filled" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_FORMATS.map((f) => (
                <SelectItem key={f} value={f}>
                  {f}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Text variant="small" color="secondary">
            Number format
          </Text>
          <Select
            value={prefs.grouping}
            onValueChange={(v) =>
              update.mutate({
                grouping: v as FinancePrefs["grouping"],
                decimalSeparator: ".",
                thousandsSeparator: ",",
              })
            }
          >
            <SelectTrigger size="small" variant="filled" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="indian">Indian (1,23,456.78)</SelectItem>
              <SelectItem value="western">International (1,234,567.89)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1 rounded-lg bg-control-subtle px-3 py-2">
        <div className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5 text-tertiary shrink-0" />
          <Text variant="small" color="secondary">
            31 Mar 2026 → {fyMar} · 1 Apr 2026 → {fyApr}
          </Text>
        </div>
        <div className="flex items-center gap-1.5">
          <Hash className="size-3.5 text-tertiary shrink-0" />
          <Text variant="small" color="tertiary">
            Dates show as {formatDatePref("2026-03-31", prefs)}.
          </Text>
        </div>
      </div>
    </section>
  );
}

export function SettingsView() {
  useTheme();
  const queryClient = useQueryClient();

  // Close the window on Escape (unless typing in a control).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      window.glazeAPI.glaze.ipc.invoke("window:closeSettings");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Scroll to a requested section when opened from a deep link (e.g. the
  // snapshot quick actions → "Review Queue"). Handles both the initial open and
  // subsequent requests while the window is already open.
  useEffect(() => {
    const scrollToSection = (section: string | null) => {
      if (!section) return;
      window.setTimeout(() => {
        document
          .getElementById(`settings-${section}`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 80);
    };
    void window.glazeAPI.glaze.ipc
      .invoke<string | null>("settings:takeFocusSection")
      .then(scrollToSection)
      .catch(() => {});
    const unsubscribe = window.glazeAPI.glaze.ipc.on(
      "settings:focusSection",
      (_event, payload: unknown) => {
        const section = (payload as { section?: string } | undefined)?.section;
        if (typeof section === "string") scrollToSection(section);
      },
    );
    return () => unsubscribe();
  }, []);

  const vaultPathQuery = useQuery({
    queryKey: ["vaultPath"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<string>("vault:getVaultPath"),
  });

  const statsQuery = useQuery({
    queryKey: ["vaultStats"],
    queryFn: () =>
      window.glazeAPI.glaze.ipc.invoke<{ total: number; converted: number }>("vault:getStats"),
  });

  const documentsQuery = useQuery({
    queryKey: ["vaultDocuments"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<DocumentRecord[]>("vault:listDocuments"),
  });

  const snapshotQuery = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:getCached"),
  });

  const themeQuery = useQuery({
    queryKey: ["themeInfo"],
    queryFn: () => window.glazeAPI.nativeTheme.getInfo(),
  });

  const reassign = useMutation({
    mutationFn: (vars: { docId: number; target: string }) =>
      window.glazeAPI.glaze.ipc.invoke("people:reassignDoc", vars.docId, vars.target),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["snapshot"] }),
    onError: (error) => toast.error(`Couldn't reassign document: ${error}`),
  });

  const handleThemeChange = async (value: string) => {
    try {
      await window.glazeAPI.nativeTheme.setThemeSource(value as NativeThemeInfo["themeSource"]);
      themeQuery.refetch();
    } catch (error) {
      toast.error(`Failed to set theme: ${error}`);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await window.glazeAPI.glaze.ipc.invoke("vault:openFolder");
    } catch (error) {
      toast.error(`Failed to open vault: ${error}`);
    }
  };

  const documents = documentsQuery.data ?? [];
  const stats = statsQuery.data;
  const snapshot = snapshotQuery.data?.snapshot ?? null;
  const people = snapshot?.people ?? [];
  const peopleNames = people.map((p) => p.name);

  // Map each analyzed document to its person (null = unidentified).
  const docPerson = new Map<number, string | null>();
  for (const person of people) {
    for (const d of person.documents) docPerson.set(d.docId, person.name);
  }
  for (const d of snapshot?.unidentified?.documents ?? []) docPerson.set(d.docId, null);

  return (
    <ScrollArea
      toolbar={
        <Toolbar>
          <ToolbarContent>
            <AppLogo />
            <ToolbarTitle>Quick2Afvault</ToolbarTitle>
          </ToolbarContent>
        </Toolbar>
      }
    >
      <div className="px-5 pb-10 flex flex-col gap-8">
        {/* Vault location */}
        <section className="flex flex-col gap-3">
          <Text variant="strong">Vault</Text>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col min-w-0">
              <Text variant="small" color="secondary" className="truncate">
                {vaultPathQuery.data ?? "…"}
              </Text>
              {stats ? (
                <Text variant="small" color="tertiary" className="tabular-nums">
                  {stats.total} document{stats.total === 1 ? "" : "s"} · {stats.converted} converted
                </Text>
              ) : null}
            </div>
            <Button variant="accent" onClick={handleOpenFolder} className="shrink-0">
              <FolderOpen className="size-4" />
              Open Vault Folder
            </Button>
          </div>
        </section>

        <Separator />

        {/* Finance & locale preferences */}
        <div id="settings-finance" className="scroll-mt-4">
          <FinancePreferencesSection />
        </div>

        <Separator />

        {/* Impact mapping preferences */}
        <ImpactPreferencesSection />

        <Separator />

        {/* Manual recurring entries */}
        <RecurringEntriesSection />

        <Separator />

        {/* Review Queue */}
        <div id="settings-review-queue" className="scroll-mt-4">
          <ReviewQueueSection />
        </div>

        <Separator />

        {/* People */}
        <PeopleSection />

        <Separator />

        {/* Ingested documents */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Text variant="strong" className="flex-1">
              Documents
            </Text>
            <Button
              variant="transparent"
              onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openDocuments")}
            >
              <FileSearch className="size-4" />
              Browse documents
            </Button>
          </div>
          {documents.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>No documents yet</EmptyStateTitle>
              <EmptyStateDescription>
                Drag files onto the orb to add them to your vault.
              </EmptyStateDescription>
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Person</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead>Markdown</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => {
                  const analyzed = docPerson.has(doc.id);
                  const person = docPerson.get(doc.id);
                  const value = !analyzed ? "" : person === null ? REASSIGN_UNIDENTIFIED : person;
                  return (
                    <TableRow key={doc.id}>
                      <TableCell className="max-w-[150px] truncate" title={doc.originalFilename}>
                        {doc.originalFilename}
                      </TableCell>
                      <TableCell>
                        <Text variant="small" color="secondary">
                          {TYPE_LABEL[doc.fileType] ?? doc.fileType}
                        </Text>
                      </TableCell>
                      <TableCell>
                        {analyzed ? (
                          <Select
                            value={value}
                            onValueChange={(target) => reassign.mutate({ docId: doc.id, target })}
                          >
                            <SelectTrigger size="small" variant="filled" className="w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {peopleNames.map((n) => (
                                <SelectItem key={n} value={n}>
                                  {n}
                                </SelectItem>
                              ))}
                              <SelectItem value={REASSIGN_UNIDENTIFIED}>Unidentified</SelectItem>
                              <SelectSeparator />
                              <SelectItem value={REASSIGN_AUTO}>Reset to AI</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Text variant="small" color="tertiary">
                            Not analyzed
                          </Text>
                        )}
                      </TableCell>
                      <TableCell>
                        <Text variant="small" color="secondary" className="tabular-nums">
                          {formatDate(doc.dateIngested)}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Text variant="small" color={doc.markdownSuccess ? "green" : "tertiary"}>
                          {doc.markdownSuccess ? "Converted" : "Raw only"}
                        </Text>
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="transparent"
                          iconOnly
                          aria-label="Inspect document"
                          title="Open in Document Browser"
                          onClick={() =>
                            window.glazeAPI.glaze.ipc.invoke("window:openDocuments", doc.id)
                          }
                        >
                          <FileSearch className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>

        <Separator />

        {/* Training Mode */}
        <TrainingSection />

        <Separator />

        {/* Appearance */}
        <section className="flex items-center justify-between gap-4">
          <Text variant="strong">Appearance</Text>
          <RadioGroup
            value={themeQuery.data?.themeSource ?? "system"}
            onValueChange={handleThemeChange}
            orientation="horizontal"
          >
            <Label>
              <RadioGroupItem value="system" />
              Auto
            </Label>
            <Label>
              <RadioGroupItem value="light" />
              Light
            </Label>
            <Label>
              <RadioGroupItem value="dark" />
              Dark
            </Label>
          </RadioGroup>
        </section>
      </div>
    </ScrollArea>
  );
}
