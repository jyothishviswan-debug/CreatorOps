import { describe, expect, it } from "vitest";

import { amountMinorSchema as payablesAmountMinorSchema, currencyCodeSchema as payablesCurrencyCodeSchema } from "@/server/finance-payables/types";

import { buildPin, buildReconciliationResult, FIXTURE_TAX_LINE } from "./testing/invoice-fixtures";
import { amountMinorSchema, currencyCodeSchema, invoiceHeadDocSchema, invoiceVersionDocSchema } from "./types";

// Step 16A: the invariants the stored Invoice shapes enforce on every parse (read AND write).

describe("money convention is pinned equal to Payables' own", () => {
  it("amountMinorSchema and currencyCodeSchema behave identically to Payables'", () => {
    for (const value of [0, 1, 5_000_000]) {
      expect(amountMinorSchema.safeParse(value).success).toBe(payablesAmountMinorSchema.safeParse(value).success);
    }
    for (const value of [-1, 1.5]) {
      expect(amountMinorSchema.safeParse(value).success).toBe(false);
      expect(payablesAmountMinorSchema.safeParse(value).success).toBe(false);
    }
    for (const value of ["INR", "USD", "inr", "US", "USDD"]) {
      expect(currencyCodeSchema.safeParse(value).success).toBe(payablesCurrencyCodeSchema.safeParse(value).success);
    }
  });
});

function version(overrides: Record<string, unknown> = {}) {
  return {
    invoiceRef: "inv_00000000000000000001",
    version: 1,
    payablePin: buildPin(),
    externalInvoiceNumber: null,
    normalizedInvoiceNumberKey: null,
    invoiceDate: null,
    receivedDate: null,
    currency: null,
    subtotalMinor: null,
    taxLines: [],
    declaredTotalMinor: null,
    dueDate: null,
    document: null,
    reconciliation: buildReconciliationResult({ state: "MISSING_IN_INVOICE", findings: [{ code: "MISSING_INVOICE_TOTAL", severity: "BLOCKER", message: "The Invoice states no declared total yet." }] }),
    changeKind: "created",
    reason: null,
    createdAt: "2024-04-03T00:00:00.000Z",
    createdByUserRef: "user-1",
    ...overrides,
  };
}

describe("invoiceVersionDocSchema", () => {
  it("accepts a well-formed fresh (undeclared) version", () => {
    expect(invoiceVersionDocSchema.safeParse(version()).success).toBe(true);
  });

  it("version 1 must be changeKind created; later versions must not be", () => {
    expect(invoiceVersionDocSchema.safeParse(version({ changeKind: "revised" })).success).toBe(false);
    expect(invoiceVersionDocSchema.safeParse(version({ version: 2, changeKind: "created" })).success).toBe(false);
    expect(invoiceVersionDocSchema.safeParse(version({ version: 2, changeKind: "revised", reason: "x" })).success).toBe(true);
  });

  it("a normalized invoice-number key is present iff a declared number is present", () => {
    expect(invoiceVersionDocSchema.safeParse(version({ externalInvoiceNumber: null, normalizedInvoiceNumberKey: "INV-1" })).success).toBe(false);
    expect(invoiceVersionDocSchema.safeParse(version({ externalInvoiceNumber: "INV-1", normalizedInvoiceNumberKey: null })).success).toBe(false);
    expect(invoiceVersionDocSchema.safeParse(version({ externalInvoiceNumber: "INV-1", normalizedInvoiceNumberKey: "INV-1" })).success).toBe(true);
  });

  it("an arithmetic mismatch between subtotal+tax and the declared total must be surfaced as a finding", () => {
    const inconsistent = version({
      subtotalMinor: 1_000_000,
      taxLines: [FIXTURE_TAX_LINE],
      declaredTotalMinor: 9_999_999,
      currency: "INR",
      reconciliation: buildReconciliationResult({ state: "MATCH", findings: [] }),
    });
    expect(invoiceVersionDocSchema.safeParse(inconsistent).success).toBe(false);

    const flagged = version({
      subtotalMinor: 1_000_000,
      taxLines: [FIXTURE_TAX_LINE],
      declaredTotalMinor: 9_999_999,
      currency: "INR",
      reconciliation: buildReconciliationResult({ state: "REVIEW_REQUIRED", findings: [{ code: "ARITHMETIC_INCONSISTENT", severity: "WARNING", message: "mismatch" }] }),
    });
    expect(invoiceVersionDocSchema.safeParse(flagged).success).toBe(true);
  });

  it("a consistent subtotal+tax=total is accepted with no arithmetic finding", () => {
    const consistent = version({ subtotalMinor: 5_000_000, taxLines: [FIXTURE_TAX_LINE], declaredTotalMinor: 5_900_000, currency: "INR", reconciliation: buildReconciliationResult() });
    expect(invoiceVersionDocSchema.safeParse(consistent).success).toBe(true);
  });
});

