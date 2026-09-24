import { describe, expect, it } from "vitest";

import { computePayeeIdentityMatch, displayOverallStatus, payeeIdentityApprovalBlocker, type PayeeIdentityEvidence } from "./matcher";

// Step 16C section 23: unit tests for the overall decision engine, the approval blocker, override
// display behavior, and version-scoped immutability.

const FULL_EVIDENCE: PayeeIdentityEvidence = {
  expectedName: "Acme Studios Private Limited",
  extractedName: "Acme Studios",
  expectedTaxId: "29ABCDE1234F1Z5",
  extractedTaxId: "29ABCDE1234F1Z5",
  expectedAddress: "12 MG Road, Bengaluru",
  extractedAddress: "12 mg road bengaluru",
  expectedBankIdentifier: "1234567890",
  extractedBankIdentifier: "1234567890",
};

function only(evidence: Partial<PayeeIdentityEvidence>): PayeeIdentityEvidence {
  return {
    expectedName: null,
    extractedName: null,
    expectedTaxId: null,
    extractedTaxId: null,
    expectedAddress: null,
    extractedAddress: null,
    expectedBankIdentifier: null,
    extractedBankIdentifier: null,
    ...evidence,
  };
}

describe("computePayeeIdentityMatch - overall status", () => {
  it("MATCH: all strong fields match (name + tax + bank all corroborate)", () => {
    const result = computePayeeIdentityMatch(FULL_EVIDENCE);
    expect(result.overallStatus).toBe("MATCH");
  });

  it("PARTIAL_MATCH: name matches but tax registration/bank/address are unavailable", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Acme Studios" }));
    expect(result.overallStatus).toBe("PARTIAL_MATCH");
  });

  it("MISMATCH: hard tax registration mismatch overrides a matching name", () => {
    const result = computePayeeIdentityMatch({
      ...only({ expectedName: "Acme Studios", extractedName: "Acme Studios" }),
      expectedTaxId: "29ABCDE1234F1Z5",
      extractedTaxId: "27ZZZZZ9999Z1Z1",
    });
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("MISMATCH: hard bank mismatch overrides a matching name", () => {
    const result = computePayeeIdentityMatch({
      ...only({ expectedName: "Acme Studios", extractedName: "Acme Studios" }),
      expectedBankIdentifier: "1234567890",
      extractedBankIdentifier: "9999999999",
    });
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("MISMATCH: a clearly different legal name", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media Ventures" }));
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("hard mismatch precedence: bank mismatch is never hidden by a matching address or trading name", () => {
    const result = computePayeeIdentityMatch({
      expectedName: "Acme Studios",
      extractedName: "Acme Studios",
      expectedTaxId: null,
      extractedTaxId: null,
      expectedAddress: "12 MG Road, Bengaluru",
      extractedAddress: "12 mg road bengaluru",
      expectedBankIdentifier: "1234567890",
      extractedBankIdentifier: "0000000000",
    });
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("INSUFFICIENT_EVIDENCE: no usable evidence on either side", () => {
    const result = computePayeeIdentityMatch(only({}));
    expect(result.overallStatus).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("INSUFFICIENT_EVIDENCE: canonical counterparty has no comparable identity fields at all", () => {
    const result = computePayeeIdentityMatch(only({ extractedName: "Acme Studios" }));
    expect(result.overallStatus).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("REVIEW_REQUIRED: an ambiguous (partially overlapping) name needs a human decision", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Global Studios", extractedName: "Acme Studios" }));
    expect(result.overallStatus).toBe("REVIEW_REQUIRED");
  });

  it("never returns OVERRIDDEN - that is a display-only projection, not a computed state", () => {
    const result = computePayeeIdentityMatch(FULL_EVIDENCE);
    expect(result.overallStatus).not.toBe("OVERRIDDEN");
  });
});

describe("payeeIdentityApprovalBlocker", () => {
  it("no context => no blocker (feature not evaluated for this version)", () => {
    expect(payeeIdentityApprovalBlocker(null, null, 1)).toBeNull();
  });

  it("MATCH => no blocker", () => {
    const result = computePayeeIdentityMatch(FULL_EVIDENCE);
    expect(payeeIdentityApprovalBlocker(result, null, 1)).toBeNull();
  });

  it("PARTIAL_MATCH => no blocker (warning only, per spec section 11's explicit resolution list)", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Acme Studios" }));
    expect(payeeIdentityApprovalBlocker(result, null, 1)).toBeNull();
  });

  it("approval BLOCKED before resolution: MISMATCH with no override", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    const blocker = payeeIdentityApprovalBlocker(result, null, 1);
    expect(blocker).not.toBeNull();
    expect(blocker?.code).toBe("PAYEE_IDENTITY_MISMATCH");
  });

  it("REVIEW_REQUIRED also requires explicit resolution before approval", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Global Studios", extractedName: "Acme Studios" }));
    expect(payeeIdentityApprovalBlocker(result, null, 1)).not.toBeNull();
  });

  it("approval ALLOWED after authorized resolution: override pinned to the exact version", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(payeeIdentityApprovalBlocker(result, { forVersion: 3 }, 3)).toBeNull();
  });

  it("an override for a DIFFERENT version does not clear the blocker (a later revision needs its own resolution)", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(payeeIdentityApprovalBlocker(result, { forVersion: 2 }, 3)).not.toBeNull();
  });
});

describe("displayOverallStatus", () => {
  it("shows OVERRIDDEN only when the override exactly pins this version and the underlying status was blocking", () => {
    const result = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(displayOverallStatus(result, { forVersion: 5 }, 5)).toBe("OVERRIDDEN");
  });

  it("never overrides a MATCH into anything else, and never forges a match for a different version", () => {
    const matched = computePayeeIdentityMatch(FULL_EVIDENCE);
    expect(displayOverallStatus(matched, { forVersion: 5 }, 5)).toBe("MATCH");

    const mismatched = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(displayOverallStatus(mismatched, { forVersion: 4 }, 5)).toBe("MISMATCH");
  });

  it("the underlying stored evidence is never mutated by the display projection (section 16)", () => {
    const mismatched = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    const before = JSON.stringify(mismatched);
    displayOverallStatus(mismatched, { forVersion: 1 }, 1);
    expect(JSON.stringify(mismatched)).toBe(before);
  });
});

describe("versioning / provenance (section 13)", () => {
  it("a new Invoice version's evidence produces its own fresh match result", () => {
    const versionOne = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Acme Studios" }));
    const versionTwo = computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(versionOne.overallStatus).toBe("PARTIAL_MATCH");
    expect(versionTwo.overallStatus).toBe("MISMATCH");
  });

  it("an old match result stays immutable when a later version's evidence changes (no shared mutable state)", () => {
    const evidence = only({ expectedName: "Acme Studios", extractedName: "Acme Studios" });
    const versionOne = computePayeeIdentityMatch(evidence);
    const frozen = JSON.parse(JSON.stringify(versionOne));
    // Recomputing for a "later version" with different evidence must never reach back and change
    // the earlier, already-returned result object.
    computePayeeIdentityMatch(only({ expectedName: "Acme Studios", extractedName: "Zenith Media" }));
    expect(JSON.parse(JSON.stringify(versionOne))).toEqual(frozen);
  });
});
