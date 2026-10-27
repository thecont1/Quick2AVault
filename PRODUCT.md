# Product

<!-- impeccable:product-schema 1 -->

## Platform

macos — the flagship is the Flutter macOS desktop client. (The schema's
canonical values are web/ios/android/adaptive; this product is a native
macOS desktop app, so `macos` is recorded truthfully.)

## Users

Primary: Mahesh and household — family money and shared decisions. The
review surface serves both the person filing the paper and whoever needs to
trust that a number is real. Context: private personal finance with real
paperwork — bank statements, payment receipts, invoices, tax documents,
email confirmations.

## Product Purpose

Ingest and keep every financial document, turn each transaction into an
evidenced ledger entry, and get smarter over time as the user corrects
what the AI extracted. Success means: any document can be found, its
extraction is trustworthy, and the learning loop makes tomorrow's intake
less manual.

## Positioning

"Every rupee a transaction, every transaction evidenced." The mechanism a
competitor could not truthfully copy: field-level provenance — every
extracted value carries who-said-so (rule, AI, or user confirmation) with
the confidence, and corrections are stored as claims against the document,
never by mutating the original.

## Operating Context

- Local daemon (Node) owns the vault and API; the Flutter client is a pure
  client — no database, no business logic in the app.
- Documents arrive via Gmail sync pulls and manual drops (folders /
  drag-and-drop). Gmail history is incremental and can expire, which needs
  self-healing sync.
- The review screen is a two-pane browser: grouped searchable list on the
  left, document + extracted metadata on the right.
- The app runs with the daemon on 127.0.0.1; token auth on data endpoints.

## Capabilities and Constraints

- Capabilities: ingest (Gmail, folders, drops), OCR/AI extraction, field
  provenance, transaction ledger with directions in/out/transfer, people
  & aliases, learning queue, evidence panel, duplicate management,
  idempotent ledger writes, markdown rendering, ` pdf page viewer with
  magnifier.
- Constraints (confirmed binding):
  - All data stays local — no cloud dependence.
  - Original files are never altered; review/edit happens on copies or
    writes claims.
  - Nothing leaves the machine except what the user explicitly sends.
  - Every field must be auditable — provenance with source and confidence.
- Undecided: whether a cloud/team sync feature will ever be wanted (blocked
  by the no-cloud principle unless explicitly revisited).

## Brand Commitments

- Name: Quick2AVault (styled Quick2A Vault in some surfaces).
- Motto used in-app: "— every rupee a transaction, every transaction
  evidenced."
- Design language already committed in code: iOS-style light surfaces,
  pale income/spending/investment cards (green/blue/peach), accent blue,
  tabular money figures, Menlo monos for technical labels.
- Voice: calm, honest, non-condescending; states are always truthful (a
  disabled tab is visibly disabled; a missing capability is never hidden).

## Evidence on Hand

- Live vault (165 docs / 36 transactions in test run) — real data, not
  fabricated samples.
- User screenshot of the current Review screen:
  /Users/home/Documents/Screenshot 2026-10-27 at 23.00.55.png
- Code-derived evidence: field provenance model (ClaimProvenance: rule /
  ai-derived / user-confirmed), impact-bucket model, teaching queue.
- Absent: no customer testimonials, press, pricing, or public deployment —
  future work must not fabricate these.

## Product Principles

1. Evidence over assertion — any number worth showing has a trail back to
   a document.
2. The review moment is a teaching moment — correctness today is stored as
   learning for tomorrow.
3. Local-first is a promise, not a setting — the product must work fully
   offline and never exfiltrate.
4. Honest states — if it is not available or not done, say so plainly in
   the UI.
5. Household trust — shared decisions need surfaces that both a
   meticulous filer and a quick checker can use without confusion.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established yet;
the Flutter surfaces follow platform-default semantics and tab navigation.
(To be revisited during design work.)
