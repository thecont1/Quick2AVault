/**
 * The Training Mode popup: a small focused card shown next to the orb that asks
 * a short set of questions about the just-ingested document. Unlike the snapshot
 * popup it does NOT dismiss on blur — the user drove this by enabling Training
 * Mode, so it stays until they Save, Skip, or turn Training Mode off.
 */
import { BrowserWindow, screen, logger } from "@glaze/core/backend";

import { getPreloadPath, getWindowUrl } from "./window-paths.js";
import { getOrbWindow } from "./orb-window.js";

const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 500;
const GAP = 10;

let trainingWindow: BrowserWindow | null = null;

export function getTrainingWindow(): BrowserWindow | null {
  return trainingWindow;
}

/** Position the popup beside the orb, clamped to the orb's display work area. */
function computePosition(): { x: number; y: number } {
  const orb = getOrbWindow();
  if (!orb || orb.isDestroyed()) {
    const wa = screen.getPrimaryDisplay().workArea;
    return {
      x: Math.round(wa.x + wa.width - POPUP_WIDTH - GAP),
      y: Math.round(wa.y + GAP),
    };
  }

  const b = orb.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: b.x + Math.round(b.width / 2),
    y: b.y + Math.round(b.height / 2),
  });
  const wa = display.workArea;

  // Prefer to the right of the orb; fall back to the left if it won't fit.
  let x = b.x + b.width + GAP;
  if (x + POPUP_WIDTH > wa.x + wa.width) {
    x = b.x - GAP - POPUP_WIDTH;
  }
  x = Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - POPUP_WIDTH - GAP);

  let y = b.y + Math.round(b.height / 2) - Math.round(POPUP_HEIGHT / 2);
  y = Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - POPUP_HEIGHT - GAP);

  return { x: Math.round(x), y: Math.round(y) };
}

export async function openTrainingWindow(): Promise<void> {
  if (trainingWindow && !trainingWindow.isDestroyed()) {
    const { x, y } = computePosition();
    trainingWindow.setPosition(x, y);
    trainingWindow.show();
    trainingWindow.focus();
    return;
  }

  const { x, y } = computePosition();

  trainingWindow = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  trainingWindow.setAlwaysOnTop(true, "floating");
  trainingWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  trainingWindow.on("closed", () => {
    trainingWindow = null;
  });

  trainingWindow.once("ready-to-show", () => {
    trainingWindow?.show();
    trainingWindow?.focus();
  });

  const url = await getWindowUrl("training-window.html");
  logger.info("training", "Opening training popup", { x, y });
  await trainingWindow.loadURL(url);
}

export function closeTrainingWindow(): void {
  if (trainingWindow && !trainingWindow.isDestroyed()) trainingWindow.close();
}
