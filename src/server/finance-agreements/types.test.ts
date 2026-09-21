import { describe, expect, it } from "vitest";

import { agreementClaimId, createDraftInputFingerprint, versionDocId } from "./firestore";
import { generateAgreementRef, generateContractArtifactRef, generateExtractionRunRef } from "./ids";
import {
  activateAgreementVersionInputSchema,
  agreementCounterpartyInputSchema,
  agreementDraftSchema,
  agreementHeadDocSchema,
  agreementVersionDocSchema,
  attachExtractionInputSchema,
  confirmAgreementVersionInputSchema,
  confirmedAgreementTermsSchema,
  contractArtifactDocSchema,
  createAgreementDraftInputSchema,
  createAgreementRevisionInputSchema,
  decideFieldInputSchema,
  endAgreementInputSchema,
  extractionProposalSchema,
  extractionRunDocSchema,
  performanceTargetSchema,
  resumeAgreementInputSchema,
  suspendAgreementInputSchema,
  type ConfirmedAgreementTerms,
} from "./types";

const NOW = "2026-01-01T00:00:00.000Z";
const AGR = "agr_0123456789abcdef0123";
const PROVENANCE = { label: "Test" };

function baseTerms(over: Partial<ConfirmedAgreementTerms> = {}): ConfirmedAgreementTerms {
  return {
    agreementNumber: null,
    dates: { signedDate: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    contractTerms: { renewalTerms: null, noticeTerms: null, terminationTerms: null },
    platform: { platforms: [], collaboratorPageLink: null, collaboratorPageName: null },
    commercial: {
      currency: null,
      paymentCycle: null,
      fixedComponent: null,
      monthlyRequiredQualifyingContentCount: null,
      qualifyingUnit: null,
      accountTransferFee: null,
      advancePayment: null,
      invoiceRequired: null,
      invoiceDueTerms: null,
      paymentDueTerms: null,
      servicesMandated: null,
      incentive: null,
      lfcSfc: null,
    },
    performanceTargets: [],
    admin: { onboardingProcessCompleted: null, remarks: null },
    agreementType: "UNSPECIFIED",
    ...over,
  };
}

describe("ConfirmedAgreementTerms", () => {
  it("accepts a minimal valid terms object", () => {
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms()).success).toBe(true);
  });

  it("rejects unknown/extra keys at every level (strict)", () => {
    expect(confirmedAgreementTermsSchema.safeParse({ ...baseTerms(), campaignRef: "x" }).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse({ ...baseTerms(), commercial: { ...baseTerms().commercial, deliverableCount: 3 } }).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse({ ...baseTerms(), dates: { ...baseTerms().dates, extra: 1 } }).success).toBe(false);
  });

  it("amounts are integer minor units: a float, a negative and a string are rejected", () => {
    const withAmount = (amountMinor: unknown) => baseTerms({ agreementType: "FIXED_ONLY", commercial: { ...baseTerms().commercial, currency: "INR", fixedComponent: { applicable: true, amountMinor: amountMinor as number } } });
    expect(confirmedAgreementTermsSchema.safeParse(withAmount(1_000_000)).success).toBe(true);
    for (const bad of [10.5, -1, "1000", Number.NaN]) expect(confirmedAgreementTermsSchema.safeParse(withAmount(bad)).success).toBe(false);
  });

  it("requires a currency when an amount is present, and a 3-letter uppercase code", () => {
    const terms = baseTerms({ agreementType: "FIXED_ONLY", commercial: { ...baseTerms().commercial, fixedComponent: { applicable: true, amountMinor: 100 } } });
    expect(confirmedAgreementTermsSchema.safeParse(terms).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse({ ...terms, commercial: { ...terms.commercial, currency: "inr" } }).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse({ ...terms, commercial: { ...terms.commercial, currency: "INR" } }).success).toBe(true);
  });

  it("agreementType must equal the type derived from the confirmed commercial structure", () => {
    const commercial = { ...baseTerms().commercial, currency: "INR", fixedComponent: { applicable: true, amountMinor: 100 } };
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ commercial, agreementType: "FIXED_ONLY" })).success).toBe(true);
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ commercial, agreementType: "INCENTIVE_BASED" })).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ agreementType: "FIXED_ONLY" })).success).toBe(false);
  });

  it("a required count and its qualifying unit come together", () => {
    const commercial = { ...baseTerms().commercial, monthlyRequiredQualifyingContentCount: 4 };
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ commercial, agreementType: "REQUIRED_CONTENT_BASED" })).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ commercial: { ...commercial, qualifyingUnit: "approved_content_thread" }, agreementType: "REQUIRED_CONTENT_BASED" })).success).toBe(true);
  });

  it("the termination date cannot precede the effective date; dates must be real calendar dates", () => {
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ dates: { signedDate: null, effectiveFrom: "2026-06-01", effectiveTo: "2026-05-01" } })).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ dates: { signedDate: null, effectiveFrom: "2026-02-30", effectiveTo: null } })).success).toBe(false);
  });

  it("platforms are normalized and duplicates (after normalization) rejected", () => {
    const parsed = confirmedAgreementTermsSchema.parse(baseTerms({ platform: { platforms: [" Instagram ", "YouTube"], collaboratorPageLink: null, collaboratorPageName: null } }));
    expect(parsed.platform.platforms).toEqual(["instagram", "youtube"]);
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ platform: { platforms: ["instagram", "Instagram"], collaboratorPageLink: null, collaboratorPageName: null } })).success).toBe(false);
  });

  it("lfcSfc is null unless explicit; when present it needs formats classified LFC/SFC only", () => {
    const commercial = (lfcSfc: unknown) => baseTerms({ commercial: { ...baseTerms().commercial, lfcSfc: lfcSfc as never } });
    expect(confirmedAgreementTermsSchema.safeParse(commercial(null)).success).toBe(true);
    expect(confirmedAgreementTermsSchema.safeParse(commercial({ byFormat: { reel: "LFC", post: "SFC" } })).success).toBe(true);
    expect(confirmedAgreementTermsSchema.safeParse(commercial({ byFormat: {} })).success).toBe(false);
    expect(confirmedAgreementTermsSchema.safeParse(commercial({ byFormat: { reel: "MFC" } })).success).toBe(false);
  });
});

