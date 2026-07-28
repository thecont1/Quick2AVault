import assert from "node:assert/strict";

import { rollupWatchCategories } from "./watch-category-rollup.js";

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
        spendCategory: "grocery",
        watchCategory: null,
        impactBucket: "household_expense",
      },
      {
        amountInr: -250,
        spendCategory: null,
        watchCategory: "Groceries",
        impactBucket: "household_expense",
      },
      {
        amountInr: 700,
        spendCategory: null,
        watchCategory: null,
        impactBucket: "shopping_discretionary",
      },
      {
        amountInr: null,
        spendCategory: "grocery",
        watchCategory: null,
        impactBucket: "household_expense",
      },
    ],
    categories,
  ),
  [
    { id: "groceries", label: "Groceries", totalInr: 350.13, documentCount: 2 },
    { id: "discretionary", label: "Discretionary", totalInr: 700, documentCount: 1 },
  ],
);

console.log("watch-category rollup smoke: ok");
