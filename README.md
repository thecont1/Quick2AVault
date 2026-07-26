# Quick2Afvault

A tiny, always-on-top macOS accessory app for archiving and organizing personal financial documents. Drop a PDF, XLSX, CSV, or TXT file onto the floating orb and it is copied to a dated vault folder, converted to Markdown, analyzed for people, dates, amounts, and foreign currencies, and recorded in a local SQLite database.

> **Platform note:** This is a Glaze SDK app configured as a macOS `accessory` app (`appConfig.macOS.activationPolicy: "accessory"`). It has no Dock icon and no Cmd-Tab presence; the only visible UI is the orb and the transient windows it opens.

## What it does

- **Floating orb widget** — a frameless, transparent, always-on-top circle that lives on all workspaces, remembers its position, and accepts drag-and-drop files. A single click opens the **Financial Snapshot**; a right-click shows the native menu.
- **Drag & drop ingestion** — files are copied to `~/Documents/Quick2Afvault/Raw/<YYYY-MM-DD>/` and converted to Markdown in `~/Documents/Quick2Afvault/Markdown/<YYYY-MM-DD>/`.
- **SHA-256 deduplication** — identical files are not reprocessed.
- **Markdown conversion** — text is extracted with `pdf-parse` / `xlsx` / utf-8 readers, then polished to Markdown by Glaze AI (`fast`, max 24 k chars) with a deterministic fallback on any AI failure.
- **Unified document extraction** — one AI pass at ingestion extracts document type, vendor/institution, document date, primary amount, and currency, each with a `confident` flag. The foreign-currency conversion is computed from the same pass.
- **Review Queue** — uncertain, missing, or conflicting fields become per-document field reviews (`doc_type`, `vendor`, `doc_date`, `amount`, `fx`, `person`). Users can confirm, correct, or defer each field; corrections feed learned rules and never overwrite user-confirmed values.
- **Canonical Person ontology** — extracted names are normalized and resolved to canonical `Person` records with aliases, semantic roles, evidence, confidence, and source-of-truth (`ai_inferred < learned_rule < user_confirmed < manual`). Supports rename, merge, split, alias add/remove, and per-document reassign.
- **Financial Snapshot** — a click-to-open popup beside the orb that summarizes the vault by person, including counts, date ranges, categories, foreign-invoice totals, Unidentified documents, and a global Needs Review bucket. Cached in SQLite; refresh re-runs AI attribution.
- **Document Browser + Evidence Card** — a dedicated `Documents` window with a searchable, keyboard-navigable list and a pinned Evidence Card that shows why the app thinks what it thinks, with per-field Confirm / Correct / Later actions.
- **Foreign-currency conversion** — USD/EUR/GBP/JPY amounts are converted to INR using the Frankfurter FBIL reference rate for the invoice date, with a nearest-prior-business-day fallback. Converted values are stored on the document record and aggregated in the Snapshot.
- **Training Mode** — opt-in mode that asks 3–5 targeted questions after each ingest and turns answers into learned rules. Rules auto-apply after consistent confirmations and are mirrored in `~/Documents/Quick2Afvault/RULES.md`.
- **Notifications & toasts** — native macOS notifications summarize every batch, and a near-orb, non-focusable toast appears for genuine conversion failures while keeping the original safe.

## Tech stack

- **Runtime / framework:** Glaze SDK (`@glaze/core/backend`, `@glaze/core/ai`)
- **Language:** TypeScript 5.5+ (ES modules)
- **Frontend:** React 19, TanStack Router, TanStack Query, Tailwind CSS 4, Radix UI / `@radix-ui/colors`, Lucide icons, `cmdk`, `class-variance-authority`, `tailwind-merge`
- **Backend:** Node.js main process, `node:sqlite`, `pdf-parse`, `xlsx`
- **Build:** Vite 8, esbuild, `glaze.ts` CLI wrapper
- **Node engine:** `>= 24`
- **Package manager:** npm (pinned via `packageManager` in `package.json`)

## Project structure

