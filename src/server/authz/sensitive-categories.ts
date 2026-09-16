// The catalog of sensitive-access categories a role can be granted (see
// sensitive.ts / sensitive-grants-service.ts). A distinct gate from
// module/feature access - e.g. a role can view Finance without being
// granted the finance_amounts category, and so not see sensitive amounts
// within it. Kept as a fixed, labeled list (rather than free text) so an
// admin picking a category from the UI knows what it actually gates.
export type SensitiveCategoryDef = { id: string; label: string; description: string };

export const SENSITIVE_CATEGORIES: SensitiveCategoryDef[] = [
  { id: "finance_amounts", label: "Finance amounts", description: "Payable, invoice and payment amounts within Finance." },
  { id: "partner_contact_info", label: "Partner contact info", description: "Partner phone numbers, emails and direct contacts." },
  { id: "payment_details", label: "Payment details", description: "Bank/payout account details on file." },
];
