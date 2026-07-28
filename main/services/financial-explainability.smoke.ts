import assert from "node:assert/strict";

import {
  sumDrilldownMetric,
  summarizeDocumentMoney,
  type ExplainableMoneyDocument,
} from "./financial-explainability.js";

const documents: ExplainableMoneyDocument[] = [
  {
    docId: 1,
    documentDate: "2026-07-02",
    lifecycleState: "active",
    bucket: "income",
    direction: "in",
    amountInr: 150_000,
  },
  {
    docId: 2,
    documentDate: "2026-07-05",
    lifecycleState: "active",
    bucket: "household_expense",
    direction: "out",
    amountInr: 30_000,
  },
  {
    docId: 3,
    documentDate: "2026-07-08",
    lifecycleState: "active",
    bucket: "investment_purchase",
    direction: "out",
    amountInr: 12_000,
  },
  {
    docId: 4,
    documentDate: "2026-07-12",
    lifecycleState: "excluded",
    bucket: "household_expense",
    direction: "out",
    amountInr: 8_000,
  },
  {
    docId: 5,
    documentDate: null,
    lifecycleState: "active",
    bucket: "household_expense",
    direction: "out",
    amountInr: 9_000,
  },
];

const period = {
  period: "month" as const,
  label: "July 2026",
  startDate: "2026-07-01",
  endDate: "2026-07-31",
};

const summary = summarizeDocumentMoney(documents, period);
assert.deepEqual(summary.totals, {
  income: 150_000,
  spending: 30_000,
  investments: 12_000,
  documentCount: 3,
  undatedDocumentCount: 1,
});
assert.deepEqual(summary.drilldownIds, {
  income: [1],
  spending: [2],
  investments: [3],
});

for (const metric of ["income", "spending", "investments"] as const) {
  assert.equal(
    summary.totals[metric],
    sumDrilldownMetric(documents, summary.drilldownIds[metric], metric, period),
    `${metric} hero total must equal the visible drill-down contribution sum`,
  );
}

// Scheduled rent/SIP/subscription values are intentionally absent from this API:
// document-only hero totals cannot double-count them alongside their real documents.
assert.equal(summary.totals.spending, 30_000);
assert.equal(summary.totals.investments, 12_000);

console.log("financial explainability smoke: ok");
