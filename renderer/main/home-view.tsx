import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDownToLine, Check, Loader2, Vault } from "lucide-react";
import { cn } from "@glaze/core/utils";

type OrbStatus = "idle" | "processing" | "success" | "error";

interface IngestResult {
  filename: string;
  status: "ingested" | "duplicate" | "unsupported" | "error";
  markdownSuccess?: boolean;
  aiBlocked?: string;
  error?: string;
}

// Pointer travel (screen px) below which a press+release counts as a click.
const CLICK_THRESHOLD = 4;

export function HomeView() {
  const [status, setStatus] = useState<OrbStatus>("idle");
  const [dragActive, setDragActive] = useState(false);

  // Latest status, readable from imperative pointer handlers.
  const statusRef = useRef<OrbStatus>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Custom drag: track the press so we can tell a click from a window drag.
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
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

    setStatus("processing");
    try {
      const results = await window.glazeAPI.glaze.ipc.invoke<IngestResult[]>("vault:ingestFiles", paths);
      const hadHardFailure = results.some((r) => r.status === "error" || r.status === "unsupported");
      const anyIngested = results.some((r) => r.status === "ingested" || r.status === "duplicate");
      setStatus(anyIngested && !hadHardFailure ? "success" : hadHardFailure ? "error" : "success");
    } catch {
      setStatus("error");
    }
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

  const flushMove = useCallback(() => {
    rafRef.current = null;
    const move = pendingRef.current;
    if (move) window.glazeAPI.glaze.ipc.send("orb:dragMove", move.dx, move.dy);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return; // left button only
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, startX: e.screenX, startY: e.screenY, moved: false };
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
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    window.glazeAPI.glaze.ipc.send("orb:dragEnd");
    // A press with no meaningful travel, while idle, opens the snapshot popup.
    if (!drag.moved && statusRef.current === "idle") {
      void window.glazeAPI.glaze.ipc.invoke("snapshot:open");
    }
  }, []);

  const Icon =
    dragActive && status !== "processing"
      ? ArrowDownToLine
      : status === "processing"
        ? Loader2
        : status === "success"
          ? Check
          : status === "error"
            ? AlertCircle
            : Vault;

  return (
    <div className="h-full w-full flex items-center justify-center select-none">
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={cn(
          "flex items-center justify-center rounded-full size-16 cursor-pointer",
          "bg-accent text-accent-contrast shadow-lg transition-all duration-200 ease-out",
          dragActive && "scale-110 shadow-xl",
          status === "processing" && "orb-pulse",
        )}
      >
        <Icon className={cn("size-7", status === "processing" && "animate-spin")} strokeWidth={2} />
      </div>
    </div>
  );
}
