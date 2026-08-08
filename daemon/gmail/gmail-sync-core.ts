import {
  collectIncrementalMessageIds,
  type GmailHistoryRecord,
  type GmailMessage,
} from "./gmail-model.js";

export interface GmailSyncImportResult {
  emailCount: number;
  documentCount: number;
  eventCount: number;
}

export interface GmailSyncPort {
  listInitialMessageIds(): Promise<{ messageIds: string[]; historyId: string }>;
  listHistory(startHistoryId: string): Promise<{
    history: GmailHistoryRecord[];
    historyId: string;
  }>;
  getMessage(id: string): Promise<GmailMessage>;
  isProcessed(id: string): Promise<boolean>;
  importMessage(message: GmailMessage): Promise<GmailSyncImportResult>;
  markProcessed(id: string): Promise<void>;
  saveCheckpoint(historyId: string): Promise<void>;
}

export interface GmailSyncRunResult {
  emailCount: number;
  documentCount: number;
  eventCount: number;
  historyId: string;
}

/**
 * Transactional incremental-sync core. The checkpoint advances only after every
 * message in the response has either been imported or identified as processed.
 */
export async function runIncrementalGmailSync(
  port: GmailSyncPort,
  checkpoint: string | null,
): Promise<GmailSyncRunResult> {
  const page = checkpoint ? await port.listHistory(checkpoint) : await port.listInitialMessageIds();
  const messageIds =
    "messageIds" in page ? page.messageIds : collectIncrementalMessageIds(page.history);
  const uniqueIds = [...new Set(messageIds)];
  let emailCount = 0;
  let documentCount = 0;
  let eventCount = 0;

  for (const id of uniqueIds) {
    if (await port.isProcessed(id)) continue;
    const message = await port.getMessage(id);
    const imported = await port.importMessage(message);
    await port.markProcessed(id);
    emailCount += imported.emailCount;
    documentCount += imported.documentCount;
    eventCount += imported.eventCount;
  }

  await port.saveCheckpoint(page.historyId);
  return { emailCount, documentCount, eventCount, historyId: page.historyId };
}
