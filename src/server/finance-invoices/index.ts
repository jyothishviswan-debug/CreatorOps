// Step 16A: the public service surface of the Finance Invoices core.
//
// Routes import from here; internals (Firestore helpers, the gate, the reconciliation engine, the
// Payable-source resolver, the document-storage port) stay module-private. The HTTP mapper stays in
// ./http (it imports next/server; the services must stay importable without it).
//
// Deliberately NOT here, and deliberately not implemented anywhere in this module: Payments. An
// Invoice's APPROVED state pins the exact immutable version a future Payments module consumes (see
// getInvoicePaymentHandoff), and that is the whole extent of the forward coupling.
export {
  attachInvoiceDocument,
  createInvoiceDraft,
  getInvoice,
  listInvoiceEvents,
  previewInvoiceEligibility,
  reconcileInvoice,
  reviseInvoiceDraft,
  type CreateInvoiceOutcome,
  type PreviewInvoiceEligibilityDto,
} from "./invoice-service";
export {
  acceptInvoiceMismatch,
  approveInvoice,
  getInvoicePaymentHandoff,
  getInvoiceSourceRevision,
  INVOICE_NOT_READY_CODES,
  rejectInvoice,
  reopenInvoice,
  submitInvoice,
  voidInvoice,
  type InvoicePaymentHandoffDto,
  type InvoiceSourceRevisionDto,
} from "./invoice-lifecycle-service";
export { listInvoicesWorkspace, INVOICE_HEAD_SCAN_CEILING } from "./invoice-workspace-service";
export { computeInvoicePermissions } from "./invoice-permissions";
export { previewInvoiceExtraction } from "./extraction-preview-service";
export type {
  InvoiceDetailDto,
  InvoiceDocumentDto,
  InvoiceEventDto,
  InvoiceExtractedFieldProposalDto,
  InvoiceExtractionPreviewDto,
  InvoiceHeadDto,
  InvoicePayablePinDto,
  InvoicePermissionsDto,
  InvoiceRowDto,
  InvoiceTaxLineDto,
  InvoiceVersionDto,
  InvoiceVersionSummaryDto,
  InvoiceWorkspaceDto,
} from "./client-dto";
export type { InvoiceExtractedFieldKey, InvoiceExtractionConfidence, InvoiceExtractionReasonCode, InvoiceExtractionStatus } from "./extraction/types";
export {
  INVOICE_COUNTERPARTY_TYPES,
  INVOICE_RECONCILIATION_CODES,
  INVOICE_RECONCILIATION_STATES,
  INVOICE_STATUSES,
  type FinanceInvoicesServiceResult,
  type InvoiceCounterpartyType,
  type InvoiceReconciliationCode,
  type InvoiceReconciliationState,
  type InvoiceSourceCurrencyState,
  type InvoiceStatus,
} from "./types";
