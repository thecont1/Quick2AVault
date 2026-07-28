import * as fs from "node:fs/promises";
import * as path from "node:path";

import { app, ipcMain, logger } from "@glaze/core/backend";
import { OAuthTokenStore } from "@glaze/core/oauth";

import {
  deleteSetting,
  getSetting,
  gmailImportTotals,
  hasGmailImport,
  saveGmailImport,
  setSetting,
} from "./database.js";
import { enqueueInternalFiles } from "./ingest-queue.js";
import {
  deriveGmailAddress,
  extractGmailArtifacts,
  gmailAccountsMatch,
  normalizeGmailLocalPart,
  type GmailMessage,
} from "./gmail-model.js";
import { runIncrementalGmailSync, type GmailSyncPort } from "./gmail-sync-core.js";
import { GmailDesktopOAuth } from "./gmail-oauth.js";
import { createGmailSyncSource } from "./gmail-api.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const LOCAL_PART_KEY = "gmail.local_part";
const PAUSED_KEY = "gmail.paused";
const HISTORY_KEY = "gmail.history_id";
const LAST_SYNC_KEY = "gmail.last_sync";
const LAST_ERROR_KEY = "gmail.last_error";
const PROVIDER_ID = "quick2avault-gmail";
const INITIAL_QUERY = "newer_than:30d";
const INITIAL_LIMIT = 100;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

export type GmailConnectionState =
  | "not_configured"
  | "disconnected"
  | "connecting"
  | "connected"
  | "paused"
  | "syncing"
  | "error";

export interface GmailStatus {
  localPart: string | null;
  mailbox: string | null;
  connection: GmailConnectionState;
  paused: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  emailCount: number;
  documentCount: number;
  eventCount: number;
  oauthConfigured: boolean;
}

let runtimeState: GmailConnectionState | null = null;
let syncPromise: Promise<GmailStatus> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;

function oauthClientId(): string | null {
  const value = process.env.QUICK2AVAULT_GMAIL_CLIENT_ID ?? process.env.GOOGLE_OAUTH_CLIENT_ID;
  return value?.trim() || null;
}

function oauthService(): GmailDesktopOAuth {
  const clientId = oauthClientId();
  if (!clientId) {
    throw new Error(
      "Gmail OAuth is not configured in this build. Set QUICK2AVAULT_GMAIL_CLIENT_ID to the Google desktop OAuth client ID.",
    );
  }
  return new GmailDesktopOAuth(clientId, PROVIDER_ID);
}

function configuredLocalPart(): string | null {
  return getSetting(LOCAL_PART_KEY);
}

function isPaused(): boolean {
  return getSetting(PAUSED_KEY) === "true";
}

async function hasTokens(): Promise<boolean> {
  if (!oauthClientId()) return false;
  try {
    return (await oauthService().getTokens()) != null;
  } catch {
    return false;
  }
}

export async function getGmailStatus(): Promise<GmailStatus> {
  const localPart = configuredLocalPart();
  const mailbox = localPart ? deriveGmailAddress(localPart) : null;
  const paused = isPaused();
  const tokens = mailbox ? await hasTokens() : false;
  const connection: GmailConnectionState = runtimeState
    ? runtimeState
    : !mailbox
      ? "not_configured"
      : !tokens
        ? "disconnected"
        : paused
          ? "paused"
          : getSetting(LAST_ERROR_KEY)
            ? "error"
            : "connected";
  return {
    localPart,
    mailbox,
    connection,
    paused,
    lastSyncAt: getSetting(LAST_SYNC_KEY),
    lastError: getSetting(LAST_ERROR_KEY),
    ...gmailImportTotals(mailbox),
    oauthConfigured: oauthClientId() != null,
  };
}

function broadcastStatus(): void {
  void getGmailStatus().then((status) => ipcMain.broadcast("gmail:statusChanged", status));
}

async function gmailFetch<T>(accessToken: string, route: string): Promise<T> {
  const response = await fetch(`${GMAIL_API}${route}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Gmail API ${response.status}: ${body.slice(0, 300)}`) as Error & {
      status?: number;
    };
    error.status = response.status;
    throw error;
  }
  return (await response.json()) as T;
}

