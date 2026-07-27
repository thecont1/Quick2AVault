/**
 * Document Browser — a calm, contact-sheet-style inbox for ingested documents.
 *
 * Two panes (SplitView list + primary): a keyboard-navigable list on the left,
 * and a large recognizable preview + textual summary / evidence card on the
 * right. Hovering a row updates the preview + summary (fast browsing); clicking
 * pins the document and opens the full, editable Evidence Card (stable study).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, EmptyState, Input, List, ScrollArea, SplitView, Text } from "@glaze/core/components";
import { cn, getFileThumbnailUrl } from "@glaze/core/utils";
import {
  Building2,
  Calendar,
  CalendarClock,
  Coins,
  ExternalLink,
  FileText,
  Pencil,
  Search,
  Star,
  Tag,
  User,
} from "lucide-react";
import { EvidenceCard } from "./evidence-card";
import { useFinancePrefs, type FinancePrefs } from "../finance";
import {
  formatDate,
  formatForeign,
  formatInr,
  fyLabel,
  OVERALL_META,
  ROLE_LABEL,
  type DocumentBrowserRow,
  type DocumentDetail,
} from "./types";

const invoke = <T,>(channel: string, ...args: unknown[]): Promise<T> =>
  window.glazeAPI.glaze.ipc.invoke<T>(channel, ...args);

// ── Contact-sheet preview ─────────────────────────────────────────────────

function Preview({ row, onOpen }: { row: DocumentBrowserRow; onOpen: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const src = getFileThumbnailUrl(row.rawPath, { size: 400, scaleFactor: 2, fallback: "icon" });

  return (
    <button
      type="button"
      onClick={onOpen}
      title="Open the original file"
      className="group relative flex h-[300px] w-full items-center justify-center overflow-hidden rounded-card border border-separator bg-well"
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
          className={cn(
            "max-h-full max-w-full object-contain transition-opacity duration-500 ease-out",
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

function SummaryLine({ icon, label, value, muted }: { icon: ReactNode; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="shrink-0 text-tertiary">{icon}</span>
      <Text variant="small" color="tertiary" className="w-24 shrink-0">
        {label}
      </Text>
      <Text variant="small" color={muted ? "tertiary" : "primary"} className="flex-1 min-w-0 truncate">
        {value}
      </Text>
    </div>
  );
}

function PeekSummary({ row, prefs }: { row: DocumentBrowserRow; prefs: FinancePrefs }) {
  const meta = OVERALL_META[row.reviewStatus];
  const currencyLine =
    row.currencyStatus === "converted" && row.foreignAmount != null && row.foreignCurrency && row.inrValue != null
      ? `${formatForeign(row.foreignAmount, row.foreignCurrency, prefs)} → ${formatInr(row.inrValue, prefs)}`
      : row.currencyStatus === "needs_review"
        ? "Foreign amount — needs review"
        : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge color={meta.color}>{meta.label}</Badge>
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
        <SummaryLine icon={<User className="size-3.5" />} label="Person" value={row.personName ?? "Unidentified"} muted={!row.personName} />
        <SummaryLine icon={<FileText className="size-3.5" />} label="Type" value={row.docType ?? "Unknown"} muted={!row.docType} />
        <SummaryLine icon={<Building2 className="size-3.5" />} label="Vendor" value={row.vendor ?? "Unknown"} muted={!row.vendor} />
        <SummaryLine icon={<Calendar className="size-3.5" />} label="Date" value={formatDate(row.docDate, prefs)} muted={!row.docDate} />
        <SummaryLine icon={<CalendarClock className="size-3.5" />} label="Financial year" value={row.financialYear ? fyLabel(row.financialYear) : "Not determined"} muted={!row.financialYear} />
        <SummaryLine icon={<Tag className="size-3.5" />} label="Category" value={row.category ?? "Uncategorized"} muted={!row.category} />
        {currencyLine ? <SummaryLine icon={<Coins className="size-3.5" />} label="Currency" value={currencyLine} /> : null}
      </div>
      <Text variant="small" color="tertiary" className="italic">
        Click this document to inspect and edit every field.
      </Text>
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
  const prefs = useFinancePrefs();

  const rowsQuery = useQuery({
    queryKey: ["documents", "list"],
    queryFn: () => invoke<DocumentBrowserRow[]>("documents:list"),
  });
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.filename, r.personName, r.vendor, r.docType, r.category, r.financialYear && fyLabel(r.financialYear)].some(
        (v) => v?.toLowerCase().includes(q),
      ),
    );
  }, [rows, query]);

  // Consume any initial focus request, and subscribe to later ones.
  useEffect(() => {
    let cancelled = false;
    void invoke<number | null>("documents:takeInitialFocus").then((id) => {
      if (!cancelled && typeof id === "number") setPinnedId(id);
    });
    const unsubscribe = window.glazeAPI.glaze.ipc.on("documents:focus", (_e, payload: unknown) => {
      const id = (payload as { docId?: unknown })?.docId;
      if (typeof id === "number") setPinnedId(id);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Default the pinned document to the first row once data arrives.
  useEffect(() => {
    if (pinnedId == null && rows.length > 0) setPinnedId(rows[0].docId);
  }, [pinnedId, rows]);

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

  const list = (
    <ScrollArea
      title="Documents"
      subtitle={rows.length > 0 ? `${rows.length} file${rows.length === 1 ? "" : "s"}` : undefined}
      actions={
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-tertiary" />
          <Input
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-40 pl-7"
          />
        </div>
      }
      className="h-full"
    >
      {rows.length === 0 ? (
        <div className="p-4">
          <Text variant="small" color="tertiary">
            No documents yet. Drop files onto the orb to get started.
          </Text>
        </div>
      ) : filtered.length === 0 ? (
        <div className="p-4">
          <Text variant="small" color="tertiary">
            No documents match “{query}”.
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
            {filtered.map((r) => (
              <List.Item key={r.docId} item={r} onMouseEnter={() => setHoverId(r.docId)}>
                <List.ItemIcon
                  src={getFileThumbnailUrl(r.rawPath, { size: 40, scaleFactor: 2, fallback: "icon" })}
                  alt=""
                />
                <List.ItemContent>
                  <List.ItemTitle>{r.filename}</List.ItemTitle>
                  <List.ItemDescription>
                    {(r.personName ?? "Unidentified") +
                      " · " +
                      (r.docType ?? "Unknown type") +
                      (r.financialYear ? " · " + fyLabel(r.financialYear) : "")}
                  </List.ItemDescription>
                </List.ItemContent>
                <List.ItemAccessory>
                  <div className="flex items-center gap-1.5">
                    {r.hasFx ? <Coins className="size-3.5 text-tertiary" /> : null}
                    {r.hasManualOverride ? <Pencil className="size-3 text-support-blue" /> : null}
                    <span
                      className={cn("size-2 rounded-full", statusDotClass(r.reviewStatus))}
                      title={OVERALL_META[r.reviewStatus].label}
                    />
                  </div>
                </List.ItemAccessory>
              </List.Item>
            ))}
          </List.Root>
        </div>
      )}
    </ScrollArea>
  );

  return (
    <SplitView list={list} listSize={{ default: 340, min: 280, max: 460 }} storageKey="documents-browser">
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
              <Preview key={activeRow.docId} row={activeRow} onOpen={() => openFile(activeRow.docId)} />

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
