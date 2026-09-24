import { z } from "zod";

// Step 18A section 6: the Approval Queue's own projection shape - a DERIVED READ MODEL, never a
// second approval engine. Every field here is either (a) copied verbatim from the source module's
// own already-safe DTO (never a raw Firestore doc), or (b) computed purely from the actor's OWN
// grants (allowedActions). There is deliberately NO persisted document behind this type - it is
// built fresh, on every read, from a live call into the source module's own published contract (see
// ./adapters/*). Nothing in this file, or anywhere in approval-queue-service.ts, ever writes an
// "approval status" of its own; grep the module for `status` and every hit is either
// `currentSourceStatus` (read straight through from the source) or a TypeScript type name.

export const APPROVAL_SOURCE_MODULES = ["partner_reviews", "finance_payables", "finance_invoices", "finance_payments"] as const;
export const approvalSourceModuleSchema = z.enum(APPROVAL_SOURCE_MODULES);
export type ApprovalSourceModule = z.infer<typeof approvalSourceModuleSchema>;

export const APPROVAL_ACTION_TYPES = [
  "FINALIZE_PARTNER_REVIEW",
  "RESOLVE_PAYABLE_FINANCE_REVIEW",
  "APPROVE_OR_REJECT_INVOICE",
  "CONFIRM_PAYMENT",
] as const;
export const approvalActionTypeSchema = z.enum(APPROVAL_ACTION_TYPES);
export type ApprovalActionType = z.infer<typeof approvalActionTypeSchema>;

// Section 6's own conceptual projection, realized as the actual DTO. `sourceVersion` is always the
// exact version/count the pending decision is about (an IN_REVIEW review's latestVersion, a DRAFT
// payable's latestVersion, a SUBMITTED invoice's latestVersion, a RECORDED payment's latestVersion)
// - the same "pin the exact version a decision is about" discipline Payments' own invoicePin uses.
// `allowedActions` is always empty in Step 18A (see approval-queue-service.ts's own comment) - kept
// as a typed array now so Step 18B's routed actions are additive, never a breaking shape change.
export type ApprovalItemDto = {
  approvalItemRef: string;
  sourceModule: ApprovalSourceModule;
  sourceType: string;
  sourceRef: string;
  sourceVersion: number;
  actionType: ApprovalActionType;
  title: string;
  summary: string;
  requestedBy: string | null;
  // Resolved by the adapter that sets `requestedBy` (a safe users/{uid} displayName lookup, same
  // discipline as TaskDto.assigneeDisplayName) - null whenever requestedBy itself is null, or the
  // lookup fails.
  requestedByDisplayName: string | null;
  requestedAt: string | null;
  currentSourceStatus: string;
  allowedActions: string[];
  safeDisplayData: Record<string, string | number | boolean | null>;
};

export type ApprovalQueueListDto = { items: ApprovalItemDto[]; scanned: { partnerReviews: number; payables: number; invoices: number; payments: number }; notices: string[] };
