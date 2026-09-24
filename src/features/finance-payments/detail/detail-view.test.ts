import { describe, expect, it } from "vitest";

import type { InvoicePaymentSettlementDto, PaymentDetailDto, PaymentEventDto, PaymentHeadDto, PaymentPermissionsDto } from "@/server/finance-payments/client-dto";

import { detailActionVisibility, detailHeaderView, historyRows, paymentSourceRevisionState, relatedPaymentRows, settlementSummaryRows, settlementStateView, sourceInvoiceRows, summaryRows } from "./detail-view";

function head(overrides: Partial<PaymentHeadDto> = {}): PaymentHeadDto {
  return {
    paymentRef: "pmt_00000000000000000001",
    invoiceRef: "inv_00000000000000000001",
    payableRef: "pay_00000000000000000001",
    counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" },
    currency: "INR",
    status: "DRAFT",
    latestVersion: 1,
    recordedVersion: null,
    recordedAt: null,
    recordedByUserRef: null,
    confirmedVersion: null,
    confirmedAt: null,
    confirmedByUserRef: null,
    confirmedReversedAt: null,
    confirmedReversedByUserRef: null,
    failedVersion: null,
    failedAt: null,
    failedByUserRef: null,
    failedReason: null,
    voidedAt: null,
    voidedByUserRef: null,
    voidReason: null,
    overageOverride: null,
    docVersion: 1,
    amountMinor: 310000,
    createdAt: "2026-03-01T00:00:00.000Z",
    createdByUserRef: "usr_1",
    updatedAt: "2026-03-01T00:00:00.000Z",
    updatedByUserRef: "usr_1",
    ...overrides,
  };
}

function detail(overrides: Partial<PaymentDetailDto["head"]> = {}): PaymentDetailDto {
  return { head: head(overrides), versions: [], hasMoreVersions: false, selectedVersion: null, amountsVisible: true };
}

const NO_PERMISSIONS: PaymentPermissionsDto = { canView: false, canManage: false, canConfirm: false, canVoid: false, canOverrideOverage: false, canViewAmounts: false };
const FULL_PERMISSIONS: PaymentPermissionsDto = { canView: true, canManage: true, canConfirm: true, canVoid: true, canOverrideOverage: true, canViewAmounts: true };

describe("detailHeaderView", () => {
  it("titles the page by the payment ref and shows invoice/counterparty as secondary", () => {
    const view = detailHeaderView(head());
    expect(view.title).toBe("pmt_00000000000000000001");
    expect(view.secondary).toBe("inv_00000000000000000001 · Aisha Khan");
    expect(view.statusChip).toEqual({ label: "Draft", tone: "gray" });
  });
});

describe("detailActionVisibility", () => {
  it("DRAFT: offers Edit, Record and Void only when permitted", () => {
    const visibility = detailActionVisibility(head({ status: "DRAFT" }), FULL_PERMISSIONS);
    expect(visibility).toMatchObject({ canEdit: true, canRecord: true, canConfirm: false, canMarkFailed: false, canReopen: false, canVoid: true, readOnly: false });
  });

  it("RECORDED: offers Confirm, Mark Failed and Void", () => {
    const visibility = detailActionVisibility(head({ status: "RECORDED" }), FULL_PERMISSIONS);
    expect(visibility).toMatchObject({ canRecord: false, canConfirm: true, canMarkFailed: true, canReopen: false, canVoid: true });
  });

  it("CONFIRMED: only Void (the correction/reversal path) - never an ordinary edit action", () => {
    const visibility = detailActionVisibility(head({ status: "CONFIRMED" }), FULL_PERMISSIONS);
    expect(visibility).toMatchObject({ canEdit: false, canRecord: false, canConfirm: false, canMarkFailed: false, canReopen: false, canVoid: true });
  });

  it("FAILED: offers Reopen (Revise/Retry) and Void", () => {
    const visibility = detailActionVisibility(head({ status: "FAILED" }), FULL_PERMISSIONS);
    expect(visibility).toMatchObject({ canReopen: true, canVoid: true, canConfirm: false, canRecord: false });
  });

  it("VOID: every action is hidden, always read-only", () => {
    const visibility = detailActionVisibility(head({ status: "VOID" }), FULL_PERMISSIONS);
    expect(visibility).toEqual({ canEdit: false, canRecord: false, canConfirm: false, canMarkFailed: false, canReopen: false, canVoid: false, readOnly: true });
  });

  it("never offers an action the server-computed permissions deny, regardless of lifecycle status", () => {
    const visibility = detailActionVisibility(head({ status: "DRAFT" }), NO_PERMISSIONS);
    expect(visibility.canEdit).toBe(false);
    expect(visibility.canRecord).toBe(false);
    expect(visibility.canVoid).toBe(false);
  });
});

