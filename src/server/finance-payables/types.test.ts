import { describe, expect, it } from "vitest";
import { z } from "zod";

import { amountMinorSchema as agreementAmountMinorSchema, currencyCodeSchema as agreementCurrencyCodeSchema } from "@/server/finance-agreements/terms";
import { COUNTERPARTY_TYPES } from "@/server/finance-agreements/types";

import { buildSnapshot } from "./testing/payable-fixtures";
import {
  amountMinorSchema,
  confirmPayableTaxInputSchema,
  currencyCodeSchema,
  PAYABLE_COUNTERPARTY_TYPES,
  payableHeadDocSchema,
  payableLineSchema,
  payableSourceSnapshotSchema,
  payableVersionDocSchema,
  type PayableLine,
} from "./types";

// Step 15A: the invariants the stored Payable shapes enforce on every parse (read AND write).

const LINE: PayableLine = {
  lineRef: "pl_00000000000000000001",
  label: "Fixed component",
  category: "BASE_FIXED",
  amountMinorSigned: 5_000_000,
  source: "AGREEMENT",
  sourceRef: "agr_0123456789abcdef0123@2",
  reason: "Fixed component stated by the confirmed Agreement terms.",
  actor: null,
  resolvesCode: null,
};

function version(overrides: Record<string, unknown> = {}) {
  return {
    payableRef: "pay_00000000000000000001",
    version: 1,
    businessKey: "b".repeat(64),
    snapshot: buildSnapshot(),
    determination: { state: "DETERMINISTIC", unresolved: [], blocked: [], warnings: [] },
    lines: [LINE],
    totalAmountMinorSigned: 5_000_000,
    currency: "INR",
    serviceBaseMinor: 5_000_000,
    gstMinor: 0,
    grossInvoiceExpectedMinor: 5_000_000,
    tdsMinor: 0,
    expectedNetPaymentMinor: 5_000_000,
    calculationRuleVersion: "MONTHLY_ANALYTICS_PRORATION_V1",
    openReviewCodes: [],
    changeKind: "created",
    reason: null,
    createdAt: "2024-04-03T00:00:00.000Z",
    createdByUserRef: "user-1",
    ...overrides,
  };
}

function head(overrides: Record<string, unknown> = {}) {
  return {
    payableRef: "pay_00000000000000000001",
    docVersion: 1,
    counterpartyType: "PARTNER",
    counterpartyRef: "partner-fixture",
    periodKey: "2024-03",
    periodStart: "2024-03-01",
    periodEnd: "2024-03-31",
    currency: "INR",
    sourceType: "PARTNER_REVIEW",
    agreementRef: "agr_0123456789abcdef0123",
    agreementVersion: 2,
    sourceReviewRef: "pr_0123456789abcdef0123",
    sourceReviewVersion: 1,
    businessKey: "b".repeat(64),
    ownerUid: null,
    regionIds: ["Kerala"],
    teamIds: [],
    partnerUid: "partner-uid",
    vendorUid: null,
    status: "DRAFT",
    latestVersion: 1,
    readyVersion: null,
    display: { counterpartyName: "Acme", counterpartyNameLower: "acme", totalAmountMinorSigned: 5_000_000, determinationState: "DETERMINISTIC", openReviewCount: 0, lineCount: 1, projectedAt: "2024-04-03T00:00:00.000Z" },
    createdAt: "2024-04-03T00:00:00.000Z",
    createdByUserRef: "user-1",
    updatedAt: "2024-04-03T00:00:00.000Z",
    updatedByUserRef: "user-1",
    ...overrides,
  };
}