describe("performance targets are warning-only (affectsPayment is ALWAYS false)", () => {
  const target = { targetRef: "t1", metricId: "views", targetValue: 5000, unit: "views", comparison: "at_least" as const };

  it("parses with affectsPayment:false", () => {
    expect(performanceTargetSchema.parse({ ...target, affectsPayment: false }).affectsPayment).toBe(false);
  });
  it("rejects affectsPayment:true, a missing flag, or any other value", () => {
    for (const bad of [true, undefined, "false", 0, null]) expect(performanceTargetSchema.safeParse({ ...target, affectsPayment: bad }).success).toBe(false);
    expect(performanceTargetSchema.safeParse(target).success).toBe(false);
  });
  it("a target inside the terms cannot carry affectsPayment:true either", () => {
    const terms = baseTerms({ performanceTargets: [{ ...target, affectsPayment: false }] });
    expect(confirmedAgreementTermsSchema.safeParse(terms).success).toBe(true);
    expect(confirmedAgreementTermsSchema.safeParse({ ...terms, performanceTargets: [{ ...target, affectsPayment: true }] }).success).toBe(false);
  });
  it("only at_least exists; target refs are unique", () => {
    expect(performanceTargetSchema.safeParse({ ...target, comparison: "at_most", affectsPayment: false }).success).toBe(false);
    const dup = [{ ...target, affectsPayment: false as const }, { ...target, affectsPayment: false as const }];
    expect(confirmedAgreementTermsSchema.safeParse(baseTerms({ performanceTargets: dup })).success).toBe(false);
  });
});

