import { describe, expect, it } from "vitest";

import {
  AGREEMENT_FIELDS,
  AGREEMENT_FIELD_BY_KEY,
  AGREEMENT_FIELD_KEYS,
  AGREEMENT_FIELD_VALUE_SCHEMAS,
  assembleConfirmedAgreement,
  checkFieldDecisionValue,
  deriveAgreementType,
  deriveIdentityStatusState,
  deriveSourceMode,
  validateContactSnapshot,
  validateIdentityStatusShape,
  type AgreementFieldKey,
} from "./fields";
import type { AgreementDraft, AgreementDraftEntry } from "./types";

// The spec's "Field registry" list, copied independently so the registry cannot drift silently.
const SPEC_FIELD_KEYS = [
  "counterpartyName", "contactNumber", "emailAddress", "state", "address", "pinCode", "gstin",
  "aadhaarNumber", "aadhaarStatus", "panNumber", "panHolderName", "bankAccountNumber", "ifsc",
  "aadhaarDocumentStatus", "panDocumentStatus", "gstCertificateStatus",
  "partnerRef", "partnerAccountRefs", "platforms", "collaboratorPageLink", "collaboratorPageName",
  "agreementNumber", "signedDate", "effectiveDate", "terminationDate", "renewalTerms", "noticeTerms", "terminationTerms",
  "currency", "paymentCycle", "fixedComponent", "monthlyRequiredQualifyingContentCount", "qualifyingUnit", "accountTransferFee",
  "advancePayment", "invoiceRequired", "invoiceDueTerms", "paymentDueTerms", "servicesMandated", "incentive", "lfcSfc",
  "performanceTargets",
  "onboardingProcessCompleted", "remarks", "agreementType",
] as const;

const IDENTITY_VALUE_KEYS = ["gstin", "aadhaarNumber", "panNumber", "panHolderName", "bankAccountNumber", "ifsc"] as const;

describe("AGREEMENT_FIELDS registry", () => {
  it("covers EVERY field in the spec list, exactly once, with no extras", () => {
    expect([...AGREEMENT_FIELD_KEYS].sort()).toEqual([...SPEC_FIELD_KEYS].sort());
    expect(new Set(AGREEMENT_FIELD_KEYS).size).toBe(AGREEMENT_FIELD_KEYS.length);
    expect(AGREEMENT_FIELDS.map((field) => field.key)).toEqual([...AGREEMENT_FIELD_KEYS]);
    for (const key of SPEC_FIELD_KEYS) expect(AGREEMENT_FIELD_BY_KEY[key].key).toBe(key);
  });

  it("every field has a group, a label, a value schema and a canonicalSource", () => {
    for (const field of AGREEMENT_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.group).toBeTruthy();
      expect(AGREEMENT_FIELD_VALUE_SCHEMAS[field.key]).toBeDefined();
      expect(field.canonicalSource.kind).toBeTruthy();
    }
  });

  it("the six identity VALUE fields are restricted, and accept a null value only", () => {
    const flagged = AGREEMENT_FIELDS.filter((field) => field.identityValue).map((field) => field.key);
    expect([...flagged].sort()).toEqual([...IDENTITY_VALUE_KEYS].sort());
    for (const key of IDENTITY_VALUE_KEYS) {
      expect(AGREEMENT_FIELD_BY_KEY[key].restricted).toBe(true);
      expect(AGREEMENT_FIELD_VALUE_SCHEMAS[key].safeParse(null).success).toBe(true);
      expect(AGREEMENT_FIELD_VALUE_SCHEMAS[key].safeParse("ABCDE1234F").success).toBe(false);
    }
  });

  it("identity statuses are computed + restricted; counterparty refs and agreementType are computed", () => {
    for (const key of ["aadhaarStatus", "aadhaarDocumentStatus", "panDocumentStatus", "gstCertificateStatus"] as const) {
      expect(AGREEMENT_FIELD_BY_KEY[key]).toMatchObject({ restricted: true, mode: "COMPUTED", identityValue: false });
    }
    for (const key of ["partnerRef", "partnerAccountRefs", "agreementType"] as const) expect(AGREEMENT_FIELD_BY_KEY[key].mode).toBe("COMPUTED");
  });

  it("Aadhaar fields apply to a Partner only", () => {
    for (const key of ["aadhaarNumber", "aadhaarStatus", "aadhaarDocumentStatus"] as const) expect(AGREEMENT_FIELD_BY_KEY[key].appliesTo).toEqual(["PARTNER"]);
  });

  it("required-for-confirm: counterpartyName + effectiveDate always; currency and the count/unit pair conditionally", () => {
    const required = AGREEMENT_FIELDS.filter((field) => field.requiredForConfirm === "always").map((field) => field.key);
    expect([...required].sort()).toEqual(["counterpartyName", "effectiveDate"]);
    const conditional = AGREEMENT_FIELDS.filter((field) => field.requiredForConfirm === "conditional").map((field) => field.key);
    expect([...conditional].sort()).toEqual(["currency", "monthlyRequiredQualifyingContentCount", "qualifyingUnit"]);
    for (const key of conditional) expect(AGREEMENT_FIELD_BY_KEY[key].requiredWhen).toBeTruthy();
  });

  it("no field is a Campaign/Assignment/Deliverable/Creator concept", () => {
    for (const key of AGREEMENT_FIELD_KEYS) expect(key).not.toMatch(/campaign|assignment|deliverable|creator/i);
    // the old "Fixed deliverable units" label maps to the qualifying content count + unit fields
    expect(AGREEMENT_FIELD_BY_KEY.monthlyRequiredQualifyingContentCount.group).toBe("commercial");
    expect(AGREEMENT_FIELD_BY_KEY.qualifyingUnit.group).toBe("commercial");
  });

  it("no ordinary value schema can hold a PAN/Aadhaar/bank-shaped value under a non-identity key", () => {
    for (const field of AGREEMENT_FIELDS.filter((f) => f.identityValue)) expect(AGREEMENT_FIELD_VALUE_SCHEMAS[field.key].safeParse("123456789012").success).toBe(false);
  });
});

