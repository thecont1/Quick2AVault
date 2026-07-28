import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ScrollArea, Separator, Text } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CalendarRange,
  ChevronRight,
  ClipboardList,
  Coins,
  FileText,
  Files,
  GraduationCap,
  HelpCircle,
  LineChart,
  Loader2,
  RefreshCw,
  Repeat,
  Settings,
  User,
  Users,
  Vault,
} from "lucide-react";

interface DocRef {
  docId: number;
  filename: string;
}

interface ForeignInvoice {
  docId: number;
  filename: string;
  amount: number;
  currency: string;
  inrValue: number;
  rateUsed: number;
  rateDate: string;
  rateIsNearest: boolean;
}

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

interface PersonSummary {
  name: string;
  personId: number | null;
  roles: PersonRole[];
  isSelf: boolean;
  documentCount: number;
  dateRange: { start: string; end: string } | null;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

interface UnidentifiedSummary {
  documentCount: number;
  categories: string[];
  documents: DocRef[];
  foreignInvoices: ForeignInvoice[];
  foreignTotalInr: number;
}

interface NeedsReviewDoc {
  docId: number;
  filename: string;
  currency: string | null;
  amount: number | null;
}

interface NeedsReviewSummary {
  documentCount: number;
  documents: NeedsReviewDoc[];
}

interface FinancialYearSummary {
  key: string;
  label: string;
  documentCount: number;
}

type ImpactDirection = "in" | "out" | "neutral";

interface SnapshotTotals {
  income: number;
  householdExpenses: number;
  businessExpenses: number;
  investments: number;
  recurringMonthlyOutflow: number;
  reviewCount: number;
  documentCount: number;
}

interface ImpactBucketSummary {
  bucket: string;
  label: string;
  direction: ImpactDirection;
  totalInr: number;
  documentCount: number;
}

interface InvestmentSecurity {
  name: string;
  symbol: string | null;
  isin: string | null;
  buyQuantity: number;
  sellQuantity: number;
  buyAmount: number;
  sellAmount: number;
}

interface InvestmentByPerson {
  name: string;
  buyAmount: number;
  sellAmount: number;
  documentCount: number;
}

interface InvestmentActivity {
  totalBuy: number;
  totalSell: number;
  documentCount: number;
  tradeCount: number;
  securities: InvestmentSecurity[];
  byPerson: InvestmentByPerson[];
}

interface RecurringEntryView {
  id: number;
  name: string;
  amount: number;
  currency: string;
  frequency: string;
  person: string | null;
  bucket: string;
  bucketLabel: string;
  scope: string;
  direction: ImpactDirection;
  monthlyEquivalent: number;
  active: boolean;
}

interface RecurringSummary {
  entries: RecurringEntryView[];
  monthlyOutflow: number;
  monthlyInflow: number;
  hasOtherCurrencies: boolean;
}

interface SnapshotData {
  totals: SnapshotTotals;
  impactBuckets: ImpactBucketSummary[];
  investments: InvestmentActivity | null;
  recurring: RecurringSummary;
  people: PersonSummary[];
  unidentified: UnidentifiedSummary | null;
  needsReview: NeedsReviewSummary | null;
  financialYears: FinancialYearSummary[];
}

const ZERO_TOTALS: SnapshotTotals = {
  income: 0,
  householdExpenses: 0,
  businessExpenses: 0,
  investments: 0,
  recurringMonthlyOutflow: 0,
  reviewCount: 0,
  documentCount: 0,
};

interface FallbackStats {
  totalDocuments: number;
  documents: { filename: string; fileType: string; dateIngested: string }[];
  dateRange: { start: string; end: string } | null;
}

interface SnapshotResponse {
  snapshot: SnapshotData | null;
  generatedAt: string | null;
  aiBlocked?: string;
  error?: string;
  fallback: FallbackStats;
}

const BLOCKED_MESSAGE: Record<string, string> = {
  "needs-consent": "AI-powered summaries need AI access. Grant access when prompted, then Refresh.",
  "signed-out": "Sign in to Glaze to generate AI summaries.",
  "needs-subscription": "AI summaries need an upgraded Glaze plan. Refresh to see options.",
  "insufficient-credits": "You're out of Glaze AI credits for now.",
  "daily-limit-reached": "You've reached today's AI limit for this app.",
  "host-unavailable": "Glaze couldn't be reached. Refresh to try again.",
  disabled: "AI is currently unavailable for this account.",
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "Not generated yet";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  const diffMs = Date.now() - date.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Updated just now";
  if (mins < 60) return `Updated ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function formatRange(range: { start: string; end: string } | null): string | null {
  if (!range) return null;
  const start = range.start?.trim();
  const end = range.end?.trim();
  if (!start && !end) return null;
  if (!start) return end ?? null;
  if (!end || start === end) return start;
  return `${start} – ${end}`;
}

function formatInr(amount: number): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `₹${Math.round(amount).toLocaleString()}`;
  }
}

function formatForeign(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toLocaleString()} ${currency}`;
  }
}

