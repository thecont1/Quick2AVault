import { BrowserWindow, ipcMain, logger } from "@glaze/core/backend";
import { getPreloadPath, getWindowUrl } from "./window-paths.js";
import type { DocumentDrilldown } from "../services/document-browser-model.js";

let documentsWindow: BrowserWindow | null = null;
/** A docId the browser should select on first load (consumed once by the renderer). */
let pendingFocusDocId: number | null = null;
let pendingDrilldown: DocumentDrilldown | null = null;

/**
 * Open (or focus) the Document Browser window. When `focusDocId` is provided the
 * browser selects that document: on first load the renderer reads it via
 * `documents:takeInitialFocus`; if the window is already open we broadcast
 * `documents:focus` so it can jump to the document immediately.
 */
export async function openDocumentsWindow(
  focusDocId?: number | null,
  drilldown?: DocumentDrilldown | null,
): Promise<void> {
  pendingFocusDocId =
    typeof focusDocId === "number" && Number.isFinite(focusDocId) ? focusDocId : null;
  pendingDrilldown = drilldown ?? null;

  if (documentsWindow && !documentsWindow.isDestroyed()) {
    documentsWindow.show();
    documentsWindow.focus();
    // Broadcast even when both values are null so a plain browser-open request
    // clears stale focus/drill-down context in an already-open window.
    ipcMain.broadcast("documents:focus", {
      docId: pendingFocusDocId,
      drilldown: pendingDrilldown,
    });
    return;
  }

  logger.info("documents", "Creating documents window");

  documentsWindow = new BrowserWindow({
    windowKey: "documents",
    width: 940,
    height: 680,
    minWidth: 760,
    minHeight: 500,
    title: "Documents",
    show: false,
    center: true,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  documentsWindow.once("ready-to-show", () => {
    documentsWindow?.show();
  });

  documentsWindow.on("closed", () => {
    documentsWindow = null;
  });

  const url = await getWindowUrl("documents-window.html");
  logger.info("documents", "Loading documents URL", { url });
  await documentsWindow.loadURL(url);
}

export function getDocumentsWindow(): BrowserWindow | null {
  return documentsWindow;
}

/** The renderer calls this once on mount to consume any pending initial focus. */
export function takeInitialDocumentsContext(): {
  docId: number | null;
  drilldown: DocumentDrilldown | null;
} {
  const context = { docId: pendingFocusDocId, drilldown: pendingDrilldown };
  pendingFocusDocId = null;
  pendingDrilldown = null;
  return context;
}
