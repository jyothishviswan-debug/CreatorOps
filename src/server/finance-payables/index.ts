// Step 15A: the public service surface of the Finance Payables core.
//
// Routes import from here; internals (Firestore helpers, the gate, the determination engine, the
// source-evidence resolver) stay module-private. The HTTP mapper stays in ./http (it imports
// next/server; the services must stay importable without it).
//
// Deliberately NOT here, and deliberately not implemented anywhere in this module: Invoices and
// Payments. A Payable's READY_FOR_INVOICE state pins the exact immutable version a future Invoice
// module will consume, and that is the whole extent of the forward coupling.
export { addPayableAdjustment, createPayable, getPayable, listPayableEvents, previewPayableSource, removePayableAdjustment, revisePayable, type CreatePayableOutcome } from "./payable-service";
export { getPayableSourceRevision, markPayableReadyForInvoice, PAYABLE_NOT_READY_CODES, voidPayable } from "./payable-lifecycle-service";
export { listPayablesWorkspace, PAYABLE_HEAD_SCAN_CEILING } from "./payable-workspace-service";
export { computePayablePermissions } from "./payable-permissions";
export type {
  PayableDetailDto,
  PayableEventDto,
  PayableHeadDto,
  PayableLineDto,
  PayablePermissionsDto,
  PayableRowDto,
  PayableSnapshotDto,
  PayableSourcePreviewDto,
  PayableSourceRevisionDto,
  PayableVersionDto,
  PayableVersionSummaryDto,
  PayableWorkspaceDto,
} from "./client-dto";
export {
  PAYABLE_BLOCKED_CODES,
  PAYABLE_COUNTERPARTY_TYPES,
  PAYABLE_DETERMINATION_STATES,
  PAYABLE_LINE_CATEGORIES,
  PAYABLE_REVIEW_CODES,
  PAYABLE_SOURCE_TYPES,
  PAYABLE_STATUSES,
  type FinancePayablesServiceResult,
  type PayableBlockedCode,
  type PayableCounterpartyType,
  type PayableDeterminationState,
  type PayableLineCategory,
  type PayableReviewCode,
  type PayableSourceCurrencyState,
  type PayableSourceType,
  type PayableStatus,
} from "./types";
