/**
 * Evidence Card — the canonical, inspectable view of one document.
 *
 * Four visually separated zones: a scannable summary grid (extracted fields),
 * a review-and-actions list (confidence / status + confirm · correct · later),
 * identity reasoning, and the audit trail. Field actions flow through the
 * existing Review Queue resolve handler, so corrections learn rules and never
 * overwrite a value the user already confirmed.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Text,
  toast,
  type BadgeColor,
} from "@glaze/core/components";
import { cn } from "@glaze/core/utils";
import {
  AlertTriangle,
  Archive,
  Building2,
  Calendar,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Coins,
  ExternalLink,
  FileText,
  Info,
  Landmark,
  Pencil,
  RefreshCw,
  RotateCcw,
  Scale,
  Sparkles,
  Star,
  Tag,
  Trash2,
  User,
  Wallet,
} from "lucide-react";
import { useFinancePrefs, type FinancePrefs } from "../finance";
import {
  confidenceColor,
  formatDate,
  formatForeign,
  formatInr,
  fyLabel,
  isPending,
  LIFECYCLE_META,
  ROLE_LABEL,
  SOURCE_LABEL,
  STATUS_META,
  TREATMENT_LABEL,
  TREATMENT_OPTIONS,
  type AccountingTreatment,
  type DetailField,
  type DocumentDetail,
  type LifecycleResult,
  type LifecycleState,
  type ResolveResult,
} from "./types";

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  window.glazeAPI.glaze.ipc.invoke<T>(channel, ...args);

/** A small "AI vs you" source icon. */
function SourceMark({ source }: { source: DetailField["source"] | null }) {
  if (!source) return null;
  const you = source === "user_confirmed" || source === "manual";
  const rule = source === "learned_rule";
  return (
    <span className="inline-flex items-center gap-1 text-tertiary" title={SOURCE_LABEL[source]}>
      {you ? (
        <Check className="size-3" strokeWidth={2.4} />
      ) : rule ? (
        <Wallet className="size-3" />
      ) : (
        <Sparkles className="size-3" />
      )}
      <Text variant="small" color="tertiary">
        {SOURCE_LABEL[source]}
      </Text>
    </span>
  );
}