describe("deriveAgreementType", () => {
  const fixed = { applicable: true };
  const incentive = { applicable: true, slabs: [{}] };
  const cases: Array<[string, Parameters<typeof deriveAgreementType>[0]["commercial"], string]> = [
    ["fixed only", { fixedComponent: fixed, incentive: null, monthlyRequiredQualifyingContentCount: null }, "FIXED_ONLY"],
    ["fixed + incentive", { fixedComponent: fixed, incentive, monthlyRequiredQualifyingContentCount: null }, "FIXED_PLUS_INCENTIVE"],
    ["fixed + required content", { fixedComponent: fixed, incentive: null, monthlyRequiredQualifyingContentCount: 8 }, "FIXED_PLUS_REQUIRED_CONTENT"],
    ["fixed + incentive + required content", { fixedComponent: fixed, incentive, monthlyRequiredQualifyingContentCount: 8 }, "FIXED_PLUS_INCENTIVE_PLUS_REQUIRED_CONTENT"],
    ["required content only", { fixedComponent: null, incentive: null, monthlyRequiredQualifyingContentCount: 4 }, "REQUIRED_CONTENT_BASED"],
    ["incentive only", { fixedComponent: null, incentive, monthlyRequiredQualifyingContentCount: null }, "INCENTIVE_BASED"],
    ["incentive + required content", { fixedComponent: { applicable: false }, incentive, monthlyRequiredQualifyingContentCount: 4 }, "INCENTIVE_PLUS_REQUIRED_CONTENT"],
    ["nothing stated", { fixedComponent: null, incentive: null, monthlyRequiredQualifyingContentCount: null }, "UNSPECIFIED"],
  ];
  for (const [name, commercial, expected] of cases) {
    it(name, () => expect(deriveAgreementType({ commercial })).toBe(expected));
  }

  it("a non-applicable component, an empty incentive and a zero count do not count as structure", () => {
    expect(deriveAgreementType({ commercial: { fixedComponent: { applicable: false }, incentive: { applicable: true, slabs: [] }, monthlyRequiredQualifyingContentCount: 0 } })).toBe("UNSPECIFIED");
  });

  it("is a pure function of the commercial structure: extra fields (e.g. an extractor's guess) are never read", () => {
    const input = { commercial: { fixedComponent: fixed, incentive: null, monthlyRequiredQualifyingContentCount: null }, agreementType: "INCENTIVE_BASED", extractedAgreementType: "INCENTIVE_BASED" };
    expect(deriveAgreementType(input)).toBe("FIXED_ONLY");
  });
});

