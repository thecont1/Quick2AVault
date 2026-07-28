import assert from "node:assert/strict";

import {
  applyDocumentDrilldown,
  groupDocumentRows,
  type BrowserDocument,
  type DocumentDrilldown,
} from "./document-browser-model.js";

const rows: BrowserDocument[] = [
  {
    docId: 1,
    category: "Income",
    docDate: "2026-07-02",
    dateIngested: "2026-07-05T10:00:00.000Z",
    lifecycleState: "active",
    impactBucket: "income",
    impactDirection: "in",
  },
  {
    docId: 2,
    category: "Household",
    docDate: "2026-07-10",
    dateIngested: "2026-07-11T10:00:00.000Z",
    lifecycleState: "active",
    impactBucket: "household_expense",
    impactDirection: "out",
  },
  {
    docId: 3,
    category: "Investments",
    docDate: "2026-07-09",
    dateIngested: "2026-07-12T10:00:00.000Z",
    lifecycleState: "active",
    impactBucket: "investment_purchase",
    impactDirection: "out",
  },
  {
    docId: 4,
    category: null,
    docDate: null,
    dateIngested: "2026-07-13T10:00:00.000Z",
    lifecycleState: "active",
    impactBucket: "income",
    impactDirection: "in",
  },
  {
    docId: 5,
    category: "Household",
    docDate: "2026-07-12",
    dateIngested: "2026-07-13T11:00:00.000Z",
    lifecycleState: "excluded",
    impactBucket: "household_expense",
    impactDirection: "out",
  },
];

const drilldown = (metric: DocumentDrilldown["metric"]): DocumentDrilldown => ({
  metric,
  period: "month",
  label: "July 2026",
  startDate: "2026-07-01",
  endDate: "2026-07-31",
  docIds: metric === "income" ? [1] : metric === "spending" ? [2] : [3],
});

assert.deepEqual(
  applyDocumentDrilldown(rows, drilldown("income")).map((row) => row.docId),
  [1],
);
assert.deepEqual(
  applyDocumentDrilldown(rows, drilldown("spending")).map((row) => row.docId),
  [2],
);
assert.deepEqual(
  applyDocumentDrilldown(rows, drilldown("investments")).map((row) => row.docId),
  [3],
);
assert.deepEqual(applyDocumentDrilldown(rows, null), rows);

assert.deepEqual(
  groupDocumentRows(rows.slice().reverse()).map((group) => ({
    label: group.label,
    ids: group.rows.map((row) => row.docId),
  })),
  [
    { label: "Household", ids: [5, 2] },
    { label: "Income", ids: [1] },
    { label: "Investments", ids: [3] },
    { label: "Uncategorized", ids: [4] },
  ],
);

console.log("document-browser model smoke: ok");
