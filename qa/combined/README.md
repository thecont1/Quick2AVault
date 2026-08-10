# Combined fixture and QA harness

The harness loads fixtures **A through H, in that order**, into a newly-created
temporary vault and SQLite database. It calls the daemon through its public
`Ports`/pipeline boundary and never reads the user's vault or AI credentials.
The temporary tree is removed after both successful and failed runs unless
`--keep` (or `Q2AV_KEEP=1`) is supplied.

## Commands

```bash
# Harness contract tests (ordering, duplicate inputs, cleanup/keep, failure
# propagation, schema validation, and fail-closed visual comparison)
bun run qa:combined:test

# Full combined run. Visual QA is mandatory by default.
bun run qa:combined -- --captures /path/to/rendered-captures

# Backend/fixture integration only, while developing without Flutter captures.
bun run qa:combined -- --no-visual
```

The capture directory must contain these exact PNG names at the golden
dimensions (2248×2024):

- `01-pet_asight_tax_invoice_detail.png`
- `02-pet_asight_tax_invoice_fields.png`
- `03-paytm_contract_note_detail.png`
- `04-paytm_contract_note_fields.png`

The comparator decodes the PNGs and compares coarse colour blocks plus edge
density. This is deliberately sensitive to panel positions, spacing, borders,
and badge styling while tolerating local text-glyph changes. Missing, malformed,
wrong-sized, or structurally divergent captures fail the run. Intentional layout
changes require reviewing and replacing the checked-in `fixtures/glaze_golden/`
references; do not copy goldens into the capture directory in production QA.

## Fixture contracts

- `fixtures/manifests/A.json` … `F.json` encode ambiguity, identity collapse,
  user-confirmed re-analysis, password/failed terminal handling, duplicates,
  and a cross-kind collision.
- G and H use the checked-in source PDFs. Their extraction value contracts are
  `fixtures/golden/G.json` and `H.json`; screenshots are layout references only.
- Numeric monetary values in the JSON goldens are integer minor units. Decimal
  source quantities remain strings to avoid binary-float drift.

## Production integration boundary

This branch predates several WO09/WO10 backend contracts. The production adapter
therefore reports those assertions as `not_applicable` with the explicit reason
`production contract is not present on this branch`; it never fabricates a pass.
Existing intake, duplicate archiving, failed/password states, and isolated-vault
behaviour are exercised for real. After the backend merge adds `pipeline_events`,
entity/document-party resolution, provenance-preserving re-analysis, the two
per-type extractors, and FX claims, replace the corresponding capability entries
in `production.ts` with queries/assertions against those public persisted
contracts. A missing visual capture remains a hard failure regardless of backend
availability.
