import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ipcMain, logger } from "@glaze/core/backend";

import { purgeAllDocumentData } from "./database.js";
import { isGmailSyncIdle, notifyGmailDataReset } from "./gmail.js";
import { isIngestIdle } from "./ingest-queue.js";
import { getVaultRoot } from "./vault.js";
import type { PurgeDocumentsResult } from "./document-purge-model.js";

const DOCUMENT_DIRECTORIES = ["Raw", "Markdown", "Irrelevant"] as const;

/** Permanently clear document files + derived rows; preserve settings, rules, and recurring entries. */
export async function purgeAllDocuments(): Promise<PurgeDocumentsResult> {
  if (!isIngestIdle() || !isGmailSyncIdle()) {
    return {
      ok: false,
      message: "Wait for document processing and Gmail sync to finish, then try again.",
    };
  }

  const vaultRoot = getVaultRoot();
  for (const directory of DOCUMENT_DIRECTORIES) {
    await fs.rm(path.join(vaultRoot, directory), { recursive: true, force: true });
  }
  const result = purgeAllDocumentData();
  for (const directory of DOCUMENT_DIRECTORIES) {
    await fs.mkdir(path.join(vaultRoot, directory), { recursive: true });
  }

  notifyGmailDataReset();
  ipcMain.broadcast("documents:changed", {});
  ipcMain.broadcast("review:changed", { count: 0 });
  ipcMain.broadcast("duplicates:changed", {});
  ipcMain.broadcast("training:changed", { pendingCount: 0 });
  logger.info("document-purge", "Purged all document data", result);
  return { ok: true, ...result };
}
