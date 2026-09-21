import { describe, expect, it } from "vitest";

import { BANK_NOT_FROM_CONTRACT, KYC_DOC_TYPES, applicableKycComponents, buildKycRows, evaluateApplyOption, extractionHasIdentityValue, kycHeadline, owningRecordHref, validateEvidenceFile, validateEvidenceLink, type KycApplyInput } from "./kyc-ui";

const components = (over: Partial<Record<"pan" | "aadhaar" | "gst" | "bank", "PRESENT" | "MISSING" | "NOT_APPLICABLE" | "RESTRICTED">> = {}) => ({ pan: "PRESENT" as const, aadhaar: "MISSING" as const, gst: "NOT_APPLICABLE" as const, bank: "PRESENT" as const, ...over });

describe("which components apply", () => {
  it("Aadhaar is a Partner-only component", () => {
    expect(applicableKycComponents("PARTNER")).toEqual(["pan", "aadhaar", "bank", "gst"]);
    expect(applicableKycComponents("VENDOR")).toEqual(["pan", "bank", "gst"]);
  });
});

describe("component rows", () => {
  it("available components say the KYC already exists in the record and offer no upload", () => {
    const rows = buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "INCOMPLETE", components: components() }, canViewIdentity: true, canManageKyc: true });
    const pan = rows.find((row) => row.component === "pan")!;
    expect(pan).toMatchObject({ kind: "available", canUpload: false, message: "KYC available in Partner/Vendor record" });
    expect(pan.chip.label).toBe("Available");
  });

  it("a missing component offers Upload / Update KYC only to a person authorized for the owning record", () => {
    const input = { counterpartyType: "PARTNER" as const, kyc: { state: "INCOMPLETE" as const, components: components() } };
    const authorized = buildKycRows({ ...input, canViewIdentity: true, canManageKyc: true }).find((row) => row.component === "aadhaar")!;
    expect(authorized).toMatchObject({ kind: "missing", canUpload: true });
    expect(authorized.chip.label).toBe("Missing");
    // viewing without the manage action, or managing without the identity category: safe status only
    expect(buildKycRows({ ...input, canViewIdentity: true, canManageKyc: false }).find((row) => row.component === "aadhaar")!.canUpload).toBe(false);
    expect(buildKycRows({ ...input, canViewIdentity: false, canManageKyc: true }).find((row) => row.component === "aadhaar")!.canUpload).toBe(false);
  });

  it("without sensitive access every component is Restricted, with no upload or reveal action", () => {
    const rows = buildKycRows({ counterpartyType: "VENDOR", kyc: { state: "MISSING", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } }, canViewIdentity: false, canManageKyc: false });
    expect(rows.map((row) => row.chip.label)).toEqual(["Restricted", "Restricted", "Restricted"]);
    expect(rows.every((row) => !row.canUpload && row.kind === "restricted")).toBe(true);
  });

  it("an unreadable or not-yet-loaded status is Unavailable and never looks complete", () => {
    for (const kyc of [null, { state: "UNAVAILABLE" as const, components: components() }]) {
      const rows = buildKycRows({ counterpartyType: "PARTNER", kyc, canViewIdentity: true, canManageKyc: true });
      expect(rows.every((row) => row.chip.label === "Unavailable" && !row.canUpload)).toBe(true);
    }
  });

  it("a component that does not apply is not offered an upload", () => {
    const rows = buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "AVAILABLE", components: components() }, canViewIdentity: true, canManageKyc: true });
    expect(rows.find((row) => row.component === "gst")).toMatchObject({ kind: "not_applicable", canUpload: false });
  });

  it("names the overall state in plain words", () => {
    expect(kycHeadline({ state: "AVAILABLE" })).toBe("KYC available in Partner/Vendor record");
    expect(kycHeadline({ state: "INCOMPLETE" })).toContain("incomplete");
    expect(kycHeadline({ state: "MISSING" })).toContain("missing");
    expect(kycHeadline({ state: "RESTRICTED" })).toContain("restricted");
    expect(kycHeadline({ state: "UNAVAILABLE" })).toContain("could not be read");
    expect(kycHeadline(null)).toContain("not loaded");
  });
});