function head(overrides: Record<string, unknown> = {}) {
  return {
    invoiceRef: "inv_00000000000000000001",
    docVersion: 1,
    payableRef: "pay_0123456789abcdef0123",
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-fixture",
    periodKey: "2024-03",
    periodStart: "2024-03-01",
    periodEnd: "2024-03-31",
    currency: null,
    externalInvoiceNumber: null,
    normalizedInvoiceNumberKey: null,
    ownerUid: "owner-1",
    regionIds: [],
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
    display: { counterpartyName: "Partner Fixture", counterpartyNameLower: "partner fixture", declaredTotalMinor: null, reconciliationState: "MISSING_IN_INVOICE", externalInvoiceNumber: null, projectedAt: "2024-04-03T00:00:00.000Z" },
    createdAt: "2024-04-03T00:00:00.000Z",
    createdByUserRef: "user-1",
    updatedAt: "2024-04-03T00:00:00.000Z",
    updatedByUserRef: "user-1",
    ...overrides,
  };
}

describe("invoiceHeadDocSchema", () => {
  it("accepts a well-formed fresh DRAFT head", () => {
    expect(invoiceHeadDocSchema.safeParse(head()).success).toBe(true);
  });

  it("a PARTNER head must have exactly partnerUid; a VENDOR head must have exactly vendorUid", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ counterpartyType: "PARTNER", partnerUid: null })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ counterpartyType: "PARTNER", partnerUid: "p", vendorUid: "v" })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ counterpartyType: "VENDOR", partnerUid: null, vendorUid: "v" })).success).toBe(true);
  });

  it("SUBMITTED requires submittedVersion/At/ByUserRef; APPROVED requires approvedVersion/At/ByUserRef", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ status: "SUBMITTED" })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ status: "SUBMITTED", submittedVersion: 1, submittedAt: "2024-04-03T00:00:00.000Z", submittedByUserRef: "u" })).success).toBe(true);
    expect(invoiceHeadDocSchema.safeParse(head({ status: "APPROVED", submittedVersion: 1, submittedAt: "2024-04-03T00:00:00.000Z", submittedByUserRef: "u" })).success).toBe(false);
    expect(
      invoiceHeadDocSchema.safeParse(
        head({ status: "APPROVED", submittedVersion: 1, submittedAt: "2024-04-03T00:00:00.000Z", submittedByUserRef: "u", approvedVersion: 1, approvedAt: "2024-04-03T00:00:00.000Z", approvedByUserRef: "u" }),
      ).success,
    ).toBe(true);
  });

  it("an approvedVersion is only ever present on an APPROVED head", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ status: "DRAFT", approvedVersion: 1 })).success).toBe(false);
  });

  it("REJECTED requires rejectedVersion/At/ByUserRef/reason; VOID requires voidedAt/ByUserRef/reason", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ status: "REJECTED" })).success).toBe(false);
    expect(
      invoiceHeadDocSchema.safeParse(head({ status: "REJECTED", rejectedVersion: 1, rejectedAt: "2024-04-03T00:00:00.000Z", rejectedByUserRef: "u", rejectionReason: "No document attached." })).success,
    ).toBe(true);
    expect(invoiceHeadDocSchema.safeParse(head({ status: "VOID" })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ status: "VOID", voidedAt: "2024-04-03T00:00:00.000Z", voidedByUserRef: "u", voidReason: "Raised in error." })).success).toBe(true);
  });

  it("a mismatchOverride cannot name a version beyond latestVersion", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ latestVersion: 1, mismatchOverride: { forVersion: 2, reason: "x".repeat(5), actorUserRef: "u", at: "2024-04-03T00:00:00.000Z" } })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ latestVersion: 2, mismatchOverride: { forVersion: 2, reason: "x".repeat(5), actorUserRef: "u", at: "2024-04-03T00:00:00.000Z" } })).success).toBe(true);
  });

  it("a normalized invoice-number key is present iff a declared number is present", () => {
    expect(invoiceHeadDocSchema.safeParse(head({ externalInvoiceNumber: null, normalizedInvoiceNumberKey: "INV-1" })).success).toBe(false);
    expect(invoiceHeadDocSchema.safeParse(head({ externalInvoiceNumber: "INV-1", normalizedInvoiceNumberKey: "INV-1" })).success).toBe(true);
  });
});