```
.
├── package.json            # app metadata, scripts, dependencies, Glaze config
├── tsconfig.json           # TypeScript paths, strict mode, bundler resolution
├── glaze.ts                # thin CLI wrapper that resolves the Glaze SDK
├── main/
│   ├── index.ts            # app entry point: menu, lifecycle, create orb
│   ├── handlers/index.ts   # registers all IPC handlers
│   ├── services/
│   │   ├── vault.ts        # file copy, dedup, Markdown conversion orchestration
│   │   ├── converter.ts    # file -> text -> Markdown (pdf/xlsx/csv/txt)
│   │   ├── extraction.ts   # unified AI extraction of doc fields + FX
│   │   ├── currency.ts     # FBIL/Frankfurter USD/EUR/GBP/JPY -> INR conversion
│   │   ├── snapshot.ts     # AI attribution, aggregation, caching
│   │   ├── people.ts       # canonical person ontology / entity resolution
│   │   ├── reviews.ts      # Review Queue routing, confirm/correct, audit
│   │   ├── training.ts     # Training Mode question generation & rules
│   │   ├── document-detail.ts  # Document Browser / Evidence Card assembly
│   │   ├── database.ts     # SQLite schema, migrations, accessors
│   │   └── notify.ts       # native macOS batch notifications
│   └── windows/
│       ├── orb-window.ts       # the floating orb window + custom drag
│       ├── orb-menu.ts         # right-click context menu
│       ├── settings-window.ts  # settings / history / people / review queue
│       ├── snapshot-window.ts  # Financial Snapshot popup
│       ├── training-window.ts  # Training Mode question popup
│       ├── documents-window.ts # Document Browser window
│       └── toast-window.ts     # near-orb transient toast (plain DOM)
├── renderer/
│   ├── styles.css
│   ├── preload.ts
│   ├── main/               # orb home view
│   ├── settings/           # settings app
│   ├── snapshot/           # Financial Snapshot popup
│   ├── training/           # Training Mode popup
│   ├── documents/          # Document Browser + Evidence Card
│   └── shared/             # shared renderer utilities
├── main-window.html
├── settings-window.html
├── snapshot-window.html
├── training-window.html
├── documents-window.html
├── toast-window.html
└── app-icon.*              # generated app icons (ignored by git)
```

## Development

All commands run from this directory:

```bash
npm install
npm run dev         # start the app in dev mode
npm run dev:renderer
npm run build       # build the app into ../.glaze/build
npm run lint
npm run type-check
npm run format
```

`glaze.ts` resolves the Glaze CLI from one of:

- `../glaze-core/cli/glaze.js`
- `../../../sdk/current/@glaze/core/cli/glaze.js`

This means the repo is expected to live inside a Glaze app container.

## Architecture overview

### Main process

`main/index.ts` registers IPC handlers and creates the orb window on `app.whenReady`. It also ensures the vault directories exist.

`main/handlers/index.ts` is the single place all IPC channels are registered. It wires renderer calls to the backend services and broadcasts state changes (`training:changed`, `review:changed`) where appropriate.

### Ingestion pipeline (`main/services/vault.ts`)

`ingestFile(filePath)` does the following:

1. Hash the file with SHA-256.
2. If the hash already exists, return a `duplicate` result.
3. Copy the original into `Raw/<today>/` with a `(n)` suffix on collisions.
4. Convert to Markdown and write to `Markdown/<today>/`.
5. Run `extractDocument()` to get doc type, vendor, date, amount, currency, and FX.
6. Insert a `DocumentRecord` into SQLite with the extracted currency fields.
7. Seed the Review Queue with `recordExtractionReviews()`.

`ingestFiles(paths)` iterates one file at a time so the renderer can show a `done/total` progress pill.

### Markdown conversion (`main/services/converter.ts`)

- PDFs are parsed with `pdf-parse`.
- XLSX/CSV are read with `xlsx` and rendered as Markdown tables.
- TXT is read as UTF-8.
- The extracted representation is sent to `generateText(glaze("fast"))` with a 24 000-char cap.
- On any `GlazeAIError` or failure, a deterministic fallback Markdown is written so the original is always preserved.

### Unified extraction (`main/services/extraction.ts`)

`extractDocument(text, filename)` calls `generateObject(glaze("fast"))` once with a schema that returns `documentType`, `vendor`, `documentDate`, `amount`, and `currency` plus per-field confidence flags. It then calls `convertToInr()` to compute the FX fields. If AI is blocked, it returns an empty extraction; the file is still stored safely.

### Currency (`main/services/currency.ts`)

`convertToInr({ currency, amount, invoiceDate, confident })`:

- Only converts `USD`, `EUR`, `GBP`, `JPY` to INR.
- `INR`/`NONE` or missing confident inputs return `currencyStatus: "none"` or `"needs_review"`.
- Fetches `https://api.frankfurter.dev/v2/rate/{CUR}/INR?providers=FBIL&date={date}`.
- Caches rates locally by `currency + requestedDate`.
- Records `rateDate` and `rateIsNearest` when a prior business-day rate is substituted.
- Returns rounded `inrValue = amount * rate`.

### Snapshot (`main/services/snapshot.ts`)

- Stores per-document AI attributions in `snapshot_cache` as `{ version: 2, attributions[] }`.
- `getCachedSnapshot()` seeds people from existing names and aggregates from cache without calling AI.
- `refreshSnapshot()` re-runs AI attribution, resolves each name to a canonical person, records person reviews, and re-aggregates.
- Aggregation groups by canonical person with counts, date ranges, categories, `foreignInvoices[]`, `foreignTotalInr`, an `Unidentified` bucket, and a global `needsReview` bucket.
- `getAttributionMap()` provides the Document Browser with per-document person/category/period without re-running AI.

### People (`main/services/people.ts`)

