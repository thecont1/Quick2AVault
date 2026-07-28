import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, ScrollArea, Separator, Text } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import {
  AlertCircle,
  CalendarClock,
  ClipboardList,
  FileSearch,
  GraduationCap,
  Loader2,
  RefreshCw,
  Repeat,
  Settings,
  TrendingDown,
  TrendingUp,
  Vault,
} from "lucide-react";

type SnapshotPeriod = "month" | "financial_year";

interface SnapshotTotals {
  income: number;
  householdExpenses: number;
  businessExpenses: number;
  investments: number;
  recurringMonthlyOutflow: number;
  reviewCount: number;
  documentCount: number;
  undatedDocumentCount: number;
}

interface WatchCategorySummary {
  id: string;
  label: string;
  totalInr: number;
  documentCount: number;
}

interface PeriodSnapshot {
  period: SnapshotPeriod;
  label: string;
  startDate: string;
  endDate: string;
  totals: SnapshotTotals;
  watchCategories: WatchCategorySummary[];
}

interface SnapshotData {
  periods: Record<SnapshotPeriod, PeriodSnapshot>;
}

interface SnapshotResponse {
  snapshot: SnapshotData | null;
  generatedAt: string | null;
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

function HeroStat({
  label,
  amount,
  tone,
  supporting,
}: {
  label: string;
  amount: number;
  tone: "positive" | "warning" | "neutral";
  supporting?: string;
}) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border px-3 py-3 flex flex-col gap-1",
        tone === "positive"
          ? "border-green-9/30 bg-green-9/10"
          : tone === "warning"
            ? "border-orange-9/30 bg-orange-9/10"
            : "border-panel bg-control-subtle",
      )}
    >
      <Text variant="mini" color="tertiary" className="uppercase tracking-[0.12em]">
        {label}
      </Text>
      <Text
        variant="heading2"
        className="tabular-nums leading-none truncate"
        title={formatInr(amount)}
      >
        {formatInr(amount)}
      </Text>
      {supporting ? (
        <Text variant="mini" color="tertiary" className="truncate">
          {supporting}
        </Text>
      ) : null}
    </div>
  );
}