describe("money convention", () => {
  it("uses the Agreement module's own integer minor-unit and ISO-4217 conventions, not a second one", () => {
    for (const value of [0, 1, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(amountMinorSchema.safeParse(value).success).toBe(agreementAmountMinorSchema.safeParse(value).success);
    }
    for (const value of [-1, 1.5, "5000000", Number.NaN]) {
      expect(amountMinorSchema.safeParse(value).success).toBe(agreementAmountMinorSchema.safeParse(value).success);
      expect(amountMinorSchema.safeParse(value).success).toBe(false);
    }
    for (const value of ["INR", "USD", "inr", "IN", "INRR", 1]) {
      expect(currencyCodeSchema.safeParse(value).success).toBe(agreementCurrencyCodeSchema.safeParse(value).success);
    }
  });

  it("names exactly the Agreement module's counterparty types (Partner is never polymorphic and never re-modelled)", () => {
    expect([...PAYABLE_COUNTERPARTY_TYPES]).toEqual([...COUNTERPARTY_TYPES]);
  });
});

describe("payable line", () => {
  it("accepts a signed manual adjustment with actor metadata and a reason", () => {
    const manual = { ...LINE, lineRef: "pl_00000000000000000002", category: "MANUAL_ADJUSTMENT", source: "MANUAL", sourceRef: null, amountMinorSigned: -50_000, actor: { userRef: "u", at: "2024-04-04T00:00:00.000Z" }, resolvesCode: "TRANSFER_FEE_APPLICATION_UNSPECIFIED" };
    expect(payableLineSchema.safeParse(manual).success).toBe(true);
  });

  it("refuses a manual adjustment with no actor metadata", () => {
    expect(payableLineSchema.safeParse({ ...LINE, category: "MANUAL_ADJUSTMENT", source: "MANUAL", actor: null }).success).toBe(false);
  });

  it("refuses an engine line that claims to be manual or to resolve a review item", () => {
    expect(payableLineSchema.safeParse({ ...LINE, actor: { userRef: "u", at: "2024-04-04T00:00:00.000Z" } }).success).toBe(false);
    expect(payableLineSchema.safeParse({ ...LINE, resolvesCode: "NARRATIVE_INCENTIVE" }).success).toBe(false);
  });
});

describe("payable version document", () => {
  it("accepts the simple deterministic shape", () => {
    expect(payableVersionDocSchema.safeParse(version()).success).toBe(true);
  });

  it("never persists a BLOCKED determination - blocking is a refusal to generate, not a stored state", () => {
    const parsed = payableVersionDocSchema.safeParse(version({ determination: { state: "BLOCKED", unresolved: [], blocked: [{ code: "CURRENCY_MISSING", message: "No currency." }], warnings: [] }, lines: [], totalAmountMinorSigned: 0 }));
    expect(parsed.success).toBe(false);
  });

  it("requires the total to equal the sum of the breakdown lines", () => {
    expect(payableVersionDocSchema.safeParse(version({ totalAmountMinorSigned: 9_999 })).success).toBe(false);
  });

  it("requires openReviewCodes to be exactly the unresolved items no manual adjustment resolves", () => {
    const unresolved = [{ code: "NARRATIVE_INCENTIVE", message: "Discretionary.", sourceRef: null }];
    const determination = { state: "FINANCE_REVIEW_REQUIRED", unresolved, blocked: [], warnings: [] };
    expect(payableVersionDocSchema.safeParse(version({ determination, openReviewCodes: ["NARRATIVE_INCENTIVE"] })).success).toBe(true);
    expect(payableVersionDocSchema.safeParse(version({ determination, openReviewCodes: [] })).success).toBe(false);

    const resolvedByManual = { ...LINE, lineRef: "pl_00000000000000000003", category: "MANUAL_ADJUSTMENT", source: "MANUAL", sourceRef: null, amountMinorSigned: 0, actor: { userRef: "u", at: "2024-04-04T00:00:00.000Z" }, resolvesCode: "NARRATIVE_INCENTIVE" };
    expect(payableVersionDocSchema.safeParse(version({ determination, lines: [LINE, resolvedByManual], openReviewCodes: [] })).success).toBe(true);
  });

  it("requires version 1 to be the creation and every later version not to be", () => {
    expect(payableVersionDocSchema.safeParse(version({ changeKind: "revised" })).success).toBe(false);
    expect(payableVersionDocSchema.safeParse(version({ version: 2, changeKind: "created" })).success).toBe(false);
    expect(payableVersionDocSchema.safeParse(version({ version: 2, changeKind: "revised", reason: "Refreshed the source." })).success).toBe(true);
  });

  it("rejects an unknown key rather than silently dropping it", () => {
    expect(payableVersionDocSchema.safeParse(version({ approvedBy: "someone" })).success).toBe(false);
  });
});

describe("payable head document", () => {
  it("accepts the DRAFT shape and scopes a partner payable by exactly a partnerUid", () => {
    expect(payableHeadDocSchema.safeParse(head()).success).toBe(true);
    expect(payableHeadDocSchema.safeParse(head({ partnerUid: null })).success).toBe(false);
    expect(payableHeadDocSchema.safeParse(head({ vendorUid: "v" })).success).toBe(false);
  });

  it("requires a partner-review payable to name its review, and forbids an agreement-only one from naming any", () => {
    expect(payableHeadDocSchema.safeParse(head({ sourceReviewRef: null, sourceReviewVersion: null })).success).toBe(false);
    expect(payableHeadDocSchema.safeParse(head({ counterpartyType: "VENDOR", partnerUid: null, vendorUid: "vendor-uid", sourceType: "AGREEMENT_ONLY" })).success).toBe(false);
    expect(payableHeadDocSchema.safeParse(head({ counterpartyType: "VENDOR", partnerUid: null, vendorUid: "vendor-uid", sourceType: "AGREEMENT_ONLY", sourceReviewRef: null, sourceReviewVersion: null })).success).toBe(true);
  });

  it("requires READY_FOR_INVOICE to pin its version, time and actor, and VOID to record when/who/why", () => {
    expect(payableHeadDocSchema.safeParse(head({ status: "READY_FOR_INVOICE" })).success).toBe(false);
    expect(payableHeadDocSchema.safeParse(head({ status: "READY_FOR_INVOICE", readyVersion: 1, readyAt: "2024-04-05T00:00:00.000Z", readyByUserRef: "u" })).success).toBe(true);
    expect(payableHeadDocSchema.safeParse(head({ status: "VOID" })).success).toBe(false);
    expect(payableHeadDocSchema.safeParse(head({ status: "VOID", voidedAt: "2024-04-05T00:00:00.000Z", voidedByUserRef: "u", voidReason: "Duplicate basis." })).success).toBe(true);
  });

  it("refuses a ready version that does not exist yet", () => {
    expect(payableHeadDocSchema.safeParse(head({ status: "READY_FOR_INVOICE", readyVersion: 9, readyAt: "2024-04-05T00:00:00.000Z", readyByUserRef: "u" })).success).toBe(false);
  });
});

describe("immutable source snapshot - what it may never carry (section 6)", () => {
  it("has no property anywhere that could hold raw Agreement text, identity, KYC or an upstream record id", () => {
    const names = new Set<string>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        for (const [key, child] of Object.entries(node)) {
          if (key === "properties" && child && typeof child === "object") Object.keys(child).forEach((property) => names.add(property));
          walk(child);
        }
      }
    };
    walk(z.toJSONSchema(payableSourceSnapshotSchema, { io: "input", unrepresentable: "any" }));
    expect(names.size).toBeGreaterThan(20);

    const forbidden = [
      // raw full Agreement text
      "servicesMandated",
      "monetisationTerms",
      "renewalTerms",
      "noticeTerms",
      "terminationTerms",
      "contractTerms",
      // identity / KYC
      "panNumber",
      "aadhaarNumber",
      "bankAccountNumber",
      "accountNumber",
      "ifsc",
      "gstin",
      "gstNumber",
      "identityStatus",
      "identityStatusSnapshot",
      "contactSnapshot",
      "emailAddress",
      "contactNumber",
      // upstream source records
      "assignmentRef",
      "campaignRef",
      "contentRef",
      "sourceRecordRef",
      "partnerAccountRef",
      "postUrl",
    ];
    expect([...names].filter((name) => forbidden.includes(name))).toEqual([]);
  });

  it("pins a Partner Review for a PARTNER_REVIEW source and never fabricates one for AGREEMENT_ONLY", () => {
    expect(() => buildSnapshot({ review: null })).toThrow();
    expect(() => buildSnapshot({ sourceType: "AGREEMENT_ONLY" })).toThrow();
  });
});

