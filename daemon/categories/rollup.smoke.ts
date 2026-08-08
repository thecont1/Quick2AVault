import assert from "node:assert/strict";

import { rollupWatchCategories } from "./rollup.js";

const categories = [
  {
    id: "groceries",
    label: "Groceries",
    pinned: true,
    spendCategories: ["grocery", "groceries"],
    impactBuckets: [],
  },
  {
    id: "discretionary",
    label: "Discretionary",
    pinned: true,
    spendCategories: ["marketplace"],
    impactBuckets: ["shopping_discretionary"],
  },
  {
    id: "ai_expense",
    label: "AI Expense",
    pinned: false,
    spendCategories: ["ai_expense"],
    impactBuckets: [],
  },
];

assert.deepEqual(
  rollupWatchCategories(
    [
      {
        amountInr: 100.125,
        source: "document",
        spendCategory: "grocery",
        watchCategory: null,
        impactBucket: "household_expense",
      },
      {
        amountInr: -250,
        source: "document",
        spendCategory: null,
        watchCategory: "Groceries",
        impactBucket: "household_expense",
      },
      {
        amountInr: 700,
        source: "document",
        spendCategory: null,
        watchCategory: null,
        impactBucket: "shopping_discretionary",
      },
      {
        amountInr: null,
        source: "document",
        spendCategory: "grocery",
        watchCategory: null,
        impactBucket: "household_expense",
      },
    ],
    categories,
  ),
  [
    {
      id: "groceries",
      label: "Groceries",
      totalInr: 350.13,
      documentCount: 2,
      scheduledEntryCount: 0,
    },
    {
      id: "discretionary",
      label: "Discretionary",
      totalInr: 700,
      documentCount: 1,
      scheduledEntryCount: 0,
    },
  ],
);

assert.deepEqual(
  rollupWatchCategories(
    [
      {
        amountInr: 100,
        source: "document",
        spendCategory: "grocery",
        watchCategory: null,
        impactBucket: "household_expense",
      },
      {
        amountInr: 900,
        source: "scheduled",
        spendCategory: "groceries",
        watchCategory: "groceries",
        impactBucket: "household_expense",
      },
    ],
    categories,
  ),
  [
    {
      id: "groceries",
      label: "Groceries",
      totalInr: 1_000,
      documentCount: 1,
      scheduledEntryCount: 1,
    },
    {
      id: "discretionary",
      label: "Discretionary",
      totalInr: 0,
      documentCount: 0,
      scheduledEntryCount: 0,
    },
  ],
);

console.log("watch-category rollup smoke: ok");
