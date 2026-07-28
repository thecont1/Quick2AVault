import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { AlertCircle, ArrowDownToLine, Check, Loader2, Vault } from "lucide-react";
import { cn } from "@glaze/core/utils";

type OrbStatus = "idle" | "received" | "processing" | "success" | "error";

interface IngestResult {
  filename: string;
  status: "ingested" | "duplicate" | "unsupported" | "error";
  markdownSuccess?: boolean;
  aiBlocked?: string;
  error?: string;
  docId?: number;
}

interface DropReceipt {
  accepted: number;
  duplicate: number;
  unsupported: number;
  error: number;
}

interface IngestProgress {
  remaining: number;
  done: number;
  total: number;
  processing: boolean;
}

// Pointer travel (screen px) below which a press+release counts as a click.
const CLICK_THRESHOLD = 4;

// How long the brief "received / safe" acknowledgment shows before the orb
// settles into background processing.
const RECEIVED_MS = 850;

export function HomeView() {
  const [status, setStatus] = useState<OrbStatus>("idle");
  const [dragActive, setDragActive] = useState(false);
  // Batch progress: how many files are done out of the whole drop (0 total = idle).
  const [progress, setProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  // How many Training Mode reviews are waiting (drives the "training pending" glow).
  const [trainingPending, setTrainingPending] = useState(0);

  // Latest status, readable from imperative pointer handlers.
  const statusRef = useRef<OrbStatus>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Files still to finish in the active run, readable from the flash timer.
  const remainingRef = useRef(0);

  // Latest pending-review count, readable from the click handler.
  const trainingPendingRef = useRef(0);
  useEffect(() => {
    trainingPendingRef.current = trainingPending;
  }, [trainingPending]);

  // Custom drag: track the press so we can tell a click from a window drag.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<{ dx: number; dy: number } | null>(null);

  // Return the orb to its resting state shortly after a result flashes.
  useEffect(() => {
    if (status === "success" || status === "error") {
      const timer = window.setTimeout(() => setStatus("idle"), 1700);
      return () => window.clearTimeout(timer);
    }
  }, [status]);

  const handleFiles = useCallback(async (fileList: FileList) => {
    const paths: string[] = [];
    for (const file of Array.from(fileList)) {
      const filePath = window.glazeAPI.webUtils.getPathForFile(file);
      if (filePath) paths.push(filePath);
    }
    if (paths.length === 0) {
      setStatus("error");
      return;
    }

    try {
      // Intake is fast: the backend copies the originals into the vault and
      // returns as soon as they're safe. Heavy processing continues in the
      // background (progress + done arrive via broadcasts), so the app stays
      // responsive and further drops just queue.
      const receipt = await window.glazeAPI.glaze.ipc.invoke<DropReceipt>("vault:enqueue", paths);
      const anySafe = receipt.accepted > 0 || receipt.duplicate > 0;
      if (!anySafe) {
        // Only unsupported / failed intakes — nothing landed in the vault.
        setStatus("error");
        return;
      }

      // Acknowledge receipt immediately, then settle into processing if the
      // background queue still has work to do.
      setStatus("received");
      window.setTimeout(() => {
        if (statusRef.current !== "received") return;
        setStatus(remainingRef.current > 0 ? "processing" : "success");
      }, RECEIVED_MS);
    } catch {
      setStatus("error");
    }
  }, []);

  // Background ingestion updates: progress drives the batch pill; done flashes
  // the final result. Status transitions are gated so the "received" flash is
  // always seen first.
  useEffect(() => {
    const onProgress = window.glazeAPI.glaze.ipc.on(
      "ingest:progress",
      (_event, payload: unknown) => {
        const p = payload as IngestProgress | undefined;
        if (!p) return;
        remainingRef.current = p.remaining;
        setProgress({ done: p.done, total: p.total });
        // If work remains and the received flash is over, keep the orb spinning.
        if (p.remaining > 0 && statusRef.current !== "received") setStatus("processing");
      },
    );
    const onDone = window.glazeAPI.glaze.ipc.on("ingest:done", (_event, payload: unknown) => {
      const results = (payload as { results?: IngestResult[] } | undefined)?.results ?? [];
      remainingRef.current = 0;
      setProgress({ done: 0, total: 0 });
      const hadHardFailure = results.some(
        (r) => r.status === "error" || r.status === "unsupported",
      );
      const anyGood = results.some((r) => r.status === "ingested" || r.status === "duplicate");
      setStatus(anyGood && !hadHardFailure ? "success" : hadHardFailure ? "error" : "success");
    });
    return () => {
      onProgress();
      onDone();
    };
  }, []);

  // Drag-and-drop and right-click are handled at the window level so they fire
  // reliably across the whole orb surface.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      if (e.dataTransfer?.files?.length) void handleFiles(e.dataTransfer.files);
    };
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      void window.glazeAPI.glaze.ipc.invoke("orb:showContextMenu");
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, [handleFiles]);

  // Cancel any queued move frame on unmount.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Track how many training reviews are pending so the orb can glow when the
  // app has follow-up questions ready.
  useEffect(() => {
    let active = true;
    void window.glazeAPI.glaze.ipc
      .invoke<number>("training:getPendingCount")
      .then((count) => {
        if (active) setTrainingPending(count);
      })
      .catch(() => {});
    const unsubscribe = window.glazeAPI.glaze.ipc.on(
      "training:changed",
      (_event, payload: unknown) => {
        const count = (payload as { pendingCount?: number } | undefined)?.pendingCount;
        if (typeof count === "number") setTrainingPending(count);
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const flushMove = useCallback(() => {
    rafRef.current = null;
    const move = pendingRef.current;
    if (move) window.glazeAPI.glaze.ipc.send("orb:dragMove", move.dx, move.dy);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left button only
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.screenX,
      startY: e.screenY,
      moved: false,
    };
    window.glazeAPI.glaze.ipc.send("orb:dragStart");
  }, []);

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const dx = e.screenX - drag.startX;
      const dy = e.screenY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > CLICK_THRESHOLD) drag.moved = true;
      if (!drag.moved) return;
      pendingRef.current = { dx, dy };
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushMove);
    },
    [flushMove],
  );

  const endDrag = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    window.glazeAPI.glaze.ipc.send("orb:dragEnd");
    // A press with no meaningful travel, while idle, opens a popup: the pending
    // training questions take priority over the financial snapshot.
    if (!drag.moved && statusRef.current === "idle") {
      const channel = trainingPendingRef.current > 0 ? "training:open" : "snapshot:open";
      void window.glazeAPI.glaze.ipc.invoke(channel);
    }
  }, []);

  const Icon =
    dragActive && status !== "processing" && status !== "received"
      ? ArrowDownToLine
      : status === "processing"
        ? Loader2
        : status === "success" || status === "received"
          ? Check
          : status === "error"
            ? AlertCircle
            : Vault;

  const showBatch = status === "processing" && progress.total > 1;
  // Glow only when idle and not mid-drop, so it doesn't fight the other states.
  const trainingGlow = trainingPending > 0 && status === "idle" && !dragActive;

  return (
    <div className="h-full w-full flex items-center justify-center select-none">
      <div className="relative flex items-center justify-center">
        <div
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={cn(
            "flex items-center justify-center rounded-full size-16 cursor-pointer",
            "bg-accent text-accent-contrast transition-all duration-200 ease-out",
            // Theme-aware edge/shadow so the orb reads cleanly on light and dark desktops.
            "ring-1 ring-black/10 shadow-lg shadow-black/20",
            "dark:ring-white/20 dark:shadow-xl dark:shadow-black/50",
            dragActive && "scale-110 shadow-xl",
            status === "received" && "orb-received",
            status === "processing" && "orb-pulse",
            trainingGlow && "orb-training ring-white/60 dark:ring-white/70",
          )}
        >
          <Icon
            className={cn("size-7", status === "processing" && "animate-spin")}
            strokeWidth={2}
          />
        </div>

        {/* Batch progress: how many files are left in a multi-file drop. */}
        {showBatch ? (
          <div
            className={cn(
              "absolute -bottom-1 left-1/2 -translate-x-1/2 px-2 py-px rounded-full",
              "bg-panel text-primary text-[10px] font-semibold tabular-nums leading-tight",
              "ring-1 ring-black/10 dark:ring-white/15 shadow-sm whitespace-nowrap",
            )}
          >
            {progress.done}/{progress.total}
          </div>
        ) : null}
      </div>
    </div>
  );
}
