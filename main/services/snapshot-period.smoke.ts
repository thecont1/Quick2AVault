import assert from "node:assert/strict";

import {
  documentIsInPeriod,
  recurringContributionForPeriod,
  recurringOccurrencesInPeriod,
  rollupMoneyForPeriod,
  snapshotPeriodInfo,
} from "./snapshot-period.js";

const july = new Date(2026, 6, 28, 12, 0, 0);
const month = snapshotPeriodInfo("month", july, 4);
assert.deepEqual(month, {
  period: "month",
  label: "July 2026",
  startDate: "2026-07-01",
  endDate: "2026-07-31",
});
assert.equal(documentIsInPeriod({ documentDate: "2026-07-01" }, month), true);
assert.equal(documentIsInPeriod({ documentDate: "2026-07-31" }, month), true);
assert.equal(documentIsInPeriod({ documentDate: "2026-06-30" }, month), false);
assert.equal(documentIsInPeriod({ documentDate: null }, month), false);
assert.equal(documentIsInPeriod({ documentDate: "not-a-date" }, month), false);

const indiaFy = snapshotPeriodInfo("financial_year", july, 4);
assert.deepEqual(indiaFy, {
  period: "financial_year",
  label: "FY 2026-27",
  startDate: "2026-04-01",
  endDate: "2027-03-31",
});
assert.equal(documentIsInPeriod({ documentDate: "2026-04-01" }, indiaFy), true);
assert.equal(documentIsInPeriod({ documentDate: "2027-03-31" }, indiaFy), true);
assert.equal(documentIsInPeriod({ documentDate: "2027-04-01" }, indiaFy), false);

const januaryFy = snapshotPeriodInfo("financial_year", new Date(2027, 0, 2), 4);
assert.equal(januaryFy.label, "FY 2026-27");
assert.equal(januaryFy.startDate, "2026-04-01");
assert.equal(januaryFy.endDate, "2027-03-31");

const calendarYear = snapshotPeriodInfo("financial_year", july, 1);
assert.equal(calendarYear.label, "FY 2026-27");
assert.equal(calendarYear.startDate, "2026-01-01");
assert.equal(calendarYear.endDate, "2026-12-31");

assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 24_000,
      frequency: "annually",
      startDate: "2026-07-15",
      endDate: null,
    },
    month,
  ),
  1,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 24_000,
      frequency: "annually",
      startDate: "2026-08-15",
      endDate: null,
    },
    month,
  ),
  0,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 2_000,
      frequency: "monthly",
      startDate: "2026-04-05",
      endDate: null,
    },
    indiaFy,
  ),
  12,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 6_000,
      frequency: "quarterly",
      startDate: "2026-04-29",
      endDate: "2026-10-29",
    },
    indiaFy,
  ),
  3,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1_000,
      frequency: "custom",
      startDate: null,
      endDate: null,
    },
    month,
  ),
  0,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 2_000,
      frequency: "monthly",
      startDate: null,
      endDate: null,
    },
    month,
  ),
  1,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 2_000,
      frequency: "monthly",
      startDate: null,
      endDate: null,
    },
    indiaFy,
  ),
  12,
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 24_000,
      frequency: "annually",
      startDate: null,
      endDate: null,
    },
    indiaFy,
  ),
  0,
);
const janToMarch = {
  period: "financial_year" as const,
  label: "Q1 2026",
  startDate: "2026-01-01",
  endDate: "2026-03-30",
};
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1,
      frequency: "monthly",
      startDate: "2026-01-31",
      endDate: null,
    },
    janToMarch,
  ),
  2,
  "Jan 31 must advance to Feb 28 then Mar 31, not drift to Mar 28",
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1,
      frequency: "monthly",
      startDate: "2026-08-31",
      endDate: null,
    },
    {
      ...janToMarch,
      label: "Aug-Oct 2026",
      startDate: "2026-08-01",
      endDate: "2026-10-30",
    },
  ),
  2,
  "Aug 31 must advance to Sep 30 then Oct 31",
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1,
      frequency: "monthly",
      startDate: "2026-04-30",
      endDate: null,
    },
    {
      ...janToMarch,
      label: "Apr-May 2026",
      startDate: "2026-04-01",
      endDate: "2026-05-30",
    },
  ),
  1,
  "An end-of-month anchor must remain at month-end when the next month is longer",
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1,
      frequency: "monthly",
      startDate: "2024-01-31",
      endDate: null,
    },
    {
      ...janToMarch,
      label: "Leap Q1 2024",
      startDate: "2024-01-01",
      endDate: "2024-03-30",
    },
  ),
  2,
  "Jan 31 must advance to leap-day Feb 29 then Mar 31",
);
assert.equal(
  recurringOccurrencesInPeriod(
    {
      amount: 1,
      frequency: "annually",
      startDate: "2024-02-29",
      endDate: null,
    },
    {
      ...janToMarch,
      label: "Four years",
      startDate: "2024-01-01",
      endDate: "2028-02-28",
    },
  ),
  4,
  "Feb 29 annual schedules use Feb 28 in non-leap years and Feb 29 in leap years",
);

assert.equal(
  recurringContributionForPeriod(
    {
      amount: 3_100,
      frequency: "custom",
      startDate: "2026-07-20",
      endDate: null,
    },
    month,
  ),
  3_100,
);
assert.equal(
  recurringContributionForPeriod(
    {
      amount: 3_100,
      frequency: "custom",
      startDate: null,
      endDate: null,
    },
    month,
  ),
  0,
);
assert.equal(
  recurringContributionForPeriod(
    {
      amount: Number.NaN,
      frequency: "custom",
      startDate: "2026-07-20",
      endDate: null,
    },
    month,
  ),
  0,
);

assert.deepEqual(
  rollupMoneyForPeriod(
    [
      {
        documentDate: "2026-07-03",
        bucket: "income",
        direction: "in",
        amountInr: 150_000,
      },
      {
        documentDate: "2026-07-07",
        bucket: "household_expense",
        direction: "out",
        amountInr: 12_500.125,
      },
      {
        documentDate: "2026-07-09",
        bucket: "business_expense",
        direction: "out",
        amountInr: 8_000,
      },
      {
        documentDate: "2026-07-12",
        bucket: "investment_purchase",
        direction: "out",
        amountInr: 25_000,
      },
      {
        documentDate: "2026-06-30",
        bucket: "income",
        direction: "in",
        amountInr: 500_000,
      },
      {
        documentDate: null,
        bucket: "income",
        direction: "in",
        amountInr: 20_000,
      },
      {
        documentDate: null,
        bucket: "needs_review",
        direction: "neutral",
        amountInr: null,
      },
    ],
    month,
  ),
  {
    income: 150_000,
    spending: 20_500.13,
    investments: 25_000,
    documentCount: 4,
    undatedDocumentCount: 1,
  },
);

console.log("snapshot-period smoke: ok");