function gmailSource(accessToken: string) {
  return createGmailSyncSource(
    { get: <T>(route: string) => gmailFetch<T>(accessToken, route) },
    { initialQuery: INITIAL_QUERY, initialLimit: INITIAL_LIMIT },
  );
}

export async function connectGmail(localPartInput: unknown): Promise<GmailStatus> {
  const normalized = normalizeGmailLocalPart(localPartInput);
  if (!normalized.ok) throw new Error(normalized.error);
  const mailbox = deriveGmailAddress(normalized.localPart);
  setSetting(LOCAL_PART_KEY, normalized.localPart);
  setSetting(PAUSED_KEY, "false");
  deleteSetting(LAST_ERROR_KEY);
  runtimeState = "connecting";
  broadcastStatus();
  try {
    const service = oauthService();
    await service.authorize(mailbox);
    const accessToken = await service.getAccessToken();
    const signedIn = await gmailSource(accessToken).profile();
    if (!gmailAccountsMatch(signedIn.emailAddress, mailbox)) {
      await service.removeTokens();
      throw new Error(
        `Google signed in as ${signedIn.emailAddress}, but Quick2A Vault is configured for ${mailbox}. Sign in with the matching Gmail account.`,
      );
    }
    deleteSetting(HISTORY_KEY);
    runtimeState = "connected";
    broadcastStatus();
    return await syncGmailNow();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSetting(LAST_ERROR_KEY, message);
    runtimeState = "error";
    broadcastStatus();
    throw error;
  } finally {
    if (runtimeState === "connecting") runtimeState = null;
  }
}

export async function disconnectGmail(): Promise<GmailStatus> {
  const localPart = configuredLocalPart();
  if (localPart) {
    await new OAuthTokenStore().remove(PROVIDER_ID).catch(() => {});
  }
  for (const key of [LOCAL_PART_KEY, PAUSED_KEY, HISTORY_KEY, LAST_SYNC_KEY, LAST_ERROR_KEY]) {
    deleteSetting(key);
  }
  runtimeState = null;
  broadcastStatus();
  return getGmailStatus();
}

export async function setGmailPaused(paused: boolean): Promise<GmailStatus> {
  if (!configuredLocalPart()) throw new Error("Configure a Gmail mailbox first.");
  setSetting(PAUSED_KEY, paused ? "true" : "false");
  runtimeState = null;
  broadcastStatus();
  if (!paused) return syncGmailNow();
  return getGmailStatus();
}

async function attachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const payload = await gmailFetch<{ data?: string; size?: number }>(
    accessToken,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if ((payload.size ?? 0) > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Gmail attachment exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
  }
  return Buffer.from(payload.data ?? "", "base64url");
}

function safeFilename(filename: string): string {
  const safe = [...path.basename(filename)]
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .slice(0, 180);
  return safe || "gmail-attachment";
}

