import { redactPaymentEventMetadata } from "./payment-events";
import type { PaymentSettlementSummary } from "./settlement-calculator";
import type {
  CommercialPeriod,
  PaymentCounterpartyType,
  PaymentEvent,
  PaymentEventKind,
  PaymentHeadDoc,
  PaymentInvoicePin,
  PaymentMethod,
  PaymentPayeeIdentitySnapshot,
  PaymentStatus,
  PaymentVersionChangeKind,
  PaymentVersionDoc,
} from "./types";

// The only shapes of a Payment ever handed to the browser:
//   - opaque refs only (paymentRef, invoiceRef, payableRef, counterpartyRef, userRefs) - never a
//     Firebase uid, and never any scope-snapshot field (ownerUid / regionIds / teamIds /
//     partnerUid / vendorUid stay server-side);
//   - no raw bank account data, no PAN/Aadhaar/GSTIN, no KYC payload, no Google Drive locator -
//     only the already-masked payee-identity projection built once by the Invoice module;
//   - every MONEY figure is withheld (null) unless the caller has verified the `finance_amounts`
//     sensitive category and passes amountsVisible - identical discipline to Payables'/Invoices'
//     own client-dto.ts.
// Every builder is an explicit field-by-field copy, so a field added to a stored document can
// never reach the browser by accident. A static test walks these DTOs for forbidden keys.

export type PaymentAmountDto = number | null;

export type PaymentInvoicePinDto = {
  invoiceRef: string;
  invoiceVersion: number;
  payableRef: string;
  payableVersion: number;
  counterpartyType: PaymentCounterpartyType;
  counterpartyRef: string;
  commercialPeriod: CommercialPeriod;
  currency: string;
  expectedNetPaymentMinor: PaymentAmountDto;
};

export type PaymentPayeeIdentityDto = {
  overallStatusAtApproval: string | null;
  bankSafeDisplay: string | null;
  resolution: { reason: string; actorUserRef: string; at: string } | null;
  comparedAt: string | null;
};

export type PaymentVersionDto = {
  version: number;
  changeKind: PaymentVersionChangeKind;
  reason: string | null;
  invoicePin: PaymentInvoicePinDto;
  payeeIdentity: PaymentPayeeIdentityDto;
  amountMinor: PaymentAmountDto;
  paymentDate: string | null;
  method: PaymentMethod | null;
  externalReference: string | null;
  memo: string | null;
  createdAt: string;
  createdByUserRef: string;
};

export type PaymentVersionSummaryDto = {
  version: number;
  changeKind: PaymentVersionChangeKind;
  reason: string | null;
  amountMinor: PaymentAmountDto;
  method: PaymentMethod | null;
  paymentDate: string | null;
  createdAt: string;
  createdByUserRef: string;
};

