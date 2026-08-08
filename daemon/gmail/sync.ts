/**
 * Gmail dropbox — the daemon's intake source #2 (plan §2, §9).
 *
 * Mail arriving at the configured address becomes documents in the same P0
 * pipeline as the magic folder: hash, dedupe, archive, convert, analyse. The
 * only difference is provenance (`source_events.source = 'gmail'`).
 *
 * Two safety properties, both deliberate:
 *   READ-ONLY   scope is gmail.readonly. Nothing sends, deletes, labels, or
 *               marks as read. A user's mailbox is not ours to mutate.
 *   IDEMPOTENT  every message id is recorded in source_events, so a re-sync
 *               after a crash imports nothing twice — and the checkpoint only
 *               advances once every message in a page is accounted for.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { DatabaseSync } from "node:sqlite";

import { createGmailSyncSource, type GmailTransport } from "./gmail-api.js";
import { extractGmailArtifacts, deriveGmailAddress, type GmailMessage } from "./gmail-model.js";
import { runIncrementalGmailSync, type GmailSyncPort } from "./gmail-sync-core.js";
import type { GmailOAuth } from "./oauth.js";
import type { Ports } from "../ports.js";
import { ingestFile } from "../pipeline.js";

const PROVIDER = "gmail";

/** Gmail REST transport bound to a live access token. */
function createTransport(oauth: GmailOAuth): GmailTransport {
  return {
    async get<T>(route: string): Promise<T> {
      const token = await oauth.getAccessToken();
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${route}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`Gmail API ${res.status} on ${route}: ${(await res.text()).slice(0, 200)}`);
      }
      return (await res.json()) as T;
    },
  };
}

async function fetchAttachment(
  oauth: GmailOAuth,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const token = await oauth.getAccessToken();
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail attachment fetch failed: ${res.status}`);
  const body = (await res.json()) as { data?: string };
  return Buffer.from(body.data ?? "", "base64url");
}

export interface GmailSyncResult {
  emailCount: number;
  documentCount: number;
  eventCount: number;
  historyId: string;
}

/**
 * Run one incremental sync. Safe to call repeatedly; does nothing when there
 * is no new mail.
 */
export async function syncGmail(
  db: DatabaseSync,
  ports: Ports,
  oauth: GmailOAuth,
): Promise<GmailSyncResult> {
  const transport = createTransport(oauth);
  // Only mail that looks financial, and a bounded first pull so connecting a
  // decade-old mailbox doesn't enqueue 40,000 jobs.
  const source = createGmailSyncSource(transport, {
    initialQuery:
      "has:attachment (invoice OR receipt OR statement OR payment OR order OR bill OR contract)",
    initialLimit: 100,
  });

  // Guard against a token that belongs to a different mailbox than the one
  // configured — otherwise a user reconnecting with the wrong Google account
  // would silently ingest a stranger's mail.
  const localPart = (
    db.prepare("SELECT value FROM app_settings WHERE key='gmail.local_part'").get() as
      | { value?: string }
      | undefined
  )?.value;
  if (localPart) {
    const profile = await source.profile();
    const expected = deriveGmailAddress(localPart);
    if (profile.emailAddress.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `Connected mailbox ${profile.emailAddress} does not match the configured ${expected}.`,
      );
    }
  }

  const checkpoint =
    (
      db.prepare("SELECT value FROM app_settings WHERE key='gmail.history_id'").get() as
        | { value?: string }
        | undefined
    )?.value ?? null;

  const port: GmailSyncPort = {
    listInitialMessageIds: () => source.initialMessageIds(),
    listHistory: (id) => source.historySince(id),
    getMessage: (id) =>
      transport.get<GmailMessage>(`/messages/${id}?format=full`),

    // Idempotency lives in source_events, shared with every other intake path.
    async isProcessed(id) {
      const row = db
        .prepare("SELECT 1 FROM source_events WHERE source=? AND external_id=?")
        .get(PROVIDER, id);
      return !!row;
    },

    async importMessage(message) {
      const artifacts = extractGmailArtifacts(message);
      // The model already decides what looks financial; respect it rather
      // than ingesting newsletters.
      if (!artifacts.relevant) return { emailCount: 1, documentCount: 0, eventCount: 0 };
      let documentCount = 0;
      let eventCount = 0;

      // Attachments are the point: invoices, statements, contract notes.
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "q2v-gmail-"));
      try {
        for (const att of artifacts.attachments) {
          try {
            const bytes = await fetchAttachment(oauth, message.id, att.attachmentId);
            const file = path.join(tmp, att.filename || `${att.attachmentId}.bin`);
            await fs.writeFile(file, bytes);
            const result = await ingestFile(db, ports, file, {
              source: PROVIDER,
              externalId: `${message.id}:${att.attachmentId}`,
              // Consume: the temp copy is ours, and archiving moves it into
              // the vault under a human-readable name.
              consumeSource: true,
            });
            if (result.status === "added") documentCount++;
            eventCount++;
          } catch (e) {
            ports.logger.warn("gmail: attachment import failed", {
              message_id: message.id,
              filename: att.filename,
              error: String(e),
            });
          }
        }

        // A body-only mail can still be evidence — a card alert with no
        // attachment is exactly the second half of the double-count demo.
        if (artifacts.attachments.length === 0 && artifacts.bodyEvent?.content) {
          const file = path.join(tmp, artifacts.bodyEvent.filename || `${message.id}.txt`);
          await fs.writeFile(file, artifacts.bodyEvent.content, "utf-8");
          const result = await ingestFile(db, ports, file, {
            source: PROVIDER,
            externalId: message.id,
            consumeSource: true,
          });
          if (result.status === "added") documentCount++;
          eventCount++;
        }
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }

      return { emailCount: 1, documentCount, eventCount };
    },

    async markProcessed(id) {
      // NOTE: the column is created_at, not seen_at. There is no document_id
      // here — one email can yield several documents, each of which records
      // its own source_events row keyed "<messageId>:<attachmentId>". This row
      // marks the MESSAGE as handled so a re-sync skips it wholesale.
      db.prepare(
        `INSERT OR IGNORE INTO source_events (source, external_id, created_at)
         VALUES (?,?,?)`,
      ).run(PROVIDER, id, ports.clock.isoNow());
    },

    async saveCheckpoint(historyId) {
      db.prepare(
        "INSERT OR REPLACE INTO app_settings(key,value) VALUES('gmail.history_id',?)",
      ).run(historyId);
    },
  };

  const result = await runIncrementalGmailSync(port, checkpoint);
  ports.logger.info("gmail: sync complete", result);
  return result;
}