/** A collapsible "Foreign invoices" line: total INR, expandable to a per-invoice breakdown. */
function ForeignInvoices({ invoices, totalInr }: { invoices: ForeignInvoice[]; totalInr: number }) {
  const [expanded, setExpanded] = useState(false);
  if (invoices.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 pt-0.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-secondary hover:text-primary transition-colors"
      >
        <Coins className="size-3.5 shrink-0" />
        <Text variant="small" color="secondary" className="flex-1 text-left">
          Foreign invoices
        </Text>
        <Text variant="small" className="tabular-nums font-medium shrink-0">
          {formatInr(totalInr)}
        </Text>
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
        />
      </button>
      {expanded ? (
        <div className="flex flex-col gap-2 pl-1 border-l border-panel">
          {invoices.map((inv) => (
            <div key={inv.docId} className="flex flex-col gap-0.5 pl-2">
              <div className="flex items-center gap-1.5">
                <Text variant="small" className="tabular-nums">
                  {formatForeign(inv.amount, inv.currency)}
                </Text>
                <ArrowRight className="size-3 text-tertiary shrink-0" />
                <Text variant="small" className="tabular-nums font-medium">
                  {formatInr(inv.inrValue)}
                </Text>
              </div>
              <Text variant="small" color="tertiary" className="truncate" title={inv.filename}>
                {inv.filename}
              </Text>
              <Text variant="small" color="tertiary" className="tabular-nums">
                Rate {inv.rateUsed.toFixed(4)} · {inv.rateDate}
                {inv.rateIsNearest ? " (nearest available)" : ""}
              </Text>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Documents where a foreign amount was detected but couldn't be converted confidently. */
function NeedsReviewCard({ needsReview }: { needsReview: NeedsReviewSummary }) {
  const [expanded, setExpanded] = useState(false);
  const { documentCount, documents } = needsReview;
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-orange-9 text-white shrink-0">
          <AlertTriangle className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="flex-1">
          Needs review
        </Text>
        <Badge color="secondary" className="tabular-nums shrink-0">
          {documentCount} doc{documentCount === 1 ? "" : "s"}
        </Badge>
      </div>
      <Text variant="small" color="secondary">
        A foreign amount was detected but couldn&apos;t be converted confidently — check{" "}
        {documentCount === 1 ? "it" : "these"} before trusting a rupee value.
      </Text>
      {documents.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-secondary hover:text-primary transition-colors self-start"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
            <Text variant="small" color="secondary">
              {expanded ? "Hide files" : "View files"}
            </Text>
          </button>
          {expanded ? (
            <div className="flex flex-col gap-1.5 pl-1 border-l border-panel">
              {documents.map((doc) => (
                <div key={doc.docId} className="flex flex-col gap-0.5 pl-2">
                  <button
                    type="button"
                    onClick={() =>
                      window.glazeAPI.glaze.ipc.invoke("window:openDocuments", doc.docId)
                    }
                    className="flex items-center gap-1.5 text-left hover:text-primary transition-colors"
                    title={`Inspect ${doc.filename}`}
                  >
                    <FileText className="size-3.5 text-tertiary shrink-0" />
                    <Text variant="small" color="tertiary" className="truncate">
                      {doc.filename}
                    </Text>
                  </button>
                  {doc.currency || doc.amount != null ? (
                    <Text variant="small" color="tertiary" className="pl-5 tabular-nums">
                      Detected:{" "}
                      {doc.amount != null && doc.currency
                        ? formatForeign(doc.amount, doc.currency)
                        : (doc.currency ?? "amount unclear")}
                    </Text>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function UnidentifiedCard({ unidentified }: { unidentified: UnidentifiedSummary }) {
  const [expanded, setExpanded] = useState(false);
  const { documentCount, categories, documents } = unidentified;
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-orange-9 text-white shrink-0">
          <HelpCircle className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="flex-1">
          Unidentified
        </Text>
        <Badge color="secondary" className="tabular-nums shrink-0">
          {documentCount} doc{documentCount === 1 ? "" : "s"}
        </Badge>
      </div>
      <Text variant="small" color="secondary">
        {documentCount === 1 ? "This document" : "These documents"} couldn&apos;t be confidently
        linked to a person.
      </Text>
      {categories.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <Badge key={c} color="secondary">
              {c}
            </Badge>
          ))}
        </div>
      ) : null}
      {documents.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-secondary hover:text-primary transition-colors self-start"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
            <Text variant="small" color="secondary">
              {expanded ? "Hide files" : "View files"}
            </Text>
          </button>
          {expanded ? (
            <div className="flex flex-col gap-1 pl-1 border-l border-panel">
              {documents.map((doc) => (
                <button
                  key={doc.docId}
                  type="button"
                  onClick={() =>
                    window.glazeAPI.glaze.ipc.invoke("window:openDocuments", doc.docId)
                  }
                  className="flex items-center gap-1.5 pl-2 text-left hover:text-primary transition-colors"
                  title={`Inspect ${doc.filename}`}
                >
                  <FileText className="size-3.5 text-tertiary shrink-0" />
                  <Text variant="small" color="tertiary" className="truncate">
                    {doc.filename}
                  </Text>
                </button>
              ))}
              <Text variant="small" color="tertiary" className="pl-2 pt-1 italic">
                Tip: click a file to inspect it, or reassign people in Settings.
              </Text>
            </div>
          ) : null}
        </>
      ) : null}
      <ForeignInvoices
        invoices={unidentified.foreignInvoices}
        totalInr={unidentified.foreignTotalInr}
      />
    </div>
  );
}

function PersonCard({
  name,
  roles,
  isSelf,
  documentCount,
  dateRange,
  categories,
  foreignInvoices,
  foreignTotalInr,
  icon,
}: PersonSummary & { icon: "user" | "users" }) {
  const range = formatRange(dateRange);
  const Icon = icon === "users" ? Users : User;
  const roleBadges = (roles ?? []).filter((r) => r !== "self");
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-accent text-accent-contrast shrink-0">
          <Icon className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="truncate flex-1" title={name}>
          {name}
        </Text>
        {isSelf ? <Badge color="blue">Self</Badge> : null}
        <Text variant="small" color="secondary" className="tabular-nums shrink-0">
          {documentCount} doc{documentCount === 1 ? "" : "s"}
        </Text>
      </div>
      {roleBadges.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {roleBadges.map((r) => (
            <Badge key={r} color="secondary">
              {ROLE_LABEL[r]}
            </Badge>
          ))}
        </div>
      ) : null}
      {range ? (
        <div className="flex items-center gap-1.5 text-secondary">
          <CalendarRange className="size-3.5 shrink-0" />
          <Text variant="small" color="secondary">
            {range}
          </Text>
        </div>
      ) : null}
      {categories.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {categories.map((c) => (
            <Badge key={c} color="secondary">
              {c}
            </Badge>
          ))}
        </div>
      ) : null}
      <ForeignInvoices invoices={foreignInvoices} totalInr={foreignTotalInr} />
    </div>
  );
}

/** One big, blocky hero number. */
function HeroStat({ label, amount, accent }: { label: string; amount: number; accent?: boolean }) {
  return (
    <div
      className={cn(
        "flex flex-col gap-0.5 rounded-xl border px-3 py-3",
        accent ? "border-accent/40 bg-accent/10" : "border-panel bg-control-subtle",
      )}
    >
      <Text
        variant="mini"
        color="tertiary"
        className="uppercase tracking-wide truncate"
        title={label}
      >
        {label}
      </Text>
      <Text variant="heading2" className="tabular-nums leading-none">
        {formatInr(amount)}
      </Text>
    </div>
  );
}

/** The at-a-glance money dashboard — the primary purpose of the surface. */
function HeroNumbers({ totals }: { totals: SnapshotTotals }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <HeroStat label="Income" amount={totals.income} accent />
        <HeroStat label="Investments" amount={totals.investments} accent />
        <HeroStat label="Household" amount={totals.householdExpenses} />
        <HeroStat label="Business" amount={totals.businessExpenses} />
      </div>
      {totals.recurringMonthlyOutflow > 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-panel bg-control-subtle px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-secondary">
            <Repeat className="size-3.5 shrink-0" />
            <Text variant="small" color="secondary">
              Recurring / month
            </Text>
          </div>
          <Text variant="large-strong" className="tabular-nums">
            {formatInr(totals.recurringMonthlyOutflow)}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

/** Secondary, quieter breakdown of every impact bucket that carries a value. */
function ImpactBreakdown({ buckets }: { buckets: ImpactBucketSummary[] }) {
  const rows = buckets.filter((b) => b.totalInr > 0 || b.documentCount > 0);
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <Text variant="small" color="secondary">
        Where it went
      </Text>
      <div className="flex flex-col gap-1">
        {rows.map((b) => (
          <div key={b.bucket} className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                b.direction === "in"
                  ? "bg-green-9"
                  : b.direction === "neutral"
                    ? "bg-tertiary"
                    : "bg-accent",
              )}
            />
            <Text variant="small" className="flex-1 truncate" title={b.label}>
              {b.label}
            </Text>
            <Text variant="small" color="tertiary" className="tabular-nums shrink-0">
              {b.documentCount}
            </Text>
            <Text variant="small-strong" className="tabular-nums shrink-0 w-20 text-right">
              {formatInr(b.totalInr)}
            </Text>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Document-driven securities trade activity (never portfolio valuation). */
function InvestmentSection({ investments }: { investments: InvestmentActivity }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-accent text-accent-contrast shrink-0">
          <LineChart className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="flex-1">
          Investment activity
        </Text>
        <Text variant="small" color="secondary" className="tabular-nums shrink-0">
          {investments.documentCount} note{investments.documentCount === 1 ? "" : "s"}
        </Text>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col">
          <Text variant="mini" color="tertiary" className="uppercase tracking-wide">
            Bought
          </Text>
          <Text variant="large-strong" className="tabular-nums">
            {formatInr(investments.totalBuy)}
          </Text>
        </div>
        {investments.totalSell > 0 ? (
          <div className="flex flex-col">
            <Text variant="mini" color="tertiary" className="uppercase tracking-wide">
              Sold
            </Text>
            <Text variant="large-strong" className="tabular-nums">
              {formatInr(investments.totalSell)}
            </Text>
          </div>
        ) : null}
      </div>
      {investments.securities.length > 0 ? (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-secondary hover:text-primary transition-colors self-start"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
            <Text variant="small" color="secondary">
              {expanded
                ? "Hide securities"
                : `${investments.securities.length} securit${investments.securities.length === 1 ? "y" : "ies"}`}
            </Text>
          </button>
          {expanded ? (
            <div className="flex flex-col gap-1.5 pl-1 border-l border-panel">
              {investments.securities.map((s) => {
                const net = s.buyAmount - s.sellAmount;
                return (
                  <div key={s.isin ?? s.name} className="flex items-center gap-2 pl-2">
                    <div className="flex flex-col min-w-0 flex-1">
                      <Text variant="small" className="truncate" title={s.name}>
                        {s.name}
                      </Text>
                      <Text variant="mini" color="tertiary" className="tabular-nums">
                        {s.buyQuantity > 0 ? `${s.buyQuantity} bought` : ""}
                        {s.sellQuantity > 0
                          ? `${s.buyQuantity > 0 ? " · " : ""}${s.sellQuantity} sold`
                          : ""}
                        {s.isin ? ` · ${s.isin}` : ""}
                      </Text>
                    </div>
                    <Text variant="small-strong" className="tabular-nums shrink-0">
                      {formatInr(Math.abs(net))}
                    </Text>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {investments.byPerson.length > 1 ? (
        <div className="flex flex-wrap gap-1 pt-0.5">
          {investments.byPerson.map((p) => (
            <Badge key={p.name} color="secondary" className="tabular-nums">
              {p.name}: {formatInr(p.buyAmount)}
            </Badge>
          ))}
        </div>
      ) : null}
      <Text variant="mini" color="tertiary">
        Document-driven trade activity — not portfolio valuation.
      </Text>
    </div>
  );
}

const FREQUENCY_LABEL: Record<string, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annually: "Annually",
  weekly: "Weekly",
  custom: "Custom",
};

/** Manual recurring entries — clearly marked as manual, not document-backed. */
function RecurringSection({ recurring }: { recurring: RecurringSummary }) {
  if (recurring.entries.length === 0) return null;
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-control text-secondary shrink-0">
          <Repeat className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="flex-1">
          Recurring
        </Text>
        <Badge color="secondary">Manual</Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        {recurring.entries.map((e) => (
          <div key={e.id} className={cn("flex items-center gap-2", !e.active && "opacity-50")}>
            <div className="flex flex-col min-w-0 flex-1">
              <Text variant="small" className="truncate" title={e.name}>
                {e.name}
              </Text>
              <Text variant="mini" color="tertiary" className="truncate">
                {FREQUENCY_LABEL[e.frequency] ?? e.frequency} · {e.bucketLabel}
                {e.person ? ` · ${e.person}` : ""}
              </Text>
            </div>
            <div className="flex flex-col items-end shrink-0">
              <Text variant="small-strong" className="tabular-nums">
                {formatInr(e.monthlyEquivalent)}
              </Text>
              <Text variant="mini" color="tertiary">
                / mo
              </Text>
            </div>
          </div>
        ))}
      </div>
      {recurring.hasOtherCurrencies ? (
        <Text variant="mini" color="tertiary">
          Some entries are in another currency and aren&apos;t included in the monthly total.
        </Text>
      ) : null}
    </div>
  );
}

export function SnapshotView() {
  useTheme();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close on Escape (blur-to-dismiss is handled natively by the window).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (menuOpen) {
          setMenuOpen(false);
          return;
        }
        void window.glazeAPI.glaze.ipc.invoke("snapshot:close");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  // Training Mode state for the quick-actions menu (kept live via broadcasts).
  const trainingModeQuery = useQuery({
    queryKey: ["trainingMode"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<boolean>("training:getMode"),
  });
  useEffect(() => {
    const unsubscribe = window.glazeAPI.glaze.ipc.on(
      "training:changed",
      (_event, payload: unknown) => {
        const mode = (payload as { mode?: boolean } | undefined)?.mode;
        if (typeof mode === "boolean") queryClient.setQueryData(["trainingMode"], mode);
      },
    );
    return () => unsubscribe();
  }, [queryClient]);
  const setTrainingMode = useMutation({
    mutationFn: (on: boolean) => window.glazeAPI.glaze.ipc.invoke<boolean>("training:setMode", on),
    onSuccess: (mode) => queryClient.setQueryData(["trainingMode"], mode),
  });
  const trainingOn = trainingModeQuery.data ?? false;

  const cachedQuery = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:getCached"),
  });

  const reviewCountQuery = useQuery({
    queryKey: ["reviewCount"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<number>("reviews:count"),
  });

  // Keep the review pill live as items are resolved elsewhere (or on refresh).
  useEffect(() => {
    const unsubscribe = window.glazeAPI.glaze.ipc.on(
      "review:changed",
      (_event, payload: unknown) => {
        const count = (payload as { count?: number } | undefined)?.count;
        if (typeof count === "number") queryClient.setQueryData(["reviewCount"], count);
      },
    );
    return () => unsubscribe();
  }, [queryClient]);

  const refresh = useMutation({
    mutationFn: async () => {
      // Keep the popup open through the refresh (and any AI consent dialog).
      await window.glazeAPI.glaze.ipc.invoke("snapshot:setBusy", true);
      try {
        return await window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:refresh");
      } finally {
        await window.glazeAPI.glaze.ipc.invoke("snapshot:setBusy", false);
      }
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["snapshot"], data);
      // A refresh runs person entity resolution, which can add review items.
      queryClient.invalidateQueries({ queryKey: ["reviewCount"] });
    },
  });

  const response = refresh.data ?? cachedQuery.data;
  const loading = refresh.isPending;
  const snapshot = response?.snapshot ?? null;
  const fallback = response?.fallback;
  const blockedMessage = response?.aiBlocked
    ? (BLOCKED_MESSAGE[response.aiBlocked] ?? BLOCKED_MESSAGE.disabled)
    : null;
  const hasPeople =
    !!snapshot && (snapshot.people.length > 0 || !!snapshot.unidentified || !!snapshot.needsReview);
  const unidentifiedCount = snapshot?.unidentified?.documentCount ?? 0;
  const needsReviewCount = snapshot?.needsReview?.documentCount ?? 0;
  const pendingReviews = reviewCountQuery.data ?? 0;
  const totals = snapshot?.totals ?? { ...ZERO_TOTALS, reviewCount: pendingReviews };
  const impactBuckets = snapshot?.impactBuckets ?? [];
  const investments = snapshot?.investments ?? null;
  const recurring = snapshot?.recurring ?? null;

  return (
    <div className="h-full w-full p-2.5">
      <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl bg-popover border border-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-accent text-accent-contrast shrink-0">
          <Vault className="size-4 shrink-0" strokeWidth={2.2} />
          <span className="font-semibold text-sm flex-1">Financial Snapshot</span>
          {pendingReviews > 0 ? (
            <button
              type="button"
              onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openSettings")}
              title={`${pendingReviews} document${pendingReviews === 1 ? "" : "s"} waiting in the Review Queue — open Settings`}
              className="flex items-center gap-1 rounded-full bg-white/20 hover:bg-white/30 px-2 py-0.5 text-[11px] font-medium tabular-nums transition-colors"
            >
              <ClipboardList className="size-3" strokeWidth={2.4} />
              {pendingReviews}
            </button>
          ) : null}
          {needsReviewCount > 0 ? (
            <span
              className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-medium tabular-nums"
              title={`${needsReviewCount} foreign-currency document${needsReviewCount === 1 ? "" : "s"} need${needsReviewCount === 1 ? "s" : ""} review`}
            >
              <AlertTriangle className="size-3" strokeWidth={2.4} />
              {needsReviewCount}
            </span>
          ) : null}
          {unidentifiedCount > 0 ? (
            <span
              className="flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[11px] font-medium tabular-nums"
              title={`${unidentifiedCount} document${unidentifiedCount === 1 ? "" : "s"} not attributed to a person`}
            >
              <HelpCircle className="size-3" strokeWidth={2.4} />
              {unidentifiedCount}
            </span>
          ) : null}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="Snapshot settings"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              className={cn(
                "flex items-center justify-center size-7 rounded-md transition-colors hover:bg-white/20",
                menuOpen && "bg-white/20",
              )}
            >
              <Settings className="size-4" strokeWidth={2.2} />
            </button>
            {menuOpen ? (
              <>
                {/* Click-away closes just the menu (staying inside the window). */}
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1.5 z-50 w-56 rounded-xl border border-panel bg-popover text-primary shadow-2xl p-1 flex flex-col"
                >
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={trainingOn}
                    onClick={() => setTrainingMode.mutate(!trainingOn)}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle transition-colors text-left"
                  >
                    <GraduationCap className="size-4 text-secondary shrink-0" />
                    <span className="flex-1 text-sm">Training Mode</span>
                    <span
                      className={cn(
                        "text-[11px] font-semibold px-1.5 py-0.5 rounded-full shrink-0",
                        trainingOn
                          ? "bg-accent text-accent-contrast"
                          : "bg-control-subtle text-secondary",
                      )}
                    >
                      {trainingOn ? "On" : "Off"}
                    </span>
                  </button>
                  <div className="h-px bg-panel my-1" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void window.glazeAPI.glaze.ipc.invoke("window:openSettings", "review-queue");
                    }}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle transition-colors text-left"
                  >
                    <ClipboardList className="size-4 text-secondary shrink-0" />
                    <span className="flex-1 text-sm">Review Queue</span>
                    {pendingReviews > 0 ? (
                      <span className="text-[11px] font-semibold tabular-nums px-1.5 py-0.5 rounded-full bg-control-subtle text-secondary shrink-0">
                        {pendingReviews}
                      </span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void window.glazeAPI.glaze.ipc.invoke("window:openDocuments");
                    }}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle transition-colors text-left"
                  >
                    <Files className="size-4 text-secondary shrink-0" />
                    <span className="flex-1 text-sm">Browse Documents</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      void window.glazeAPI.glaze.ipc.invoke("window:openSettings");
                    }}
                    className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle transition-colors text-left"
                  >
                    <Settings className="size-4 text-secondary shrink-0" />
                    <span className="flex-1 text-sm">Open Settings</span>
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </div>

        {/* Subheader */}
        <div className="px-4 py-1.5 shrink-0">
          <Text variant="small" color="tertiary">
            {loading ? "Analyzing your documents…" : formatUpdated(response?.generatedAt ?? null)}
          </Text>
        </div>

        <Separator />

        {/* Body */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 py-3 flex flex-col gap-3">
            {blockedMessage ? (
              <div className="flex items-start gap-2 rounded-lg border border-panel bg-control-subtle p-3">
                <AlertCircle className="size-4 text-orange-9 shrink-0 mt-0.5" />
                <Text variant="small" color="secondary">
                  {blockedMessage}
                </Text>
              </div>
            ) : null}

            {/* Big-number-first: the numbers that run the user's life, shown first. */}
            <HeroNumbers totals={totals} />

            {loading && !snapshot ? (
              <div className="flex flex-col items-center justify-center gap-2 py-6 text-secondary">
                <Loader2 className="size-6 animate-spin" />
                <Text variant="small" color="secondary">
                  Reading your documents…
                </Text>
              </div>
            ) : null}

            {/* Secondary financial layers — quieter than the hero numbers. */}
            {impactBuckets.length > 0 ? <ImpactBreakdown buckets={impactBuckets} /> : null}
            {investments ? <InvestmentSection investments={investments} /> : null}
            {recurring ? <RecurringSection recurring={recurring} /> : null}

            {/* Financial-year breakdown — a calm organizing lens. */}
            {snapshot && snapshot.financialYears.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-1.5 text-secondary">
                  <CalendarClock className="size-3.5 shrink-0" />
                  <Text variant="small" color="secondary" className="flex-1">
                    By financial year
                  </Text>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {snapshot.financialYears.map((fy) => (
                    <Badge key={fy.key} color="secondary" className="tabular-nums">
                      {fy.label} · {fy.documentCount}
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}

            {/* AI summary cards */}
            {hasPeople ? (
              <>
                {snapshot!.people.map((person) => (
                  <PersonCard key={person.name} {...person} icon="user" />
                ))}
                {snapshot!.unidentified && snapshot!.unidentified.documentCount > 0 ? (
                  <UnidentifiedCard unidentified={snapshot!.unidentified} />
                ) : null}
                {snapshot!.needsReview && snapshot!.needsReview.documentCount > 0 ? (
                  <NeedsReviewCard needsReview={snapshot!.needsReview} />
                ) : null}
              </>
            ) : null}

            {/* Fallback / empty states */}
            {!hasPeople && !loading ? (
              fallback && fallback.totalDocuments > 0 ? (
                <div className="flex flex-col gap-3">
                  {!blockedMessage ? (
                    <Text variant="small" color="secondary">
                      Tap Refresh to generate an AI summary grouped by person.
                    </Text>
                  ) : null}
                  <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <FileText className="size-4 text-secondary shrink-0" />
                      <Text variant="strong" className="flex-1">
                        {fallback.totalDocuments} document{fallback.totalDocuments === 1 ? "" : "s"}
                      </Text>
                    </div>
                    {formatRange(
                      fallback.dateRange
                        ? {
                            start: formatDate(fallback.dateRange.start),
                            end: formatDate(fallback.dateRange.end),
                          }
                        : null,
                    ) ? (
                      <div className="flex items-center gap-1.5">
                        <CalendarRange className="size-3.5 text-secondary shrink-0" />
                        <Text variant="small" color="secondary">
                          {formatRange({
                            start: formatDate(fallback.dateRange!.start),
                            end: formatDate(fallback.dateRange!.end),
                          })}
                        </Text>
                      </div>
                    ) : null}
                    <div className="flex flex-col gap-1 pt-1">
                      {fallback.documents.slice(0, 12).map((doc, i) => (
                        <Text
                          key={`${doc.filename}-${i}`}
                          variant="small"
                          color="tertiary"
                          className="truncate"
                          title={doc.filename}
                        >
                          {doc.filename}
                        </Text>
                      ))}
                      {fallback.documents.length > 12 ? (
                        <Text variant="small" color="tertiary">
                          + {fallback.documents.length - 12} more
                        </Text>
                      ) : null}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <FileText className="size-6 text-tertiary" />
                  <Text variant="small" color="secondary">
                    No documents yet.
                  </Text>
                  <Text variant="small" color="tertiary">
                    Drop files on the orb to build your vault.
                  </Text>
                </div>
              )
            ) : null}
          </div>
        </ScrollArea>

        {/* Footer */}
        <Separator />
        <div className="px-4 py-2.5 shrink-0">
          <Button
            variant="accent"
            className="w-full"
            onClick={() => refresh.mutate()}
            disabled={loading}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {loading ? "Generating…" : hasPeople ? "Refresh" : "Generate Summary"}
          </Button>
        </div>
      </div>
    </div>
  );
}