async function importGmailMessage(
  accessToken: string,
  message: GmailMessage,
): Promise<{ emailCount: number; documentCount: number; eventCount: number }> {
  const artifacts = extractGmailArtifacts(message);
  if (!artifacts.relevant) return { emailCount: 0, documentCount: 0, eventCount: 0 };
  const tempDir = await fs.mkdtemp(path.join(app.getPath("temp"), "q2av-gmail-"));
  const paths: string[] = [];
  let bodyPath: string | null = null;
  try {
    for (const [index, attachment] of artifacts.attachments.entries()) {
      const target = path.join(tempDir, `${index + 1}-${safeFilename(attachment.filename)}`);
      await fs.writeFile(
        target,
        await attachmentBytes(accessToken, message.id, attachment.attachmentId),
      );
      paths.push(target);
    }
    if (artifacts.bodyEvent) {
      bodyPath = path.join(tempDir, safeFilename(artifacts.bodyEvent.filename));
      await fs.writeFile(bodyPath, artifacts.bodyEvent.content, "utf8");
      paths.push(bodyPath);
    }
    if (paths.length === 0) return { emailCount: 0, documentCount: 0, eventCount: 0 };
    const receipt = await enqueueInternalFiles(paths);
    if (receipt.error > 0) throw new Error("One or more Gmail artifacts failed intake.");
    return {
      emailCount: 1,
      documentCount: artifacts.attachments.length > 0 ? receipt.accepted : 0,
      eventCount: bodyPath ? receipt.accepted : 0,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function performSync(): Promise<GmailStatus> {
  const localPart = configuredLocalPart();
  if (!localPart) throw new Error("Configure a Gmail mailbox first.");
  if (isPaused()) return getGmailStatus();
  const mailbox = deriveGmailAddress(localPart);
  const service = oauthService();
  runtimeState = "syncing";
  broadcastStatus();
  try {
    const accessToken = await service.getAccessToken();
    const source = gmailSource(accessToken);
    const signedIn = await source.profile();
    if (!gmailAccountsMatch(signedIn.emailAddress, mailbox)) {
      throw new Error(
        `Connected Google account ${signedIn.emailAddress} does not match ${mailbox}.`,
      );
    }
    const pendingCounts = new Map<
      string,
      { emailCount: number; documentCount: number; eventCount: number }
    >();
    const port: GmailSyncPort = {
      listInitialMessageIds: () => source.initialMessageIds(),
      listHistory: (historyId) => source.historySince(historyId),
      getMessage: (id) =>
        gmailFetch<GmailMessage>(accessToken, `/messages/${encodeURIComponent(id)}?format=full`),
      isProcessed: async (id) => hasGmailImport(mailbox, id),
      importMessage: async (message) => {
        const counts = await importGmailMessage(accessToken, message);
        pendingCounts.set(message.id, counts);
        return counts;
      },
      markProcessed: async (id) => {
        const counts = pendingCounts.get(id) ?? {
          emailCount: 0,
          documentCount: 0,
          eventCount: 0,
        };
        saveGmailImport({
          mailbox,
          messageId: id,
          importedAt: new Date().toISOString(),
          ...counts,
        });
      },
      saveCheckpoint: async (historyId) => setSetting(HISTORY_KEY, historyId),
    };
    try {
      await runIncrementalGmailSync(port, getSetting(HISTORY_KEY));
    } catch (error) {
      // Gmail expires old history cursors. A bounded 30-day bootstrap is safe and
      // message-ID idempotence prevents re-importing already-seen messages.
      if ((error as { status?: number }).status !== 404 || !getSetting(HISTORY_KEY)) throw error;
      deleteSetting(HISTORY_KEY);
      await runIncrementalGmailSync(port, null);
    }
    setSetting(LAST_SYNC_KEY, new Date().toISOString());
    deleteSetting(LAST_ERROR_KEY);
    runtimeState = "connected";
    broadcastStatus();
    return getGmailStatus();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSetting(LAST_ERROR_KEY, message);
    runtimeState = "error";
    logger.warn("gmail", "Gmail sync failed", { error: message });
    broadcastStatus();
    throw error;
  }
}

export function syncGmailNow(): Promise<GmailStatus> {
  if (!syncPromise) syncPromise = performSync().finally(() => (syncPromise = null));
  return syncPromise;
}

export function isGmailSyncIdle(): boolean {
  return syncPromise == null;
}

/** Re-read connection state after document data/provenance is cleared. */
export function notifyGmailDataReset(): void {
  runtimeState = null;
  broadcastStatus();
}

export function startGmailSyncScheduler(): void {
  if (syncTimer) return;
  void getGmailStatus().then((status) => {
    if (status.mailbox && !status.paused && status.connection !== "disconnected") {
      void syncGmailNow().catch(() => {});
    }
  });
  syncTimer = setInterval(() => {
    if (!configuredLocalPart() || isPaused()) return;
    void hasTokens().then((tokens) => {
      if (tokens) void syncGmailNow().catch(() => {});
    });
  }, SYNC_INTERVAL_MS);
}

export function stopGmailSyncScheduler(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}
