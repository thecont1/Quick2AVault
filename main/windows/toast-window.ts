/**
 * A small, non-focusable toast shown just beside the orb — used to surface a
 * Markdown-conversion failure without stealing focus or clipping on the tiny orb
 * window. It auto-dismisses after a few seconds.
 */
import { BrowserWindow, screen, logger } from "@glaze/core/backend";

import { getWindowUrl } from "./window-paths.js";
import { getOrbWindow } from "./orb-window.js";

const TOAST_WIDTH = 300;
const TOAST_HEIGHT = 72;
const GAP = 10;
const DISMISS_MS = 6000;

export type ToastTone = "warn" | "info";

let toastWindow: BrowserWindow | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

/** Position the toast beside the orb (preferring the left), clamped on-screen. */
function computePosition(): { x: number; y: number } {
  const orb = getOrbWindow();
  const wa = orb && !orb.isDestroyed()
    ? screen.getDisplayNearestPoint({
        x: orb.getBounds().x + Math.round(orb.getBounds().width / 2),
        y: orb.getBounds().y + Math.round(orb.getBounds().height / 2),
      }).workArea
    : screen.getPrimaryDisplay().workArea;

  if (!orb || orb.isDestroyed()) {
    return {
      x: Math.round(wa.x + wa.width - TOAST_WIDTH - GAP),
      y: Math.round(wa.y + GAP),
    };
  }

  const b = orb.getBounds();
  // Prefer the left of the orb; fall back to the right if it won't fit.
  let x = b.x - GAP - TOAST_WIDTH;
  if (x < wa.x + GAP) x = b.x + b.width + GAP;
  x = Math.min(Math.max(x, wa.x + GAP), wa.x + wa.width - TOAST_WIDTH - GAP);

  let y = b.y + Math.round(b.height / 2) - Math.round(TOAST_HEIGHT / 2);
  y = Math.min(Math.max(y, wa.y + GAP), wa.y + wa.height - TOAST_HEIGHT - GAP);

  return { x: Math.round(x), y: Math.round(y) };
}

function scheduleDismiss(): void {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.close();
  }, DISMISS_MS);
}

export async function showToast(title: string, body: string, tone: ToastTone = "info"): Promise<void> {
  const { x, y } = computePosition();
  const params = new URLSearchParams({ title, body, tone });
  const base = await getWindowUrl("toast-window.html");
  const url = `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;

  if (toastWindow && !toastWindow.isDestroyed()) {
    toastWindow.setPosition(x, y);
    await toastWindow.loadURL(url);
    toastWindow.showInactive();
    scheduleDismiss();
    return;
  }

  toastWindow = new BrowserWindow({
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
  });

  toastWindow.setAlwaysOnTop(true, "floating");
  toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  toastWindow.on("closed", () => {
    toastWindow = null;
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  });

  toastWindow.once("ready-to-show", () => {
    toastWindow?.showInactive();
  });

  logger.info("toast", "Showing toast", { tone, x, y });
  await toastWindow.loadURL(url);
  scheduleDismiss();
}
