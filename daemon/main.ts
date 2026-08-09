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
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "./ports.js";
import { createApi } from "./api.js";
import { GmailOAuth } from "./gmail/oauth.js";
import { createTokenStore } from "./gmail/token-store.js";
import { syncGmail } from "./gmail/sync.js";
import { createMutableProvider } from "./ai-provider.js";
import { createEmbeddingProvider } from "./embeddings.js";

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

/**
 * Google OAuth client credentials, in the same precedence order the Glaze app
 * used, so an existing setup keeps working:
 *   1. app_settings (set from the UI)
 *   2. gmail-oauth.json in the vault root — the file Google Cloud downloads
 *   3. environment
 *
 * The file must be the "Desktop app" (installed) client type: a web client
 * cannot use a loopback redirect.
 */
function loadGoogleCredentials(
  db: DatabaseSync,
  vaultRoot: string,
  logger: Logger,
): { clientId: string; clientSecret: string; source: string } | null {
  const kv = (k: string) =>
    (db.prepare("SELECT value FROM app_settings WHERE key=?").get(k) as { value?: string } | undefined)
      ?.value?.trim() || "";

  const fromDbId = kv("gmail.client_id");
  const fromDbSecret = kv("gmail.client_secret");
  if (fromDbId && fromDbSecret) {
    return { clientId: fromDbId, clientSecret: fromDbSecret, source: "settings" };
  }

  for (const name of ["gmail-oauth.json", "client_secret.json"]) {
    const file = path.join(vaultRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, never>;
      const c = (raw.installed ?? raw.web ?? raw) as { client_id?: string; client_secret?: string };
      if (raw.web && !raw.installed) {
        logger.warn("gmail: OAuth client is a 'web' type; loopback needs a 'Desktop app' client", {
          file,
        });
      }
      if (c.client_id && c.client_secret) {
        return { clientId: c.client_id.trim(), clientSecret: c.client_secret.trim(), source: name };
      }
    } catch (e) {
      logger.warn("gmail: could not read OAuth client file", { file, error: String(e) });
    }
  }

  const envId =
    process.env.Q2AV_GOOGLE_CLIENT_ID ??
    process.env.QUICK2AVAULT_GMAIL_CLIENT_ID ??
    process.env.GOOGLE_OAUTH_CLIENT_ID;
  const envSecret =
    process.env.Q2AV_GOOGLE_CLIENT_SECRET ??
    process.env.QUICK2AVAULT_GMAIL_CLIENT_SECRET ??
    process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId.trim(), clientSecret: envSecret.trim(), source: "environment" };
  }
  return null;
}

async function main() {
  const ports = createPorts({ vaultRoot: VAULT, logLevel: (process.env.Q2AV_LOG as never) ?? "info" });
  const db = openDatabase(ports.paths.dbPath());

  ports.logger.info("Quick2AVault daemon", { version: VERSION, vault: ports.paths.vaultRoot() });

  // Settings saved from the Setup page take precedence over environment vars,
  // so a user who pastes a key into the app doesn't have to touch a shell.
  const stored = Object.fromEntries(
    (db.prepare("SELECT key, value FROM app_settings").all() as { key: string; value: string }[])
      .map((r) => [r.key, r.value]),
  );

  // Mutable so Settings changes apply immediately. See createMutableProvider:
  // this used to be a fixed provider, and saving a key did nothing until the
  // daemon was restarted.
  const ai = createMutableProvider(
    {
      apiKey: stored["ai.api_key"] || process.env.ANTHROPIC_API_KEY,
      baseUrl: stored["ai.base_url"] || process.env.Q2AV_AI_BASE_URL,
      model: stored["ai.model"] || process.env.Q2AV_MODEL,
    },
    ports.logger,
  );
  ports.logger.info("ai provider", { available: ai.available, model: ai.model });

  // Embedding provider for hybrid search (work order 04 §Track B).
  // Separate config namespace from the chat/extraction provider because
  // embeddings are often a different vendor (Anthropic has no embeddings API).
  const embed = createEmbeddingProvider(
    {
      apiKey: stored["embed.api_key"] || process.env.Q2AV_EMBED_KEY,
      baseUrl: stored["embed.base_url"] || process.env.Q2AV_EMBED_BASE_URL,
      model: stored["embed.model"] || process.env.Q2AV_EMBED_MODEL,
    },
    ports.logger,
  );
  ports.logger.info("embedding provider", { available: embed.available, model: embed.model });

  const worker = new JobWorker(db, ports, ai, 400, embed);
  worker.start();

  const dropDir = DROP ?? path.join(ports.paths.vaultRoot(), "Drop");

  // ── gmail dropbox ─────────────────────────────────────────────────────────
  // Optional: without Google OAuth credentials the daemon runs exactly as
  // before and the endpoints answer 501 with instructions, rather than the
  // feature silently pretending to work.
  const creds = loadGoogleCredentials(db, ports.paths.vaultRoot(), ports.logger);
  let gmail: { oauth: GmailOAuth; sync: () => Promise<unknown> } | undefined;
  if (creds) {
    const store = await createTokenStore(ports.paths.vaultRoot());
    const oauth = new GmailOAuth(creds.clientId, creds.clientSecret, "gmail", store, ports.logger);
    gmail = { oauth, sync: () => syncGmail(db, ports, oauth) };
    ports.logger.info("gmail dropbox ready", {
      credentials: creds.source,
      client_id: `${creds.clientId.slice(0, 12)}…`,
      token_store: store.backend,
    });
  } else {
    ports.logger.info("gmail dropbox not configured", {
      hint: "drop the Google 'Desktop app' client JSON at <vault>/gmail-oauth.json, or set Q2AV_GOOGLE_CLIENT_ID/SECRET",
    });
  }

  const api = createApi(db, ports, {
    port: PORT,
    token: TOKEN,
    version: VERSION,
    // Pass the provider ITSELF, not a snapshot: the settings route calls
    // ai.reconfigure() so a key saved in the UI applies without a restart.
    ai,
    dropDir,
    embed,
    // The RESOLVED vault root, not the raw env var — Q2AV_VAULT may be unset,
    // in which case ports.paths applies the default location. Passing the env
    // var directly would leave the file route confining reads to "undefined".
    vaultDir: ports.paths.vaultRoot(),
    gmail,
    // Browser dev UI is opt-in: it hands API access to any local process that
    // can read the page.
    devUi: process.env.Q2AV_DEV_UI === "1",
  });
  await api.listen();
  ports.logger.info(`Core API listening`, { url: `http://127.0.0.1:${PORT}` });
  // Printed plainly so the operator can copy it into the health probe.
  console.log(`\n  token: ${TOKEN}\n  probe: Q2AV_TOKEN=${TOKEN} ./daemon-health.sh\n`);

  // ── magic folder ───────────────────────────────────────────────────────────
  fs.mkdirSync(dropDir, { recursive: true });
  ports.logger.info("watching drop folder", { dropDir });

  // Scan-on-launch covers files that arrived while the daemon was down.
  for (const f of fs.readdirSync(dropDir)) {
    if (isIgnorable(f)) continue;
    const full = path.join(dropDir, f);
    if (fs.statSync(full).isFile()) {
      // consumeSource: files in Drop are the app's own inbox — once safely
      // archived they are removed, so Drop never accumulates.
      await ingestFile(db, ports, full, { source: "folder", consumeSource: true });
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
          await ingestFile(db, ports, full, { source: "folder", consumeSource: true });
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
