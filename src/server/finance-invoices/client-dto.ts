import type { InvoiceExtractedFieldKey, InvoiceExtractionConfidence, InvoiceExtractionReasonCode, InvoiceExtractionStatus } from "./extraction/types";
import { redactInvoiceEventMetadata } from "./invoice-events";
import type {
  CommercialPeriod,
  InvoiceCounterpartyType,
  InvoiceDocumentRef,
  InvoiceEvent,
  InvoiceEventKind,
  InvoiceHeadDoc,
  InvoiceMismatchOverride,
  InvoicePayablePin,
  InvoiceReconciliationResult,
  InvoiceStatus,
  InvoiceTaxLine,
  InvoiceVersionChangeKind,
  InvoiceVersionDoc,
} from "./types";

// The only shapes of an Invoice ever handed to the browser:
//   - opaque refs only (invoiceRef, payableRef, counterpartyRef, agreementRef, reviewRef,
//     documentId, userRefs) - never a Firebase uid, and never any scope-snapshot field (ownerUid /
//     regionIds / teamIds / partnerUid / vendorUid stay server-side);
//   - no restricted identity value or status, no KYC, no raw Agreement clause text, no signed Drive
//     URL, no secret;
//   - every MONEY figure is withheld (null) unless the caller has verified the `finance_amounts`
//     sensitive category and passes amountsVisible - identical discipline to Payables' own
//     client-dto.ts. A reconciliation finding's MESSAGE never embeds a literal figure (see
//     reconciliation.ts), so the reconciliation STATE and its findings are always visible even
//     without amounts access (the same "state visible, figures withheld" shape Payables' own
//     determination uses).
// Every builder is an explicit field-by-field copy, so a field added to a stored document can never
// reach the browser by accident. A static test walks these DTOs for forbidden keys.

export type InvoiceAmountDto = number | null;

export type InvoiceTaxLineDto = { label: string; ratePercentBasisPoints: number | null; amountMinor: InvoiceAmountDto };

export type InvoicePayablePinDto = {
  payableRef: string;
  payableVersion: number;
  counterpartyType: InvoiceCounterpartyType;
  counterpartyRef: string;
  agreementRef: string;
  agreementVersion: number;
  reviewRef: string | null;
  reviewVersion: number | null;
  commercialPeriod: CommercialPeriod;
  payableCurrency: string;
  // Step 15C: the five distinct tax/proration totals, plus the full payout sum kept as read-only
  // context. The Invoice reconciles against payableGrossInvoiceExpectedMinor specifically - never
  // payableExpectedNetPaymentMinor (TDS is payment treatment, not part of the supplier's Invoice).
  payableTotalAmountMinorSigned: InvoiceAmountDto;
  payableServiceBaseMinor: InvoiceAmountDto;
  payableGstMinor: InvoiceAmountDto;
  payableGrossInvoiceExpectedMinor: InvoiceAmountDto;
  payableTdsMinor: InvoiceAmountDto;
  payableExpectedNetPaymentMinor: InvoiceAmountDto;
  payableCalculationRuleVersion: string;
};

export type InvoiceDocumentDto = { documentId: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string; storedAt: string; storedByUserRef: string };

export type InvoiceMismatchOverrideDto = { forVersion: number; reason: string; actorUserRef: string; at: string };

export type InvoiceVersionDto = {
  version: number;
  changeKind: InvoiceVersionChangeKind;
  reason: string | null;
  payablePin: InvoicePayablePinDto;
  externalInvoiceNumber: string | null;
  invoiceDate: string | null;
  receivedDate: string | null;
  currency: string | null;
  subtotalMinor: InvoiceAmountDto;
  taxLines: InvoiceTaxLineDto[];
  declaredTotalMinor: InvoiceAmountDto;
  dueDate: string | null;
  document: InvoiceDocumentDto | null;
  reconciliation: InvoiceReconciliationResult;
  createdAt: string;
  createdByUserRef: string;
};

export type InvoiceVersionSummaryDto = {
  version: number;
  changeKind: InvoiceVersionChangeKind;
  reason: string | null;
  externalInvoiceNumber: string | null;
  currency: string | null;
  declaredTotalMinor: InvoiceAmountDto;
  reconciliationState: InvoiceReconciliationResult["state"];
  createdAt: string;
  createdByUserRef: string;
};