describe("strict command input schemas", () => {
  const partner = { type: "PARTNER" as const, partnerRef: "p1" };

  it("createAgreementDraft: accepts a Partner (+ account refs) and a Vendor", () => {
    expect(createAgreementDraftInputSchema.safeParse({ clientRequestId: "req-12345678", counterparty: { ...partner, partnerAccountRefs: ["a1", "a2"] } }).success).toBe(true);
    expect(createAgreementDraftInputSchema.safeParse({ clientRequestId: "req-12345678", counterparty: { type: "VENDOR", vendorRef: "v1" }, sourceMode: "EXTRACTED" }).success).toBe(true);
  });
  it("createAgreementDraft: rejects unknown keys everywhere - a client can never supply platformScope, uid or scope", () => {
    const base = { clientRequestId: "req-12345678", counterparty: partner };
    expect(createAgreementDraftInputSchema.safeParse({ ...base, ownerUid: "x" }).success).toBe(false);
    expect(createAgreementDraftInputSchema.safeParse({ ...base, counterparty: { ...partner, platformScope: ["instagram"] } }).success).toBe(false);
    expect(createAgreementDraftInputSchema.safeParse({ ...base, counterparty: { ...partner, partnerUid: "u" } }).success).toBe(false);
    expect(createAgreementDraftInputSchema.safeParse({ ...base, counterparty: { type: "VENDOR", vendorRef: "v", partnerRef: "p" } }).success).toBe(false);
    expect(createAgreementDraftInputSchema.safeParse({ ...base, campaignRef: "c" }).success).toBe(false);
  });
  it("createAgreementDraft: needs a well-formed clientRequestId and a known counterparty type", () => {
    expect(createAgreementDraftInputSchema.safeParse({ clientRequestId: "short", counterparty: partner }).success).toBe(false);
    expect(createAgreementDraftInputSchema.safeParse({ clientRequestId: "has spaces here", counterparty: partner }).success).toBe(false);
    expect(agreementCounterpartyInputSchema.safeParse({ type: "CREATOR", creatorRef: "c" }).success).toBe(false);
  });

  const lifecycleBase = { agreementRef: AGR, expectedDocVersion: 1 };
  it("lifecycle inputs are strict, need expectedDocVersion, and suspend/end need a reason", () => {
    expect(activateAgreementVersionInputSchema.safeParse({ ...lifecycleBase, version: 1 }).success).toBe(true);
    expect(activateAgreementVersionInputSchema.safeParse({ ...lifecycleBase, version: 1, status: "ACTIVE" }).success).toBe(false);
    expect(activateAgreementVersionInputSchema.safeParse({ agreementRef: AGR, version: 1 }).success).toBe(false);
    expect(confirmAgreementVersionInputSchema.safeParse({ ...lifecycleBase, version: 1 }).success).toBe(true);
    expect(confirmAgreementVersionInputSchema.safeParse({ ...lifecycleBase, version: 1, terms: {} }).success).toBe(false);
    expect(createAgreementRevisionInputSchema.safeParse(lifecycleBase).success).toBe(true);
    expect(resumeAgreementInputSchema.safeParse(lifecycleBase).success).toBe(true);
    expect(suspendAgreementInputSchema.safeParse(lifecycleBase).success).toBe(false);
    expect(suspendAgreementInputSchema.safeParse({ ...lifecycleBase, reason: "  " }).success).toBe(false);
    expect(suspendAgreementInputSchema.safeParse({ ...lifecycleBase, reason: "Payment dispute" }).success).toBe(true);
    expect(endAgreementInputSchema.safeParse(lifecycleBase).success).toBe(false);
    expect(endAgreementInputSchema.safeParse({ ...lifecycleBase, reason: "Contract terminated" }).success).toBe(true);
    expect(attachExtractionInputSchema.safeParse({ ...lifecycleBase, version: 1, extractionRunRef: generateExtractionRunRef() }).success).toBe(true);
    expect(attachExtractionInputSchema.safeParse({ ...lifecycleBase, version: 1, extractionRunRef: "nope" }).success).toBe(false);
  });
  it("agreement refs must have the agr_ + 20 hex shape", () => {
    expect(resumeAgreementInputSchema.safeParse({ agreementRef: "../etc", expectedDocVersion: 1 }).success).toBe(false);
    expect(resumeAgreementInputSchema.safeParse({ agreementRef: generateAgreementRef(), expectedDocVersion: 1 }).success).toBe(true);
    expect(generateContractArtifactRef()).toMatch(/^ca_[0-9a-f]{20}$/);
  });

  describe("decideField", () => {
    const base = { agreementRef: AGR, version: 1, expectedDocVersion: 1 };
    it("CORRECTED needs a value; UNAVAILABLE/NOT_APPLICABLE forbid one; ACCEPTED may omit it", () => {
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "state", decision: "CORRECTED" }).success).toBe(false);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "state", decision: "CORRECTED", value: "Kerala" }).success).toBe(true);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "state", decision: "UNAVAILABLE", value: "Kerala" }).success).toBe(false);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "state", decision: "ACCEPTED" }).success).toBe(true);
    });
    it("normalizes the value on the way in and rejects unknown keys / unknown field keys", () => {
      const parsed = decideFieldInputSchema.parse({ ...base, fieldKey: "platforms", decision: "CORRECTED", value: ["Instagram "] });
      expect(parsed.value).toEqual(["instagram"]);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "state", decision: "ACCEPTED", extra: 1 }).success).toBe(false);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "campaignRef", decision: "ACCEPTED" }).success).toBe(false);
    });
    it("an identity value can be neither supplied nor corrected; computed fields cannot be decided", () => {
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "panNumber", decision: "CORRECTED", value: "ABCDE1234F" }).success).toBe(false);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "ifsc", decision: "ACCEPTED", value: "HDFC0001234" }).success).toBe(false);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "ifsc", decision: "ACCEPTED" }).success).toBe(true);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "agreementType", decision: "ACCEPTED" }).success).toBe(false);
    });
    it("validates the value against the field's own shape (amounts as integer minor units)", () => {
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 250000 } }).success).toBe(true);
      expect(decideFieldInputSchema.safeParse({ ...base, fieldKey: "fixedComponent", decision: "CORRECTED", value: { applicable: true, amountMinor: 2500.5 } }).success).toBe(false);
    });
  });
});

