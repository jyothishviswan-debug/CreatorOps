import { describe, expect, it } from "vitest";

import type { AgreementVersionDto } from "@/server/finance-agreements/client-dto";
import type { FieldReconciliationDto } from "@/server/finance-agreements/reconciliation-compare";
import type { ConfirmedAgreementTerms, ContactSnapshot } from "@/server/finance-agreements/terms";

import { IDENTITY_NOT_STORED_TEXT, buildComparisonRows, buildProvenanceRows, provenanceText, reconciliationAttentionCount, reconciliationSummaryChips } from "./verification-view";

const TERMS: ConfirmedAgreementTerms = {
  agreementNumber: null,
  dates: { signedDate: null, effectiveFrom: "2026-09-01", effectiveTo: null },
  contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null },
  platform: { platforms: ["instagram"], collaboratorPageLink: null, collaboratorPageName: null },
  commercial: { currency: "INR", paymentCycle: "MONTHLY", fixedComponent: { applicable: true, amountMinor: 3500000 }, monthlyRequiredQualifyingContentCount: null, qualifyingUnit: null, accountTransferFee: null, advancePayment: null, invoiceRequired: null, invoiceDueTerms: null, paymentDueTerms: null, servicesMandated: null, incentive: null, lfcSfc: null, contentObligations: [], monetisationTerms: null },
  performanceTargets: [],
  performanceEvaluationClause: null,
  admin: { onboardingProcessCompleted: null, remarks: null },
  agreementType: "FIXED_ONLY",
};
const CONTACT: ContactSnapshot = { counterpartyName: "Asha Rao", contactNumber: null, emailAddress: "asha@example.com", state: null, address: null, pinCode: null };

const provenance = (label: string, page: number | null = null, confidence: "HIGH" | "LOW" | null = null) => ({ label, extractionRunRef: null, page, confidence });

const VERSION: Pick<AgreementVersionDto, "fieldProvenance" | "terms" | "contactSnapshot"> = {
  terms: TERMS,
  contactSnapshot: CONTACT,
  fieldProvenance: {
    // Deliberately NOT in registry order.
    fixedComponent: { origin: "EXTRACTED", decision: "CORRECTED", decidedByUserRef: "usr_a", decidedAt: "2026-09-01T10:00:00.000Z", provenance: provenance("Agreement", 3, "HIGH") },
    emailAddress: { origin: "MASTER_DATA", decision: "ACCEPTED", decidedByUserRef: "usr_a", decidedAt: "2026-09-01T10:00:00.000Z", provenance: provenance("CreatorOps master data") },
    panNumber: { origin: "MANUAL", decision: "ACCEPTED", decidedByUserRef: "usr_a", decidedAt: null, provenance: provenance("Manual entry") },
    signedDate: { origin: "MANUAL", decision: "UNAVAILABLE", decidedByUserRef: null, decidedAt: null, provenance: provenance("Manual entry") },
  },
};

describe("frozen provenance rows", () => {
  const rows = buildProvenanceRows(VERSION);

  it("lists every frozen field in registry order with its decision, source and provenance", () => {
    expect(rows.map((row) => row.fieldKey)).toEqual(["emailAddress", "panNumber", "signedDate", "fixedComponent"]);
    const fixed = rows.find((row) => row.fieldKey === "fixedComponent")!;
    expect(fixed).toMatchObject({ label: "Fixed component", source: "Agreement", provenance: "Agreement · page 3 · Confidence: High", value: "₹35,000" });
    expect(fixed.decision.label).toBe("Corrected");
    expect(rows.find((row) => row.fieldKey === "emailAddress")).toMatchObject({ source: "CreatorOps master data", value: "asha@example.com" });
  });

  it("never prints an identity value; states it is not stored", () => {
    const pan = rows.find((row) => row.fieldKey === "panNumber")!;
    expect(pan.value).toBe(IDENTITY_NOT_STORED_TEXT);
  });

  it("an UNAVAILABLE decision reads Unavailable, and a missing timestamp / actor is a dash / null", () => {
    const signed = rows.find((row) => row.fieldKey === "signedDate")!;
    expect(signed.value).toBe("Unavailable");
    expect(signed.decidedAt).toBe("—");
    expect(signed.decidedBy).toBeNull();
  });

  it("a version with no frozen provenance (an unconfirmed draft) has no rows", () => {
    expect(buildProvenanceRows({ fieldProvenance: null, terms: null, contactSnapshot: null })).toEqual([]);
  });

  it("provenanceText omits what is not known", () => {
    expect(provenanceText({ provenance: provenance("Manual entry") })).toBe("Manual entry");
    expect(provenanceText({ provenance: provenance("Agreement", 2, "LOW") })).toBe("Agreement · page 2 · Confidence: Low");
  });
});

