/**
 * The financial-snapshot popup: a small custom-shaped card shown next to the
 * orb. It is focusable so it dismisses on blur (click outside), but a busy flag
 * keeps it open while a refresh (and any AI consent dialog) is in flight.
 */
import { BrowserWindow, screen, logger } from "@glaze/core/backend";

import { getPreloadPath, getWindowUrl } from "./window-paths.js";
import { getOrbWindow } from "./orb-window.js";

const POPUP_WIDTH = 450;
const POPUP_HEIGHT = 680;
const GAP = 5;

let snapshotWindow: BrowserWindow | null = null;
let busy = false;

/** While busy (refresh/consent in flight), a blur must not dismiss the popup. */
export function setSnapshotBusy(value: boolean): void {
  busy = value;
}

export function getSnapshotWindow(): BrowserWindow | null {
  return snapshotWindow;
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

  // Vertically centre on the orb, clamped inside the work area.
  let y = b.y + Math.round(b.height / 2) - Math.round(POPUP_HEIGHT / 2);
  y = Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - POPUP_HEIGHT - GAP);

  return { x: Math.round(x), y: Math.round(y) };
}

export async function openSnapshotWindow(): Promise<void> {
  if (snapshotWindow && !snapshotWindow.isDestroyed()) {
    const { x, y } = computePosition();
    snapshotWindow.setPosition(x, y);
    snapshotWindow.show();
    snapshotWindow.focus();
    return;
  }

  busy = false;
  const { x, y } = computePosition();

  snapshotWindow = new BrowserWindow({
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

  snapshotWindow.setAlwaysOnTop(true, "floating");
  snapshotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Dismiss on click-outside, unless a refresh/consent flow is running.
  snapshotWindow.on("blur", () => {
    if (busy) return;
    if (snapshotWindow && !snapshotWindow.isDestroyed()) snapshotWindow.close();
  });

  snapshotWindow.on("closed", () => {
    snapshotWindow = null;
    busy = false;
  });

  snapshotWindow.once("ready-to-show", () => {
    snapshotWindow?.show();
    // Don't call .focus() — it auto-focuses the first focusable element in the
    // popup (the Review Queue icon in the header), leaving a persistent focus
    // ring that looks like the button is "selected". The popup is already
    // visible and interactive without stealing focus.
  });

  const url = await getWindowUrl("snapshot-window.html");
  logger.info("snapshot", "Opening snapshot popup", { x, y });
  await snapshotWindow.loadURL(url);
}

export function closeSnapshotWindow(): void {
  if (snapshotWindow && !snapshotWindow.isDestroyed()) snapshotWindow.close();
}