describe("draft working copy never holds identity values", () => {
  const entry = (over: object) => ({ value: null, origin: "MANUAL", decision: "ACCEPTED", provenance: PROVENANCE, ...over });
  it("rejects a value (or extractedValue) on an identity VALUE field", () => {
    expect(agreementDraftSchema.safeParse({ panNumber: entry({ value: "ABCDE1234F" }) }).success).toBe(false);
    expect(agreementDraftSchema.safeParse({ ifsc: entry({ extractedValue: "HDFC0001234" }) }).success).toBe(false);
    expect(agreementDraftSchema.safeParse({ panNumber: entry({}) }).success).toBe(true);
  });
  it("rejects a value under an UNAVAILABLE / NOT_APPLICABLE decision, and an unknown field key", () => {
    expect(agreementDraftSchema.safeParse({ state: entry({ decision: "UNAVAILABLE", value: "Kerala" }) }).success).toBe(false);
    expect(agreementDraftSchema.safeParse({ campaignRef: entry({}) }).success).toBe(false);
  });
});

describe("head / version document invariants", () => {
  const partnerCp = { type: "PARTNER" as const, partnerRef: "p1", partnerAccountRefs: [], platformScope: [] };
  const head = (over: object = {}) => ({
    agreementRef: AGR, docVersion: 1, counterparty: partnerCp, ownerUid: null, regionIds: [], teamIds: [], partnerUid: "pu1", vendorUid: null,
    status: "DRAFT", latestVersion: 1, openVersion: 1, activeVersion: null, lastEndedVersion: null,
    createdAt: NOW, createdByUserRef: "u", updatedAt: NOW, updatedByUserRef: "u", ...over,
  });

  it("head: counterparty type and uid agree; status and activeVersion agree", () => {
    expect(agreementHeadDocSchema.safeParse(head()).success).toBe(true);
    expect(agreementHeadDocSchema.safeParse(head({ partnerUid: null })).success).toBe(false);
    expect(agreementHeadDocSchema.safeParse(head({ vendorUid: "v" })).success).toBe(false);
    expect(agreementHeadDocSchema.safeParse(head({ counterparty: { type: "VENDOR", vendorRef: "v1" }, partnerUid: null, vendorUid: "vu1" })).success).toBe(true);
    expect(agreementHeadDocSchema.safeParse(head({ status: "ACTIVE" })).success).toBe(false);
    expect(agreementHeadDocSchema.safeParse(head({ status: "ACTIVE", activeVersion: 1 })).success).toBe(true);
    expect(agreementHeadDocSchema.safeParse(head({ status: "ENDED" })).success).toBe(false);
    expect(agreementHeadDocSchema.safeParse(head({ openVersion: 5 })).success).toBe(false);
  });
  it("head: rejects unknown keys (strict)", () => {
    expect(agreementHeadDocSchema.safeParse(head({ campaignRef: "c" })).success).toBe(false);
  });

  const version = (over: object = {}) => ({
    agreementRef: AGR, version: 1, status: "DRAFT", docVersion: 1, counterparty: partnerCp, sourceMode: "MANUAL", source: {}, draft: {},
    createdAt: NOW, createdByUserRef: "u", updatedAt: NOW, updatedByUserRef: "u", ...over,
  });
  const confirmed = () => ({
    terms: baseTerms(),
    contactSnapshot: { counterpartyName: "A", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: null },
    identityStatusSnapshot: { state: "MISSING", components: { pan: "MISSING", aadhaar: "MISSING", gst: "NOT_APPLICABLE", bank: "MISSING" }, capturedAt: NOW },
    fieldProvenance: {},
    effective: { signedDate: null, effectiveFrom: "2026-01-01", effectiveTo: null },
    confirmation: { confirmedByUserRef: "u", confirmedAt: NOW },
  });

  it("version: a fresh DRAFT parses; defaults fill the lifecycle fields", () => {
    const parsed = agreementVersionDocSchema.parse(version());
    expect(parsed.terms).toBeNull();
    expect(parsed.activation).toBeNull();
  });
  it("version: confirmed parts are set together, clear the draft, and effective mirrors the terms' dates", () => {
    expect(agreementVersionDocSchema.safeParse(version(confirmed())).success).toBe(true);
    expect(agreementVersionDocSchema.safeParse(version({ ...confirmed(), confirmation: null })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...confirmed(), draft: { state: { value: null, origin: "MANUAL", decision: "PENDING", provenance: PROVENANCE } } })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...confirmed(), effective: { signedDate: null, effectiveFrom: "2027-01-01", effectiveTo: null } })).success).toBe(false);
  });
  it("version: only a confirmed, activated version can be ACTIVE/SUSPENDED/ENDED/SUPERSEDED, each with its own facts", () => {
    const active = { ...confirmed(), status: "ACTIVE", activation: { activatedByUserRef: "u", activatedAt: NOW } };
    expect(agreementVersionDocSchema.safeParse(version(active)).success).toBe(true);
    expect(agreementVersionDocSchema.safeParse(version({ status: "ACTIVE" })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "SUSPENDED" })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "SUSPENDED", suspendedAt: NOW })).success).toBe(true);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "ENDED", endedAt: NOW })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "ENDED", endedAt: NOW, endReason: "Done" })).success).toBe(true);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "SUPERSEDED" })).success).toBe(false);
    expect(agreementVersionDocSchema.safeParse(version({ ...active, status: "SUPERSEDED", supersededByVersion: 2 })).success).toBe(true);
    expect(agreementVersionDocSchema.safeParse(version({ activation: { activatedByUserRef: "u", activatedAt: NOW } })).success).toBe(false);
  });
});