const field = (over: Partial<FieldReconciliationDto> & { fieldKey: FieldReconciliationDto["fieldKey"]; state: FieldReconciliationDto["state"] }): FieldReconciliationDto => ({ label: over.fieldKey, group: "counterparty_contact", source: { canonical: null, agreement: null }, allowedActions: [], ...over });

describe("live comparison rows", () => {
  const rows = buildComparisonRows({
    versionConfirmed: true,
    versionStatus: "ACTIVE",
    fields: [
      field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "old@example.com", confirmedValue: "new@example.com", agreementDecision: "CORRECTED", allowedActions: ["OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"] }),
      field({ fieldKey: "panNumber", group: "identity", state: "MISMATCH", canonicalValue: "ABCDE1234F", extractedValue: "ZZZZZ9999Z" }),
      field({ fieldKey: "gstin", group: "identity", state: "RESTRICTED" }),
      field({ fieldKey: "address", state: "UNAVAILABLE", reason: "no_canonical_field" }),
    ],
  });

  it("shows ordinary values on both sides and highlights only a mismatch (text carries the meaning)", () => {
    const email = rows.find((row) => row.fieldKey === "emailAddress")!;
    expect(email).toMatchObject({ creatorOpsText: "old@example.com", agreementText: "new@example.com", highlight: true, identity: false });
    expect(email.stateChip.label).toBe("Mismatch");
  });

  it("prints an identity value only MASKED (last four characters) even when the server supplied it in full", () => {
    const pan = rows.find((row) => row.fieldKey === "panNumber")!;
    expect(pan).toMatchObject({ creatorOpsText: "••••••234F", agreementText: "••••••999Z", identity: true });
    expect(JSON.stringify(rows)).not.toMatch(/ABCDE1234F|ZZZZZ9999Z/);
    expect(rows.find((row) => row.fieldKey === "gstin")).toMatchObject({ creatorOpsText: "Restricted", agreementText: "Restricted" });
  });

  it("a field CreatorOps has no place for says so", () => {
    expect(rows.find((row) => row.fieldKey === "address")).toMatchObject({ creatorOpsText: "Not available in CreatorOps", reason: "CreatorOps has no field for this yet." });
  });

  it("offers no action of any kind (read-only)", () => {
    expect(rows.every((row) => !("actions" in row))).toBe(true);
  });
});

describe("summary", () => {
  it("chips only the states that occur, in a fixed order, with their text", () => {
    const chips = reconciliationSummaryChips({ MATCH: 6, MISMATCH: 1, MISSING_IN_CREATOROPS: 0, MISSING_IN_AGREEMENT: 2, NOT_APPLICABLE: 3 });
    expect(chips.map((chip) => `${chip.label} ${chip.count}`)).toEqual(["Match 6", "Mismatch 1", "Missing in Agreement 2", "Not applicable 3"]);
    expect(reconciliationSummaryChips({})).toEqual([]);
  });

  it("counts the differences that need attention", () => {
    expect(reconciliationAttentionCount({ MATCH: 6, MISMATCH: 1, MISSING_IN_CREATOROPS: 2, MISSING_IN_AGREEMENT: 3, UNAVAILABLE: 9 })).toBe(6);
    expect(reconciliationAttentionCount({})).toBe(0);
  });
});