// Step 15C.1 section 10: GST applicability is a tri-state - null ("unconfirmed"), false ("confirmed
// not applicable") and true ("confirmed applicable", rate required) - and the confirmation input a
// Finance actor submits carries the same "rate iff applicable" invariant.
describe("GST tax tri-state and the Finance confirmation input (section 10)", () => {
  it("accepts gstApplicable: null (unconfirmed) with no rate", () => {
    expect(() => buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: null, gstRateBps: null, gstProvenance: "UNCONFIRMED_NO_CANONICAL_SOURCE" } })).not.toThrow();
  });

  it("rejects a null/false gstApplicable that still carries a rate", () => {
    expect(() => buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: null, gstRateBps: 1800, gstProvenance: "test" } })).toThrow();
    expect(() => buildSnapshot({ tax: { tdsApplicable: true, tdsRateBps: 1000, tdsProvenance: "test", gstApplicable: false, gstRateBps: 1800, gstProvenance: "test" } })).toThrow();
  });

  it("confirmPayableTaxInputSchema requires a rate exactly when gstApplicable is true", () => {
    expect(confirmPayableTaxInputSchema.safeParse({ payableRef: "pay_00000000000000000001", expectedDocVersion: 1, gstApplicable: true, gstRateBps: 1800 }).success).toBe(true);
    expect(confirmPayableTaxInputSchema.safeParse({ payableRef: "pay_00000000000000000001", expectedDocVersion: 1, gstApplicable: false, gstRateBps: null }).success).toBe(true);
    expect(confirmPayableTaxInputSchema.safeParse({ payableRef: "pay_00000000000000000001", expectedDocVersion: 1, gstApplicable: true, gstRateBps: null }).success).toBe(false);
    expect(confirmPayableTaxInputSchema.safeParse({ payableRef: "pay_00000000000000000001", expectedDocVersion: 1, gstApplicable: false, gstRateBps: 1800 }).success).toBe(false);
  });
});
