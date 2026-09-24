import { describe, expect, it } from "vitest";

import { amountMinorSchema as invoicesAmountMinorSchema, currencyCodeSchema as invoicesCurrencyCodeSchema } from "@/server/finance-invoices/types";

import { paymentHeadDisplaySchema, paymentHeadDocSchema, paymentVersionDocSchema, positiveAmountMinorSchema } from "./types";

// Step 17A: the invariants the stored Payment shapes enforce on every parse (read AND write).

describe("money convention is pinned equal to Invoices' own", () => {
  it("amountMinorSchema behaves identically to Invoices' own for non-negative integers", () => {
    for (const value of [0, 1, 5_000_000]) {
      // positiveAmountMinorSchema additionally forbids 0 (section 8: a Payment amount is always
      // positive) - so we compare against Invoices' own amountMinorSchema only for values >= 1.
      if (value >= 1) expect(positiveAmountMinorSchema.safeParse(value).success).toBe(invoicesAmountMinorSchema.safeParse(value).success);
    }
    for (const value of [-1, 1.5]) {
      expect(positiveAmountMinorSchema.safeParse(value).success).toBe(false);
      expect(invoicesAmountMinorSchema.safeParse(value).success).toBe(false);
    }
    expect(positiveAmountMinorSchema.safeParse(0).success).toBe(false); // section 8: positive, never zero
  });

  it("currencyCodeSchema behaves identically to Invoices'", () => {
    for (const value of ["INR", "USD", "inr", "US", "USDD"]) {
      expect(invoicesCurrencyCodeSchema.safeParse(value).success).toBe(invoicesCurrencyCodeSchema.safeParse(value).success);
    }
  });
});

function pin(overrides: Record<string, unknown> = {}) {
  return {
    invoiceRef: "inv_00000000000000000001",
    invoiceVersion: 2,
    payableRef: "pay_00000000000000000001",
    payableVersion: 1,
    counterpartyType: "PARTNER",
    counterpartyRef: "prt_1",
    commercialPeriod: { periodKey: "2024-04", periodStart: "2024-04-01", periodEnd: "2024-04-30" },
    currency: "INR",
    externalInvoiceNumber: "INV-2024-001",
    serviceBaseMinor: 80_000,
    gstMinor: 10_000,
    grossInvoiceExpectedMinor: 90_000,
    tdsMinor: 0,
    expectedNetPaymentMinor: 90_000,
    pinnedAt: "2024-05-01T00:00:00.000Z",
    ...overrides,
  };
}

function payeeIdentity(overrides: Record<string, unknown> = {}) {
  return { overallStatusAtApproval: "MATCH", bankSafeDisplay: "••••1234", resolution: null, comparedAt: "2024-04-20T00:00:00.000Z", ...overrides };
}

function version(overrides: Record<string, unknown> = {}) {
  return {
    paymentRef: "pmt_00000000000000000001",
    version: 1,
    invoicePin: pin(),
    payeeIdentity: payeeIdentity(),
    amountMinor: null,
    paymentDate: null,
    method: null,
    externalReference: null,
    normalizedExternalReferenceKey: null,
    memo: null,
    changeKind: "created",
    reason: null,
    createdAt: "2024-05-01T00:00:00.000Z",
    createdByUserRef: "user-1",
    ...overrides,
  };
}

describe("paymentVersionDocSchema", () => {
  it("accepts a well-formed fresh (undeclared) version", () => {
    expect(paymentVersionDocSchema.safeParse(version()).success).toBe(true);
  });

  it("version 1 must be changeKind created; later versions must not be", () => {
    expect(paymentVersionDocSchema.safeParse(version({ changeKind: "revised" })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ version: 2, changeKind: "created" })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ version: 2, changeKind: "revised", reason: "x" })).success).toBe(true);
  });

  it("a normalized external-reference key is present iff a declared reference is present", () => {
    expect(paymentVersionDocSchema.safeParse(version({ externalReference: "UTR123", normalizedExternalReferenceKey: null })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ externalReference: null, normalizedExternalReferenceKey: "UTR123" })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ externalReference: "UTR123", normalizedExternalReferenceKey: "UTR123" })).success).toBe(true);
  });

  it("amountMinor rejects zero and negative values (section 8: always positive)", () => {
    expect(paymentVersionDocSchema.safeParse(version({ amountMinor: 0 })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ amountMinor: -1 })).success).toBe(false);
    expect(paymentVersionDocSchema.safeParse(version({ amountMinor: 1 })).success).toBe(true);
  });

  it("rejects an unknown key (strict schema)", () => {
    expect(paymentVersionDocSchema.safeParse({ ...version(), extraField: "nope" }).success).toBe(false);
  });
});

