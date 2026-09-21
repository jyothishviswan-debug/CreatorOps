import { describe, expect, it } from "vitest";

import {
  BANK_NOT_FROM_CONTRACT,
  COMPLETE_BANK_LABEL,
  KYC_DOC_TYPES,
  KYC_UPLOAD_LABEL,
  applicableKycComponents,
  buildKycRows,
  evaluateApplyOption,
  extractionHasIdentityValue,
  isKycActionKind,
  kycActionComponents,
  kycAllComponentsAvailable,
  kycAttentionSummary,
  kycDialogIntro,
  kycDialogTitle,
  kycHeadline,
  kycSectionHeadline,
  owningRecordHref,
  validateEvidenceFile,
  validateEvidenceLink,
  type KycApplyInput,
} from "./kyc-ui";

const components = (over: Partial<Record<"pan" | "aadhaar" | "gst" | "bank", "PRESENT" | "MISSING" | "INCOMPLETE" | "NOT_APPLICABLE" | "RESTRICTED">> = {}) => ({ pan: "PRESENT" as const, aadhaar: "MISSING" as const, gst: "NOT_APPLICABLE" as const, bank: "PRESENT" as const, ...over });

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

  it("an INCOMPLETE component reads Incomplete and offers upload/complete for an authorized person; nothing else does", () => {
    const input = { counterpartyType: "PARTNER" as const, kyc: { state: "INCOMPLETE" as const, components: components({ bank: "INCOMPLETE" }) } };
    const rows = buildKycRows({ ...input, canViewIdentity: true, canManageKyc: true });
    const bank = rows.find((row) => row.component === "bank")!;
    expect(bank).toMatchObject({ kind: "incomplete", canUpload: true });
    expect(bank.chip.label).toBe("Incomplete");
    expect(bank.message).toContain("details are not entered yet");
    // only the incomplete bank and the missing aadhaar may be uploaded; PAN (present) and GST (not applicable) never
    expect(rows.filter((row) => row.canUpload).map((row) => row.component).sort()).toEqual(["aadhaar", "bank"]);
    // without the owning grants: status only, no action
    const noAccess = buildKycRows({ ...input, canViewIdentity: true, canManageKyc: false }).find((row) => row.component === "bank")!;
    expect(noAccess.canUpload).toBe(false);
    expect(noAccess.message).toContain("Someone with KYC access");
  });

  it("everything complete offers no upload action at all", () => {
    const rows = buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "AVAILABLE", components: components({ aadhaar: "PRESENT" }) }, canViewIdentity: true, canManageKyc: true });
    expect(rows.some((row) => row.canUpload)).toBe(false);
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

// Step 14B.1: the per-COMPONENT action matrix. `Upload / Update` exists ONLY for a MISSING or INCOMPLETE component and only for an actor who holds the
// identity category AND the owning KYC action; every other state (available, not applicable, restricted, unavailable) has no action for anyone.
type Status = "PRESENT" | "MISSING" | "INCOMPLETE" | "NOT_APPLICABLE" | "RESTRICTED";
const partnerRows = (over: Partial<Record<"pan" | "aadhaar" | "gst" | "bank", Status>>, access = { canViewIdentity: true, canManageKyc: true }) =>
  buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT", ...over } }, ...access });
const vendorRows = (over: Partial<Record<"pan" | "aadhaar" | "gst" | "bank", Status>>, access = { canViewIdentity: true, canManageKyc: true }) =>
  buildKycRows({ counterpartyType: "VENDOR", kyc: { state: "INCOMPLETE", components: { pan: "PRESENT", aadhaar: "NOT_APPLICABLE", gst: "PRESENT", bank: "PRESENT", ...over } }, ...access });

