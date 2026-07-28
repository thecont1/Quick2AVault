import assert from "node:assert/strict";

import { runIncrementalGmailSync, type GmailSyncPort } from "./gmail-sync-core.js";
import type { GmailMessage } from "./gmail-model.js";

const message = (id: string): GmailMessage => ({
  id,
  threadId: `thread-${id}`,
  historyId: String(100 + Number(id.slice(1))),
  internalDate: "1760000000000",
  payload: {
    mimeType: "application/pdf",
    filename: `${id}.pdf`,
    headers: [{ name: "Subject", value: `Invoice ${id}` }],
    body: { attachmentId: `att-${id}`, size: 10 },
  },
});

const seen = new Set<string>();
const imported: string[] = [];
const checkpoints: string[] = [];
const port: GmailSyncPort = {
  async listInitialMessageIds() {
    return { messageIds: ["m1", "m2", "m1"], historyId: "102" };
  },
  async listHistory(startHistoryId) {
    assert.equal(startHistoryId, "102");
    return {
      history: [
        { id: "103", messagesAdded: [{ message: { id: "m2" } }, { message: { id: "m3" } }] },
      ],
      historyId: "103",
    };
  },
  async getMessage(id) {
    return message(id);
  },
  async isProcessed(id) {
    return seen.has(id);
  },
  async importMessage(msg) {
    imported.push(msg.id);
    seen.add(msg.id);
    return { emailCount: 1, documentCount: 1, eventCount: 0 };
  },
  async markProcessed() {},
  async saveCheckpoint(historyId) {
    checkpoints.push(historyId);
  },
};

const initial = await runIncrementalGmailSync(port, null);
assert.deepEqual(imported, ["m1", "m2"]);
assert.equal(initial.emailCount, 2);
assert.equal(initial.documentCount, 2);
assert.equal(initial.eventCount, 0);
assert.deepEqual(checkpoints, ["102"], "Cursor advances only after the full page succeeds");

const incremental = await runIncrementalGmailSync(port, "102");
assert.deepEqual(imported, ["m1", "m2", "m3"]);
assert.equal(incremental.emailCount, 1);
assert.deepEqual(checkpoints, ["102", "103"]);

const irrelevant = await runIncrementalGmailSync(
  {
    ...port,
    async listInitialMessageIds() {
      return { messageIds: ["m6"], historyId: "106" };
    },
    async importMessage() {
      return { emailCount: 0, documentCount: 0, eventCount: 0 };
    },
  },
  null,
);
assert.equal(irrelevant.emailCount, 0, "Irrelevant scanned mail is not an imported email");

const failedCheckpoints: string[] = [];
await assert.rejects(
  runIncrementalGmailSync(
    {
      ...port,
      async listInitialMessageIds() {
        return { messageIds: ["m4", "m5"], historyId: "105" };
      },
      async getMessage(id) {
        if (id === "m5") throw new Error("network failed");
        return message(id);
      },
      async saveCheckpoint(id) {
        failedCheckpoints.push(id);
      },
    },
    null,
  ),
  /network failed/,
);
assert.deepEqual(failedCheckpoints, [], "A partial failure must not advance the history cursor");

console.log("gmail sync core smoke: ok");
