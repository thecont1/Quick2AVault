/**
 * Document Browser — a calm, contact-sheet-style inbox for ingested documents.
 *
 * Two panes (SplitView list + primary): a keyboard-navigable list on the left,
 * and a large recognizable preview + textual summary / evidence card on the
 * right. Hovering a row updates the preview + summary (fast browsing); clicking
 * pins the document and opens the full, editable Evidence Card (stable study).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  List,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SplitView,
  Text,
} from "@glaze/core/components";
import { cn, getFileThumbnailUrl } from "@glaze/core/utils";
import {
  Building2,
  Calendar,
  CalendarClock,
  Camera,
  Coins,
  Copy,
  ExternalLink,
  FileSearch,
  FileText,
  LineChart,
  Pencil,
  Search,
  Star,
  Tag,
  Trash2,
  TrendingUp,
  User,
  ZoomIn,
} from "lucide-react";
import { EvidenceCard } from "./evidence-card";
import {
  applyDocumentDrilldown,
  groupDocumentRows,
  type DocumentDrilldown,
} from "../../main/services/document-browser-model";
import { impactSummary, useFinancePrefs, type FinancePrefs } from "../finance";
import {
  formatDate,
  formatForeign,
  formatInr,
  fyLabel,
  IMPACT_LABEL,
  LIFECYCLE_META,
  OVERALL_META,
  ROLE_LABEL,
  type DocumentBrowserRow,
  type DocumentDetail,
  type DuplicateEvent,
  type LifecycleResult,
} from "./types";

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  window.glazeAPI.glaze.ipc.invoke<T>(channel, ...args);

/** The lanes the browser can filter to. */
type Lane = "all" | "active" | "irrelevant" | "excluded" | "duplicates";

const LANE_OPTIONS: { value: Lane; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "irrelevant", label: "Irrelevant" },
  { value: "excluded", label: "Excluded" },
  { value: "duplicates", label: "Duplicates" },
];

// ── Contact-sheet preview ─────────────────────────────────────────────────

// How much the hover magnifier enlarges the document under the cursor.
const PREVIEW_ZOOM = 2.6;
const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/**
 * Recognizable preview with a hover magnifier: while the pointer is over the
 * image it enlarges the region under the cursor and pans as the pointer moves,
 * so fine print can be inspected without opening the file. A higher-resolution
 * thumbnail is loaded so the zoom stays sharp; clicking still opens the original.
 */
function Preview({ row, onOpen }: { row: DocumentBrowserRow; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const [zooming, setZooming] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  // The image's on-screen box, captured (unscaled) on enter so pointer→origin
  // math stays stable while the image is transformed.
  const rectRef = useRef<DOMRect | null>(null);
  const src = getFileThumbnailUrl(row.rawPath, { size: 1600, scaleFactor: 2, fallback: "icon" });
  const canZoom = !errored && loaded;

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open the original file"
      className={cn(
        "group relative flex h-[min(52vh,480px)] min-h-[340px] w-full items-center justify-center overflow-hidden rounded-card border border-separator bg-well",
        canZoom && "cursor-zoom-in",
      )}
    >
      {!errored ? (
        <img
          key={row.rawPath}
          src={src}
          alt={row.filename}
          draggable={false}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
          onMouseEnter={(e) => {
            if (!canZoom) return;
            rectRef.current = e.currentTarget.getBoundingClientRect();
            setZooming(true);
          }}
          onMouseMove={(e) => {
            if (!canZoom) return;
            const rect = rectRef.current;
            if (!rect) return;
            setOrigin({
              x: clampPct(((e.clientX - rect.left) / rect.width) * 100),
              y: clampPct(((e.clientY - rect.top) / rect.height) * 100),
            });
          }}
          onMouseLeave={() => setZooming(false)}
          style={{
            transform: zooming ? `scale(${PREVIEW_ZOOM})` : "scale(1)",
            transformOrigin: `${origin.x}% ${origin.y}%`,
            transition: "transform 220ms ease-out, opacity 400ms ease-out",
          }}
          className={cn(
            "max-h-full max-w-full object-contain will-change-transform",
            loaded ? "opacity-100" : "opacity-0",
          )}
        />
      ) : (
        <div className="flex flex-col items-center gap-2 text-tertiary">
          <FileText className="size-10" strokeWidth={1.5} />
          <Text variant="small" color="tertiary" className="uppercase tracking-wide">
            {row.fileType || "file"}
          </Text>
        </div>
      )}

      {/* Magnifier hint — appears while the zoom is active. */}
      {canZoom ? (
        <span
          className={cn(
            "pointer-events-none absolute left-2 top-2 flex items-center gap-1 rounded-pill bg-popover/90 px-2 py-1 shadow-sm transition-opacity",
            zooming ? "opacity-100" : "opacity-0",
          )}
        >
          <ZoomIn className="size-3 text-secondary" />
          <Text variant="small" color="secondary">
            Move to inspect
          </Text>
        </span>
      ) : null}

      <span className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-pill bg-popover/90 px-2 py-1 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
        <ExternalLink className="size-3 text-secondary" />
        <Text variant="small" color="secondary">
          Open
        </Text>
      </span>
    </button>
  );
}