describe("per-component action visibility (Step 14B.1)", () => {
  it("every component present: no KYC upload action anywhere, and the section reads 'KYC available in Partner/Vendor record'", () => {
    const rows = partnerRows({});
    expect(kycActionComponents(rows)).toEqual([]);
    expect(rows.every((row) => row.kind === "available" && row.actionLabel === null && row.actionAriaLabel === null)).toBe(true);
    expect(kycAllComponentsAvailable(rows)).toBe(true);
    expect(kycSectionHeadline({ state: "AVAILABLE" }, rows)).toBe("KYC available in Partner/Vendor record");
    expect(kycAttentionSummary(rows)).toBeNull();
    // a Vendor: Aadhaar does not apply and never counts against "all available"
    const vendor = vendorRows({});
    expect(kycAllComponentsAvailable(vendor)).toBe(true);
    expect(kycActionComponents(vendor)).toEqual([]);
  });

  it("only PAN missing: only the PAN row has an action", () => {
    const rows = partnerRows({ pan: "MISSING" });
    expect(kycActionComponents(rows)).toEqual(["pan"]);
    expect(rows.find((row) => row.component === "pan")).toMatchObject({ kind: "missing", actionLabel: "Upload / Update", actionAriaLabel: "Upload / Update KYC for PAN" });
    expect(kycAllComponentsAvailable(rows)).toBe(false);
    expect(kycSectionHeadline({ state: "MISSING" }, rows)).toBe("KYC is missing from the Partner / Vendor record.");
    expect(kycAttentionSummary(rows)).toBe("PAN needs attention.");
  });

  it("incomplete bank: only the Bank row has an action, worded 'Complete bank details'", () => {
    const rows = partnerRows({ bank: "INCOMPLETE" });
    expect(kycActionComponents(rows)).toEqual(["bank"]);
    const bank = rows.find((row) => row.component === "bank")!;
    expect(bank).toMatchObject({ kind: "incomplete", actionLabel: COMPLETE_BANK_LABEL });
    // the accessible name still names the KYC action and the component (existing specs locate it as `Upload / Update KYC for Bank details`)
    expect(bank.actionAriaLabel).toContain("Upload / Update KYC for Bank details");
    expect(bank.actionAriaLabel).toContain(COMPLETE_BANK_LABEL);
  });

  it("an incomplete component other than bank keeps the plain 'Upload / Update' wording", () => {
    const gst = partnerRows({ gst: "INCOMPLETE" }).find((row) => row.component === "gst")!;
    expect(gst).toMatchObject({ kind: "incomplete", canUpload: true, actionLabel: KYC_UPLOAD_LABEL, actionAriaLabel: "Upload / Update KYC for GST certificate" });
  });

  it("several components need attention: each of them (and only them) gets its own action", () => {
    const rows = partnerRows({ pan: "MISSING", aadhaar: "MISSING", bank: "INCOMPLETE", gst: "NOT_APPLICABLE" });
    expect(kycActionComponents(rows)).toEqual(["pan", "aadhaar", "bank"]);
    expect(kycAttentionSummary(rows)).toBe("PAN, Aadhaar and Bank details need attention.");
  });

  it("the full matrix: state x access -> action", () => {
    const states: Status[] = ["PRESENT", "MISSING", "INCOMPLETE", "NOT_APPLICABLE", "RESTRICTED"];
    const accesses = [
      { name: "both", canViewIdentity: true, canManageKyc: true, allowed: true },
      { name: "view only", canViewIdentity: true, canManageKyc: false, allowed: false },
      { name: "manage without the category", canViewIdentity: false, canManageKyc: true, allowed: false },
      { name: "neither", canViewIdentity: false, canManageKyc: false, allowed: false },
    ];
    for (const state of states) {
      for (const access of accesses) {
        const rows = partnerRows({ pan: state }, { canViewIdentity: access.canViewIdentity, canManageKyc: access.canManageKyc });
        const pan = rows.find((row) => row.component === "pan")!;
        const expected = (state === "MISSING" || state === "INCOMPLETE") && access.allowed;
        expect(pan.canUpload, `${state} / ${access.name}`).toBe(expected);
        expect(pan.actionLabel !== null, `${state} / ${access.name} label`).toBe(expected);
        // the other (present) rows never gain an action
        expect(rows.filter((row) => row.component !== "pan").some((row) => row.canUpload)).toBe(false);
      }
    }
  });

  it("no sensitive access: safe status only - every row is Restricted, nothing to upload or reveal, and the headline is the overall state", () => {
    const rows = buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "INCOMPLETE", components: { pan: "RESTRICTED", aadhaar: "RESTRICTED", gst: "RESTRICTED", bank: "RESTRICTED" } }, canViewIdentity: false, canManageKyc: false });
    expect(kycActionComponents(rows)).toEqual([]);
    expect(kycAllComponentsAvailable(rows)).toBe(false);
    expect(kycSectionHeadline({ state: "INCOMPLETE" }, rows)).toBe("KYC in the Partner / Vendor record is incomplete.");
    expect(kycAttentionSummary(rows)).toBeNull();
  });

  it("an unreadable status never reads as complete", () => {
    const rows = buildKycRows({ counterpartyType: "PARTNER", kyc: { state: "UNAVAILABLE", components: { pan: "PRESENT", aadhaar: "PRESENT", gst: "PRESENT", bank: "PRESENT" } }, canViewIdentity: true, canManageKyc: true });
    expect(kycAllComponentsAvailable(rows)).toBe(false);
    expect(kycSectionHeadline({ state: "UNAVAILABLE" }, rows)).toContain("could not be read");
  });

  it("only a missing / incomplete row can open the component-scoped dialog", () => {
    expect(isKycActionKind("missing")).toBe(true);
    expect(isKycActionKind("incomplete")).toBe(true);
    for (const kind of ["available", "restricted", "unavailable", "not_applicable"] as const) expect(isKycActionKind(kind)).toBe(false);
  });
});

describe("the component-scoped dialog copy", () => {
  it("is titled for THAT component; an incomplete bank is 'Complete bank details'", () => {
    expect(kycDialogTitle("pan", "missing")).toBe("Upload / Update KYC: PAN");
    expect(kycDialogTitle("gst", "incomplete")).toBe("Upload / Update KYC: GST certificate");
    expect(kycDialogTitle("bank", "incomplete")).toBe("Complete bank details");
    expect(kycDialogTitle("bank", "missing")).toBe("Upload / Update KYC: Bank details");
  });

  it("says KYC is kept once in the owning record; an incomplete component also says a document is already on file", () => {
    expect(kycDialogIntro("pan", "missing", "PARTNER")).toBe("KYC is kept once, in the Partner record. Choose one of these ways to add the PAN. Nothing is copied into this Agreement.");
    const incomplete = kycDialogIntro("bank", "incomplete", "VENDOR");
    expect(incomplete).toContain("already on file");
    expect(incomplete).toContain("KYC is kept once, in the Vendor record");
  });

  it("applying from the Agreement is scoped to the one component (PAN here) and bank is never applicable", () => {
    const ready: KycApplyInput = { component: "pan", counterpartyType: "PARTNER", extractionState: "attached", extractedValueUsable: true, identityDecision: "ACCEPTED", canViewContractDetail: true, canManageKyc: true, canViewIdentity: true, componentMissing: true };
    expect(evaluateApplyOption(ready).available).toBe(true);
    expect(evaluateApplyOption({ ...ready, component: "bank" }).reasons).toEqual([BANK_NOT_FROM_CONTRACT]);
  });
});
