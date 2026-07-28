import assert from "node:assert/strict";

import {
  collectIncrementalMessageIds,
  deriveGmailAddress,
  extractGmailArtifacts,
  gmailAccountsMatch,
  normalizeGmailLocalPart,
  type GmailMessage,
} from "./gmail-model.js";

assert.deepEqual(normalizeGmailLocalPart("  Test.User "), {
  ok: true,
  localPart: "test.user",
});
const configuredMailbox = deriveGmailAddress("test.user");
assert.equal(configuredMailbox, `test.user@${"gmail.com"}`);
assert.equal(gmailAccountsMatch(deriveGmailAddress("Test.User"), configuredMailbox), true);
assert.equal(gmailAccountsMatch(deriveGmailAddress("testuser"), configuredMailbox), true);
assert.equal(gmailAccountsMatch(deriveGmailAddress("other.account"), configuredMailbox), false);
assert.equal(gmailAccountsMatch(`testuser@${"example.com"}`, configuredMailbox), false);
for (const invalid of [
  "",
  "abc",
  ".abcdef",
  "abcdef.",
  "abc..def",
  "abc+dropbox",
  `abc@${"gmail.com"}`,
  "white space",
  "a".repeat(31),
]) {
  assert.equal(
    normalizeGmailLocalPart(invalid).ok,
    false,
    `Expected invalid Gmail local-part: ${invalid}`,
  );
}

const encode = (value: string) => Buffer.from(value).toString("base64url");
const message: GmailMessage = {
  id: "msg-1",
  threadId: "thread-1",
  historyId: "101",
  internalDate: "1760000000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "Subject", value: "Payment confirmation from Namma Yatri" },
      { name: "From", value: "receipts@example.test" },
      { name: "Date", value: "Tue, 28 Jul 2026 10:00:00 +0530" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { data: encode("Paid INR 245 to Namma Yatri by UPI") } },
          {
            mimeType: "text/html",
            body: { data: encode("<p>Paid <b>INR 245</b> to Namma Yatri</p>") },
          },
        ],
      },
      {
        mimeType: "application/pdf",
        filename: "receipt.pdf",
        body: { attachmentId: "att-1", size: 1234 },
      },
      {
        mimeType: "application/zip",
        filename: "archive.zip",
        body: { attachmentId: "att-2", size: 999 },
      },
    ],
  },
};

const withAttachment = extractGmailArtifacts(message);
assert.equal(withAttachment.relevant, true);
assert.deepEqual(
  withAttachment.attachments.map((item) => ({
    filename: item.filename,
    attachmentId: item.attachmentId,
  })),
  [{ filename: "receipt.pdf", attachmentId: "att-1" }],
);
assert.ok(
  withAttachment.bodyEvent?.content.includes("Namma Yatri"),
  "A relevant body signal must survive even when the message also has an attachment",
);

const bodyOnly: GmailMessage = {
  ...message,
  id: "msg-2",
  payload: {
    ...message.payload,
    mimeType: "text/plain",
    body: { data: encode("UPI payment of INR 245 to Namma Yatri was successful") },
    parts: undefined,
  },
};
const extractedBody = extractGmailArtifacts(bodyOnly);
assert.equal(extractedBody.attachments.length, 0);
assert.ok(extractedBody.bodyEvent?.content.includes("Namma Yatri"));
assert.ok(extractedBody.bodyEvent?.filename.endsWith(".txt"));

const irrelevant: GmailMessage = {
  ...bodyOnly,
  id: "msg-3",
  payload: {
    ...bodyOnly.payload,
    headers: [{ name: "Subject", value: "Family dinner plans" }],
    body: { data: encode("See you at 8 tonight") },
  },
};
assert.deepEqual(extractGmailArtifacts(irrelevant), {
  relevant: false,
  attachments: [],
  bodyEvent: null,
});

assert.deepEqual(
  collectIncrementalMessageIds([
    { id: "102", messagesAdded: [{ message: { id: "b" } }, { message: { id: "a" } }] },
    { id: "104", messagesAdded: [{ message: { id: "a" } }, { message: { id: "c" } }] },
  ]),
  ["b", "a", "c"],
  "History message IDs must preserve first-seen order and deduplicate",
);

console.log("gmail model smoke: ok");