// --- confirm-time assembly -------------------------------------------------------------------------------------------------
const NOW = "2026-01-01T00:00:00.000Z";
const PROVENANCE = { label: "Test", extractionRunRef: null, page: null, confidence: null };

function entry(value: unknown, over: Partial<AgreementDraftEntry> = {}): AgreementDraftEntry {
  return { value: value as AgreementDraftEntry["value"], origin: "MANUAL", decision: "ACCEPTED", extractedValue: null, decidedByUserRef: "u1", decidedAt: NOW, provenance: PROVENANCE, ...over };
}
function unavailable(over: Partial<AgreementDraftEntry> = {}): AgreementDraftEntry {
  return entry(null, { decision: "UNAVAILABLE", ...over });
}

// Every explicit-decision field decided (UNAVAILABLE) plus the two required values; overrides win.
function completeDraft(overrides: AgreementDraft = {}): AgreementDraft {
  const draft: AgreementDraft = {};
  for (const field of AGREEMENT_FIELDS) if (field.explicitDecisionRequired && field.mode === "DECIDED") draft[field.key] = unavailable();
  draft.counterpartyName = entry("Acme Media Pvt Ltd");
  draft.effectiveDate = entry("2026-01-01");
  return { ...draft, ...overrides };
}
const assemble = (draft: AgreementDraft, counterpartyType: "PARTNER" | "VENDOR" = "PARTNER") => assembleConfirmedAgreement({ draft, counterpartyType, actorUserRef: "confirmer", confirmedAt: NOW });
const blockerKeys = (result: ReturnType<typeof assemble>) => (result.ok ? [] : result.blockers.map((b) => `${b.code}:${b.fieldKey ?? ""}`));

