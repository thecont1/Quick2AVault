/**
 * Quick2AVault daemon entrypoint.
 *
 *   npm run daemon
 *   Q2AV_PORT=4477 Q2AV_TOKEN=... Q2AV_VAULT=~/Documents/Quick2AVault node --experimental-strip-types daemon/main.ts
 *
 * Headless. No Electron, no Glaze. Every UI is a client of the Core API.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

import { createPorts } from "./adapters.js";
import { openDatabase } from "./schema.js";
import { JobWorker, ingestFile } from "./pipeline.js";
import { createApi } from "./api.js";
import { createAnthropicProvider } from "./ai-provider.js";

const VERSION = "2.0.0-daemon";

/**
 * Files a real user's Drop folder accumulates that are not documents.
 * Finder writes .DS_Store the moment the folder is opened, and browsers/
 * AirDrop leave partial files mid-transfer — ingesting either produces junk
 * documents and, worse, a partial PDF that fails conversion.
 */
const IGNORED_NAMES = new Set([".DS_Store", "Icon\r", ".localized", "desktop.ini"]);
const IGNORED_EXT = /\.(download|crdownload|part|partial|tmp|sb-[a-z0-9]+)$/i;

function isIgnorable(filename: string): boolean {
  if (filename.startsWith(".")) return true;
  if (IGNORED_NAMES.has(filename)) return true;
  if (IGNORED_EXT.test(filename)) return true;
  return false;
}

const PORT = Number(process.env.Q2AV_PORT ?? 4477);
const VAULT = process.env.Q2AV_VAULT ?? undefined;
const DROP = process.env.Q2AV_DROP ?? undefined;
const TOKEN = process.env.Q2AV_TOKEN ?? crypto.randomBytes(16).toString("hex");

async function main() {
  const ports = createPorts({ vaultRoot: VAULT, logLevel: (process.env.Q2AV_LOG as never) ?? "info" });
  const db = openDatabase(ports.paths.dbPath());

  ports.logger.info("Quick2AVault daemon", { version: VERSION, vault: ports.paths.vaultRoot() });

  const ai = createAnthropicProvider(
    { apiKey: process.env.ANTHROPIC_API_KEY, baseUrl: process.env.Q2AV_AI_BASE_URL, model: process.env.Q2AV_MODEL },
    ports.logger,
  );
  ports.logger.info("ai provider", { available: ai.available, model: ai.model });

  const worker = new JobWorker(db, ports, ai);
  worker.start();

  const api = createApi(db, ports, { port: PORT, token: TOKEN, version: VERSION });
  await api.listen();
  ports.logger.info(`Core API listening`, { url: `http://127.0.0.1:${PORT}` });
  // Printed plainly so the operator can copy it into the health probe.
  console.log(`\n  token: ${TOKEN}\n  probe: Q2AV_TOKEN=${TOKEN} ./daemon-health.sh\n`);

  // ── magic folder ───────────────────────────────────────────────────────────
  const dropDir = DROP ?? path.join(ports.paths.vaultRoot(), "Drop");
  fs.mkdirSync(dropDir, { recursive: true });
  ports.logger.info("watching drop folder", { dropDir });

  // Scan-on-launch covers files that arrived while the daemon was down.
  for (const f of fs.readdirSync(dropDir)) {
    if (isIgnorable(f)) continue;
    const full = path.join(dropDir, f);
    if (fs.statSync(full).isFile()) {
      await ingestFile(db, ports, full, { source: "folder" });
    }
  }

  // Debounced watcher: editors and copies fire multiple events per file.
  const pending = new Map<string, NodeJS.Timeout>();
  fs.watch(dropDir, (_event, filename) => {
    if (!filename || isIgnorable(filename)) return;
    const full = path.join(dropDir, filename);
    clearTimeout(pending.get(full));
    pending.set(
      full,
      setTimeout(async () => {
        pending.delete(full);
        try {
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return;
          await ingestFile(db, ports, full, { source: "folder" });
        } catch (err) {
          ports.logger.error("watch intake failed", { full, err: (err as Error)?.message });
        }
      }, 250),
    );
  });

  const shutdown = async () => {
    ports.logger.info("shutting down");
    worker.stop();
    await api.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
