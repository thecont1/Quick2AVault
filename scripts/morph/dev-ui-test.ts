#!/usr/bin/env tsx
/**
 * Glance — Morph's diff-aware browser testing for the dev UI.
 *
 * Runs a natural-language test against the dev UI served by the daemon
 * (requires Q2AV_DEV_UI=1). Glance reads the PR diff to decide what to test,
 * then drives a browser and returns video, screenshots, and errors.
 *
 * Usage:
 *   npm run morph:dev-ui-test -- --task "Verify the API provider settings save correctly"
 *   npm run morph:dev-ui-test -- --task "Test the connection status indicator" --record-video
 *
 * Requires:
 *   - Q2AV_DEV_UI=1 when starting the daemon
 *   - MORPH_API_KEY env var
 */
import { MorphClient } from "@morphllm/morphsdk";
import * as process from "node:process";

function parseArgs(argv: string[]): {
  task?: string;
  url?: string;
  recordVideo?: boolean;
} {
  const out: { task?: string; url?: string; recordVideo?: boolean } = {
    url: "http://localhost:4477/",
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--task":
      case "-t":
        out.task = argv[++i];
        break;
      case "--url":
      case "-u":
        out.url = argv[++i];
        break;
      case "--record-video":
        out.recordVideo = true;
        break;
    }
  }
  return out;
}

async function main() {
  const { task, url, recordVideo } = parseArgs(process.argv);
  if (!task) {
    console.error("Usage: tsx scripts/morph/dev-ui-test.ts --task <natural language test>");
    console.error("  --url <url>       Base URL (default: http://localhost:4477/)");
    console.error("  --record-video    Record a video of the test session");
    process.exit(1);
  }

  const morph = new MorphClient({ apiKey: process.env.MORPH_API_KEY });

  // Diff is empty in local dev — Glance will test based on the task description
  // alone, which is fine for the dev UI where we're testing interactive flows.
  const result = await morph.browser.execute({
    task,
    url,
    recordVideo: recordVideo ?? true,
    maxSteps: 25,
  });

  console.log(`${result.success ? "✅ PASS" : "❌ FAIL"}: ${result.result}`);

  if (!result.success && result.error) {
    console.error("Error:", result.error);
  }

  if (result.recordingId) {
    const rec = await morph.browser.getRecording(result.recordingId);
    if (rec.videoUrl) console.log("Video:", rec.videoUrl);
    if (rec.networkUrl) console.log("Network:", rec.networkUrl);
    if (rec.consoleUrl) console.log("Console:", rec.consoleUrl);
  }

  if (!result.success) process.exit(1);
}

main();
