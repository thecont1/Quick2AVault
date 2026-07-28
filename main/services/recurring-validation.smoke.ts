import assert from "node:assert/strict";

import { validateRecurringInput } from "./recurring.js";

const valid = {
  name: "Rent",
  amount: 30_000,
  currency: "INR",
  frequency: "monthly",
  startDate: "2026-01-31",
  endDate: null,
  person: null,
  impactBucket: "household_expense",
  category: "Household",
  scope: "personal",
  notes: null,
};

assert.equal(validateRecurringInput(valid).ok, true);
for (const value of ["2026-02-31", "2026-13-10", "2025-02-29", "2026-2-01"]) {
  const result = validateRecurringInput({ ...valid, startDate: value });
  assert.deepEqual(result, {
    ok: false,
    error: `Start date must be a real calendar date in YYYY-MM-DD format (${value} is invalid).`,
  });
}
assert.equal(validateRecurringInput({ ...valid, startDate: "2024-02-29" }).ok, true);
assert.deepEqual(validateRecurringInput({ ...valid, endDate: "2026-02-31" }), {
  ok: false,
  error: "End date must be a real calendar date in YYYY-MM-DD format (2026-02-31 is invalid).",
});
assert.deepEqual(
  validateRecurringInput({ ...valid, startDate: "2026-03-01", endDate: "2026-02-28" }),
  { ok: false, error: "End date must be on or after the start date." },
);

console.log("recurring validation smoke: ok");
