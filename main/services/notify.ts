/**
 * Quiet, native summaries of what happened after a drop. Keeps the orb itself
 * purely visual while still telling the user the outcome — including any AI
 * blocked-state message when Markdown conversion couldn't run.
 */
import { Notification, logger } from "@glaze/core/backend";

import type { IngestResult } from "./vault.js";

// Per blocked-state message shown when AI conversion is unavailable. The file is
// still saved with a plain-text fallback, so this explains why it wasn't polished.
const AI_BLOCKED_MESSAGE: Record<string, string> = {
  "needs-consent": "Saved without Markdown conversion — AI access wasn't allowed.",
  "signed-out": "Saved without Markdown conversion — sign in to Glaze to use AI.",
  "needs-subscription": "Saved without Markdown conversion — this needs an upgraded Glaze plan.",
  "insufficient-credits": "Saved without Markdown conversion — you're out of Glaze AI credits.",
  "daily-limit-reached": "Saved without Markdown conversion — today's AI limit was reached.",
  "host-unavailable": "Saved without Markdown conversion — Glaze couldn't be reached.",
  disabled: "Saved without Markdown conversion — AI is unavailable for this account.",
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function notifyIngestOutcome(results: IngestResult[]): void {
  if (results.length === 0) return;
  if (!Notification.isSupported()) return;

  const ingested = results.filter((r) => r.status === "ingested");
  const duplicates = results.filter((r) => r.status === "duplicate");
  const unsupported = results.filter((r) => r.status === "unsupported");
  const errored = results.filter((r) => r.status === "error");
  const blocked = ingested.find((r) => r.aiBlocked)?.aiBlocked;

  let title = "Quick2Afvault";
  let body = "";

  if (ingested.length > 0) {
    title = `Added ${pluralize(ingested.length, "document")} to your vault`;
    const parts: string[] = [];
    if (blocked) {
      parts.push(AI_BLOCKED_MESSAGE[blocked] ?? "Saved without Markdown conversion.");
    } else {
      const converted = ingested.filter((r) => r.markdownSuccess).length;
      parts.push(`Converted ${pluralize(converted, "file")} to Markdown.`);
    }
    if (duplicates.length > 0) parts.push(`Skipped ${pluralize(duplicates.length, "duplicate")}.`);
    body = parts.join(" ");
  } else if (duplicates.length > 0 && unsupported.length === 0 && errored.length === 0) {
    title = "Already in your vault";
    body = `Skipped ${pluralize(duplicates.length, "duplicate")}.`;
  } else if (unsupported.length > 0) {
    title = "Unsupported file";
    body = "Drop PDF, XLSX, CSV, or TXT files.";
  } else if (errored.length > 0) {
    title = "Couldn't add file";
    body = errored[0].error ? errored[0].error.slice(0, 120) : "Something went wrong.";
  } else {
    return;
  }

  try {
    new Notification({ title, body }).show();
  } catch (error) {
    logger.warn("notify", "Failed to show notification", { error: String(error) });
  }
}
