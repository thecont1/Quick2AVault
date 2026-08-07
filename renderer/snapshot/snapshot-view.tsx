import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollArea, Text } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import { Treemap, ResponsiveContainer } from "recharts";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileSearch,
  GraduationCap,
  Loader2,
  RefreshCw,
  Settings,
  Slash,
  TrendingDown,
  TrendingUp,
} from "lucide-react";


type SnapshotPeriod = "month" | "previous_month" | "financial_year";

interface SnapshotTotals {
  income: number;
  householdExpenses: number;
  businessExpenses: number;
  investments: number;
  reviewCount: number;
  documentCount: number;
  undatedDocumentCount: number;
}

interface WatchCategorySummary {
  id: string;
  label: string;
  totalInr: number;
  documentCount: number;
  scheduledEntryCount: number;
}

interface SnapshotDrilldownIds {
  income: number[];
  spending: number[];
  investments: number[];
}

interface PeriodSnapshot {
  period: SnapshotPeriod;
  label: string;
  startDate: string;
  endDate: string;
  totals: SnapshotTotals;
  watchCategories: WatchCategorySummary[];
  drilldownIds: SnapshotDrilldownIds;
}

interface RecentDocument {
  docId: number;
  filename: string;
  dateIngested: string;
  docDate: string | null;
  personName: string | null;
  category: string | null;
  lifecycleState: string;
  reviewStatus: "conflict" | "missing" | "low_confidence" | "ok";
  impact: { bucket: string; amountInr: number | null } | null;
}

interface SnapshotData {
  periods: Record<SnapshotPeriod, PeriodSnapshot>;
}