export type PaymentHeadDto = {
  paymentRef: string;
  invoiceRef: string;
  payableRef: string;
  counterparty: { type: PaymentCounterpartyType; ref: string; displayName: string | null };
  currency: string;
  status: PaymentStatus;
  latestVersion: number;
  recordedVersion: number | null;
  recordedAt: string | null;
  recordedByUserRef: string | null;
  confirmedVersion: number | null;
  confirmedAt: string | null;
  confirmedByUserRef: string | null;
  confirmedReversedAt: string | null;
  confirmedReversedByUserRef: string | null;
  failedVersion: number | null;
  failedAt: string | null;
  failedByUserRef: string | null;
  failedReason: string | null;
  voidedAt: string | null;
  voidedByUserRef: string | null;
  voidReason: string | null;
  overageOverride: { forVersion: number; reason: string; actorUserRef: string; at: string } | null;
  docVersion: number;
  amountMinor: PaymentAmountDto;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

export type PaymentDetailDto = {
  head: PaymentHeadDto;
  versions: PaymentVersionSummaryDto[];
  hasMoreVersions: boolean;
  selectedVersion: PaymentVersionDto | null;
  amountsVisible: boolean;
};

export type PaymentEventDto = { kind: PaymentEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

export type PaymentRowDto = {
  paymentRef: string;
  invoiceRef: string;
  counterparty: { type: PaymentCounterpartyType; ref: string; displayName: string | null };
  currency: string;
  status: PaymentStatus;
  amountMinor: PaymentAmountDto;
  method: PaymentMethod | null;
  latestVersion: number;
  lastUpdatedAt: string;
};

export type PaymentPermissionsDto = {
  canView: boolean;
  canManage: boolean;
  canConfirm: boolean;
  canVoid: boolean;
  canOverrideOverage: boolean;
  canViewAmounts: boolean;
};

export type PaymentWorkspaceDto = {
  rows: PaymentRowDto[];
  nextCursor: string | null;
  disclosure: { headsRead: number; headsTruncated: boolean; scanLimit: number };
  notices: string[];
  permissions: PaymentPermissionsDto;
};

// The Invoice-facing settlement READ MODEL (section 13/17): never mutates the Invoice, sourced
// purely from this module's own bounded query plus the pure settlement calculator.
export type InvoicePaymentSettlementDto = {
  invoiceRef: string;
  currency: string | null;
  amountsVisible: boolean;
  summary: {
    expectedNetPaymentMinor: PaymentAmountDto;
    confirmedPaidMinor: PaymentAmountDto;
    recordedPendingMinor: PaymentAmountDto;
    failedMinor: PaymentAmountDto;
    remainingMinor: PaymentAmountDto;
    overpaidByMinor: PaymentAmountDto;
    state: PaymentSettlementSummary["state"];
    warnings: string[];
  };
  payments: PaymentRowDto[];
};

type AmountOptions = { amountsVisible: boolean };

function amount(value: number, options: AmountOptions): PaymentAmountDto {
  return options.amountsVisible ? value : null;
}
function nullableAmount(value: number | null, options: AmountOptions): PaymentAmountDto {
  return options.amountsVisible ? value : null;
}

export function toPaymentInvoicePinDto(pin: PaymentInvoicePin, options: AmountOptions): PaymentInvoicePinDto {
  return {
    invoiceRef: pin.invoiceRef,
    invoiceVersion: pin.invoiceVersion,
    payableRef: pin.payableRef,
    payableVersion: pin.payableVersion,
    counterpartyType: pin.counterpartyType,
    counterpartyRef: pin.counterpartyRef,
    commercialPeriod: { ...pin.commercialPeriod },
    currency: pin.currency,
    expectedNetPaymentMinor: amount(pin.expectedNetPaymentMinor, options),
  };
}

export function toPaymentPayeeIdentityDto(snapshot: PaymentPayeeIdentitySnapshot): PaymentPayeeIdentityDto {
  return {
    overallStatusAtApproval: snapshot.overallStatusAtApproval,
    bankSafeDisplay: snapshot.bankSafeDisplay,
    resolution: snapshot.resolution ? { ...snapshot.resolution } : null,
    comparedAt: snapshot.comparedAt,
  };
}

export function toPaymentVersionDto(doc: PaymentVersionDoc, options: AmountOptions): PaymentVersionDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    invoicePin: toPaymentInvoicePinDto(doc.invoicePin, options),
    payeeIdentity: toPaymentPayeeIdentityDto(doc.payeeIdentity),
    amountMinor: nullableAmount(doc.amountMinor, options),
    paymentDate: doc.paymentDate,
    method: doc.method,
    externalReference: doc.externalReference,
    memo: doc.memo,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toPaymentVersionSummaryDto(doc: PaymentVersionDoc, options: AmountOptions): PaymentVersionSummaryDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    amountMinor: nullableAmount(doc.amountMinor, options),
    method: doc.method,
    paymentDate: doc.paymentDate,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toPaymentHeadDto(head: PaymentHeadDoc, displayName: string | null, options: AmountOptions): PaymentHeadDto {
  return {
    paymentRef: head.paymentRef,
    invoiceRef: head.invoiceRef,
    payableRef: head.payableRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    currency: head.currency,
    status: head.status,
    latestVersion: head.latestVersion,
    recordedVersion: head.recordedVersion,
    recordedAt: head.recordedAt,
    recordedByUserRef: head.recordedByUserRef,
    confirmedVersion: head.confirmedVersion,
    confirmedAt: head.confirmedAt,
    confirmedByUserRef: head.confirmedByUserRef,
    confirmedReversedAt: head.confirmedReversedAt,
    confirmedReversedByUserRef: head.confirmedReversedByUserRef,
    failedVersion: head.failedVersion,
    failedAt: head.failedAt,
    failedByUserRef: head.failedByUserRef,
    failedReason: head.failedReason,
    voidedAt: head.voidedAt,
    voidedByUserRef: head.voidedByUserRef,
    voidReason: head.voidReason,
    overageOverride: head.overageOverride ? { ...head.overageOverride } : null,
    docVersion: head.docVersion,
    amountMinor: nullableAmount(head.display.amountMinor, options),
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
  };
}

export function toPaymentRowDto(head: PaymentHeadDoc, displayName: string | null, method: PaymentMethod | null, options: AmountOptions): PaymentRowDto {
  return {
    paymentRef: head.paymentRef,
    invoiceRef: head.invoiceRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    currency: head.currency,
    status: head.status,
    amountMinor: nullableAmount(head.display.amountMinor, options),
    method,
    latestVersion: head.latestVersion,
    lastUpdatedAt: head.updatedAt,
  };
}

// Metadata is re-screened through the allowlist redactor on the way OUT as well.
export function toPaymentEventDto(event: PaymentEvent): PaymentEventDto {
  return { kind: event.kind, version: event.version, actorUserRef: event.actorUserRef, metadata: redactPaymentEventMetadata(event.metadata), createdAt: event.createdAt };
}
