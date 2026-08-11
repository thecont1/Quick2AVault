# Release checklist

## Layer 3 — Glaze document-detail smoke test

Run this against a release-candidate macOS build after automated tests pass.

- [ ] Open Fixture G (PetaSight tax invoice) and compare the detail layout with
      [`01-pet_asight_tax_invoice_detail.png`](../fixtures/glaze_golden/01-pet_asight_tax_invoice_detail.png).
- [ ] Check Fixture G fields, evidence, parties, and line items against
      [`02-pet_asight_tax_invoice_fields.png`](../fixtures/glaze_golden/02-pet_asight_tax_invoice_fields.png).
- [ ] Open Fixture H (Paytm contract note) and compare the detail layout with
      [`03-paytm_contract_note_detail.png`](../fixtures/glaze_golden/03-paytm_contract_note_detail.png).
- [ ] Check Fixture H broker/client fields, trades, ISINs, and investment impact
      against [`04-paytm_contract_note_fields.png`](../fixtures/glaze_golden/04-paytm_contract_note_fields.png).
- [ ] Confirm Document and Markdown tabs both work when their sources exist.
- [ ] Confirm the footer exposes Open original, Open Markdown, Reprocess,
      Remove from active, and Delete permanently.
- [ ] Confirm failed lifecycle actions show an error and do not refresh away the
      loaded document.
- [ ] Confirm narrow layouts scroll without an unbounded-height exception.

Advisory golden reports are generated under
`desktop/test/_golden/reports/`. Review them, but do not update canonical
goldens in CI.