interface SnapshotResponse {
  snapshot: SnapshotData | null;
  generatedAt: string | null;
  lastActivity: string | null;
  aiBlocked?: string;
  error?: string;
  fallback: { totalDocuments: number };
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

function formatInr(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "Waiting for your first summary";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Updated recently";
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  return `Updated ${Math.round(minutes / 60)}h ago`;
}

function effectiveTimestamp(generatedAt: string | null, lastActivity: string | null): string | null {
  const candidates = [generatedAt, lastActivity].filter((v): v is string => v != null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

type HeroTone = "income" | "spending" | "investments";

const HERO_TONES: Record<HeroTone, { card: string; label: string; subtext: string }> = {
  income: {
    card: "border-emerald-600/30 bg-emerald-500/10 shadow-emerald-900/5",
    label: "text-emerald-800 dark:text-emerald-300",
    subtext: "text-emerald-900/60 dark:text-emerald-200/60",
  },
  spending: {
    card: "border-orange-600/25 bg-orange-400/10 shadow-orange-900/5",
    label: "text-orange-800 dark:text-orange-300",
    subtext: "text-orange-900/60 dark:text-orange-200/60",
  },
  investments: {
    card: "border-sky-600/25 bg-sky-500/10 shadow-sky-900/5",
    label: "text-sky-800 dark:text-sky-300",
    subtext: "text-sky-900/60 dark:text-sky-200/60",
  },
};

function HeroRow({
  label,
  amount,
  tone,
  supporting,
  onOpen,
}: {
  label: string;
  amount: number;
  tone: HeroTone;
  supporting: ReactNode;
  onOpen: () => void;
}) {
  const palette = HERO_TONES[tone];
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "group flex items-center gap-3 min-w-0 rounded-2xl border px-4 py-3 text-left shadow-sm transition-all hover:-translate-y-px hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        palette.card,
      )}
      aria-label={`Inspect documents contributing to ${label}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span
          className={cn("text-[15px] font-bold tracking-[-0.01em] leading-none", palette.label)}
          style={{ fontFamily: "Unbounded, 'Arial Black', ui-sans-serif, system-ui" }}
        >
          {label}
        </span>
        <span className={cn("truncate text-[10.5px] leading-snug", palette.subtext)}>
          {supporting}
        </span>
      </span>
      <span
        className="shrink-0 text-right text-[clamp(1.4rem,4.5vw,1.9rem)] font-black leading-none tracking-[-0.03em] tabular-nums"
        style={{ fontFamily: "Unbounded, 'Arial Black', ui-sans-serif, system-ui" }}
        title={formatInr(amount)}
      >
        {formatInr(amount)}
      </span>
    </button>
  );
}

function SnapshotMenu({
  pendingReviews,
  trainingOn,
  toggleTraining,
  onRefresh,
  refreshPending,
  canGenerate,
}: {
  pendingReviews: number;
  trainingOn: boolean;
  toggleTraining: () => void;
  onRefresh: () => void;
  refreshPending: boolean;
  canGenerate: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      {/* Document Review */}
      <div className="relative">
        <button
          type="button"
          onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openSettings", "review-queue")}
          aria-label="Review Queue"
          className="flex items-center justify-center size-7 rounded-full text-tertiary transition-colors hover:text-primary hover:bg-control-subtle"
        >
          <ClipboardList className="size-4" />
        </button>
        {pendingReviews > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[9px] font-semibold text-destructive-foreground">
            {pendingReviews}
          </span>
        ) : null}
      </div>

      {/* Document Browser */}
      <div className="relative">
        <button
          type="button"
          onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openDocuments")}
          aria-label="Browse Documents"
          className="flex items-center justify-center size-7 rounded-full text-tertiary transition-colors hover:text-primary hover:bg-control-subtle"
        >
          <FileSearch className="size-4" />
        </button>
      </div>

      {/* Learning Mode — green when on, grey with slash when off */}
      <button
        type="button"
        onClick={toggleTraining}
        aria-label={trainingOn ? "Turn off Learning Mode" : "Turn on Learning Mode"}
        className={cn(
          "relative flex items-center justify-center size-7 rounded-full transition-colors",
          trainingOn
            ? "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30"
            : "text-tertiary hover:text-primary hover:bg-control-subtle",
        )}
      >
        <GraduationCap className="size-4" />
        {!trainingOn ? (
          <Slash className="absolute size-3.5 stroke-2" />
        ) : null}
      </button>

      {/* Refresh / Generate */}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshPending}
        aria-label={canGenerate ? "Generate snapshot" : "Refresh snapshot"}
        className={cn(
          "flex items-center justify-center size-7 rounded-full text-tertiary transition-colors hover:text-primary hover:bg-control-subtle",
          refreshPending && "cursor-wait opacity-60",
        )}
      >
        <RefreshCw className={cn("size-4", refreshPending && "animate-spin")} />
      </button>

      {/* Settings */}
      <button
        type="button"
        onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openSettings", "settings")}
        aria-label="Open Settings"
        className="flex items-center justify-center size-7 rounded-full text-tertiary transition-colors hover:text-primary hover:bg-control-subtle"
      >
        <Settings className="size-4" />
      </button>
    </div>
  );
}

const WATCH_BAR_TONES = [
  "bg-emerald-500",
  "bg-orange-400",
  "bg-sky-500",
  "bg-violet-400",
  "bg-rose-500",
  "bg-amber-400",
  "bg-teal-500",
  "bg-fuchsia-500",
];

const TONE_BG: Record<string, string> = {
  "bg-emerald-500": "#10b981",
  "bg-orange-400": "#fb923c",
  "bg-sky-500": "#0ea5e9",
  "bg-violet-400": "#a78bfa",
  "bg-rose-500": "#f43f5e",
  "bg-amber-400": "#fbbf24",
  "bg-teal-500": "#14b8a6",
  "bg-fuchsia-500": "#d946ef",
};

const PERIOD_STORAGE_KEY = "quick2a:snapshot-period";

interface TreemapDatum {
  id: string;
  label: string;
  totalInr: number;
  percent: number;
  index: number;
}

function WatchTreemapContent(props: Record<string, unknown>) {
  const x = props.x as number;
  const y = props.y as number;
  const width = props.width as number;
  const height = props.height as number;
  const label = props.label as string | undefined;
  const totalInr = props.totalInr as number | undefined;
  const percent = props.percent as number | undefined;
  const index = props.index as number | undefined;
  if (width < 4 || height < 4 || !label) return null;
  const tone = WATCH_BAR_TONES[(index ?? 0) % WATCH_BAR_TONES.length];
  const fill = TONE_BG[tone] ?? "#6b7280";
  const showLabel = width >= 60 && height >= 32;
  const showAmount = width >= 60 && height >= 48;
  const showPercent = width >= 40 && height >= 20;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={fill}
        fillOpacity={0.9}
        stroke="white"
        strokeWidth={0.5}
      />
      {showLabel && (
        <text
          x={x + 8}
          y={y + 16}
          fill="white"
          fontSize={11}
          fontWeight={700}
        >
          {label.length > 16 ? label.slice(0, 15) + "…" : label}
        </text>
      )}
      {showAmount && (
        <text x={x + 8} y={y + 32} fill="white" fontSize={10} fontWeight={500} fillOpacity={0.9}>
          {formatInr(totalInr ?? 0)}
        </text>
      )}
      {showPercent && (
        <text
          x={x + width - 8}
          y={y + 16}
          fill="white"
          fontSize={11}
          fontWeight={700}
          textAnchor="end"
          fillOpacity={0.95}
        >
          {percent ?? 0}%
        </text>
      )}
    </g>
  );
}

function WatchTreemap({
  data,
  onSelect,
}: {
  data: TreemapDatum[];
  onSelect: () => void;
}) {
  if (data.length === 0) return null;
  const treemapData = data.map((d) => ({ ...d, name: d.label, size: d.totalInr }));
  return (
    <div className="flex flex-col gap-2">
      <div
        className="w-full overflow-hidden border border-panel"
        style={{ height: Math.max(120, Math.min(200, data.length * 48)) }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={treemapData}
            dataKey="size"
            content={<WatchTreemapContent />}
            isAnimationActive={false}
            onClick={onSelect}
          />
        </ResponsiveContainer>
      </div>
      <div
        className="grid px-0.5"
        style={{
          gridTemplateColumns: `repeat(${Math.ceil(data.length / 2)}, 1fr)`,
          columnGap: "0.75rem",
          rowGap: "0.125rem",
        }}
      >
        {data.map((d) => {
          const tone = WATCH_BAR_TONES[d.index % WATCH_BAR_TONES.length];
          const fill = TONE_BG[tone] ?? "#6b7280";
          return (
            <div key={d.id} className="flex items-center gap-1.5">
              <span
                className="size-2.5 shrink-0 rounded-[1px]"
                style={{ backgroundColor: fill }}
              />
              <span className="text-[11px] text-secondary">{d.label}</span>
              <span className="text-[11px] tabular-nums text-tertiary ml-auto">
                {d.percent}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function readStoredPeriod(): SnapshotPeriod {
  try {
    const stored = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    if (stored === "financial_year" || stored === "previous_month") return stored;
    return "month";
  } catch {
    return "month";
  }
}

export function SnapshotView() {
  useTheme();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<SnapshotPeriod>(readStoredPeriod);

  const updatePeriod = (value: SnapshotPeriod) => {
    setPeriod(value);
    try {
      window.localStorage.setItem(PERIOD_STORAGE_KEY, value);
    } catch {
      // storage unavailable (private window edge) — in-memory state still works
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      void window.glazeAPI.glaze.ipc.invoke("snapshot:close");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const cached = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:getCached"),
  });
  const reviewCount = useQuery({
    queryKey: ["reviewCount"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<number>("reviews:count"),
  });
  const trainingMode = useQuery({
    queryKey: ["trainingMode"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<boolean>("training:getMode"),
  });
  useEffect(() => {
    const unsubscribe = window.glazeAPI.glaze.ipc.on("training:changed", () => {
      queryClient.invalidateQueries({ queryKey: ["trainingMode"] });
    });
    return () => unsubscribe();
  }, [queryClient]);
  const recentDocuments = useQuery({
    queryKey: ["documents", "recent"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<RecentDocument[]>("documents:list"),
  });
  const setTrainingMode = useMutation({
    mutationFn: (value: boolean) =>
      window.glazeAPI.glaze.ipc.invoke<boolean>("training:setMode", value),
    onSuccess: (value) => queryClient.setQueryData(["trainingMode"], value),
  });
  const refresh = useMutation({
    mutationFn: async () => {
      await window.glazeAPI.glaze.ipc.invoke("snapshot:setBusy", true);
      try {
        return await window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:refresh");
      } finally {
        await window.glazeAPI.glaze.ipc.invoke("snapshot:setBusy", false);
      }
    },
    onSuccess: (value) => {
      queryClient.setQueryData(["snapshot"], value);
      queryClient.invalidateQueries({ queryKey: ["reviewCount"] });
    },
  });

  useEffect(() => {
    const offReview = window.glazeAPI.glaze.ipc.on("review:changed", (_event, payload: unknown) => {
      const count = (payload as { count?: number })?.count;
      if (typeof count === "number") queryClient.setQueryData(["reviewCount"], count);
    });
    const offWatch = window.glazeAPI.glaze.ipc.on("watchCategories:changed", () => {
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    const offDocuments = window.glazeAPI.glaze.ipc.on("documents:changed", () => {
      queryClient.invalidateQueries({ queryKey: ["documents", "recent"] });
      queryClient.invalidateQueries({ queryKey: ["snapshot"] });
    });
    return () => {
      offReview();
      offWatch();
      offDocuments();
    };
  }, [queryClient]);

  const response = refresh.data ?? cached.data;
  const active = response?.snapshot?.periods?.[period] ?? null;
  const totals = active?.totals;
  const pendingReviews = reviewCount.data ?? 0;
  const blocked = response?.aiBlocked
    ? (BLOCKED_MESSAGE[response.aiBlocked] ?? BLOCKED_MESSAGE.disabled)
    : null;
  const allWatchCategories = active?.watchCategories ?? [];
  const watchCategories = allWatchCategories.slice(0, 6);
  const watchTotalSum = allWatchCategories.reduce((sum, c) => sum + c.totalInr, 0);
  const watchPercentages = watchCategories.map((c) =>
    watchTotalSum > 0 ? Math.round((c.totalInr / watchTotalSum) * 100) : 0,
  );
  const docsProcessed = (count: number) => `${count} document${count === 1 ? "" : "s"} processed`;
  const openDocuments = (metric?: "income" | "spending" | "investments", docId?: number) => {
    if (!metric || !active) {
      void window.glazeAPI.glaze.ipc.invoke("window:openDocuments", docId ?? null);
      return;
    }
    void window.glazeAPI.glaze.ipc.invoke("window:openDocuments", null, {
      metric,
      period,
      label: active.label,
      startDate: active.startDate,
      endDate: active.endDate,
      docIds: active.drilldownIds[metric],
    });
  };
  const recent = (recentDocuments.data ?? []).slice(0, 30);

  return (
    <div className="h-full w-full p-2.5">
      <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl bg-popover border border-panel shadow-2xl">
        <header className="flex items-center gap-3 px-4 pb-2 pt-3.5 shrink-0 border-b border-panel/60">
          <span
            className="flex-1 font-bold text-lg leading-none tracking-[-0.01em]"
            style={{ fontFamily: "Unbounded, 'Arial Black', ui-sans-serif, system-ui" }}
          >
            Your Money
          </span>
          <SnapshotMenu
            pendingReviews={pendingReviews}
            trainingOn={trainingMode.data ?? false}
            toggleTraining={() => setTrainingMode.mutate(!(trainingMode.data ?? false))}
            onRefresh={() => refresh.mutate()}
            refreshPending={refresh.isPending}
            canGenerate={!!active}
          />
        </header>

        <div className="px-4 pt-3 pb-2.5 shrink-0 flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-accent" />
            {(period === "month" || period === "previous_month") ? (
              <button
                type="button"
                onClick={() =>
                  updatePeriod(period === "month" ? "previous_month" : "month")
                }
                className="flex flex-1 items-center gap-1 text-left hover:opacity-80 transition-opacity"
                aria-label={`Switch to ${period === "month" ? "previous" : "current"} month`}
              >
                <Text variant="large-strong">
                  {active?.label ?? "Current period"}
                </Text>
                <ChevronRight className="size-4 text-tertiary" />
              </button>
            ) : (
              <Text variant="large-strong" className="flex-1">
                {active?.label ?? "Current period"}
              </Text>
            )}
            <div
              role="group"
              aria-label="Snapshot period"
              className="flex h-9 items-center rounded-lg bg-control-subtle p-0.5 text-sm font-semibold"
            >
              <button
                type="button"
                role="switch"
                aria-checked={period === "month" || period === "previous_month"}
                aria-label="View by month"
                onClick={() => updatePeriod("month")}
                className={cn(
                  "flex h-8 items-center rounded-md px-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
                  period === "month" || period === "previous_month"
                    ? "bg-accent text-accent-contrast shadow-sm"
                    : "text-secondary hover:text-primary hover:bg-control-subtle/70",
                )}
              >
                Month
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={period === "financial_year"}
                aria-label="View this financial year"
                onClick={() => updatePeriod("financial_year")}
                className={cn(
                  "flex h-8 items-center rounded-md px-3.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1",
                  period === "financial_year"
                    ? "bg-accent text-accent-contrast shadow-sm"
                    : "text-secondary hover:text-primary hover:bg-control-subtle/70",
                )}
              >
                Year
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 pl-6">
            <Text variant="mini" color="tertiary">
              {refresh.isPending
                ? "Updating…"
                : formatUpdated(
                    effectiveTimestamp(
                      response?.generatedAt ?? null,
                      response?.lastActivity ?? null,
                    ),
                  )}
            </Text>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <main className="px-4 py-3 flex flex-col gap-4">
            {blocked ? (
              <div className="flex items-start gap-2 rounded-lg border border-panel bg-control-subtle p-3">
                <AlertCircle className="size-4 text-orange-9 mt-0.5" />
                <Text variant="small" color="secondary">
                  {blocked}
                </Text>
              </div>
            ) : null}

            {totals ? (
              <>
                <section className="flex flex-col gap-2">
                  <HeroRow
                    label="Income"
                    amount={totals.income}
                    tone="income"
                    supporting={docsProcessed(active?.drilldownIds?.income?.length ?? 0)}
                    onOpen={() => openDocuments("income")}
                  />
                  <HeroRow
                    label="Spending"
                    amount={totals.householdExpenses}
                    tone="spending"
                    supporting={docsProcessed(active?.drilldownIds?.spending?.length ?? 0)}
                    onOpen={() => openDocuments("spending")}
                  />
                  <HeroRow
                    label="Investments"
                    amount={totals.investments}
                    tone="investments"
                    supporting={docsProcessed(active?.drilldownIds?.investments?.length ?? 0)}
                    onOpen={() => openDocuments("investments")}
                  />
                </section>

                <section className="flex flex-col gap-2.5">
                  <div className="flex items-center gap-2">
                    <Text variant="strong" className="flex-1">
                      Watchlist
                    </Text>
                    <button
                      type="button"
                      onClick={() =>
                        window.glazeAPI.glaze.ipc.invoke("window:openSettings", "finance")
                      }
                      className="rounded-full border border-panel px-2.5 py-0.5 text-[11px] text-secondary transition-colors hover:border-accent/50 hover:text-primary"
                    >
                      Edit
                    </button>
                  </div>
                  {watchCategories.length > 0 && watchTotalSum > 0 ? (
                    <WatchTreemap
                      data={watchCategories.map((category, index) => ({
                        id: category.id,
                        label: category.label,
                        totalInr: category.totalInr,
                        percent: watchPercentages[index] ?? 0,
                        index,
                      }))}
                      onSelect={() =>
                        window.glazeAPI.glaze.ipc.invoke("window:openSettings", "finance")
                      }
                    />
                  ) : watchCategories.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {watchCategories.map((category) => (
                        <div
                          key={category.id}
                          className="flex items-center justify-between rounded-lg border border-panel bg-control-subtle/40 px-3 py-2"
                        >
                          <Text variant="small-strong" className="truncate">
                            {category.label}
                          </Text>
                          <Text variant="mini" color="tertiary" className="shrink-0 tabular-nums">
                            No spending yet this period
                          </Text>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text variant="small" color="secondary">
                      No spending yet this period. Choose categories to watch in Settings.
                    </Text>
                  )}
                </section>

                {totals.undatedDocumentCount > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      window.glazeAPI.glaze.ipc.invoke("window:openSettings", "review-queue")
                    }
                    className="flex items-center gap-2 text-left text-secondary hover:text-primary"
                  >
                    <AlertCircle className="size-3.5" />
                    <Text variant="small" color="secondary">
                      {totals.undatedDocumentCount} money document
                      {totals.undatedDocumentCount === 1 ? " is" : "s are"} excluded from period
                      totals because the date is unclear.
                    </Text>
                  </button>
                ) : null}

                <section className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Text variant="strong" className="flex-1">
                      Recent documents
                    </Text>
                    <Text variant="mini" color="tertiary">
                      Newest first
                    </Text>
                  </div>
                  {recent.length ? (
                    <div className="overflow-hidden rounded-xl border border-panel bg-control-subtle/40">
                      {recent.map((document) => {
                        const needsReview = document.reviewStatus !== "ok";
                        const status =
                          document.lifecycleState !== "active"
                            ? document.lifecycleState.replace(/_/g, " ")
                            : needsReview
                              ? "needs review"
                              : "processed";
                        return (
                          <button
                            key={document.docId}
                            type="button"
                            onClick={() => openDocuments(undefined, document.docId)}
                            className="flex w-full items-center gap-2 border-b border-panel/70 px-3 py-2 text-left last:border-b-0 hover:bg-control-subtle"
                          >
                            {needsReview ? (
                              <AlertCircle className="size-3.5 shrink-0 text-orange-9" />
                            ) : (
                              <CheckCircle2 className="size-3.5 shrink-0 text-green-9" />
                            )}
                            <span className="min-w-0 flex-1">
                              <Text variant="small-strong" className="block truncate">
                                {document.filename}
                              </Text>
                              <Text variant="mini" color="tertiary" className="block truncate">
                                {document.personName ? `👤 ${document.personName} · ` : ""}
                                {document.category ??
                                  document.impact?.bucket?.replace(/_/g, " ") ??
                                  "Uncategorized"}
                              </Text>
                            </span>
                            <span className="rounded-full bg-popover px-2 py-0.5 text-[10px] capitalize text-secondary">
                              {status}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <Text variant="small" color="secondary">
                      Recent drops will appear here.
                    </Text>
                  )}
                </section>
              </>
            ) : refresh.isPending || cached.isPending ? (
              <div className="flex flex-col items-center gap-2 py-10 text-secondary">
                <Loader2 className="size-6 animate-spin" />
                <Text variant="small" color="secondary">
                  Building your money picture…
                </Text>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-10 text-center">
                {response?.fallback.totalDocuments ? (
                  <TrendingUp className="size-6 text-accent" />
                ) : (
                  <TrendingDown className="size-6 text-tertiary" />
                )}
                <Text variant="strong">
                  {response?.fallback.totalDocuments
                    ? "Generate your money snapshot"
                    : "No money documents yet"}
                </Text>
                <Text variant="small" color="secondary">
                  {response?.fallback.totalDocuments
                    ? "Analyze the documents already in your vault to populate period totals."
                    : "Drop financial documents onto the Quick2A logo to begin."}
                </Text>
              </div>
            )}
          </main>
        </ScrollArea>
      </div>
    </div>
  );
}