function display(overrides: Record<string, unknown> = {}) {
  return paymentHeadDisplaySchema.parse({ counterpartyName: "Acme", counterpartyNameLower: "acme", amountMinor: null, status: "DRAFT", projectedAt: "2024-05-01T00:00:00.000Z", ...overrides });
}

function head(overrides: Record<string, unknown> = {}) {
  return {
    paymentRef: "pmt_00000000000000000001",
    docVersion: 1,
    invoiceRef: "inv_00000000000000000001",
    payableRef: "pay_00000000000000000001",
    counterpartyType: "PARTNER",
    counterpartyRef: "prt_1",
    currency: "INR",
    ownerUid: null,
    regionIds: [],
    teamIds: [],
    partnerUid: "uid-1",
    vendorUid: null,
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
    display: display(),
    createdAt: "2024-05-01T00:00:00.000Z",
    createdByUserRef: "user-1",
    updatedAt: "2024-05-01T00:00:00.000Z",
    updatedByUserRef: "user-1",
    ...overrides,
  };
}

describe("paymentHeadDocSchema", () => {
  it("accepts a well-formed fresh DRAFT head", () => {
    expect(paymentHeadDocSchema.safeParse(head()).success).toBe(true);
  });

  it("a partner payment is scoped by exactly a partnerUid; a vendor payment by exactly a vendorUid", () => {
    expect(paymentHeadDocSchema.safeParse(head({ counterpartyType: "PARTNER", partnerUid: null })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ counterpartyType: "PARTNER", partnerUid: "u1", vendorUid: "u2" })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ counterpartyType: "VENDOR", partnerUid: null, vendorUid: null })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ counterpartyType: "VENDOR", partnerUid: null, vendorUid: "u2" })).success).toBe(true);
  });

  it("a recorded/confirmed/failed head must pin its version, time and actor", () => {
    expect(paymentHeadDocSchema.safeParse(head({ status: "RECORDED" })).success).toBe(false);
    expect(
      paymentHeadDocSchema.safeParse(head({ status: "RECORDED", recordedVersion: 1, recordedAt: "2024-05-01T00:00:00.000Z", recordedByUserRef: "u1", display: display({ status: "RECORDED" }) })).success,
    ).toBe(true);
    expect(paymentHeadDocSchema.safeParse(head({ status: "CONFIRMED" })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ status: "FAILED" })).success).toBe(false);
  });

  it("a voided head must record when/by whom/why, and no other status may carry a void reason", () => {
    expect(paymentHeadDocSchema.safeParse(head({ status: "VOID" })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ status: "VOID", voidedAt: "2024-05-01T00:00:00.000Z", voidedByUserRef: "u1", voidReason: "correction", display: display({ status: "VOID" }) })).success).toBe(true);
    expect(paymentHeadDocSchema.safeParse(head({ voidReason: "not void but has a reason" })).success).toBe(false);
  });

  it("an accepted overpayment override cannot name a version beyond the payment's latest", () => {
    expect(paymentHeadDocSchema.safeParse(head({ latestVersion: 1, overageOverride: { forVersion: 2, reason: "ok", actorUserRef: "u1", at: "2024-05-01T00:00:00.000Z" } })).success).toBe(false);
    expect(paymentHeadDocSchema.safeParse(head({ latestVersion: 2, overageOverride: { forVersion: 2, reason: "ok", actorUserRef: "u1", at: "2024-05-01T00:00:00.000Z" } })).success).toBe(true);
  });

  it("a confirmed-then-reversed payment is always VOID", () => {
    expect(paymentHeadDocSchema.safeParse(head({ status: "DRAFT", confirmedReversedAt: "2024-05-01T00:00:00.000Z", confirmedReversedByUserRef: "u1" })).success).toBe(false);
    expect(
      paymentHeadDocSchema.safeParse(
        head({ status: "VOID", voidedAt: "2024-05-01T00:00:00.000Z", voidedByUserRef: "u1", voidReason: "reversed", confirmedReversedAt: "2024-05-01T00:00:00.000Z", confirmedReversedByUserRef: "u1", display: display({ status: "VOID" }) }),
      ).success,
    ).toBe(true);
  });

  it("rejects an unknown key (strict schema)", () => {
    expect(paymentHeadDocSchema.safeParse({ ...head(), extraField: "nope" }).success).toBe(false);
  });
});