describe("assembleConfirmedAgreement", () => {
  it("assembles a minimal fully-decided draft; undecided non-explicit fields become implicit UNAVAILABLE at confirm", () => {
    const result = assemble(completeDraft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terms.agreementType).toBe("UNSPECIFIED");
    expect(result.terms.dates.effectiveFrom).toBe("2026-01-01");
    expect(result.contactSnapshot.counterpartyName).toBe("Acme Media Pvt Ltd");
    expect(result.effective).toEqual({ signedDate: null, effectiveFrom: "2026-01-01", effectiveTo: null });
    expect(result.fieldProvenance.address).toMatchObject({ origin: "MANUAL", decision: "UNAVAILABLE", decidedByUserRef: "confirmer" });
    expect(result.sourceMode).toBe("MANUAL");
    // never assembled for computed fields
    expect(result.fieldProvenance.agreementType).toBeUndefined();
    expect(result.fieldProvenance.partnerRef).toBeUndefined();
  });

  it("derives agreementType from the confirmed commercial structure (fixed + required content)", () => {
    const result = assemble(
      completeDraft({
        currency: entry("INR"),
        fixedComponent: entry({ applicable: true, amountMinor: 5_000_000 }),
        monthlyRequiredQualifyingContentCount: entry(8),
        qualifyingUnit: entry("approved_content_thread"),
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.terms.agreementType).toBe("FIXED_PLUS_REQUIRED_CONTENT");
      expect(result.terms.commercial.fixedComponent).toEqual({ applicable: true, amountMinor: 5_000_000 });
    }
  });

  it("blocks on a PENDING entry (an extracted/prefilled field nobody decided)", () => {
    const result = assemble(completeDraft({ emailAddress: entry("a@b.co", { decision: "PENDING", origin: "EXTRACTED" }) }));
    expect(blockerKeys(result)).toContain("field_pending:emailAddress");
  });

  it("blocks when an explicit-decision (payment-affecting) field has no entry", () => {
    const draft = completeDraft();
    delete draft.incentive;
    expect(blockerKeys(assemble(draft))).toContain("field_undecided:incentive");
  });

  it("requires the counterparty name and the effective date to carry a usable value", () => {
    const noName = assemble(completeDraft({ counterpartyName: unavailable() }));
    expect(blockerKeys(noName).join()).toMatch(/required_field_missing:counterpartyName/);
    const noDate = assemble(completeDraft({ effectiveDate: unavailable() }));
    expect(blockerKeys(noDate).join()).toMatch(/required_field_missing:effectiveDate/);
  });

  it("requires a currency when any amount is present, and the count <-> unit pair together", () => {
    const noCurrency = assemble(completeDraft({ fixedComponent: entry({ applicable: true, amountMinor: 100 }) }));
    expect(blockerKeys(noCurrency).join()).toMatch(/terms_invalid:currency/);
    const noUnit = assemble(completeDraft({ monthlyRequiredQualifyingContentCount: entry(4) }));
    expect(blockerKeys(noUnit).join()).toMatch(/terms_invalid:qualifyingUnit/);
    const noCount = assemble(completeDraft({ qualifyingUnit: entry("approved_content_thread") }));
    expect(blockerKeys(noCount).join()).toMatch(/terms_invalid:monthlyRequiredQualifyingContentCount/);
  });

  it("rejects an invalid value for a field, and an ACCEPTED decision that has no value", () => {
    expect(blockerKeys(assemble(completeDraft({ pinCode: entry("12345") })))).toContain("value_invalid:pinCode");
    expect(blockerKeys(assemble(completeDraft({ emailAddress: entry(null) })))).toContain("decision_without_value:emailAddress");
  });

  it("NOT_APPLICABLE freezes to the component's explicit not-applicable value", () => {
    const result = assemble(completeDraft({ fixedComponent: entry(null, { decision: "NOT_APPLICABLE" }), incentive: entry(null, { decision: "NOT_APPLICABLE" }) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.terms.commercial.fixedComponent).toEqual({ applicable: false, amountMinor: null });
      expect(result.terms.commercial.incentive).toEqual({ applicable: false, slabs: [] });
    }
  });

  it("an identity VALUE field is decided by acknowledgement only and never contributes a value", () => {
    const result = assemble(completeDraft({ panNumber: entry(null, { decision: "ACCEPTED", origin: "EXTRACTED" }) }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/panNumber":"/);
    const pending = assemble(completeDraft({ panNumber: entry(null, { decision: "PENDING", origin: "EXTRACTED" }) }));
    expect(blockerKeys(pending)).toContain("field_pending:panNumber");
  });

  it("a Partner-only field on a Vendor draft is rejected", () => {
    expect(blockerKeys(assemble(completeDraft({ aadhaarNumber: entry(null, { origin: "EXTRACTED" }) }), "VENDOR"))).toContain("field_not_applicable:aadhaarNumber");
  });

  it("performance targets are warning-only: a target that affects payment cannot be assembled", () => {
    const target = { targetRef: "t1", metricId: "views", targetValue: 1000, unit: "views", comparison: "at_least", affectsPayment: false };
    const ok = assemble(completeDraft({ performanceTargets: entry([target]) }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.terms.performanceTargets[0]!.affectsPayment).toBe(false);
    expect(blockerKeys(assemble(completeDraft({ performanceTargets: entry([{ ...target, affectsPayment: true }]) })))).toContain("value_invalid:performanceTargets");
  });
});

describe("deriveSourceMode (from field origins)", () => {
  const fp = (entries: Array<[AgreementFieldKey, "MASTER_DATA" | "EXTRACTED" | "MANUAL", "ACCEPTED" | "CORRECTED" | "UNAVAILABLE" | "NOT_APPLICABLE"]>) =>
    Object.fromEntries(entries.map(([key, origin, decision]) => [key, { origin, decision, decidedByUserRef: "u", decidedAt: NOW, provenance: PROVENANCE }]));

  it("MANUAL when nothing extracted was accepted (master-data prefills and implicit UNAVAILABLE count for nothing)", () => {
    expect(deriveSourceMode(fp([["counterpartyName", "MASTER_DATA", "ACCEPTED"], ["address", "MANUAL", "UNAVAILABLE"]]))).toBe("MANUAL");
  });
  it("EXTRACTED when extracted values were accepted and no human supplied a value", () => {
    expect(deriveSourceMode(fp([["currency", "EXTRACTED", "ACCEPTED"], ["counterpartyName", "MASTER_DATA", "ACCEPTED"]]))).toBe("EXTRACTED");
  });
  it("MIXED when extracted values are accepted alongside a human correction or manual value", () => {
    expect(deriveSourceMode(fp([["currency", "EXTRACTED", "ACCEPTED"], ["paymentCycle", "EXTRACTED", "CORRECTED"]]))).toBe("MIXED");
    expect(deriveSourceMode(fp([["currency", "EXTRACTED", "ACCEPTED"], ["remarks", "MANUAL", "ACCEPTED"]]))).toBe("MIXED");
  });
});

describe("checkFieldDecisionValue", () => {
  it("CORRECTED needs a value; ACCEPTED may omit it; UNAVAILABLE/NOT_APPLICABLE carry none", () => {
    expect(checkFieldDecisionValue("state", "CORRECTED", undefined).ok).toBe(false);
    expect(checkFieldDecisionValue("state", "ACCEPTED", undefined)).toEqual({ ok: true, value: undefined });
    expect(checkFieldDecisionValue("state", "UNAVAILABLE", "Kerala").ok).toBe(false);
    expect(checkFieldDecisionValue("state", "NOT_APPLICABLE", undefined)).toEqual({ ok: true, value: null });
  });
  it("validates and normalizes the value (trim, platforms)", () => {
    expect(checkFieldDecisionValue("state", "CORRECTED", "  Kerala ")).toEqual({ ok: true, value: "Kerala" });
    expect(checkFieldDecisionValue("platforms", "CORRECTED", [" Instagram", "YouTube "])).toEqual({ ok: true, value: ["instagram", "youtube"] });
    expect(checkFieldDecisionValue("pinCode", "CORRECTED", "abc").ok).toBe(false);
  });
  it("identity value fields: decision only, never a value, never CORRECTED; computed fields cannot be decided", () => {
    expect(checkFieldDecisionValue("panNumber", "ACCEPTED", undefined)).toEqual({ ok: true, value: null });
    expect(checkFieldDecisionValue("panNumber", "ACCEPTED", "ABCDE1234F").ok).toBe(false);
    expect(checkFieldDecisionValue("panNumber", "CORRECTED", "ABCDE1234F").ok).toBe(false);
    expect(checkFieldDecisionValue("agreementType", "CORRECTED", "FIXED_ONLY").ok).toBe(false);
    expect(checkFieldDecisionValue("panDocumentStatus", "ACCEPTED", undefined).ok).toBe(false);
  });
});

describe("snapshot validators", () => {
  it("validateContactSnapshot enforces shape (name required, 6-digit PIN, strict keys)", () => {
    expect(validateContactSnapshot({ counterpartyName: "A", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: "682001" }).ok).toBe(true);
    expect(validateContactSnapshot({ counterpartyName: "A", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: "68" }).ok).toBe(false);
    expect(validateContactSnapshot({ counterpartyName: "A", contactNumber: null, emailAddress: null, state: null, address: null, pinCode: null, panNumber: "X" }).ok).toBe(false);
  });

  it("deriveIdentityStatusState: pan + bank (+ gst when applicable) drive AVAILABLE/INCOMPLETE/MISSING; aadhaar never required", () => {
    const c = (pan: string, bank: string, gst: string, aadhaar = "MISSING") => ({ pan, bank, gst, aadhaar }) as never;
    expect(deriveIdentityStatusState(c("PRESENT", "PRESENT", "NOT_APPLICABLE"))).toBe("AVAILABLE");
    expect(deriveIdentityStatusState(c("PRESENT", "PRESENT", "MISSING"))).toBe("INCOMPLETE");
    expect(deriveIdentityStatusState(c("PRESENT", "MISSING", "NOT_APPLICABLE"))).toBe("INCOMPLETE");
    expect(deriveIdentityStatusState(c("MISSING", "MISSING", "NOT_APPLICABLE"))).toBe("MISSING");
    expect(deriveIdentityStatusState(c("PRESENT", "PRESENT", "PRESENT", "MISSING"))).toBe("AVAILABLE");
  });

  it("validateIdentityStatusShape: a vendor has no Aadhaar; a stored state must agree with the components", () => {
    const components = { pan: "PRESENT", bank: "PRESENT", gst: "NOT_APPLICABLE", aadhaar: "NOT_APPLICABLE" } as const;
    expect(validateIdentityStatusShape("VENDOR", { state: "AVAILABLE", components })).toEqual([]);
    expect(validateIdentityStatusShape("VENDOR", { state: "AVAILABLE", components: { ...components, aadhaar: "PRESENT" } })).toHaveLength(1);
    expect(validateIdentityStatusShape("PARTNER", { state: "MISSING", components })).toHaveLength(1);
    expect(validateIdentityStatusShape("PARTNER", { state: "UNAVAILABLE", components })).toEqual([]);
  });
});
