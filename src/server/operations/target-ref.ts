import { z } from "zod";

// Step 18A section 4: the bounded, typed target-reference model every Operations Task/Reminder
// links through. A CLOSED enum of canonical record types - never an arbitrary collection name,
// never a polymorphic "Creator"/"Deliverable" concept. Reusing the canonical ref shape (an opaque
// string, exactly like every other module's own *Ref) rather than inventing a new id scheme.
//
// Deliberately NOT resolved live against the named module in this step: Operations does not import
// Partners/Vendors/Campaigns/Assignments/Content/Partner-Reviews/Agreements/Payables/Invoices/
// Payments internals just to validate or display a target. Only FORMAT is checked here (closed
// type, non-empty bounded opaque string) - the same discipline the Approval Queue's own adapters
// use in the other direction (a real source ref, read only through that module's own published
// contract). A Task/Reminder never re-exposes the target record's own data: knowing a targetRef
// grants no access to the target (section 9: "A Task/Reminder/Approval item does not grant access
// to its target").
export const TARGET_TYPES = [
  "PARTNER",
  "PARTNER_ACCOUNT",
  "VENDOR",
  "CAMPAIGN",
  "ASSIGNMENT",
  "CONTENT",
  "PARTNER_REVIEW",
  "AGREEMENT",
  "PAYABLE",
  "INVOICE",
  "PAYMENT",
] as const;
export const targetTypeSchema = z.enum(TARGET_TYPES);
export type TargetType = z.infer<typeof targetTypeSchema>;

const opaqueRefSchema = z.string().min(1).max(200);

// `targetVersion` is optional and "only where meaningful" (section 4) - a Task pinned to a specific
// immutable version of a versioned record (an Agreement/Payable/Invoice/Payment/Partner-Review
// version, exactly like Payments pins an Invoice version). Never required for record types that
// have no version concept of their own (Partner/Vendor/Campaign/Assignment/Content).
export const targetReferenceSchema = z
  .object({
    targetType: targetTypeSchema,
    targetRef: opaqueRefSchema,
    targetVersion: z.number().int().min(1).nullable().optional().default(null),
  })
  .strict();
export type TargetReference = z.infer<typeof targetReferenceSchema>;
