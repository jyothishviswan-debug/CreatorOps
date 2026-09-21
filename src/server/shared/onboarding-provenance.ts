import { z } from "zod";

// Step 14B.1: the one closed provenance marker an owning module records when a Partner / Vendor / Partner Account is created by
// the Finance Agreement onboarding orchestration ("Created from Finance Agreement onboarding"). Domain-neutral on purpose (Partners,
// Vendors and Finance all name the same literal, none imports the other). It is provenance only - it creates no second identity
// source and grants nothing: the owning create service still applies its own gate, scope and validation.
export const FINANCE_AGREEMENT_ONBOARDING_PROVENANCE = "FINANCE_AGREEMENT_ONBOARDING" as const;
export const createdViaSchema = z.literal(FINANCE_AGREEMENT_ONBOARDING_PROVENANCE);
export type CreatedVia = z.infer<typeof createdViaSchema>;