/** One line in the scannable summary grid. */
function SummaryRow({
  icon,
  label,
  children,
  emphasize,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className={cn("mt-0.5 shrink-0", emphasize ? "text-orange-9" : "text-tertiary")}>{icon}</span>
      <Text variant="small" color="tertiary" className="w-28 shrink-0 pt-px">
        {label}
      </Text>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

/** A reviewable field with confirm / correct / later actions. */
function FieldRow({ docId, field, onChanged }: { docId: number; field: DetailField; onChanged: () => void }) {
  const [correcting, setCorrecting] = useState(false);
  const [draft, setDraft] = useState(field.value ?? field.suggestedValue ?? "");
  const [showWhy, setShowWhy] = useState(false);
  const queryClient = useQueryClient();
  const meta = STATUS_META[field.status];
  const pending = isPending(field.status);

  const resolve = useMutation({
    mutationFn: (input: { action: "confirm" | "correct" | "defer"; value?: string }) =>
      invoke<ResolveResult>("reviews:resolve", docId, field.field, input.action, input.value),
    onSuccess: (result) => {
      if (result?.message && !result.ok) {
        toast(result.message);
      } else if (result?.ruleLearned) {
        toast("Learned a rule from your correction");
      } else if (result?.ruleReinforced) {
        toast("Reinforced a rule from your correction");
      }
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
      onChanged();
    },
  });

  const commit = () => {
    const next = draft.trim();
    if (next && next !== field.value) resolve.mutate({ action: "correct", value: next });
    setCorrecting(false);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Text variant="small-strong" className="flex-1 min-w-0 truncate">
          {field.label}
        </Text>
        {field.userTouched ? (
          <Badge color="blue" title="You set this value">
            Edited by you
          </Badge>
        ) : null}
        <Badge color={meta.color}>{meta.label}</Badge>
        <Badge color={confidenceColor(field.confidence)} className="tabular-nums">
          {Math.round(field.confidence * 100)}%
        </Badge>
      </div>

      {correcting ? (
        <div className="flex items-center gap-1.5">
          <Input
            size="small"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setCorrecting(false);
            }}
            onBlur={commit}
            placeholder={`Correct ${field.label.toLowerCase()}`}
            className="flex-1"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Text variant="small" color={field.value ? "primary" : "tertiary"} className="flex-1 min-w-0 break-words">
            {field.value ?? "Not detected"}
          </Text>
          <SourceMark source={field.source} />
        </div>
      )}

      {field.reason ? (
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          className="flex items-center gap-0.5 self-start text-secondary hover:text-primary transition-colors"
        >
          <Info className="size-3.5" />
          <Text variant="small" color="secondary">
            {showWhy ? "Hide reason" : "Why?"}
          </Text>
        </button>
      ) : null}
      {showWhy && field.reason ? (
        <Text variant="small" color="secondary" className="pl-5 break-words">
          {field.reason}
        </Text>
      ) : null}

      <div className="flex items-center gap-1.5 pt-0.5">
        {pending ? (
          <Button
            size="small"
            variant="accent"
            onClick={() => resolve.mutate({ action: "confirm", value: field.suggestedValue ?? field.value ?? undefined })}
            disabled={resolve.isPending}
          >
            <CheckCircle2 className="size-3.5" />
            Confirm
          </Button>
        ) : null}
        <Button
          size="small"
          variant="transparent"
          onClick={() => {
            setDraft(field.value ?? field.suggestedValue ?? "");
            setCorrecting(true);
          }}
          disabled={resolve.isPending}
        >
          <Pencil className="size-3.5" />
          Correct
        </Button>
        {pending ? (
          <Button size="small" variant="transparent" onClick={() => resolve.mutate({ action: "defer" })} disabled={resolve.isPending}>
            <Clock className="size-3.5" />
            Later
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AuditTrail({ audit }: { audit: DocumentDetail["audit"] }) {
  const [open, setOpen] = useState(false);
  if (audit.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 self-start text-secondary hover:text-primary transition-colors"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        <Text variant="small-strong" color="secondary">
          Audit trail ({audit.length})
        </Text>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 pl-1 border-l border-separator">
          {audit.map((entry) => (
            <div key={entry.id} className="flex flex-col gap-0.5 pl-3">
              <div className="flex items-center gap-1.5">
                <Text variant="small" className="capitalize">
                  {entry.action}
                </Text>
                <Text variant="small" color="tertiary">
                  · {entry.field.replace(/_/g, " ")}
                </Text>
                <Text variant="small" color="tertiary" className="ml-auto tabular-nums">
                  {formatDate(entry.at)}
                </Text>
              </div>
              {entry.oldValue || entry.newValue ? (
                <Text variant="small" color="secondary" className="break-words">
                  {entry.oldValue ? <span className="line-through text-tertiary">{entry.oldValue}</span> : null}
                  {entry.oldValue && entry.newValue ? " → " : null}
                  {entry.newValue ?? ""}
                </Text>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function treatmentColor(t: AccountingTreatment): BadgeColor {
  switch (t) {
    case "needs_accounting_review":
      return "orange";
    case "prepaid_expense":
    case "accrued_expense":
    case "deferred_revenue":
      return "yellow";
    case "recognized_revenue":
    case "current_period_expense":
      return "green";
    case "reimbursement":
      return "blue";
    default:
      return "secondary";
  }
}

/**
 * The advisory Accounting Policy Hint — kept separate from the raw facts and
 * always framed as a suggestion. Lets the user override the treatment (which
 * teaches a vendor rule) or confirm/defer the suggestion.
 */
function AccountingBlock({
  detail,
  prefs,
  onChanged,
}: {
  detail: DocumentDetail;
  prefs: FinancePrefs;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const acc = detail.fields.find((f) => f.field === "accounting");
  const hint = detail.accounting;
  const treatment = (hint?.treatment ?? (acc?.value as AccountingTreatment | null) ?? null) as AccountingTreatment | null;

  const resolve = useMutation({
    mutationFn: (input: { action: "confirm" | "correct" | "defer"; value?: string }) =>
      invoke<ResolveResult>("reviews:resolve", detail.docId, "accounting", input.action, input.value),
    onSuccess: (result) => {
      if (result?.ruleLearned) toast("Learned an accounting rule from your choice");
      else if (result?.ruleReinforced) toast("Reinforced your accounting rule");
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
      onChanged();
    },
  });

  if (!acc && !hint) return null;
  const confidence = hint?.confidence ?? acc?.confidence ?? 0;
  const reason = hint?.reason ?? acc?.reason ?? "";
  const pending = acc ? isPending(acc.status) : false;
  const userTouched = acc?.userTouched ?? false;

  return (
    <>
      <Separator />
      <div className="flex flex-col gap-2 rounded-lg bg-well px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Scale className="size-4 text-tertiary" />
          <Text variant="small-strong" className="flex-1">
            Accounting hint
          </Text>
          {userTouched ? <Badge color="blue">Edited by you</Badge> : null}
          {acc ? <Badge color={STATUS_META[acc.status].color}>{STATUS_META[acc.status].label}</Badge> : null}
          {confidence > 0 ? (
            <Badge color={confidenceColor(confidence)} className="tabular-nums">
              {Math.round(confidence * 100)}%
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Text variant="small" color="tertiary" className="w-28 shrink-0">
            Suggested treatment
          </Text>
          {treatment ? (
            <Badge color={treatmentColor(treatment)}>{TREATMENT_LABEL[treatment]}</Badge>
          ) : (
            <Text variant="small" color="tertiary">
              Not applicable
            </Text>
          )}
        </div>

        {hint && (hint.servicePeriodStart || hint.servicePeriodEnd || hint.paymentDate) ? (
          <div className="flex flex-col gap-0.5">
            {hint.servicePeriodStart || hint.servicePeriodEnd ? (
              <div className="flex items-center gap-1.5">
                <CalendarClock className="size-3.5 text-tertiary shrink-0" />
                <Text variant="small" color="secondary">
                  Service period: {formatDate(hint.servicePeriodStart, prefs)} – {formatDate(hint.servicePeriodEnd, prefs)}
                </Text>
              </div>
            ) : null}
            {hint.paymentDate ? (
              <div className="flex items-center gap-1.5">
                <Landmark className="size-3.5 text-tertiary shrink-0" />
                <Text variant="small" color="secondary">
                  Payment date: {formatDate(hint.paymentDate, prefs)}
                </Text>
              </div>
            ) : null}
          </div>
        ) : null}

        {reason ? (
          <Text variant="small" color="secondary" className="break-words">
            {reason}
          </Text>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Text variant="small" color="tertiary">
            Set treatment
          </Text>
          <Select value={treatment ?? undefined} onValueChange={(v) => resolve.mutate({ action: "correct", value: v })}>
            <SelectTrigger size="small" variant="filled" className="w-56">
              <SelectValue placeholder="Choose a treatment…" />
            </SelectTrigger>
            <SelectContent>
              {TREATMENT_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {TREATMENT_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pending ? (
            <Button
              size="small"
              variant="accent"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate({ action: "confirm", value: acc?.suggestedValue ?? treatment ?? undefined })}
            >
              <CheckCircle2 className="size-3.5" />
              Confirm
            </Button>
          ) : null}
          {pending ? (
            <Button size="small" variant="transparent" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: "defer" })}>
              <Clock className="size-3.5" />
              Later
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-1 text-tertiary">
          <Info className="size-3 shrink-0" />
          <Text variant="small" color="tertiary">
            Suggested treatment — an accounting hint, not a booked entry or accounting advice.
          </Text>
        </div>
      </div>
    </>
  );
}

/** A calm banner explaining a non-active lane, or a filename-collision note. */
function LifecycleBanner({ state, reason }: { state: LifecycleState; reason: string | null }) {
  if (state === "active" && !reason) return null;
  const meta = LIFECYCLE_META[state];
  const tone =
    state === "irrelevant"
      ? "border-separator bg-well"
      : state === "excluded"
        ? "border-orange-6 bg-orange-2"
        : state === "reprocess_requested"
          ? "border-blue-6 bg-blue-2"
          : "border-separator bg-well";
  return (
    <div className={cn("flex items-start gap-2 rounded-card border px-3 py-2.5", tone)}>
      <Info className="mt-0.5 size-4 shrink-0 text-secondary" />
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-1.5">
          {state !== "active" ? <Badge color={meta.color}>{meta.label}</Badge> : null}
        </div>
        {reason ? (
          <Text variant="small" color="secondary" className="break-words">
            {reason}
          </Text>
        ) : null}
      </div>
    </div>
  );
}

/** Deliberate, reversible lane controls for a document (exclude / restore / reprocess / delete). */
function LifecycleActions({
  docId,
  state,
  onChanged,
}: {
  docId: number;
  state: LifecycleState;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const act = useMutation({
    mutationFn: (input: { channel: string; args: unknown[] }) =>
      invoke<LifecycleResult>(input.channel, ...input.args),
    onSuccess: (result) => {
      if (result?.message) toast(result.message);
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
      onChanged();
    },
  });

  const run = (channel: string, ...args: unknown[]) => act.mutate({ channel, args });
  const busy = act.isPending;

  return (
    <>
      <Separator />
      <div className="flex flex-col gap-2">
        <Text variant="small-strong" color="secondary">
          Manage this document
        </Text>
        <div className="flex flex-wrap items-center gap-1.5">
          {state === "active" ? (
            <>
              <Button size="small" variant="transparent" disabled={busy} onClick={() => run("documents:reprocess", docId, "now")}>
                <RefreshCw className="size-3.5" />
                Reprocess
              </Button>
              <Button size="small" variant="transparent" disabled={busy} onClick={() => run("documents:exclude", docId)}>
                <Archive className="size-3.5" />
                Remove from active
              </Button>
            </>
          ) : null}

          {state === "irrelevant" ? (
            <Button size="small" variant="accent" disabled={busy} onClick={() => run("documents:restore", docId)}>
              <RotateCcw className="size-3.5" />
              Restore &amp; process
            </Button>
          ) : null}

          {state === "excluded" ? (
            <>
              <Button size="small" variant="accent" disabled={busy} onClick={() => run("documents:restore", docId)}>
                <RotateCcw className="size-3.5" />
                Restore to active
              </Button>
              <Button size="small" variant="transparent" disabled={busy} onClick={() => run("documents:reprocess", docId, "now")}>
                <RefreshCw className="size-3.5" />
                Reprocess
              </Button>
            </>
          ) : null}

          {state === "reprocess_requested" ? (
            <>
              <Button size="small" variant="accent" disabled={busy} onClick={() => run("documents:reprocess", docId, "now")}>
                <RefreshCw className="size-3.5" />
                Reprocess now
              </Button>
              <Button size="small" variant="transparent" disabled={busy} onClick={() => run("documents:restore", docId)}>
                Cancel request
              </Button>
            </>
          ) : null}

          {confirmingDelete ? (
            <>
              <Button size="small" variant="destructive" disabled={busy} onClick={() => run("documents:deletePermanently", docId)}>
                <Trash2 className="size-3.5" />
                Confirm delete
              </Button>
              <Button size="small" variant="transparent" disabled={busy} onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button size="small" variant="transparent" disabled={busy} onClick={() => setConfirmingDelete(true)}>
              <Trash2 className="size-3.5" />
              Delete permanently
            </Button>
          )}
        </div>
        {confirmingDelete ? (
          <Text variant="small" color="tertiary">
            This removes the file from disk and the app. This can&apos;t be undone.
          </Text>
        ) : (
          <Text variant="small" color="tertiary">
            Removing from active keeps the original file safe — you can restore or reprocess it anytime.
          </Text>
        )}
      </div>
    </>
  );
}

export function EvidenceCard({ detail, onChanged }: { detail: DocumentDetail; onChanged: () => void }) {
  const [showIdentity, setShowIdentity] = useState(false);
  const queryClient = useQueryClient();
  const prefs = useFinancePrefs();
  const p = detail.person;

  const confirmAll = useMutation({
    mutationFn: () => invoke<{ confirmed: number }>("reviews:confirmAll", detail.docId),
    onSuccess: (result) => {
      if (result?.confirmed > 0) toast(`Confirmed ${result.confirmed} suggestion${result.confirmed === 1 ? "" : "s"}`);
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
      onChanged();
    },
  });

  const openFile = () => {
    void invoke<string>("documents:open", detail.docId).then((err) => {
      if (err) toast(err);
    });
  };

  const pendingCount = detail.fields.filter((f) => isPending(f.status)).length;
  const cur = detail.currency;

  return (
    <div className="flex flex-col gap-3">
      {/* Lane / triage context */}
      <LifecycleBanner state={detail.lifecycleState} reason={detail.triageReason} />

      {/* Summary — scan in seconds */}
      <div className="flex flex-col divide-y divide-separator">
        <SummaryRow icon={<User className="size-4" />} label="Person">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text variant="small-strong" className={cn(!p.name && "text-tertiary")}>
              {p.name ?? "Unidentified"}
            </Text>
            {p.isSelf ? (
              <Badge color="blue">
                <Star className="size-3" /> Self
              </Badge>
            ) : null}
            {p.roles.map((r) => (
              <Badge key={r} color="secondary">
                {ROLE_LABEL[r]}
              </Badge>
            ))}
            {p.source ? <SourceMark source={p.source} /> : null}
          </div>
        </SummaryRow>

        <SummaryRow icon={<FileText className="size-4" />} label="Document type">
          <Text variant="small" color={detail.docType ? "primary" : "tertiary"}>
            {detail.docType ?? "Unknown"}
          </Text>
        </SummaryRow>

        <SummaryRow icon={<Building2 className="size-4" />} label="Vendor">
          <Text variant="small" color={detail.vendor ? "primary" : "tertiary"}>
            {detail.vendor ?? "Unknown"}
          </Text>
        </SummaryRow>

        <SummaryRow icon={<Calendar className="size-4" />} label="Document date">
          <Text variant="small" color={detail.docDate ? "primary" : "tertiary"} className="tabular-nums">
            {formatDate(detail.docDate, prefs)}
          </Text>
        </SummaryRow>

        <SummaryRow
          icon={<CalendarClock className="size-4" />}
          label="Financial year"
          emphasize={!detail.financialYear}
        >
          <Text variant="small" color={detail.financialYear ? "primary" : "tertiary"} className="tabular-nums">
            {detail.financialYear ? fyLabel(detail.financialYear) : "Not determined — needs a document date"}
          </Text>
        </SummaryRow>

        <SummaryRow icon={<Tag className="size-4" />} label="Category">
          <div className="flex flex-wrap items-center gap-1.5">
            <Text variant="small" color={detail.category ? "primary" : "tertiary"}>
              {detail.category ?? "Uncategorized"}
            </Text>
            {detail.scope ? (
              <Badge color={detail.scope === "business" ? "purple" : "secondary"} title={detail.scopeEvidence ?? undefined}>
                {detail.scope === "business" ? "Business" : "Personal"}
              </Badge>
            ) : null}
          </div>
        </SummaryRow>

        {cur.currencyStatus !== "none" ? (
          <SummaryRow
            icon={<Coins className="size-4" />}
            label="Currency"
            emphasize={cur.currencyStatus === "needs_review"}
          >
            {cur.currencyStatus === "converted" && cur.foreignAmount != null && cur.foreignCurrency && cur.inrValue != null ? (
              <div className="flex flex-col gap-0.5">
                <Text variant="small" className="tabular-nums">
                  {formatForeign(cur.foreignAmount, cur.foreignCurrency, prefs)} → {formatInr(cur.inrValue, prefs)}
                </Text>
                {cur.rateUsed != null && cur.rateDate ? (
                  <Text variant="small" color="tertiary" className="tabular-nums">
                    rate {cur.rateUsed} · {cur.rateDate}
                    {cur.rateIsNearest ? " (nearest available)" : ""}
                  </Text>
                ) : null}
              </div>
            ) : (
              <Text variant="small" color="secondary">
                Foreign amount detected — couldn&apos;t be converted confidently.
              </Text>
            )}
          </SummaryRow>
        ) : null}
      </div>

      {/* Accounting policy hint (advisory) */}
      <AccountingBlock detail={detail} prefs={prefs} onChanged={onChanged} />

      {/* Identity reasoning */}
      {(p.aliases.length > 0 || p.evidence.length > 0) ? (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => setShowIdentity((v) => !v)}
              className="flex items-center gap-1 self-start text-secondary hover:text-primary transition-colors"
            >
              <ChevronRight className={cn("size-3.5 transition-transform", showIdentity && "rotate-90")} />
              <Text variant="small-strong" color="secondary">
                Identity reasoning
              </Text>
            </button>
            {showIdentity ? (
              <div className="flex flex-col gap-2 pl-5">
                {p.aliases.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Text variant="small" color="tertiary" className="mr-1">
                      Name variants
                    </Text>
                    {p.aliases.map((a) => (
                      <Badge key={a} color="secondary">
                        {a}
                      </Badge>
                    ))}
                  </div>
                ) : null}
                {p.evidence.map((e, i) => (
                  <Text key={i} variant="small" color="secondary" className="break-words">
                    · {e.detail}
                  </Text>
                ))}
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {/* Review & actions */}
      <Separator />
      <div className="flex items-center gap-2">
        <Text variant="small-strong" className="flex-1">
          Fields & evidence
        </Text>
        {pendingCount > 0 ? (
          <Button size="small" variant="transparent" onClick={() => confirmAll.mutate()} disabled={confirmAll.isPending}>
            <CheckCircle2 className="size-3.5" />
            Confirm all suggestions
          </Button>
        ) : (
          <span className="inline-flex items-center gap-1 text-support-green">
            <CheckCircle2 className="size-3.5" />
            <Text variant="small" color="green">
              All reviewed
            </Text>
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        {detail.fields.length === 0 ? (
          <Text variant="small" color="tertiary">
            No field intelligence recorded yet for this document.
          </Text>
        ) : (
          detail.fields
            .filter((f) => f.field !== "accounting")
            .map((f) => <FieldRow key={f.field} docId={detail.docId} field={f} onChanged={onChanged} />)
        )}
      </div>

      {/* Evidence excerpt */}
      {detail.markdownExcerpt ? (
        <>
          <Separator />
          <div className="flex flex-col gap-1.5">
            <Text variant="small-strong" color="secondary">
              Source excerpt
            </Text>
            <div className="rounded-lg bg-well px-3 py-2 max-h-40 overflow-auto">
              <Text variant="small" color="secondary" className="whitespace-pre-wrap break-words">
                {detail.markdownExcerpt}
              </Text>
            </div>
          </div>
        </>
      ) : null}

      {/* Audit trail */}
      <Separator />
      <AuditTrail audit={detail.audit} />

      {/* File actions */}
      <Separator />
      <div className="flex items-center gap-1.5">
        <Button size="small" variant="transparent" onClick={openFile}>
          <ExternalLink className="size-3.5" />
          Open original
        </Button>
        <Button
          size="small"
          variant="transparent"
          onClick={() => {
            void invoke<string>("documents:openMarkdown", detail.docId).then((err) => {
              if (err) toast(err);
            });
          }}
        >
          <FileText className="size-3.5" />
          Open Markdown
        </Button>
      </div>
      {detail.fields.some((f) => f.status === "conflict") ? (
        <div className="flex items-center gap-1.5 text-orange-9">
          <AlertTriangle className="size-3.5" />
          <Text variant="small" color="orange">
            This document has conflicting signals — review the flagged fields above.
          </Text>
        </div>
      ) : null}

      {/* Lifecycle controls — deliberate and reversible */}
      <LifecycleActions docId={detail.docId} state={detail.lifecycleState} onChanged={onChanged} />
    </div>
  );
}
