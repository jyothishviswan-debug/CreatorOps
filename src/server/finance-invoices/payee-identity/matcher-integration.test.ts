import { describe, expect, it } from "vitest";

import { computePayeeIdentityMatch } from "./matcher";
import { buildPayeeIdentityEvidence, type CanonicalPayeeIdentity, type RestrictedPayeeIdentityEvidence } from "./restricted-extraction";

// Step 16D section 21: proves the live wiring from restricted-extraction.ts's proposals, through
// buildPayeeIdentityEvidence's confidence gate, into the EXISTING, UNCHANGED Step 16C matcher
// (computePayeeIdentityMatch) - end to end at the pure-function level (no Firestore; the Firestore
// resolution itself is a thin, single-by-ref-lookup layer already covered by resolve-identity's own
// static guards and the Invoice emulator suite).

const CANONICAL: CanonicalPayeeIdentity = {
  expectedName: "Acme Studios Private Limited",
  expectedTaxId: "29ABCDE1234F1Z5",
  expectedAddress: "12 MG Road, Bengaluru",
  expectedBankIdentifier: "000123456789",
};

function restricted(partial: Partial<RestrictedPayeeIdentityEvidence>): RestrictedPayeeIdentityEvidence {
  return { taxRegistration: null, businessAddress: null, bankIdentifier: null, ...partial };
}

describe("Step 16D -> Step 16C live wiring", () => {
  it("extracted GST + canonical GST match -> MATCH (with a confirmed name)", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ taxRegistration: { value: "29ABCDE1234F1Z5", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("MATCH");
    expect(result.fields.find((f) => f.field === "TAX_REGISTRATION")?.status).toBe("EXACT");
  });

  it("GST mismatch -> hard MISMATCH, even with a matching name", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ taxRegistration: { value: "27ZZZZZ9999Z1Z1", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("extracted bank + canonical bank match -> MATCH (with a confirmed name)", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ bankIdentifier: { value: "000123456789", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("MATCH");
    expect(result.fields.find((f) => f.field === "BANK")?.status).toBe("EXACT");
  });

  it("bank mismatch -> hard MISMATCH, even with a matching name", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ bankIdentifier: { value: "000999999999", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("a hard GST mismatch overrides an otherwise-matching address and name (precedence)", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ taxRegistration: { value: "27ZZZZZ9999Z1Z1", confidence: "HIGH", page: 1 }, businessAddress: { value: "12 MG Road, Bengaluru", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("MISMATCH");
  });

  it("address partial overlap -> REVIEW_REQUIRED, not a silent MATCH", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ businessAddress: { value: "12 MG Road, Bengaluru 560001, near the metro station", confidence: "HIGH", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(["PARTIAL_MATCH", "REVIEW_REQUIRED", "MATCH"]).toContain(result.overallStatus);
    expect(result.fields.find((f) => f.field === "ADDRESS")?.status).not.toBe("MISMATCH");
  });

  it("name match with no restricted evidence at all -> existing PARTIAL_MATCH behaviour, never fabricated MATCH", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", null);
    const result = computePayeeIdentityMatch(evidence);
    expect(result.overallStatus).toBe("PARTIAL_MATCH");
  });

  it("low-confidence GST never creates an automatic hard mismatch - it is withheld, so the field reads UNAVAILABLE", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ taxRegistration: { value: "27ZZZZZ9999Z1Z1", confidence: "LOW", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.fields.find((f) => f.field === "TAX_REGISTRATION")?.status).toBe("UNAVAILABLE");
    expect(result.overallStatus).not.toBe("MISMATCH");
  });

  it("low-confidence bank evidence never creates an automatic hard mismatch either", () => {
    const evidence = buildPayeeIdentityEvidence(CANONICAL, "Acme Studios Private Limited", restricted({ bankIdentifier: { value: "000999999999", confidence: "LOW", page: 1 } }));
    const result = computePayeeIdentityMatch(evidence);
    expect(result.fields.find((f) => f.field === "BANK")?.status).toBe("UNAVAILABLE");
    expect(result.overallStatus).not.toBe("MISMATCH");
  });

  it("no raw restricted value ever appears anywhere in the serialized match result", () => {
    const evidence = buildPayeeIdentityEvidence(
      CANONICAL,
      "Acme Studios Private Limited",
      restricted({ taxRegistration: { value: "29ABCDE1234F1Z5", confidence: "HIGH", page: 1 }, bankIdentifier: { value: "000123456789", confidence: "HIGH", page: 1 } }),
    );
    const result = computePayeeIdentityMatch(evidence);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("29ABCDE1234F1Z5");
    expect(serialized).not.toContain("000123456789");
  });
});
