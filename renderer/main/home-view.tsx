import { useCallback, useEffect, useState } from "react";
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

export function HomeView() {
  const [status, setStatus] = useState<OrbStatus>("idle");
  const [dragActive, setDragActive] = useState(false);

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
  // reliably across the whole orb surface (including the draggable region).
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
        className={cn(
          "drag-region flex items-center justify-center rounded-full size-16",
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
