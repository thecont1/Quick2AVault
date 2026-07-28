import assert from "node:assert/strict";

import { createGmailSyncSource, type GmailTransport } from "./gmail-api.js";

const calls: string[] = [];
const transport: GmailTransport = {
  async get<T>(route: string): Promise<T> {
    calls.push(route);
    if (route === "/profile")
      return { emailAddress: `dropbox@${"gmail.com"}`, historyId: "100" } as T;
    if (route.startsWith("/messages?") && !route.includes("pageToken")) {
      return { messages: [{ id: "m1" }], nextPageToken: "next" } as T;
    }
    if (route.startsWith("/messages?") && route.includes("pageToken=next")) {
      return { messages: [{ id: "m2" }] } as T;
    }
    if (route.startsWith("/history?") && !route.includes("pageToken")) {
      return {
        history: [{ id: "101", messagesAdded: [{ message: { id: "m3" } }] }],
        historyId: "102",
        nextPageToken: "history-next",
      } as T;
    }
    if (route.startsWith("/history?") && route.includes("pageToken=history-next")) {
      return {
        history: [{ id: "102", messagesAdded: [{ message: { id: "m4" } }] }],
        historyId: "103",
      } as T;
    }
    throw new Error(`Unexpected route: ${route}`);
  },
};

const source = createGmailSyncSource(transport, {
  initialQuery: "newer_than:30d",
  initialLimit: 100,
});
assert.deepEqual(await source.initialMessageIds(), { messageIds: ["m1", "m2"], historyId: "100" });
assert.equal(calls[0], "/profile", "Initial checkpoint must be captured before listing messages");
assert.deepEqual(await source.historySince("100"), {
  history: [
    { id: "101", messagesAdded: [{ message: { id: "m3" } }] },
    { id: "102", messagesAdded: [{ message: { id: "m4" } }] },
  ],
  historyId: "103",
});

console.log("gmail api smoke: ok");