describe("artifact / extraction schemas", () => {
  const artifact = { artifactRef: generateContractArtifactRef(), fileName: "c.pdf", mimeType: "application/pdf", sizeBytes: 1000, sha256: "a".repeat(64), uploadedByUserRef: "u", uploadedAt: NOW, counterparty: { type: "PARTNER", ref: "p1" }, status: "UPLOADED", storageLocator: "loc" };
  it("contract artifact: PDF only, <= 10 MB", () => {
    expect(contractArtifactDocSchema.safeParse(artifact).success).toBe(true);
    expect(contractArtifactDocSchema.safeParse({ ...artifact, mimeType: "image/png" }).success).toBe(false);
    expect(contractArtifactDocSchema.safeParse({ ...artifact, sizeBytes: 10 * 1024 * 1024 + 1 }).success).toBe(false);
  });
  it("extraction proposals always require human confirmation and never carry an identity value", () => {
    const proposal = { fieldKey: "currency", normalizedValue: "INR", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, source: { page: 1 } };
    expect(extractionProposalSchema.safeParse(proposal).success).toBe(true);
    expect(extractionProposalSchema.safeParse({ ...proposal, requiresHumanConfirmation: false }).success).toBe(false);
    expect(extractionProposalSchema.safeParse({ ...proposal, fieldKey: "panNumber" }).success).toBe(false);
    expect(extractionProposalSchema.safeParse({ ...proposal, fieldKey: "panNumber", normalizedValue: null }).success).toBe(true);
    expect(extractionProposalSchema.safeParse({ ...proposal, confidence: "CERTAIN" }).success).toBe(false);
  });
  it("extraction run status is completeness only", () => {
    const run = { runRef: generateExtractionRunRef(), agreementRef: AGR, artifactRef: "ca_x", status: "MANUAL_REVIEW_REQUIRED", reasonCodes: ["no_extractable_text"], parserVersion: "1", pageCount: 0, charCount: 0, proposals: [], createdAt: NOW, createdByUserRef: "u" };
    expect(extractionRunDocSchema.safeParse(run).success).toBe(true);
    expect(extractionRunDocSchema.safeParse({ ...run, status: "VERIFIED" }).success).toBe(false);
  });
});

