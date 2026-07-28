// Main process entry point - Node.js backend for Quick2Afvault
//
// The glaze CLI runtime automatically handles all framework wiring (IPC server,
// native bridge, lifecycle, signal handlers) before this file runs.

import { app, Menu, logger, initDevToolsButtonState } from "@glaze/core/backend";

import { registerHandlers } from "./handlers/index.js";
import { createOrbWindow, getOrbWindow } from "./windows/orb-window.js";
import { openSettingsWindow } from "./windows/settings-window.js";
import { ensureVaultDirs } from "./services/vault.js";
import { enqueueReprocess } from "./services/ingest-queue.js";
import { reprocessRequestedDocIds } from "./services/database.js";
import { backfillFinancialYears, reconcileReviews } from "./services/reviews.js";
import { isFirstRun } from "./services/preferences.js";
import { openOnboardingWindow } from "./windows/onboarding-window.js";
import { startGmailSyncScheduler, stopGmailSyncScheduler } from "./services/gmail.js";

// ── IPC Handlers ──────────────────────────────────────────────────────
registerHandlers();

// ── Application menu ──────────────────────────────────────────────────
// The orb is an accessory app, so this menu is only visible while the app is
// active — it mainly provides the standard shortcuts (Settings, Quit, editing).
async function setupApplicationMenu() {
  await initDevToolsButtonState();
  const menu = Menu.buildFromTemplate([
    {
      label: "Quick2Afvault",
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: "Settings…",
          icon: "gearshape",
          accelerator: "Command+,",
          click: async () => await openSettingsWindow(),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ]);
  Menu.setApplicationMenu(menu);
}

// ── Lifecycle events ──────────────────────────────────────────────────
app.on("window-all-closed", () => {
  // Keep the orb-based app alive even if the settings window is closed.
});

app.on("activate", (hasVisibleWindows) => {
  const orb = getOrbWindow();
  if (!orb || orb.isDestroyed()) {
    createOrbWindow();
  } else if (!hasVisibleWindows) {
    orb.showInactive();
  }
});

app.on("before-quit", () => {
  stopGmailSyncScheduler();
  logger.info("main", "App before-quit, cleaning up...");
});

// ── App ready ─────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  await setupApplicationMenu();
  await ensureVaultDirs();

  // Clear stale review flags left by superseded logic (e.g. zero-value invoices)
  // so the Review Queue count reflects only real, unresolved work, and classify
  // any previously-ingested documents into their financial-year buckets.
  reconcileReviews();
  backfillFinancialYears();
  startGmailSyncScheduler();

  // Pick up any documents the user asked to reprocess "later" in a prior session.
  const pending = reprocessRequestedDocIds();
  if (pending.length > 0) {
    enqueueReprocess(pending).catch((error) => {
      logger.error("main", "Failed to enqueue pending reprocess", error);
    });
  }

  createOrbWindow().catch((error) => {
    logger.error("main", "Failed to create orb window", error);
  });

  // Fresh install: invite the user to confirm their finance preferences
  // (prefilled with India defaults) before serious analysis begins.
  if (isFirstRun()) {
    openOnboardingWindow().catch((error) => {
      logger.error("main", "Failed to open onboarding window", error);
    });
  }
});