function SnapshotMenu({
  open,
  setOpen,
  trainingOn,
  pendingReviews,
  toggleTraining,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  trainingOn: boolean;
  pendingReviews: number;
  toggleTraining: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="Snapshot actions"
        className={cn(
          "flex items-center justify-center size-7 rounded-md transition-colors hover:bg-white/20",
          open && "bg-white/20",
        )}
      >
        <Settings className="size-4" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1.5 z-50 w-56 rounded-xl border border-panel bg-popover text-primary shadow-2xl p-1 flex flex-col">
            <button
              type="button"
              onClick={toggleTraining}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle text-left"
            >
              <GraduationCap className="size-4 text-secondary" />
              <span className="flex-1 text-sm">Training Mode</span>
              <span className="text-[11px] font-semibold">{trainingOn ? "On" : "Off"}</span>
            </button>
            <div className="h-px bg-panel my-1" />
            <button
              type="button"
              onClick={() =>
                window.glazeAPI.glaze.ipc.invoke("window:openSettings", "review-queue")
              }
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle text-left"
            >
              <ClipboardList className="size-4 text-secondary" />
              <span className="flex-1 text-sm">Review Queue</span>
              {pendingReviews > 0 ? <span className="text-[11px]">{pendingReviews}</span> : null}
            </button>
            <button
              type="button"
              onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openDocuments")}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle text-left"
            >
              <FileSearch className="size-4 text-secondary" />
              <span className="text-sm">Browse Documents</span>
            </button>
            <button
              type="button"
              onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openSettings")}
              className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-control-subtle text-left"
            >
              <Settings className="size-4 text-secondary" />
              <span className="text-sm">Open Settings</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function SnapshotView() {
  useTheme();
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState<SnapshotPeriod>("month");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (menuOpen) setMenuOpen(false);
      else void window.glazeAPI.glaze.ipc.invoke("snapshot:close");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

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
    return () => {
      offReview();
      offWatch();
    };
  }, [queryClient]);

  const response = refresh.data ?? cached.data;
  const active = response?.snapshot?.periods?.[period] ?? null;
  const totals = active?.totals;
  const pendingReviews = reviewCount.data ?? 0;
  const blocked = response?.aiBlocked
    ? (BLOCKED_MESSAGE[response.aiBlocked] ?? BLOCKED_MESSAGE.disabled)
    : null;
  const watchCategories = (active?.watchCategories ?? []).slice(0, 6);
  const incomeMessage = totals?.income
    ? `${formatInr(totals.income)} came in during ${active?.label ?? "this period"}.`
    : "No recognized income in this period yet.";

  return (
    <div className="h-full w-full p-2.5">
      <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl bg-popover border border-panel shadow-2xl">
        <header className="flex items-center gap-2 px-4 py-3 bg-accent text-accent-contrast shrink-0">
          <Vault className="size-4" />
          <span className="font-semibold text-sm flex-1">Money Snapshot</span>
          {pendingReviews > 0 ? (
            <button
              type="button"
              onClick={() =>
                window.glazeAPI.glaze.ipc.invoke("window:openSettings", "review-queue")
              }
              className="flex items-center gap-1 rounded-full bg-white/20 hover:bg-white/30 px-2 py-0.5 text-[11px] font-medium tabular-nums"
              title={`${pendingReviews} item${pendingReviews === 1 ? "" : "s"} need review`}
            >
              <ClipboardList className="size-3" /> {pendingReviews}
            </button>
          ) : null}
          <SnapshotMenu
            open={menuOpen}
            setOpen={setMenuOpen}
            trainingOn={trainingMode.data ?? false}
            pendingReviews={pendingReviews}
            toggleTraining={() => setTrainingMode.mutate(!(trainingMode.data ?? false))}
          />
        </header>

        <div className="px-4 pt-3 pb-2 shrink-0 flex flex-col gap-2.5">
          <div className="grid grid-cols-2 rounded-lg bg-control-subtle p-0.5" role="tablist">
            {(
              [
                ["month", "This month"],
                ["financial_year", "This financial year"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={period === value}
                onClick={() => setPeriod(value)}
                className={cn(
                  "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  period === value
                    ? "bg-popover text-primary shadow-sm"
                    : "text-secondary hover:text-primary",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-secondary" />
            <Text variant="large-strong" className="flex-1">
              {active?.label ?? "Current period"}
            </Text>
            <Text variant="mini" color="tertiary">
              {refresh.isPending ? "Updating…" : formatUpdated(response?.generatedAt ?? null)}
            </Text>
          </div>
        </div>
        <Separator />

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
                  <HeroStat
                    label="Income"
                    amount={totals.income}
                    tone="positive"
                    supporting={incomeMessage}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <HeroStat
                      label="Spending / outflow"
                      amount={totals.householdExpenses}
                      tone="warning"
                      supporting="Investments excluded"
                    />
                    <HeroStat
                      label="Investments"
                      amount={totals.investments}
                      tone={
                        totals.investments > totals.income && totals.income > 0
                          ? "warning"
                          : "neutral"
                      }
                      supporting={
                        period === "month"
                          ? "Put into markets this month"
                          : "Put into markets this FY"
                      }
                    />
                  </div>
                  {totals.recurringMonthlyOutflow > 0 ? (
                    <div className="flex items-center justify-between rounded-xl bg-control-subtle px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-secondary">
                        <Repeat className="size-3.5" />
                        <Text variant="small" color="secondary">
                          Recurring monthly outflow
                        </Text>
                      </div>
                      <Text variant="large-strong" className="tabular-nums">
                        {formatInr(totals.recurringMonthlyOutflow)}
                      </Text>
                    </div>
                  ) : null}
                </section>

                <section className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Text variant="strong" className="flex-1">
                      Watching
                    </Text>
                    <button
                      type="button"
                      onClick={() =>
                        window.glazeAPI.glaze.ipc.invoke("window:openSettings", "finance")
                      }
                      className="text-xs text-secondary hover:text-primary"
                    >
                      Edit in Settings
                    </button>
                  </div>
                  {watchCategories.length > 0 ? (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                      {watchCategories.map((category) => (
                        <div
                          key={category.id}
                          className="flex items-center gap-2 min-w-0 py-1 border-b border-panel/70"
                        >
                          <span className="size-1.5 rounded-full bg-accent shrink-0" />
                          <Text variant="small" className="flex-1 truncate">
                            {category.label}
                          </Text>
                          <Text variant="small-strong" className="tabular-nums shrink-0">
                            {formatInr(category.totalInr)}
                          </Text>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Text variant="small" color="secondary">
                      Choose categories in Settings.
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

                <section className="grid grid-cols-2 gap-2">
                  <Button
                    variant="filled"
                    onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openDocuments")}
                  >
                    <FileSearch className="size-4" /> Documents
                  </Button>
                  <Button
                    variant="transparent"
                    onClick={() => window.glazeAPI.glaze.ipc.invoke("window:openSettings")}
                  >
                    <Settings className="size-4" /> Settings
                  </Button>
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

        <Separator />
        <footer className="px-4 py-2.5 shrink-0">
          <Button
            variant="accent"
            className="w-full"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
          >
            <RefreshCw className={cn("size-4", refresh.isPending && "animate-spin")} />
            {refresh.isPending ? "Updating…" : active ? "Refresh numbers" : "Generate snapshot"}
          </Button>
        </footer>
      </div>
    </div>
  );
}
