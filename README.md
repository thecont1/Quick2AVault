# Quick2AVault

A macOS desktop utility that turns your financial document chaos into a calm, organised, AI-powered vault. Drop a PDF, spreadsheet, or photo of a receipt into the vault and **Quick2AVault** safely archives it, converts it to searchable Markdown, reads its contents, classifies it by person and financial period, converts foreign currencies at official exchange rates, and surfaces only the things that actually need your attention.

> **Architecture note:** Quick2AVault is two programs. A **headless TypeScript daemon** owns the vault, the SQLite ledger, and every AI call, exposing a token-authenticated HTTP API on `localhost:4477`. A **Flutter macOS client** in `desktop/` is one consumer of that API — not the app itself. Any client (CLI, MCP server, another UI) can speak the same protocol.
>
> The original Electron/Glaze implementation was retired on 2026-08-09. Its complete history is archived at [thecont1/Quick2AVault-archived](https://github.com/thecont1/Quick2AVault-archived), tagged `glaze-final`.

## The Problem

Personal financial documents live everywhere: email attachments, phone photos, downloads folders, random folders on the desktop. They're PDFs you can't search, spreadsheets with no context, photos of receipts that vanish into your camera roll. When tax season or a loan application comes around, good luck finding that one statement from three years ago.

**Quick2AVault** solves this by being the single, calm place where every financial document lands — automatically organised, intelligently analyzed, and always findable.

## The Vision

**Quick2AVault** is not just a document scanner. It's a **personal financial intelligence layer** that reasons about your money life:

- **Who** does this document belong to? (You, your spouse, a client, a vendor?)
- **What** kind of document is it? (Invoice, statement, receipt, contract note?)
- **When** does it belong — not just the date on the paper, but which financial year, which accounting period?
- **How much** money moved, and in what direction — income, expense, investment, tax?
- **What does it mean** — suggested accounting treatment, financial impact, and confidence-backed insights?

It's a safe deposit box, a filing cabinet, a financial analyst, and a compliance assistant — running quietly as a local daemon you own.

## Core Features

### Local-First, Client-Agnostic
The daemon is the product; the UI is a client. Everything — your documents, the
ledger, the learned rules — stays on your machine, reachable over a
token-authenticated API on `localhost`. The Flutter client in `desktop/` is the
reference UI, but the CLI and MCP server are equally first-class consumers.

### Non-Blocking, Safe-Receipt Ingestion
Drop a file — any file — and the moment it's safely copied into your vault, you get an immediate receipt. Heavy work happens afterwards on a persisted job queue, so you can add another batch while the first is still processing, and a crash resumes where it left off instead of starting over.

- **Phase 1 (intake):** Hash with SHA-256, deduplicate, copy the original into `~/Documents/Quick2AVault/Raw/<YYYY-MM-DD>/` — returns instantly.
- **Phase 2 (processing):** Convert to Markdown, run AI extraction, classify, and record — all in the background.
- **Batch support:** Drop 10 files at once; see live progress.
- **Failure safety:** If processing fails, the original is always safe. The job records why, and the document can be retried.

### Gmail Financial Dropbox (Gmail Only)
Settings can connect one user-chosen Gmail address by entering only its local part; the app derives
`<local-part>@gmail.com` and stores no hardcoded mailbox. Google authorization uses an installed-desktop
PKCE flow with a loopback callback and read-only Gmail scope. Refresh tokens are held in the macOS Keychain
(`daemon/gmail/token-store.ts`), never in SQLite preferences.

Quick2A Vault performs a bounded 30-day bootstrap (up to 100 messages), then advances via Gmail history IDs
every five minutes. Supported attachments and relevant body-only transaction alerts enter the same SHA-256
intake queue as dropped files, so deduplication and learned vendor/category rules behave identically. Gmail
messages are never sent, replied to, archived, deleted, labelled, or marked read.

### Intelligent Intake Triage
Not every file is a financial document. **Quick2AVault** performs a fast, deterministic (no-AI) first pass to decide what lane each file belongs in:

1. **Accepted** — plausibly a financial document; queued for normal processing.
2. **Irrelevant / junk** — family photos, personal notes, casual non-financial content; filed into `~/Documents/Quick2AVault/Irrelevant/` with a clear explanation, never destroyed, restorable later.
3. **Exact duplicate** — identical SHA-256 content hash; logged and skipped, never reprocessed.
4. **Same filename, different content** — both kept, stored under safe unique paths, original visible filename preserved in the UI.

### SHA-256 Content Deduplication
Identical files are never reprocessed. Duplicate detection uses deterministic file/content comparison (SHA-256), never an LLM. Filename is used only as a fast first-pass signal; content hashing confirms the match.

### Universal Document Conversion
Converts any supported file into clean, searchable Markdown:

- **PDFs** parsed with `pdf-parse`
- **XLSX/CSV** read with `xlsx` and rendered as Markdown tables
- **TXT** read as UTF-8
- **Photos & scanned PDFs** transcribed via vision OCR (native macOS image stack with EXIF auto-rotation)
- AI polishes the extracted representation into well-structured Markdown with a deterministic fallback on any AI failure — the original is always preserved

### Vision OCR for Photographed Documents
Many users capture documents with their phone. **Quick2AVault** runs vision extraction on image files and image-based/scanned PDFs, transcribing text faithfully and deciding whether the image is actually a financial document — so a family photo gets routed to the irrelevant lane instead of being force-analyzed.

### Unified AI Document Extraction
One AI pass at ingestion extracts every field the app reasons about — document type, vendor/institution, document date, primary amount, currency, expense/income direction, service period, payment date, advance/prepaid status, impact bucket, and more — each with a confidence flag. The foreign-currency conversion is computed from the same pass (no extra AI call).

### Foreign-Currency Conversion
USD, EUR, GBP, and JPY amounts are converted to INR using India's official FBIL benchmark rate for the invoice date, fetched via the free Frankfurter API. When FBIL doesn't publish a rate (weekends, Mumbai bank holidays), the most recent prior business day's rate is used and clearly marked as a "nearest available rate." Rates are cached locally so the same currency+date is never fetched twice. Uncertain conversions are flagged for review rather than guessing a wrong number.

### Financial-Year Awareness (Core Classification Layer)
Every dated document is assigned to a financial-year bucket as early as possible in processing. India's default FY (April 1 to March 31) is used, so a document dated 2026-03-31 lands in FY 2025-26 and one dated 2026-04-01 lands in FY 2026-27. Missing or ambiguous dates route uncertainty into review rather than silent misclassification. FY appears in document records, the Review Queue, Document Browser, Evidence Card, and Snapshot summaries.

### Accounting Policy Hints (Advisory Layer)
A lightweight, advisory classification layer that separates document facts from accounting interpretation. For relevant documents, it infers a suggested accounting treatment — current-period expense, prepaid expense, accrued expense, deferred revenue, recognized revenue, reimbursement, or needs accounting review — with confidence and a plain-language reason. It flags advance payments, prepaid subscriptions, and cross-financial-year cases for review. Presented as "Suggested treatment," never as final accounting truth.

### Financial Impact Layer (Plain-Language "What Changed")
Once a document is recognized as a financial transaction, **Quick2AVault** derives an immediate, human-readable impact: which bucket it feeds (income, household expense, business expense, software/utility expense, investment purchase/sale, liability/dues, tax/statutory, transfer/neutral, or needs review), the canonical INR amount it moves, and a confidence-backed explanation. Low-confidence guesses are framed as "Looks like…" rather than certainties. User-editable preferences steer ambiguous categories (software invoices, groceries, marketplace purchases).

### Canonical Person Intelligence
A real person may appear across documents under several name variants: first-name/last-name form, reversed form, or an initialled form. **Quick2AVault** introduces a canonical Person entity with known aliases, semantic roles (self, spouse, client, supplier, bank RM, accountant, etc.), confidence, and supporting evidence. Entity resolution matches detected names using exact alias match, reordered first/last names, and initials/shortened variants. High-confidence matches link silently; uncertain ones create candidates that Learning Mode asks about. User-confirmed fields are never overwritten by AI.

### Financial Snapshot
A summary view of the vault by person — counts, date ranges, categories, foreign-invoice totals converted to INR, an Unidentified bucket, and a global Needs Review count. Cached in SQLite for instant opening; a refresh re-runs AI attribution. Income, Spending, and Investments are strictly document-derived: every rupee in a hero total is represented by a document in its drill-down. Scheduled/manual recurring entries are tracked separately and may appear in clearly labelled watch-category rollups, but are not merged into hero totals until trustworthy scheduled-to-actual reconciliation exists.

### Review Queue
A lightweight triage inbox for document intelligence the app isn't confident about. Every ingested document gets one review row per tracked field (person, document type, vendor, date, financial year, amount, currency conversion, accounting hint, financial impact). Anything low-confidence, conflicting, or missing stays pending and surfaces in the queue. Resolving a field keeps a full audit trail, never overwrites a user-confirmed value, and feeds corrections back into learned rules. Zero-value invoices are correctly treated as valid when the rest of the extraction is coherent.

### Document Browser + Evidence Card
A dedicated Documents window with a searchable, keyboard-navigable list and a pinned Evidence Card that shows why the app thinks what it thinks — per-field confidence, source of truth, status, and reason. Includes Confirm / Correct / Later actions, per-document person reassignment, file opening, and lifecycle controls (exclude, restore, reprocess, delete permanently).

### Learning Mode
A user-enabled mode that asks 3–5 targeted questions after each ingest, turning answers into reusable learned rules (vendor→category, name variant→person, keyword→document type, account→business/personal, vendor→accounting treatment, vendor→impact bucket). Rules auto-apply after consistent confirmations and are mirrored in `~/Documents/Quick2AVault/RULES.md`. On a fresh install, Learning Mode defaults to ON so the app starts learning from the very first drop — and never silently re-enables if you turn it off.

### Broker Contract Note Support
Stock-broker contract notes ("Contract Note cum Tax Invoice") are recognized as a first-class document class, not generic invoices. The app extracts the broker, client, trade/settlement dates, contract note number, net amount, and every traded security line item (buy/sell, quantity, price, net amount, symbol/ISIN). These feed an investment-activity view and map the document to an investment purchase/sale event rather than an expense.

### Manual Recurring Entries
Not everything arrives as a document. Salary, rent, SIPs, school fees, subscriptions, EMIs, and utilities are tracked as manual recurring entries with configurable frequency, scope (business/personal), impact bucket, and optional watch category. They are clearly marked as scheduled/manual. They can feed labelled watch-category planning rollups with a separate scheduled-entry count, but do not alter document-derived Income, Spending, or Investments hero totals. A future reconciliation layer may link schedules to actual documents; v1.1.1 deliberately does not infer those matches.

### Live Event Stream
The daemon publishes domain events (`DocumentReceived`, `MarkdownReady`,
`AnalysisComplete`, `TransactionReResolved`) over SSE on `/v1/events`. Clients
subscribe rather than poll, so progress appears as it happens and any number of
UIs stay in sync with one vault.

### Lifecycle Management
Documents move through clear, reversible states: **active**, **irrelevant**, **excluded**, **reprocess requested**. You can delete from the active working set without erasing from disk, restore excluded documents, and reprocess from the existing raw file — no re-drop needed. The state model is surfaced everywhere: Review Queue, Document Browser, and Evidence Card.

### First-Run Finance Preferences
On installation, **Quick2AVault** prompts you to confirm a small set of financial preferences before serious analysis begins — prefilled with India defaults (INR, April–March financial year, DD-MM-YYYY date format, Indian number grouping with lakh/crore). These preferences actually drive display and interpretation: currency and number formatting, date rendering, and the financial-year classification every dated document receives. Fully editable in Settings.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Daemon** | Node.js ≥ 24, plain TypeScript (ES modules), no framework |
| **Ledger** | `node:sqlite` (`DatabaseSync`), FTS5 for search |
| **AI** | `@anthropic-ai/sdk` — extraction only; never rewrites your documents |
| **Conversion** | `@firecrawl/anydoc`, native macOS Vision OCR (`daemon/ocr.swift`) |
| **Desktop client** | Flutter (macOS), talks to the daemon over HTTP |
| **Integrations** | `@modelcontextprotocol/sdk` (MCP server), Gmail API |
| **Dev tooling** | `tsx`, `eslint`, `oxfmt`, per-file `*.smoke.ts` tests |
| **Package Manager** | npm (pinned via `packageManager` in `package.json`) |

## Data & Storage Paths

| What | Where |
|------|-------|
| **Vault originals** | `~/Documents/Quick2AVault/Raw/<YYYY-MM-DD>/` |
| **Vault Markdown** | `~/Documents/Quick2AVault/Markdown/<YYYY-MM-DD>/` |
| **Irrelevant docs** | `~/Documents/Quick2AVault/Irrelevant/<YYYY-MM-DD>/` |
| **Learned rules mirror** | `~/Documents/Quick2AVault/RULES.md` |
| **SQLite database** | `~/Documents/Quick2AVault/vault.db` |

The database lives *inside* the vault directory, not in Application Support. The
vault is one self-contained, portable, backup-able folder: copy it and you have
moved everything, ledger included.

## Architecture Overview

### Non-Blocking Ingestion Pipeline

```
Drop → ingestFile() → job queue → convert → analyse → link
  │         │              │
  │         │              ├── 1. Convert to markdown (adapters.ts: anydoc / Vision OCR)
  │         │              │      records converter, version, and a hash of the text
  │         │              ├── 2. Extract fields (ai-provider.ts → extraction-contract.ts)
  │         │              │      records the model and the markdown hash it read
  │         │              ├── 3. Index for search (search.ts → FTS5)
  │         │              ├── 4. Match against existing transactions (matcher.ts)
  │         │              ├── 5. Record or link the transaction (ledger.ts)
  │         │              └── 6. Resolve canonical fields from claims (claims.ts)
  │         │
  │         └── SHA-256 hash → dedupe → copy into the vault → return a receipt
  │
  └── Any client: Flutter UI, CLI, MCP, or a POST to /v1/intake
```

Every step is a row in `jobs`, so a crash resumes rather than restarts, and a
failed conversion never blocks the original from being safely stored.

### AI Behavior & Graceful Degradation

AI is **optional**. Without an API key, or when a call fails:

- Markdown conversion falls back to the deterministic extracted representation.
- Extraction returns empty/uncertain fields that go to the Review Queue.
- Snapshot `getCachedSnapshot()` still works from cache; `refreshSnapshot()` shows a blocked banner alongside raw stats.
- Learning Mode doesn't run without AI.
- OCR falls back to empty text; the document is still stored safely.

The app **never overwrites** a user-confirmed field with AI output. Authority is `user > rule > import > ai`, and a confirmed claim is never overwritten by anything below it — enforced in one place, `writeClaim()` in `daemon/claims.ts`.

## Key Design Principles

- **Calm but reversible.** The app doesn't destroy anything. Irrelevant files are kept, not deleted. Duplicates are logged, not silently dropped. Excluded documents can be restored.
- **Immediate feedback, background processing.** "Received" comes before "processed." Intake returns a receipt instantly; heavy work happens off the critical path on a resumable queue.
- **Confidence-backed, never overpromised.** Every AI-derived field carries a confidence flag. Low-confidence results surface in the Review Queue with a clear explanation of what's uncertain.
- **User authority over AI.** User-confirmed values are never overwritten. Corrections feed learned rules that auto-apply in the future.
- **Financial-period aware.** Documents are classified into financial years from day one. The app reasons in accounting periods, not just raw dates.
- **Accounting-aware, not a bookkeeping engine.** Accounting treatment hints are advisory suggestions with evidence, never GAAP-compliant bookings.

## Development

```bash
npm install

npm run daemon       # start the daemon (prints its auth token on boot)
npm run daemon:dev   # same, with watch-reload

npm test             # every daemon/*.smoke.ts
npm run type-check
npm run lint
npm run format

npm run app          # Flutter client (macOS)
npm run app:test
npm run app:build
```

The daemon binds `localhost:4477` and mints a random bearer token each boot,
printed to stdout. Pin it for scripting:

```bash
Q2AV_TOKEN=devtoken npm run daemon
curl -H "Authorization: Bearer devtoken" localhost:4477/v1/health
```

| Variable | Meaning |
|----------|---------|
| `Q2AV_PORT` | API port (default `4477`) |
| `Q2AV_TOKEN` | Bearer token; random per boot when unset |
| `Q2AV_VAULT` | Vault root (default `~/Documents/Quick2AVault`) |

### Migrating from the Glaze app

A one-time importer carries corrections out of the retired Electron app's
database into the daemon's claim store, matching documents by SHA-256:

```bash
npm run migrate:glaze -- --dry-run   # report only, writes nothing
npm run migrate:glaze -- --apply
```

It is idempotent and deliberately conservative: it imports vendor, document
type, document date, amount, person links and confirmed aliases, and **refuses**
to import fields whose vocabularies don't match between the two apps (Glaze's
accounting treatment and impact classification). Those stay in the archive
rather than being guessed at.

### Gmail OAuth setup

Create a Google Cloud OAuth client with application type **Desktop app**, enable
the Gmail API, and configure the consent screen. Expose the public client ID:

```bash
QUICK2AVAULT_GMAIL_CLIENT_ID="<desktop OAuth client ID>" npm run daemon
```

No client secret is required or stored for the desktop PKCE flow. For an OAuth
app still in Testing mode, add intended Gmail accounts as test users. Gmail setup
stays unavailable when the client ID is absent.

## Status & Known Limitations

The daemon is the working implementation: intake, conversion, extraction,
matching, the ledger, provenance, lexical search and the claims resolver all run
against a real vault. The Flutter client is in active development and does not
yet cover every daemon capability.

AI-dependent paths (conversion, extraction, snapshot refresh, FX conversion, OCR,
contract-note extraction) are validated statically and by schema, but their
quality depends on actual inputs and available credits. The Frankfurter FBIL API
is keyless but requires network access.

Recurring entries are planning records, not booked transactions. They stay
separate from hero totals to prevent double-counting when an actual document is
also present. Reconciliation states (scheduled, actual, matched) are reserved for
a later release rather than shipped as an unreliable heuristic.

## License

Proprietary — built for personal financial document management.
