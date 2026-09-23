import { redactPayableEventMetadata } from "./payable-events";
import type { PayableSourceBlocker } from "./source-evidence";
import type {
  PayableCounterpartyType,
  PayableDeterminationState,
  PayableEvent,
  PayableEventKind,
  PayableHeadDoc,
  PayableLine,
  PayableLineCategory,
  PayableLineSource,
  PayableReviewCode,
  PayableSourceCurrencyState,
  PayableSourceSnapshot,
  PayableSourceType,
  PayableStatus,
  PayableUnresolvedItem,
  PayableVersionChangeKind,
  PayableVersionDoc,
} from "./types";

// The only shapes of a Payable ever handed to the browser:
//   - opaque refs only (payableRef, counterpartyRef, agreementRef, reviewRef, lineRef, userRefs) -
//     never a Firebase uid, and never any scope-snapshot field (ownerUid / regionIds / teamIds /
//     partnerUid / vendorUid stay server-side);
//   - no restricted identity value or status, no KYC, and no raw Agreement clause text;
//   - no Campaign / Assignment / Content / Analytics record identifier (the finalized Review
//     handoff this is built from carries none by contract);
//   - every MONEY figure is withheld (null) unless the caller has verified the `finance_amounts`
//     sensitive category and passes amountsVisible - this file only shapes the result, the
//     category check is the service's job.
// Every builder is an explicit field-by-field copy, so a field added to a stored document can
// never reach the browser by accident. A static test walks these DTOs for forbidden keys.

export type PayableAmountDto = number | null;

export type PayableLineDto = {
  lineRef: string;
  label: string;
  category: PayableLineCategory;
  amountMinorSigned: PayableAmountDto;
  source: PayableLineSource;
  sourceRef: string | null;
  reason: string;
  actorUserRef: string | null;
  actorAt: string | null;
  resolvesCode: PayableReviewCode | null;
};

export type PayableSnapshotDto = Omit<PayableSourceSnapshot, "fixedComponent" | "accountTransferFee" | "advancePayment" | "incentive"> & {
  fixedComponent: { applicable: boolean; amountMinor: PayableAmountDto } | null;
  accountTransferFee: { applicable: boolean; amountMinor: PayableAmountDto; details: string | null } | null;
  advancePayment: { applicable: boolean; amountMinor: PayableAmountDto; details: string | null } | null;
  incentive: { applicable: boolean; narrative: string | null; slabs: Array<{ slabRef: string; metricId: string; lowerBound: number; upperBound: number | null; unit: string; amountMinor: PayableAmountDto }> } | null;
};

export type PayableVersionDto = {
  version: number;
  changeKind: PayableVersionChangeKind;
  reason: string | null;
  currency: string;
  totalAmountMinorSigned: PayableAmountDto;
  determinationState: PayableDeterminationState;
  unresolved: PayableUnresolvedItem[];
  openReviewCodes: PayableReviewCode[];
  warnings: string[];
  lines: PayableLineDto[];
  snapshot: PayableSnapshotDto;
  createdAt: string;
  createdByUserRef: string;
};

export type PayableVersionSummaryDto = {
  version: number;
  changeKind: PayableVersionChangeKind;
  reason: string | null;
  currency: string;
  totalAmountMinorSigned: PayableAmountDto;
  determinationState: PayableDeterminationState;
  openReviewCodes: PayableReviewCode[];
  lineCount: number;
  agreementRef: string;
  agreementVersion: number;
  reviewRef: string | null;
  reviewVersion: number | null;
  createdAt: string;
  createdByUserRef: string;
};

export type PayableHeadDto = {
  payableRef: string;
  counterparty: { type: PayableCounterpartyType; ref: string; displayName: string | null };
  commercialPeriod: { periodKey: string; periodStart: string; periodEnd: string };
  currency: string;
  status: PayableStatus;
  sourceType: PayableSourceType;
  agreementRef: string;
  agreementVersion: number;
  reviewRef: string | null;
  reviewVersion: number | null;
  latestVersion: number;
  readyVersion: number | null;
  readyAt: string | null;
  readyByUserRef: string | null;
  voidedAt: string | null;
  voidedByUserRef: string | null;
  voidReason: string | null;
  docVersion: number;
  totalAmountMinorSigned: PayableAmountDto;
  determinationState: PayableDeterminationState;
  openReviewCount: number;
  createdAt: string;
  createdByUserRef: string;
  updatedAt: string;
  updatedByUserRef: string;
};

export type PayableDetailDto = {
  head: PayableHeadDto;
  versions: PayableVersionSummaryDto[];
  hasMoreVersions: boolean;
  selectedVersion: PayableVersionDto | null;
  // false = every money figure in this response is withheld (null), not zero.
  amountsVisible: boolean;
};