// ── Lightweight hover summary (from list-row data, no fetch) ───────────────

function SummaryLine({
  icon,
  label,
  value,
  muted,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shrink-0 text-tertiary">{icon}</span>
      <Text variant="small" color="tertiary" className="w-24 shrink-0">
        {label}
      </Text>
      <Text
        variant="small"
        color={muted ? "tertiary" : "primary"}
        className="flex-1 min-w-0 truncate"
      >
        {value}
      </Text>
    </div>
  );
}

function PeekSummary({ row, prefs }: { row: DocumentBrowserRow; prefs: FinancePrefs }) {
  const meta = OVERALL_META[row.reviewStatus];
  const currencyLine =
    row.currencyStatus === "converted" &&
    row.foreignAmount != null &&
    row.foreignCurrency &&
    row.inrValue != null
      ? `${formatForeign(row.foreignAmount, row.foreignCurrency, prefs)} → ${formatInr(row.inrValue, prefs)}`
      : row.currencyStatus === "needs_review"
        ? "Foreign amount — needs review"
        : null;

  return (
    <div className="flex flex-col gap-2">
      {/* Plain-language "what this means" — the first thing to read. */}
      {row.impact ? (
        <div className="flex items-start gap-2 rounded-card border border-accent/30 bg-accent/10 px-3 py-2">
          <TrendingUp className="mt-0.5 size-4 shrink-0 text-accent" />
          <Text variant="small" className="break-words">
            {impactSummary(row.impact, prefs)}
          </Text>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {row.lifecycleState !== "active" ? (
          <Badge color={LIFECYCLE_META[row.lifecycleState].color}>
            {LIFECYCLE_META[row.lifecycleState].label}
          </Badge>
        ) : null}
        <Badge color={meta.color}>{meta.label}</Badge>
        {row.isContractNote ? (
          <Badge color="purple">
            <LineChart className="size-3" /> Contract note
          </Badge>
        ) : null}
        {row.fileType === "image" ? (
          <Badge color="secondary">
            <Camera className="size-3" /> Photo
          </Badge>
        ) : null}
        {row.personIsSelf ? (
          <Badge color="blue">
            <Star className="size-3" /> Self
          </Badge>
        ) : null}
        {row.personRoles.map((r) => (
          <Badge key={r} color="secondary">
            {ROLE_LABEL[r]}
          </Badge>
        ))}
        {row.hasManualOverride ? (
          <Badge color="blue">
            <Pencil className="size-3" /> Edited
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-separator">
        <SummaryLine
          icon={<User className="size-3.5" />}
          label="Person"
          value={row.personName ?? "Unidentified"}
          muted={!row.personName}
        />
        <SummaryLine
          icon={<FileText className="size-3.5" />}
          label="Type"
          value={row.docType ?? "Unknown"}
          muted={!row.docType}
        />
        <SummaryLine
          icon={<Building2 className="size-3.5" />}
          label="Vendor"
          value={row.vendor ?? "Unknown"}
          muted={!row.vendor}
        />
        <SummaryLine
          icon={<Calendar className="size-3.5" />}
          label="Date"
          value={formatDate(row.docDate, prefs)}
          muted={!row.docDate}
        />
        <SummaryLine
          icon={<CalendarClock className="size-3.5" />}
          label="Financial year"
          value={row.financialYear ? fyLabel(row.financialYear) : "Not determined"}
          muted={!row.financialYear}
        />
        <SummaryLine
          icon={<Tag className="size-3.5" />}
          label="Category"
          value={row.category ?? "Uncategorized"}
          muted={!row.category}
        />
        {row.impact ? (
          <SummaryLine
            icon={<TrendingUp className="size-3.5" />}
            label="Impact"
            value={`${IMPACT_LABEL[row.impact.bucket]}${row.impact.amountInr != null ? " · " + formatInr(row.impact.amountInr, prefs) : ""}`}
          />
        ) : null}
        {currencyLine ? (
          <SummaryLine
            icon={<Coins className="size-3.5" />}
            label="Currency"
            value={currencyLine}
          />
        ) : null}
      </div>
      {row.triageReason ? (
        <Text variant="small" color="secondary">
          {row.triageReason}
        </Text>
      ) : null}
      <Text variant="small" color="tertiary" className="italic">
        Click this document to inspect and edit every field.
      </Text>
    </div>
  );
}

// ── Duplicates lane ────────────────────────────────────────────────────────

function DuplicatesPanel({ onOpenOriginal }: { onOpenOriginal: (docId: number) => void }) {
  const queryClient = useQueryClient();
  const dupQuery = useQuery({
    queryKey: ["documents", "duplicates"],
    queryFn: () => invoke<DuplicateEvent[]>("duplicates:list"),
  });
  const events = dupQuery.data ?? [];

  const resolve = useMutation({
    mutationFn: (input: { id: number; action: "acknowledge" | "delete" }) =>
      invoke<LifecycleResult>("duplicates:resolve", input.id, input.action),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["documents", "duplicates"] });
    },
  });

  if (events.length === 0) {
    return (
      <div className="p-4">
        <EmptyState
          title="No duplicates"
          description="When you drop a file that exactly matches one already in your vault, it's logged here instead of being processed again."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <Text variant="small" color="secondary">
        Exact duplicates (identical content) are never reprocessed. Keep them ignored, or delete the
        log entry.
      </Text>
      {events.map((e) => (
        <div
          key={e.id}
          className="flex flex-col gap-2 rounded-card border border-separator bg-well px-3 py-2.5"
        >
          <div className="flex items-center gap-2">
            <Copy className="size-4 shrink-0 text-tertiary" />
            <Text variant="small-strong" className="flex-1 min-w-0 truncate" title={e.filename}>
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
                onClick={() => onOpenOriginal(e.duplicateOfDocId!)}
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
              Delete log entry
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── List row ──────────────────────────────────────────────────────────────

function statusDotClass(status: DocumentBrowserRow["reviewStatus"]): string {
  switch (status) {
    case "conflict":
      return "bg-support-red";
    case "missing":
      return "bg-support-orange";
    case "low_confidence":
      return "bg-support-yellow";
    default:
      return "bg-support-green";
  }
}

// ── The view ────────────────────────────────────────────────────────────────

export function DocumentsView() {
  const [pinnedId, setPinnedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [lane, setLane] = useState<Lane>("all");
  const [drilldown, setDrilldown] = useState<DocumentDrilldown | null>(null);
  const prefs = useFinancePrefs();
  const queryClient = useQueryClient();

  const rowsQuery = useQuery({
    queryKey: ["documents", "list"],
    queryFn: () => invoke<DocumentBrowserRow[]>("documents:list"),
  });
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  const laneMatches = (r: DocumentBrowserRow) =>
    lane === "all" || lane === "duplicates" ? true : r.lifecycleState === lane;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return applyDocumentDrilldown(rows, drilldown).filter((r) => {
      if (!laneMatches(r)) return false;
      if (!q) return true;
      return [
        r.filename,
        r.personName,
        r.vendor,
        r.docType,
        r.category,
        r.financialYear && fyLabel(r.financialYear),
      ].some((v) => v?.toLowerCase().includes(q));
    });
  }, [rows, query, lane, drilldown]);
  const groups = useMemo(() => groupDocumentRows(filtered), [filtered]);

  // Consume any initial focus request, and subscribe to later ones + data changes.
  useEffect(() => {
    let cancelled = false;
    void invoke<{ docId: number | null; drilldown: DocumentDrilldown | null }>(
      "documents:takeInitialFocus",
    ).then((context) => {
      if (cancelled) return;
      if (typeof context.docId === "number") setPinnedId(context.docId);
      if (context.drilldown) {
        setDrilldown(context.drilldown);
        setLane("all");
      }
    });
    const unsubscribeFocus = window.glazeAPI.glaze.ipc.on(
      "documents:focus",
      (_e, payload: unknown) => {
        const context = payload as { docId?: unknown; drilldown?: DocumentDrilldown | null };
        const id = context.docId;
        if (typeof id === "number") setPinnedId(id);
        setDrilldown(context.drilldown ?? null);
        if (context.drilldown) setLane("all");
      },
    );
    const unsubscribeChanged = window.glazeAPI.glaze.ipc.on("documents:changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["documents"] });
    });
    const unsubscribeDupes = window.glazeAPI.glaze.ipc.on("duplicates:changed", () => {
      void queryClient.invalidateQueries({ queryKey: ["documents", "duplicates"] });
    });
    return () => {
      cancelled = true;
      unsubscribeFocus();
      unsubscribeChanged();
      unsubscribeDupes();
    };
  }, [queryClient]);

  // Default the pinned document to the first row once data arrives.
  useEffect(() => {
    if (pinnedId == null && filtered.length > 0) setPinnedId(filtered[0].docId);
  }, [pinnedId, filtered]);

  useEffect(() => {
    if (filtered.length > 0 && !filtered.some((row) => row.docId === pinnedId)) {
      setPinnedId(filtered[0].docId);
    }
  }, [filtered, pinnedId]);

  const activeId = hoverId ?? pinnedId;
  const activeRow = rows.find((r) => r.docId === activeId) ?? null;
  const selectedRow = filtered.find((r) => r.docId === pinnedId) ?? null;
  const showingPinned = activeId != null && activeId === pinnedId;

  const detailQuery = useQuery({
    queryKey: ["documents", "detail", pinnedId],
    queryFn: () => invoke<DocumentDetail | null>("documents:detail", pinnedId),
    enabled: pinnedId != null,
  });

  const openFile = (docId: number) => {
    void invoke<string>("documents:open", docId);
  };

  const openOriginal = (docId: number) => {
    setLane("all");
    setPinnedId(docId);
  };

  const laneSelect = (
    <Select value={lane} onValueChange={(v) => setLane(v as Lane)}>
      <SelectTrigger size="small" variant="filled" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LANE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // The Duplicates lane is a full-width log rather than a list/detail split.
  if (lane === "duplicates") {
    return (
      <ScrollArea title="Duplicates" actions={laneSelect} className="h-full">
        <DuplicatesPanel onOpenOriginal={openOriginal} />
      </ScrollArea>
    );
  }

  const list = (
    <ScrollArea
      title="Documents"
      subtitle={rows.length > 0 ? `${rows.length} file${rows.length === 1 ? "" : "s"}` : undefined}
      actions={
        <div className="flex items-center gap-1.5">
          {laneSelect}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input
              size="small"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-32 pl-7"
            />
          </div>
        </div>
      }
      className="h-full"
    >
      {drilldown ? (
        <div className="m-3 flex items-start gap-2 rounded-card border border-accent/30 bg-accent/10 px-3 py-2">
          <FileSearch className="mt-0.5 size-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <Text variant="small-strong" className="capitalize">
              {drilldown.metric} · {drilldown.label}
            </Text>
            <Text variant="mini" color="secondary" className="block">
              Documents behind this snapshot total.
            </Text>
          </div>
          <button
            type="button"
            className="text-xs text-secondary hover:text-primary"
            onClick={() => setDrilldown(null)}
          >
            Clear
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        <div className="p-4">
          <Text variant="small" color="tertiary">
            No documents yet. Drop files onto the orb to get started.
          </Text>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-4">
          <Text variant="small" color="tertiary">
            {query
              ? `No documents match “${query}”.`
              : lane === "all"
                ? "No documents."
                : `No ${LANE_OPTIONS.find((o) => o.value === lane)?.label.toLowerCase()} documents.`}
          </Text>
        </div>
      ) : (
        <div onMouseLeave={() => setHoverId(null)}>
          <List.Root
            items={filtered}
            getItemKey={(r) => String(r.docId)}
            selectedItem={selectedRow}
            onSelectedItemChange={(r) => setPinnedId(r?.docId ?? null)}
            autoFocus
            onNavigationKeyDown={(e) => {
              if (e.key === "Enter" && pinnedId != null) openFile(pinnedId);
            }}
          >
            {groups.flatMap((group) => [
              <div
                key={`group-${group.label}`}
                className="sticky top-0 z-10 flex items-center gap-2 border-y border-separator bg-popover/95 px-3 py-1.5 backdrop-blur"
              >
                <Text
                  variant="mini"
                  color="secondary"
                  className="font-semibold uppercase tracking-[0.12em]"
                >
                  {group.label}
                </Text>
                <span className="text-[10px] tabular-nums text-tertiary">{group.rows.length}</span>
              </div>,
              ...group.rows.map((r) => (
                <List.Item key={r.docId} item={r} onMouseEnter={() => setHoverId(r.docId)}>
                  <List.ItemIcon
                    src={getFileThumbnailUrl(r.rawPath, {
                      size: 40,
                      scaleFactor: 2,
                      fallback: "icon",
                    })}
                    alt=""
                  />
                  <List.ItemContent>
                    <List.ItemTitle>{r.filename}</List.ItemTitle>
                    <List.ItemDescription>
                      {formatDate(r.docDate ?? r.dateIngested, prefs) +
                        " · " +
                        (r.personName ? `👤 ${r.personName}` : "Unidentified") +
                        (r.financialYear ? " · " + fyLabel(r.financialYear) : "")}
                    </List.ItemDescription>
                  </List.ItemContent>
                  <List.ItemAccessory>
                    <div className="flex items-center gap-1.5">
                      {r.lifecycleState !== "active" ? (
                        <Badge color={LIFECYCLE_META[r.lifecycleState].color}>
                          {LIFECYCLE_META[r.lifecycleState].label}
                        </Badge>
                      ) : null}
                      {r.isContractNote ? (
                        <span title="Contract note">
                          <LineChart className="size-3.5 text-purple-9" />
                        </span>
                      ) : null}
                      {r.fileType === "image" ? (
                        <span title="Photo">
                          <Camera className="size-3.5 text-tertiary" />
                        </span>
                      ) : null}
                      {r.hasFx ? <Coins className="size-3.5 text-tertiary" /> : null}
                      {r.hasManualOverride ? <Pencil className="size-3 text-support-blue" /> : null}
                      <span
                        className={cn("size-2 rounded-full", statusDotClass(r.reviewStatus))}
                        title={OVERALL_META[r.reviewStatus].label}
                      />
                    </div>
                  </List.ItemAccessory>
                </List.Item>
              )),
            ])}
          </List.Root>
        </div>
      )}
    </ScrollArea>
  );

  return (
    <SplitView
      list={list}
      listSize={{ default: 340, min: 280, max: 460 }}
      storageKey="documents-browser"
    >
      <ScrollArea
        title={activeRow ? activeRow.filename : "Details"}
        subtitle={activeRow ? formatDate(activeRow.dateIngested, prefs) + " · ingested" : undefined}
        className="h-full"
      >
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
          {activeRow == null ? (
            <EmptyState
              title={rows.length === 0 ? "Nothing ingested yet" : "Select a document"}
              description={
                rows.length === 0
                  ? "Drop financial documents onto the orb — they'll appear here to browse and inspect."
                  : "Hover a document to preview it, or click one to inspect and edit every field."
              }
            />
          ) : (
            <>
              <Preview
                key={activeRow.docId}
                row={activeRow}
                onOpen={() => openFile(activeRow.docId)}
              />

              {showingPinned ? (
                detailQuery.isLoading || !detailQuery.data ? (
                  <div className="flex flex-col gap-2">
                    <div className="h-4 w-40 rounded-md bg-well" />
                    <div className="h-4 w-64 rounded-md bg-well" />
                    <div className="h-24 w-full rounded-lg bg-well" />
                  </div>
                ) : (
                  <EvidenceCard
                    detail={detailQuery.data}
                    onChanged={() => {
                      void detailQuery.refetch();
                      void rowsQuery.refetch();
                    }}
                  />
                )
              ) : (
                <PeekSummary row={activeRow} prefs={prefs} />
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </SplitView>
  );
}