describe("deterministic ids", () => {
  it("claim id is sha256(actorUid|clientRequestId): deterministic, actor-scoped, and hides both inputs", () => {
    const a = agreementClaimId("actor-1", "req-12345678");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(agreementClaimId("actor-1", "req-12345678")).toBe(a);
    expect(agreementClaimId("actor-2", "req-12345678")).not.toBe(a);
    expect(agreementClaimId("actor-1", "req-87654321")).not.toBe(a);
    expect(a).not.toContain("actor-1");
    // the separator prevents ("ab","c") == ("a","bc")
    expect(agreementClaimId("ab", "c")).not.toBe(agreementClaimId("a", "bc"));
  });
  it("version doc id is the plain integer as a string", () => {
    expect(versionDocId(1)).toBe("1");
    expect(versionDocId(12)).toBe("12");
  });
  it("the create-draft fingerprint is stable and order-insensitive over account refs; differs when the payload differs", () => {
    const one = createDraftInputFingerprint({ type: "PARTNER", partnerRef: "p", partnerAccountRefs: ["b", "a", "a"] });
    expect(createDraftInputFingerprint({ type: "PARTNER", partnerRef: "p", partnerAccountRefs: ["a", "b"] })).toBe(one);
    expect(createDraftInputFingerprint({ type: "PARTNER", partnerRef: "p" })).not.toBe(one);
    expect(createDraftInputFingerprint({ type: "VENDOR", vendorRef: "p" })).not.toBe(createDraftInputFingerprint({ type: "PARTNER", partnerRef: "p" }));
  });
  it("generated refs have the expected shapes and are unique", () => {
    const refs = new Set(Array.from({ length: 50 }, () => generateAgreementRef()));
    expect(refs.size).toBe(50);
    for (const ref of refs) expect(ref).toMatch(/^agr_[0-9a-f]{20}$/);
  });
});