export type PayableEventDto = { kind: PayableEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

export type PayableSourcePreviewDto = {
  counterparty: { type: PayableCounterpartyType; ref: string; displayName: string | null };
  commercialPeriod: { periodKey: string; periodStart: string; periodEnd: string };
  sourceType: PayableSourceType | null;
  agreementRef: string | null;
  agreementVersion: number | null;
  reviewRef: string | null;
  reviewVersion: number | null;
  // Present only when the evidence resolves; null when generation is blocked.
  snapshot: PayableSnapshotDto | null;
  determinationState: PayableDeterminationState;
  unresolved: PayableUnresolvedItem[];
  blockers: PayableSourceBlocker[];
  warnings: string[];
  lines: PayableLineDto[];
  totalAmountMinorSigned: PayableAmountDto;
  currency: string | null;
  amountsVisible: boolean;
  // An existing canonical Payable already covers this commercial basis.
  existingPayableRef: string | null;
};

export type PayableSourceRevisionDto = {
  payableRef: string;
  state: PayableSourceCurrencyState;
  message: string;
  pinned: { agreementRef: string; agreementVersion: number; reviewRef: string | null; reviewVersion: number | null };
  current: { agreementRef: string; agreementVersion: number; reviewRef: string | null; reviewVersion: number | null } | null;
};

export type PayableRowDto = {
  payableRef: string;
  counterparty: { type: PayableCounterpartyType; ref: string; displayName: string | null };
  commercialPeriod: string;
  currency: string;
  status: PayableStatus;
  sourceType: PayableSourceType;
  totalAmountMinorSigned: PayableAmountDto;
  determinationState: PayableDeterminationState;
  openReviewCount: number;
  latestVersion: number;
  readyVersion: number | null;
  lastUpdatedAt: string;
};

export type PayablePermissionsDto = {
  canView: boolean;
  canManage: boolean;
  canApprove: boolean;
  canAdjust: boolean;
  canVoid: boolean;
  canViewAmounts: boolean;
};

export type PayableWorkspaceDto = {
  rows: PayableRowDto[];
  nextCursor: string | null;
  offset: number;
  pageSize: number;
  totalInBoundedSet: number;
  disclosure: { headsRead: number; headsTruncated: boolean; scanLimit: number };
  notices: string[];
  permissions: PayablePermissionsDto;
};

type AmountOptions = { amountsVisible: boolean };

function amount(value: number, options: AmountOptions): PayableAmountDto {
  return options.amountsVisible ? value : null;
}

function nullableAmount(value: number | null, options: AmountOptions): PayableAmountDto {
  return options.amountsVisible ? value : null;
}

export function toPayableLineDto(line: PayableLine, options: AmountOptions): PayableLineDto {
  return {
    lineRef: line.lineRef,
    label: line.label,
    category: line.category,
    amountMinorSigned: amount(line.amountMinorSigned, options),
    source: line.source,
    sourceRef: line.sourceRef,
    reason: line.reason,
    actorUserRef: line.actor?.userRef ?? null,
    actorAt: line.actor?.at ?? null,
    resolvesCode: line.resolvesCode as PayableReviewCode | null,
  };
}

// An explicit copy: every figure of the immutable snapshot passes through the amount gate, and
// nothing that is not listed here can reach the browser.
export function toPayableSnapshotDto(snapshot: PayableSourceSnapshot, options: AmountOptions): PayableSnapshotDto {
  return {
    schemaVersion: snapshot.schemaVersion,
    counterparty: { ...snapshot.counterparty },
    commercialPeriod: { ...snapshot.commercialPeriod },
    sourceType: snapshot.sourceType,
    agreement: { ...snapshot.agreement },
    review: snapshot.review ? { ...snapshot.review } : null,
    currency: snapshot.currency,
    qualifyingContent: snapshot.qualifyingContent ? { ...snapshot.qualifyingContent } : null,
    lfcSfc: snapshot.lfcSfc ? { ...snapshot.lfcSfc } : null,
    contentObligations: snapshot.contentObligations.map((obligation) => ({ ...obligation })),
    fixedComponent: snapshot.fixedComponent ? { applicable: snapshot.fixedComponent.applicable, amountMinor: nullableAmount(snapshot.fixedComponent.amountMinor, options) } : null,
    accountTransferFee: snapshot.accountTransferFee
      ? { applicable: snapshot.accountTransferFee.applicable, amountMinor: nullableAmount(snapshot.accountTransferFee.amountMinor, options), details: snapshot.accountTransferFee.details }
      : null,
    advancePayment: snapshot.advancePayment ? { applicable: snapshot.advancePayment.applicable, amountMinor: nullableAmount(snapshot.advancePayment.amountMinor, options), details: snapshot.advancePayment.details } : null,
    incentive: snapshot.incentive
      ? {
          applicable: snapshot.incentive.applicable,
          narrative: snapshot.incentive.narrative,
          slabs: snapshot.incentive.slabs.map((slab) => ({ slabRef: slab.slabRef, metricId: slab.metricId, lowerBound: slab.lowerBound, upperBound: slab.upperBound, unit: slab.unit, amountMinor: amount(slab.amountMinor, options) })),
        }
      : null,
    paymentTerms: { ...snapshot.paymentTerms },
    performanceTargets: snapshot.performanceTargets.map((target) => ({ ...target })),
    warnings: [...snapshot.warnings],
    capturedAt: snapshot.capturedAt,
  };
}

export function toPayableVersionDto(doc: PayableVersionDoc, options: AmountOptions): PayableVersionDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    currency: doc.currency,
    totalAmountMinorSigned: amount(doc.totalAmountMinorSigned, options),
    determinationState: doc.determination.state,
    unresolved: doc.determination.unresolved.map((item) => ({ ...item })),
    openReviewCodes: [...doc.openReviewCodes],
    warnings: [...doc.determination.warnings],
    lines: doc.lines.map((line) => toPayableLineDto(line, options)),
    snapshot: toPayableSnapshotDto(doc.snapshot, options),
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toPayableVersionSummaryDto(doc: PayableVersionDoc, options: AmountOptions): PayableVersionSummaryDto {
  return {
    version: doc.version,
    changeKind: doc.changeKind,
    reason: doc.reason,
    currency: doc.currency,
    totalAmountMinorSigned: amount(doc.totalAmountMinorSigned, options),
    determinationState: doc.determination.state,
    openReviewCodes: [...doc.openReviewCodes],
    lineCount: doc.lines.length,
    agreementRef: doc.snapshot.agreement.agreementRef,
    agreementVersion: doc.snapshot.agreement.agreementVersion,
    reviewRef: doc.snapshot.review?.reviewRef ?? null,
    reviewVersion: doc.snapshot.review?.reviewVersion ?? null,
    createdAt: doc.createdAt,
    createdByUserRef: doc.createdByUserRef,
  };
}

export function toPayableHeadDto(head: PayableHeadDoc, displayName: string | null, options: AmountOptions): PayableHeadDto {
  return {
    payableRef: head.payableRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    commercialPeriod: { periodKey: head.periodKey, periodStart: head.periodStart, periodEnd: head.periodEnd },
    currency: head.currency,
    status: head.status,
    sourceType: head.sourceType,
    agreementRef: head.agreementRef,
    agreementVersion: head.agreementVersion,
    reviewRef: head.sourceReviewRef,
    reviewVersion: head.sourceReviewVersion,
    latestVersion: head.latestVersion,
    readyVersion: head.readyVersion,
    readyAt: head.readyAt,
    readyByUserRef: head.readyByUserRef,
    voidedAt: head.voidedAt,
    voidedByUserRef: head.voidedByUserRef,
    voidReason: head.voidReason,
    docVersion: head.docVersion,
    totalAmountMinorSigned: amount(head.display.totalAmountMinorSigned, options),
    determinationState: head.display.determinationState,
    openReviewCount: head.display.openReviewCount,
    createdAt: head.createdAt,
    createdByUserRef: head.createdByUserRef,
    updatedAt: head.updatedAt,
    updatedByUserRef: head.updatedByUserRef,
  };
}

export function toPayableRowDto(head: PayableHeadDoc, displayName: string | null, options: AmountOptions): PayableRowDto {
  return {
    payableRef: head.payableRef,
    counterparty: { type: head.counterpartyType, ref: head.counterpartyRef, displayName },
    commercialPeriod: head.periodKey,
    currency: head.currency,
    status: head.status,
    sourceType: head.sourceType,
    totalAmountMinorSigned: amount(head.display.totalAmountMinorSigned, options),
    determinationState: head.display.determinationState,
    openReviewCount: head.display.openReviewCount,
    latestVersion: head.latestVersion,
    readyVersion: head.readyVersion,
    lastUpdatedAt: head.updatedAt,
  };
}

// Metadata is re-screened through the allowlist redactor on the way OUT as well (an event written
// before a redactor change can never leak through a newer read path).
export function toPayableEventDto(event: PayableEvent): PayableEventDto {
  return { kind: event.kind, version: event.version, actorUserRef: event.actorUserRef, metadata: redactPayableEventMetadata(event.metadata), createdAt: event.createdAt };
}