export type InvoiceHeadDto = {
  invoiceRef: string;
  payableRef: string;
  counterparty: { type: InvoiceCounterpartyType; ref: string; displayName: string | null };
  commercialPeriod: { periodKey: string; periodStart: string; periodEnd: string };
  currency: string | null;
  externalInvoiceNumber: string | null;
  status: InvoiceStatus;
  latestVersion: number;
  submittedVersion: number | null;
  submittedAt: string | null;
  submittedByUserRef: string | null;
  approvedVersion: number | null;
  approvedAt: string | null;
  approvedByUserRef: string | null;
  rejectedVersion: number | null;
  rejectedAt: string | null;
  rejectedByUserRef: string | null;
  rejectionReason: string | null;
  voidedAt: string | null;
  voidedByUserRef: string | null;
  voidReason: string | null;
  mismatchOverride: InvoiceMismatchOverrideDto | null;
  docVersion: number;
  declaredTotalMinor: InvoiceAmountDto;
  reconciliationState: InvoiceReconciliationResult["state"];
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

export type InvoiceDetailDto = {
  head: InvoiceHeadDto;
  versions: InvoiceVersionSummaryDto[];
  hasMoreVersions: boolean;
  selectedVersion: InvoiceVersionDto | null;
  // false = every money figure in this response is withheld (null), not zero.
  amountsVisible: boolean;
};

export type InvoiceEventDto = { kind: InvoiceEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

export type InvoiceRowDto = {
  invoiceRef: string;
  payableRef: string;
  counterparty: { type: InvoiceCounterpartyType; ref: string; displayName: string | null };
  commercialPeriod: string;
  currency: string | null;
  status: InvoiceStatus;
  externalInvoiceNumber: string | null;
  declaredTotalMinor: InvoiceAmountDto;
  reconciliationState: InvoiceReconciliationResult["state"];
  latestVersion: number;
  lastUpdatedAt: string;
};

export type InvoicePermissionsDto = { canView: boolean; canManage: boolean; canApprove: boolean; canVoid: boolean; canOverrideMismatch: boolean; canViewAmounts: boolean };

export type InvoiceWorkspaceDto = {
  rows: InvoiceRowDto[];
  nextCursor: string | null;
  offset: number;
  pageSize: number;
  totalInBoundedSet: number;
  disclosure: { headsRead: number; headsTruncated: boolean; scanLimit: number };
  notices: string[];
  permissions: InvoicePermissionsDto;
};

type AmountOptions = { amountsVisible: boolean };

function amount(value: number, options: AmountOptions): InvoiceAmountDto {
  return options.amountsVisible ? value : null;
}

function nullableAmount(value: number | null, options: AmountOptions): InvoiceAmountDto {
  return options.amountsVisible ? value : null;
}

export function toInvoiceTaxLineDto(line: InvoiceTaxLine, options: AmountOptions): InvoiceTaxLineDto {
  return { label: line.label, ratePercentBasisPoints: line.ratePercentBasisPoints, amountMinor: amount(line.amountMinor, options) };
}

export function toInvoicePayablePinDto(pin: InvoicePayablePin, options: AmountOptions): InvoicePayablePinDto {
  return {
    payableRef: pin.payableRef,
    payableVersion: pin.payableVersion,
    counterpartyType: pin.counterpartyType,
    counterpartyRef: pin.counterpartyRef,
    agreementRef: pin.agreementRef,
    agreementVersion: pin.agreementVersion,
    reviewRef: pin.reviewRef,
    reviewVersion: pin.reviewVersion,
    commercialPeriod: { ...pin.commercialPeriod },
    payableCurrency: pin.payableCurrency,
    payableTotalAmountMinorSigned: amount(pin.payableTotalAmountMinorSigned, options),
    payableServiceBaseMinor: nullableAmount(pin.payableServiceBaseMinor, options),
    payableGstMinor: amount(pin.payableGstMinor, options),
    payableGrossInvoiceExpectedMinor: nullableAmount(pin.payableGrossInvoiceExpectedMinor, options),
    payableTdsMinor: amount(pin.payableTdsMinor, options),
    payableExpectedNetPaymentMinor: nullableAmount(pin.payableExpectedNetPaymentMinor, options),
    payableCalculationRuleVersion: pin.payableCalculationRuleVersion,
  };
}

export function toInvoiceDocumentDto(document: InvoiceDocumentRef): InvoiceDocumentDto {
  return { documentId: document.documentId, fileName: document.fileName, mimeType: document.mimeType, sizeBytes: document.sizeBytes, sha256: document.sha256, storedAt: document.storedAt, storedByUserRef: document.storedByUserRef };
}

export function toInvoiceMismatchOverrideDto(override: InvoiceMismatchOverride): InvoiceMismatchOverrideDto {
  return { forVersion: override.forVersion, reason: override.reason, actorUserRef: override.actorUserRef, at: override.at };
}

export function toInvoiceVersionDto(doc: InvoiceVersionDoc, options: AmountOptions): InvoiceVersionDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    payablePin: toInvoicePayablePinDto(doc.payablePin, options),
    externalInvoiceNumber: doc.externalInvoiceNumber,
    invoiceDate: doc.invoiceDate,
    receivedDate: doc.receivedDate,
    currency: doc.currency,
    subtotalMinor: nullableAmount(doc.subtotalMinor, options),
    taxLines: doc.taxLines.map((line) => toInvoiceTaxLineDto(line, options)),
    declaredTotalMinor: nullableAmount(doc.declaredTotalMinor, options),
    dueDate: doc.dueDate,
    document: doc.document ? toInvoiceDocumentDto(doc.document) : null,
    reconciliation: { state: doc.reconciliation.state, findings: doc.reconciliation.findings.map((finding) => ({ ...finding })), computedAt: doc.reconciliation.computedAt },
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toInvoiceVersionSummaryDto(doc: InvoiceVersionDoc, options: AmountOptions): InvoiceVersionSummaryDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    externalInvoiceNumber: doc.externalInvoiceNumber,
    currency: doc.currency,
    declaredTotalMinor: nullableAmount(doc.declaredTotalMinor, options),
    reconciliationState: doc.reconciliation.state,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toInvoiceHeadDto(head: InvoiceHeadDoc, displayName: string | null, options: AmountOptions): InvoiceHeadDto {
  return {
    invoiceRef: head.invoiceRef,
    payableRef: head.payableRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    commercialPeriod: { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd },
    currency: head.currency,
    externalInvoiceNumber: head.externalInvoiceNumber,
    status: head.status,
    latestVersion: head.latestVersion,
    submittedVersion: head.submittedVersion,
    submittedAt: head.submittedAt,
    submittedByUserRef: head.submittedByUserRef,
    approvedVersion: head.approvedVersion,
    approvedAt: head.approvedAt,
    approvedByUserRef: head.approvedByUserRef,
    rejectedVersion: head.rejectedVersion,
    rejectedAt: head.rejectedAt,
    rejectedByUserRef: head.rejectedByUserRef,
    rejectionReason: head.rejectionReason,
    voidedAt: head.voidedAt,
    voidedByUserRef: head.voidedByUserRef,
    voidReason: head.voidReason,
    mismatchOverride: head.mismatchOverride ? toInvoiceMismatchOverrideDto(head.mismatchOverride) : null,
    docVersion: head.docVersion,
    declaredTotalMinor: nullableAmount(head.display.declaredTotalMinor, options),
    reconciliationState: head.display.reconciliationState,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
  };
}

export function toInvoiceRowDto(head: InvoiceHeadDoc, displayName: string | null, options: AmountOptions): InvoiceRowDto {
  return {
    invoiceRef: head.invoiceRef,
    payableRef: head.payableRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    commercialPeriod: head.periodKey,
    currency: head.currency,
    status: head.status,
    externalInvoiceNumber: head.externalInvoiceNumber,
    declaredTotalMinor: nullableAmount(head.display.declaredTotalMinor, options),
    reconciliationState: head.display.reconciliationState,
    latestVersion: head.latestVersion,
    lastUpdatedAt: head.updatedAt,
  };
}

// Metadata is re-screened through the allowlist redactor on the way OUT as well.
export function toInvoiceEventDto(event: InvoiceEvent): InvoiceEventDto {
  return { kind: event.kind, version: event.version, actorUserRef: event.actorUserRef, metadata: redactInvoiceEventMetadata(event.metadata), createdAt: event.createdAt };
}

// --- Extraction preview (Step 15C section 24/26) --------------------------------------------------------------------------------
// Every field is a PROPOSAL, never confirmed here - the same "requiresHumanConfirmation always
// true" discipline as extraction/types.ts itself. Deliberately excludes `rawSnippet` (section 28:
// "do not store large raw contract/document snippets in normal client-visible state") - a
// restricted field (today: only gstin) already carries `value: null` from the pure extractor, so
// no further gating is needed here, but the DTO copy is still explicit field-by-field, matching
// this file's own "nothing reaches the browser by accident" rule.
export type InvoiceExtractedFieldProposalDto = {
  fieldKey: InvoiceExtractedFieldKey;
  value: string | number | null;
  page: number;
  confidence: InvoiceExtractionConfidence;
  warnings: string[];
  restricted: boolean;
};

export type InvoiceExtractionPreviewDto = {
  status: InvoiceExtractionStatus;
  reasons: InvoiceExtractionReasonCode[];
  fields: InvoiceExtractedFieldProposalDto[];
};

export function toInvoiceExtractionPreviewDto(result: {
  classification: { status: InvoiceExtractionStatus; reasons: InvoiceExtractionReasonCode[] };
  fields: Array<{ fieldKey: InvoiceExtractedFieldKey; value: string | number | null; page: number; confidence: InvoiceExtractionConfidence; warnings: string[]; restricted: boolean }>;
}): InvoiceExtractionPreviewDto {
  return {
    status: result.classification.status,
    reasons: [...result.classification.reasons],
    fields: result.fields.map((field) => ({ fieldKey: field.fieldKey, value: field.value, page: field.page, confidence: field.confidence, warnings: [...field.warnings], restricted: field.restricted })),
  };
}