- Tables: `persons`, `person_aliases`, `person_evidence`.
- Normalization supports exact alias, reordered first/last names (≥0.85 auto-link for candidates), and initials/shortened variants (0.72, kept as candidates for Training).
- Source-of-truth hierarchy: `ai_inferred < learned_rule < user_confirmed < manual`; AI never overwrites a higher source.
- Supports `listPeople`, `ensurePerson`, `renamePerson`, `mergePersons`, `splitPerson`, `add/removeAlias`, `markSelf`, `setPersonRoles`, `deletePersonEntity`, and `consolidateCandidateDuplicates`.
- Document overrides (`document_overrides`) apply at aggregation time, so reassignments reflect instantly without an AI re-run.

### Review Queue (`main/services/reviews.ts`)

- Tables: `document_field_reviews`, `review_audit`.
- Tracks six fields: `person`, `doc_type`, `vendor`, `doc_date`, `amount`, `fx`.
- Statuses: `low_confidence`, `conflict`, `missing`, `confirmed`, `corrected`, `deferred`.
- `resolveField(docId, field, action, value?)` enforces source authority, writes an audit entry, and applies side effects:
  - person correction → learns `person_variant` and can create/confirm a person
  - doc_type correction with known vendor → learns `vendor_category`
  - fx correction → re-runs `convertToInr()` and updates the document currency
- `confirmAllSuggestions(docId)` confirms every pending field in one action.

### Training (`main/services/training.ts`)

- Tables: `app_settings`, `learned_rules`, `training_reviews`.
- `prepareTraining(docId)` generates 3–5 questions from the doc excerpt and known confident facts.
- `saveAnswers()` turns answers into rules keyed by `(type, match_key)`:
  - `vendor_category`, `person_variant`, `keyword_doctype`, `source_scope`
- `AUTO_APPLY_THRESHOLD = 2` confirms before a rule auto-applies; manual rules apply immediately.
- A human-readable `RULES.md` is mirrored in the vault root.
- Settings shows mode toggle, stats, and an editable rule list.

### Document Browser / Evidence Card (`main/services/document-detail.ts`)

`listDocumentBrowser()` returns lightweight rows joining the document record, field reviews, snapshot attribution, canonical person, and a best-effort `source_scope` business/personal label.

`getDocumentDetail(docId)` reads a 1200-char Markdown excerpt and returns the full Evidence Card data: summary grid, person context with aliases/evidence, detail fields with confidence/source/status/reason, Markdown excerpt, and audit trail.

### Database (`main/services/database.ts`)

`node:sqlite` (`DatabaseSync`) located at `~/Library/Application Support/Quick2Afvault/quick2afvault.db`.

Key tables:

- `documents` — every ingested file + paths + hash + currency columns
- `snapshot_cache` — AI attribution cache
- `persons`, `person_aliases`, `person_evidence` — canonical people
- `document_overrides`, `person_name_overrides` (vestigial, read-only seed) — user overrides
- `rate_cache` — FBIL rate cache
- `learned_rules`, `training_reviews` — Training Mode
- `document_field_reviews`, `review_audit` — Review Queue
- `app_settings` — key/value settings

Migrations are idempotent and check `PRAGMA table_info` before `ADD COLUMN`.

## Data & storage paths

- **Vault originals:** `~/Documents/Quick2Afvault/Raw/<YYYY-MM-DD>/`
- **Vault Markdown:** `~/Documents/Quick2Afvault/Markdown/<YYYY-MM-DD>/`
- **Learned rules mirror:** `~/Documents/Quick2Afvault/RULES.md`
- **SQLite database:** `~/Library/Application Support/Quick2Afvault/quick2afvault.db`
- **Orb position/state:** `~/Library/Application Support/Quick2Afvault/orb-state.json`

## AI behavior & fallbacks

AI is **optional** (`capabilities.ai.mode: "optional"`, grade `"fast"`). If the user has not enabled AI or credits are exhausted:

- Markdown conversion falls back to the extracted representation.
- Extraction returns empty/uncertain fields that go to the Review Queue.
- Snapshot `getCachedSnapshot()` still works from cache; `refreshSnapshot()` shows a blocked banner and raw stats.
- Training Mode does not run without AI.

The app never overwrites a `user_confirmed` or `manual` field with AI output. This is enforced by `canOverwrite()` in `database.ts` and by the resolve logic in `reviews.ts`.

## macOS integration notes

- `activationPolicy: "accessory"` means no Dock icon and no Cmd-Tab entry.
- The orb is a `BrowserWindow` with `frame: false`, `transparent: true`, `hasShadow: false`, `alwaysOnTop: "floating"`, `visibleOnAllWorkspaces: true`, and a custom pointer-driven drag so clicks and drags are distinguishable.
- Toast, Snapshot, and Training windows are positioned relative to the orb using `screen.getDisplayNearestPoint` and `workArea` clamping.
- Native notifications are used for batch outcomes via `main/services/notify.ts`.

## Status & known limitations

The app is functionally complete through the Document Browser + Evidence Card. The AI-dependent paths (conversion, extraction, snapshot refresh, training question generation, FX conversion) are validated statically and by schema, but their quality and runtime behavior depend on real file drops and available AI credits. The Frankfurter FBIL API is keyless but requires network access.
