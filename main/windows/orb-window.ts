/**
 * The floating orb window: a small, always-on-top, transparent circular widget
 * that stays visible across apps and spaces and remembers its position.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { BrowserWindow, app, logger } from "@glaze/core/backend";

import { getPreloadPath, getWindowUrl } from "./window-paths.js";

// Window is larger than the visible orb so its shadow and pulse have room.
const ORB_WINDOW_SIZE = 104;

let orbWindow: BrowserWindow | null = null;

// Custom drag state: the orb is dragged from the renderer (so plain clicks can
// be distinguished from drags), applied here via setPosition.
let dragOrigin: [number, number] | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

interface OrbState {
  x?: number;
  y?: number;
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), "orb-state.json");
}

function loadState(): OrbState {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), "utf-8")) as OrbState;
  } catch {
    return {};
  }
}

function saveState(state: OrbState): void {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(stateFilePath(), JSON.stringify(state));
  } catch (error) {
    logger.warn("orb", "Failed to save orb position", { error: String(error) });
  }
}

export function getOrbWindow(): BrowserWindow | null {
  return orbWindow;
}

/** Persist the orb position shortly after movement settles (avoids per-frame writes). */
function schedulePositionSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!orbWindow || orbWindow.isDestroyed()) return;
    const [x, y] = orbWindow.getPosition();
    saveState({ x, y });
  }, 400);
}

/** Record the orb's starting position at the beginning of a renderer drag. */
export function beginOrbDrag(): void {
  if (!orbWindow || orbWindow.isDestroyed()) return;
  const [x, y] = orbWindow.getPosition();
  dragOrigin = [x, y];
}

/** Move the orb by a delta (in screen pixels) from the drag's start position. */
export function moveOrbBy(dx: number, dy: number): void {
  if (!orbWindow || orbWindow.isDestroyed() || !dragOrigin) return;
  orbWindow.setPosition(Math.round(dragOrigin[0] + dx), Math.round(dragOrigin[1] + dy));
}

/** End a renderer drag and persist the final position. */
export function endOrbDrag(): void {
  dragOrigin = null;
  schedulePositionSave();
}

export async function createOrbWindow(): Promise<void> {
  if (orbWindow && !orbWindow.isDestroyed()) {
    orbWindow.showInactive();
    return;
  }

  const state = loadState();
  const hasPosition = typeof state.x === "number" && typeof state.y === "number";

  orbWindow = new BrowserWindow({
    width: ORB_WINDOW_SIZE,
    height: ORB_WINDOW_SIZE,
    ...(hasPosition ? { x: state.x, y: state.y } : { center: true }),
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: getPreloadPath(),
    },
  });

  // Float above regular windows and follow the user across every space,
  // including full-screen apps.
  orbWindow.setAlwaysOnTop(true, "floating");
  orbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  orbWindow.on("moved", () => {
    schedulePositionSave();
  });

  orbWindow.on("closed", () => {
    orbWindow = null;
  });

  orbWindow.once("ready-to-show", () => {
    orbWindow?.showInactive();
  });

  const url = await getWindowUrl("main-window.html");
  logger.info("orb", "Loading orb window", { url, hasPosition });
  await orbWindow.loadURL(url);
}
