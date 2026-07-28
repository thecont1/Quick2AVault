export type RecurringFrequency = "monthly" | "quarterly" | "annually" | "weekly" | "custom";

export type RecurringImpactBucket =
  | "income"
  | "household_expense"
  | "shared_family_expense"
  | "business_expense"
  | "software_utility_expense"
  | "personal_expense"
  | "shopping_discretionary"
  | "investment_purchase"
  | "investment_sale"
  | "liability_dues"
  | "tax_statutory"
  | "transfer_neutral"
  | "needs_review";

export type RecurringEntryScope = "business" | "personal" | "shared";

export interface RecurringInput {
  name: string;
  amount: number;
  currency: string;
  frequency: RecurringFrequency;
  startDate: string | null;
  endDate: string | null;
  person: string | null;
  impactBucket: RecurringImpactBucket;
  category: string | null;
  scope: RecurringEntryScope;
  notes: string | null;
}

export interface StoredRecurringEntry extends RecurringInput {
  id: number;
  createdAt: string;
  updatedAt: string;
}
