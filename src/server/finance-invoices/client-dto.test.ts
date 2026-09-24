import { describe, expect, it } from "vitest";

import { toInvoiceHeadDto, toInvoiceRowDto, toInvoiceVersionDto } from "./client-dto";
import { buildPin, buildReconciliationResult, FIXTURE_TAX_LINE } from "./testing/invoice-fixtures";
import type { InvoiceHeadDoc, InvoiceVersionDoc } from "./types";

const VERSION: InvoiceVersionDoc = {
  invoiceRef: "inv_00000000000000000001",
  version: 1,
  payablePin: buildPin(),
  externalInvoiceNumber: "INV-001",
  normalizedInvoiceNumberKey: "INV-001",
  invoiceDate: "2024-04-01",
  receivedDate: "2024-04-02",
  currency: "INR",
  subtotalMinor: 4_100_000,
  taxLines: [FIXTURE_TAX_LINE],
  declaredTotalMinor: 5_000_000,
  dueDate: "2024-05-01",
  document: null,
  reconciliation: buildReconciliationResult(),
  extractedPayeeName: null,
  payeeIdentity: null,
  changeKind: "created",
  reason: null,
  createdAt: "2024-04-03T00:00:00.000Z",
  createdByUserRef: "user-1",
};

const HEAD: InvoiceHeadDoc = {
  invoiceRef: "inv_00000000000000000001",
  docVersion: 1,
  payableRef: "pay_0123456789abcdef0123",
  counterpartyType: "PARTNER",
  counterpartyRef: "partner-fixture",
  periodKey: "2024-03",
  periodStart: "2024-03-01",
  periodEnd: "2024-03-31",
  currency: "INR",
  externalInvoiceNumber: "INV-001",
  normalizedInvoiceNumberKey: "INV-001",
  ownerUid: "owner-uid-1",
  regionIds: ["Kerala"],
  teamIds: [],
  partnerUid: "partner-uid-1",
  vendorUid: null,
  status: "DRAFT",
  latestVersion: 1,
  submittedVersion: null,
  submittedAt: null,
  submittedByUserRef: null,
  approvedVersion: null,
  approvedAt: null,
  approvedByUserRef: null,
  rejectedVersion: null,
  rejectedAt: null,
  rejectedByUserRef: null,
  rejectionReason: null,
  voidedAt: null,
  voidedByUserRef: null,
  voidReason: null,
  mismatchOverride: null,
  payeeMismatchOverride: null,
  display: { counterpartyName: "Partner Fixture", counterpartyNameLower: "partner fixture", declaredTotalMinor: 5_000_000, reconciliationState: "MATCH", externalInvoiceNumber: "INV-001", projectedAt: "2024-04-03T00:00:00.000Z" },
  createdAt: "2024-04-03T00:00:00.000Z",
  createdByUserRef: "user-1",
  updatedAt: "2024-04-03T00:00:00.000Z",
  updatedByUserRef: "user-1",
};

describe("amount redaction cascades through every DTO builder", () => {
  it("toInvoiceVersionDto withholds every money figure (null, not zero) when amountsVisible is false", () => {
    const dto = toInvoiceVersionDto(VERSION, { amountsVisible: false });
    expect(dto.subtotalMinor).toBeNull();
    expect(dto.declaredTotalMinor).toBeNull();
    expect(dto.taxLines[0]!.amountMinor).toBeNull();
    expect(dto.payablePin.payableGrossInvoiceExpectedMinor).toBeNull();
    expect(dto.payablePin.payableServiceBaseMinor).toBeNull();
    expect(dto.payablePin.payableTdsMinor).toBeNull();
    expect(dto.payablePin.payableExpectedNetPaymentMinor).toBeNull();
    // calculationRuleVersion is not money - stays visible even when amounts are withheld.
    expect(dto.payablePin.payableCalculationRuleVersion).toBe("MONTHLY_ANALYTICS_PRORATION_V1");
    // Non-money fields are still visible.
    expect(dto.externalInvoiceNumber).toBe("INV-001");
    expect(dto.reconciliation.state).toBe("MATCH");
  });

  it("toInvoiceVersionDto shows every money figure when amountsVisible is true", () => {
    const dto = toInvoiceVersionDto(VERSION, { amountsVisible: true });
    expect(dto.declaredTotalMinor).toBe(5_000_000);
    expect(dto.subtotalMinor).toBe(4_100_000);
    expect(dto.taxLines[0]!.amountMinor).toBe(900_000);
    expect(dto.payablePin.payableGrossInvoiceExpectedMinor).toBe(5_000_000);
    expect(dto.payablePin.payableServiceBaseMinor).toBe(5_000_000);
    expect(dto.payablePin.payableTdsMinor).toBe(500_000);
    expect(dto.payablePin.payableExpectedNetPaymentMinor).toBe(4_500_000);
  });

  it("toInvoiceHeadDto and toInvoiceRowDto withhold declaredTotalMinor without amounts access", () => {
    expect(toInvoiceHeadDto(HEAD, "Partner Fixture", { amountsVisible: false }).declaredTotalMinor).toBeNull();
    expect(toInvoiceRowDto(HEAD, "Partner Fixture", { amountsVisible: false }).declaredTotalMinor).toBeNull();
    expect(toInvoiceHeadDto(HEAD, "Partner Fixture", { amountsVisible: true }).declaredTotalMinor).toBe(5_000_000);
  });

  it("never exposes a scope field or a raw Firebase uid", () => {
    const dto = toInvoiceHeadDto(HEAD, "Partner Fixture", { amountsVisible: true });
    const serialized = JSON.stringify(dto);
    for (const forbidden of ["ownerUid", "regionIds", "teamIds", "partnerUid", "vendorUid"]) expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toContain("owner-uid-1");
    expect(serialized).not.toContain("partner-uid-1");
  });
});
