import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, ScrollArea, Separator, Text } from "@glaze/core/components";
import { useTheme } from "@glaze/core/hooks";
import { cn } from "@glaze/core/utils";
import { AlertCircle, CalendarRange, FileText, Loader2, RefreshCw, User, Users, Vault } from "lucide-react";

interface PersonSummary {
  name: string;
  documentCount: number;
  dateRange: { start: string; end: string } | null;
  categories: string[];
}

interface SnapshotData {
  people: PersonSummary[];
  unidentified: { documentCount: number; categories: string[] } | null;
}

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

function PersonCard({ name, documentCount, dateRange, categories, icon }: PersonSummary & { icon: "user" | "users" }) {
  const range = formatRange(dateRange);
  const Icon = icon === "users" ? Users : User;
  return (
    <div className="rounded-xl border border-panel bg-control-subtle p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center justify-center size-6 rounded-full bg-accent text-accent-contrast shrink-0">
          <Icon className="size-3.5" strokeWidth={2.2} />
        </span>
        <Text variant="strong" className="truncate flex-1" title={name}>
          {name}
        </Text>
        <Text variant="small" color="secondary" className="tabular-nums shrink-0">
          {documentCount} doc{documentCount === 1 ? "" : "s"}
        </Text>
      </div>
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
    </div>
  );
}

export function SnapshotView() {
  useTheme();
  const queryClient = useQueryClient();

  // Close on Escape (blur-to-dismiss is handled natively by the window).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void window.glazeAPI.glaze.ipc.invoke("snapshot:close");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const cachedQuery = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => window.glazeAPI.glaze.ipc.invoke<SnapshotResponse>("snapshot:getCached"),
  });

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
    },
  });

  const response = refresh.data ?? cachedQuery.data;
  const loading = refresh.isPending;
  const snapshot = response?.snapshot ?? null;
  const fallback = response?.fallback;
  const blockedMessage = response?.aiBlocked ? (BLOCKED_MESSAGE[response.aiBlocked] ?? BLOCKED_MESSAGE.disabled) : null;
  const hasPeople = !!snapshot && (snapshot.people.length > 0 || !!snapshot.unidentified);

  return (
    <div className="h-full w-full p-2.5">
      <div className="h-full w-full flex flex-col overflow-hidden rounded-2xl bg-popover border border-panel shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 bg-accent text-accent-contrast shrink-0">
          <Vault className="size-4 shrink-0" strokeWidth={2.2} />
          <span className="font-semibold text-sm flex-1">Financial Snapshot</span>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={loading}
            title="Refresh summary"
            className={cn(
              "flex items-center justify-center size-7 rounded-md transition-colors",
              "hover:bg-white/20 disabled:opacity-60 disabled:hover:bg-transparent",
            )}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} strokeWidth={2.2} />
          </button>
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

            {loading && !hasPeople ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-secondary">
                <Loader2 className="size-6 animate-spin" />
                <Text variant="small" color="secondary">
                  Reading your documents…
                </Text>
              </div>
            ) : null}

            {/* AI summary cards */}
            {hasPeople ? (
              <>
                {snapshot!.people.map((person) => (
                  <PersonCard key={person.name} {...person} icon="user" />
                ))}
                {snapshot!.unidentified && snapshot!.unidentified.documentCount > 0 ? (
                  <PersonCard
                    name="Unidentified"
                    documentCount={snapshot!.unidentified.documentCount}
                    dateRange={null}
                    categories={snapshot!.unidentified.categories}
                    icon="users"
                  />
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
                        ? { start: formatDate(fallback.dateRange.start), end: formatDate(fallback.dateRange.end) }
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
          <Button variant="accent" className="w-full" onClick={() => refresh.mutate()} disabled={loading}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            {loading ? "Generating…" : hasPeople ? "Refresh" : "Generate Summary"}
          </Button>
        </div>
      </div>
    </div>
  );
}