describe("summaryRows", () => {
  it("withholds the amount label per amountsVisible via formatMoneyMinor, never invents a figure", () => {
    const rows = summaryRows({ ...detail(), amountsVisible: false });
    const amountRow = rows.find((row) => row.label === "Amount");
    expect(amountRow?.value).toBe("Hidden");
  });

  it("shows an em-dash for a missing note", () => {
    const rows = summaryRows(detail());
    expect(rows.find((row) => row.label === "Note")?.value).toBe("—");
  });
});

describe("paymentSourceRevisionState", () => {
  it("is CURRENT when the pinned version matches the invoice's latest", () => {
    expect(paymentSourceRevisionState(2, 2)).toBe("CURRENT");
  });

  it("is CURRENT when the current invoice state is unknown (never a false warning)", () => {
    expect(paymentSourceRevisionState(2, null)).toBe("CURRENT");
  });

  it("reports INVOICE_REVISION_AVAILABLE once the invoice has moved on, never silently repins", () => {
    expect(paymentSourceRevisionState(2, 3)).toBe("INVOICE_REVISION_AVAILABLE");
  });
});

const SETTLEMENT: InvoicePaymentSettlementDto = {
  invoiceRef: "inv_00000000000000000001",
  currency: "INR",
  amountsVisible: true,
  summary: { expectedNetPaymentMinor: 810000, confirmedPaidMinor: 500000, recordedPendingMinor: 310000, failedMinor: 0, remainingMinor: 310000, overpaidByMinor: 0, state: "PARTIALLY_PAID", warnings: [] },
  payments: [{ paymentRef: "pmt_1", invoiceRef: "inv_1", counterparty: { type: "PARTNER", ref: "prt_1", displayName: "Aisha Khan" }, currency: "INR", status: "CONFIRMED", amountMinor: 500000, method: "UPI", latestVersion: 1, lastUpdatedAt: "2026-03-01T00:00:00.000Z" }],
};

describe("settlementSummaryRows / settlementStateView", () => {
  it("never labels a partially paid Invoice as Paid", () => {
    expect(settlementStateView(SETTLEMENT)).toEqual({ label: "Partially paid", tone: "orange" });
    const rows = settlementSummaryRows(SETTLEMENT);
    expect(rows.find((row) => row.label === "Remaining amount")?.value).toBe("₹3,100");
  });
});

describe("relatedPaymentRows", () => {
  it("maps each related Payment to a compact row, never a raw bank value", () => {
    const rows = relatedPaymentRows(SETTLEMENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ paymentRef: "pmt_1", amountText: "₹5,000", methodText: "UPI", status: { label: "Confirmed", tone: "default" } });
  });
});

describe("sourceInvoiceRows", () => {
  it("falls back to the head's own invoice/payable refs when no version is selected", () => {
    const rows = sourceInvoiceRows(detail());
    expect(rows.find((row) => row.label === "Invoice ref / version")?.value).toBe("inv_00000000000000000001");
  });
});

describe("historyRows", () => {
  it("prefers a reason, then a change kind, then a method, then the em-dash", () => {
    const events: PaymentEventDto[] = [
      { kind: "PAYMENT_VOIDED", version: 2, actorUserRef: "usr_1", metadata: { reason: "Duplicate entry" }, createdAt: "2026-03-02T00:00:00.000Z" },
      { kind: "PAYMENT_VERSION_CREATED", version: 1, actorUserRef: "usr_1", metadata: { changeKind: "created" }, createdAt: "2026-03-01T00:00:00.000Z" },
      { kind: "PAYMENT_RECORDED", version: 1, actorUserRef: "usr_1", metadata: null, createdAt: "2026-03-01T00:00:00.000Z" },
    ];
    const rows = historyRows(events);
    expect(rows[0].event).toBe("Voided");
    expect(rows[0].reasonOrMetadata).toBe("Duplicate entry");
    expect(rows[1].reasonOrMetadata).toBe("Created");
    expect(rows[2].reasonOrMetadata).toBe("—");
  });
});