describe("Apply KYC values found in the Agreement", () => {
  const ready: KycApplyInput = {
    component: "pan",
    counterpartyType: "PARTNER",
    extractionState: "attached",
    extractedValueUsable: true,
    identityDecision: "ACCEPTED",
    canViewContractDetail: true,
    canManageKyc: true,
    canViewIdentity: true,
    componentMissing: true,
  };
  it("is available only when every condition the server checks holds", () => {
    expect(evaluateApplyOption(ready)).toEqual({ available: true, reasons: [] });
  });
  it("tells the person what is missing instead of failing later", () => {
    expect(evaluateApplyOption({ ...ready, extractionState: "none" }).reasons).toContain("Extract the Agreement first.");
    expect(evaluateApplyOption({ ...ready, extractionState: "not_attached" }).reasons).toContain("Attach the extracted values to this draft first.");
    expect(evaluateApplyOption({ ...ready, extractedValueUsable: false }).reasons.join(" ")).toContain("found no PAN value");
    expect(evaluateApplyOption({ ...ready, identityDecision: "PENDING" }).reasons.join(" ")).toContain("Confirm the PAN found in the Agreement");
    expect(evaluateApplyOption({ ...ready, identityDecision: null }).available).toBe(false);
    expect(evaluateApplyOption({ ...ready, canViewContractDetail: false }).reasons.join(" ")).toContain("contract details");
    expect(evaluateApplyOption({ ...ready, canManageKyc: false }).available).toBe(false);
    expect(evaluateApplyOption({ ...ready, canViewIdentity: false }).available).toBe(false);
    expect(evaluateApplyOption({ ...ready, componentMissing: false }).available).toBe(false);
  });
  it("bank details can never be applied from a contract, and says so", () => {
    expect(evaluateApplyOption({ ...ready, component: "bank" })).toEqual({ available: false, reasons: [BANK_NOT_FROM_CONTRACT] });
  });
  it("a Vendor has no Aadhaar to apply", () => {
    const result = evaluateApplyOption({ ...ready, component: "aadhaar", counterpartyType: "VENDOR" });
    expect(result.available).toBe(false);
    expect(result.reasons).toContain("Aadhaar applies to Partners only.");
  });
});

describe("extraction values", () => {
  const fields = [
    { fieldKey: "panNumber", valueState: "VISIBLE", normalizedValue: "ABCDE1234F" },
    { fieldKey: "gstin", valueState: "RESTRICTED", normalizedValue: null },
  ] as never;
  it("a component is usable only when the value is visible to this person and non-empty", () => {
    expect(extractionHasIdentityValue({ fields, identityValuesVisible: true }, "pan")).toBe(true);
    expect(extractionHasIdentityValue({ fields, identityValuesVisible: true }, "gst")).toBe(false);
    expect(extractionHasIdentityValue({ fields, identityValuesVisible: true }, "aadhaar")).toBe(false);
    expect(extractionHasIdentityValue({ fields, identityValuesVisible: false }, "pan")).toBe(false);
    expect(extractionHasIdentityValue(null, "pan")).toBe(false);
  });
});

describe("the owning-module paths", () => {
  it("evidence doc types map one to one onto the owning module's types", () => {
    expect(KYC_DOC_TYPES).toEqual({ pan: "pan", aadhaar: "aadhaar", gst: "gst", bank: "bank" });
  });
  it("links to the owning record", () => {
    expect(owningRecordHref("PARTNER", "partner_abc")).toBe("/partners/partner_abc");
    expect(owningRecordHref("VENDOR", "v 1")).toBe("/vendors/v%201");
  });
  it("validates an evidence link", () => {
    expect(validateEvidenceLink("").ok).toBe(false);
    expect(validateEvidenceLink("not a link").ok).toBe(false);
    expect(validateEvidenceLink("javascript:alert(1)").ok).toBe(false);
    expect(validateEvidenceLink("https://drive.example.com/file/1")).toEqual({ ok: true, value: "https://drive.example.com/file/1" });
    expect(validateEvidenceLink(`https://x.example/${"a".repeat(1000)}`).ok).toBe(false);
  });
  it("validates an evidence document (non-empty, at most 15 MB)", () => {
    expect(validateEvidenceFile({ name: "pan.pdf", size: 0 })).toBe("This file is empty.");
    expect(validateEvidenceFile({ name: "pan.pdf", size: 15 * 1024 * 1024 + 1 })).toContain("15 MB");
    expect(validateEvidenceFile({ name: "pan.pdf", size: 1024 })).toBeNull();
  });
});
