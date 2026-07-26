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
  Check,
  ChevronRight,
  FolderOpen,
  GraduationCap,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Scissors,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";

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

type RuleType = "vendor_category" | "person_variant" | "keyword_doctype" | "source_scope";

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
}

const RULE_TYPE_LABEL: Record<RuleType, string> = {
  vendor_category: "Vendor → Category",
  person_variant: "Name variant → Person",
  keyword_doctype: "Keyword → Doc type",
  source_scope: "Account → Business / Personal",
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
          <Button size="small" variant="transparent" iconOnly onClick={() => setEditing(true)} title="Edit value">
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
          title={rule.autoApply ? "Applied automatically — click to require asking" : "Click to auto-apply"}
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
            <ChevronRight className={cn("size-3.5 transition-transform", showEvidence && "rotate-90")} />
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
      window.glazeAPI.glaze.ipc.invoke("training:addRule", vars.ruleType, vars.matchKey, vars.value),
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
        When on, the orb asks a few quick questions about each new document and learns reusable rules. Confirmed
        rules are applied automatically and won't be asked again. A readable summary is saved to RULES.md in your
        vault.
      </Text>

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
            <Button size="small" variant="accent" onClick={() => reset.mutate()} disabled={reset.isPending}>
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
        {person.isSelf ? <Star className="size-3.5 text-accent shrink-0" fill="currentColor" /> : null}
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
            <Button size="small" variant="transparent" iconOnly onClick={() => setRenaming(true)} title="Rename">
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
          <Button size="small" variant="transparent" iconOnly onClick={commitAlias} disabled={!newAlias.trim()} title="Add variant">
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
            <Button size="small" variant="transparent" onClick={onMarkSelf} title="Mark this person as yourself">
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
              <Button size="small" variant="transparent" iconOnly onClick={() => setConfirmDelete(false)}>
                <X className="size-3.5" />
              </Button>
            </>
          ) : (
            <Button size="small" variant="transparent" iconOnly onClick={() => setConfirmDelete(true)} title="Delete person">
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
    mutationFn: (v: { id: number; name: string }) => window.glazeAPI.glaze.ipc.invoke("people:rename", v.id, v.name),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't rename: ${e}`),
  });
  const setRoles = useMutation({
    mutationFn: (v: { id: number; roles: PersonRole[] }) => window.glazeAPI.glaze.ipc.invoke("people:setRoles", v.id, v.roles),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't set roles: ${e}`),
  });
  const markSelf = useMutation({
    mutationFn: (id: number) => window.glazeAPI.glaze.ipc.invoke("people:markSelf", id),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't mark Self: ${e}`),
  });
  const addAlias = useMutation({
    mutationFn: (v: { id: number; alias: string }) => window.glazeAPI.glaze.ipc.invoke("people:addAlias", v.id, v.alias),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't add variant: ${e}`),
  });
  const removeAlias = useMutation({
    mutationFn: (aliasId: number) => window.glazeAPI.glaze.ipc.invoke("people:removeAlias", aliasId),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't remove variant: ${e}`),
  });
  const splitAlias = useMutation({
    mutationFn: (v: { id: number; aliasId: number }) => window.glazeAPI.glaze.ipc.invoke("people:split", v.id, [v.aliasId]),
    onSuccess: invalidate,
    onError: (e) => toast.error(`Couldn't split: ${e}`),
  });
  const merge = useMutation({
    mutationFn: (v: { fromId: number; toId: number }) => window.glazeAPI.glaze.ipc.invoke("people:merge", v.fromId, v.toId),
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
        Canonical people the app has discovered. Merge duplicates, split a mistaken merge, add name variants, assign
        roles, and mark yourself as Self — used to resolve future documents. Changes apply to the Financial Snapshot
        instantly.
      </Text>
      {people.length === 0 ? (
        <Text variant="small" color="secondary">
          No people identified yet. Open the Financial Snapshot from the orb and tap Refresh to analyze your documents.
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

  const vaultPathQuery = useQuery({
    queryKey: ["vaultPath"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<string>("vault:getVaultPath"),
  });

  const statsQuery = useQuery({
    queryKey: ["vaultStats"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<{ total: number; converted: number }>("vault:getStats"),
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

        {/* People */}
        <PeopleSection />

        <Separator />

        {/* Ingested documents */}
        <section className="flex flex-col gap-3">
          <Text variant="strong">Documents</Text>
          {documents.length === 0 ? (
            <EmptyState>
              <EmptyStateTitle>No documents yet</EmptyStateTitle>
              <EmptyStateDescription>Drag files onto the orb to add them to your vault.</EmptyStateDescription>
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
