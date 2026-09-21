import { describe, expect, it } from "vitest";

import type { FieldReconciliationDto } from "@/server/finance-agreements/reconciliation-compare";

import { buildCrossVerificationRows } from "../cross-verification";
import { buildMasterDataRequest, correctedValueSeed, crossVerificationGroupOf, describeMasterDataAction, groupCrossVerificationRows, jumpLabel, REASON_MAX, summarizeCrossVerification, summaryText, validateCorrectedText, validateReason } from "./cross-verification-ui";

function field(over: Partial<FieldReconciliationDto> & Pick<FieldReconciliationDto, "fieldKey" | "state">): FieldReconciliationDto {
  return { label: over.fieldKey, group: "counterparty_contact", source: { canonical: "CreatorOps master data", agreement: null }, allowedActions: [], ...over };
}
const rows = (fields: FieldReconciliationDto[]) => buildCrossVerificationRows({ fields, versionConfirmed: false, versionStatus: "DRAFT" }, { canManage: true });

describe("grouping", () => {
  it("places contact, platform and identity fields in their groups, in display order", () => {
    expect(crossVerificationGroupOf("emailAddress")).toBe("contact");
    expect(crossVerificationGroupOf("address")).toBe("contact");
    expect(crossVerificationGroupOf("platforms")).toBe("platform");
    expect(crossVerificationGroupOf("collaboratorPageLink")).toBe("platform");
    expect(crossVerificationGroupOf("panNumber")).toBe("identity");
    expect(crossVerificationGroupOf("gstin")).toBe("identity");
    const groups = groupCrossVerificationRows(
      rows([
        field({ fieldKey: "panNumber", state: "RESTRICTED", group: "identity" }),
        field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" }),
        field({ fieldKey: "platforms", state: "MATCH", canonicalValue: ["instagram"], group: "partner_platform" }),
      ]),
    );
    expect(groups.map((group) => group.key)).toEqual(["contact", "platform", "identity"]);
    expect(groups[0]!.rows.map((row) => row.fieldKey)).toEqual(["emailAddress"]);
  });
  it("drops empty groups (a Vendor has no platform rows)", () => {
    expect(groupCrossVerificationRows(rows([field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" })])).map((group) => group.key)).toEqual(["contact"]);
    expect(groupCrossVerificationRows([])).toEqual([]);
  });
});

describe("summary", () => {
  const list = rows([
    field({ fieldKey: "emailAddress", state: "MISMATCH", canonicalValue: "a@b.co", extractedValue: "c@d.co", agreementDecision: "PENDING", allowedActions: ["KEEP_CREATOROPS_VALUE", "USE_AGREEMENT_VALUE_IN_AGREEMENT_ONLY"] }),
    field({ fieldKey: "contactNumber", state: "MATCH", canonicalValue: "9876543210", extractedValue: "9876543210" }),
    field({ fieldKey: "panNumber", state: "RESTRICTED", group: "identity" }),
  ]);
  it("counts what needs a decision and what is restricted", () => {
    const summary = summarizeCrossVerification(list);
    expect(summary).toMatchObject({ total: 3, needsResolution: 1, mismatches: 1, restricted: 1 });
    expect(summary.pendingRows.map((row) => row.fieldKey)).toEqual(["emailAddress"]);
    expect(summaryText(summary)).toBe("1 of 3 fields need your decision.");
  });
  it("has plain text for empty and fully resolved states", () => {
    expect(summaryText(summarizeCrossVerification([]))).toBe("Nothing to compare yet.");
    expect(summaryText({ total: 4, needsResolution: 0, mismatches: 0, restricted: 0, pendingRows: [] })).toBe("Every comparable field is resolved or needs no action.");
    expect(summaryText({ total: 1, needsResolution: 1, mismatches: 0, restricted: 0, pendingRows: [] })).toBe("1 of 1 field needs your decision.");
  });
  it("jump labels carry the status text (never colour alone)", () => {
    expect(jumpLabel(list[0]!)).toBe("Email address - Mismatch");
  });
});

describe("enter corrected value", () => {
  it("validates typed text with the server's own rules", () => {
    expect(validateCorrectedText("emailAddress", "  a@b.co ")).toEqual({ ok: true, value: "a@b.co" });
    expect(validateCorrectedText("emailAddress", "").ok).toBe(false);
    expect(validateCorrectedText("pinCode", "5600")).toMatchObject({ ok: false });
    expect(validateCorrectedText("pinCode", "560001")).toEqual({ ok: true, value: "560001" });
    expect(validateCorrectedText("platforms", "Instagram, youtube")).toEqual({ ok: true, value: ["instagram", "youtube"] });
    expect(validateCorrectedText("platforms", "")).toMatchObject({ ok: false });
  });
  it("seeds the box from the Agreement's value, never from CreatorOps or a placeholder", () => {
    expect(correctedValueSeed({ agreementText: "c@d.co", confirmedText: null, restricted: false })).toBe("c@d.co");
    expect(correctedValueSeed({ agreementText: "c@d.co", confirmedText: "e@f.co", restricted: false })).toBe("e@f.co");
    expect(correctedValueSeed({ agreementText: "—", confirmedText: null, restricted: false })).toBe("");
    expect(correctedValueSeed({ agreementText: "Not applicable", confirmedText: null, restricted: false })).toBe("");
    expect(correctedValueSeed({ agreementText: "secret", confirmedText: null, restricted: true })).toBe("");
  });
});

describe("master-data commands", () => {
  const fill = rows([field({ fieldKey: "emailAddress", state: "MISSING_IN_CREATOROPS", extractedValue: "new@b.co", agreementDecision: "ACCEPTED", confirmedValue: "new@b.co", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] })])[0]!;
  const overwrite = rows([field({ fieldKey: "contactNumber", state: "MISMATCH", canonicalValue: "9876543210", extractedValue: "9123456789", agreementDecision: "PENDING", allowedActions: ["OVERWRITE_MASTER_DATA_WITH_AGREEMENT_VALUE"] })])[0]!;
  const kyc = rows([field({ fieldKey: "panNumber", state: "MISSING_IN_CREATOROPS", group: "identity", allowedActions: ["UPDATE_MASTER_DATA_FROM_AGREEMENT"] })])[0]!;
  const fillAction = fill.actions.find((action) => action.masterData)!;
  const overwriteAction = overwrite.actions.find((action) => action.masterData)!;
  const kycAction = kyc.actions.find((action) => action.masterData)!;

  it("the fill dialog explains that only an empty value is filled and that saving never changes the record", () => {
    const copy = describeMasterDataAction(fill, fillAction, "PARTNER")!;
    expect(copy.title).toBe("Update Partner");
    expect(copy.requiresReason).toBe(false);
    expect(copy.lead).toContain("empty in CreatorOps");
    expect(copy.points.join(" ")).toContain("Saving the Agreement never changes the Partner/Vendor record.");
    expect(describeMasterDataAction(fill, fillAction, "VENDOR")!.title).toBe("Update Vendor");
  });
  it("the replace dialog is titled 'after confirmation' and needs an acknowledged reason", () => {
    const copy = describeMasterDataAction(overwrite, overwriteAction, "PARTNER")!;
    expect(copy.title).toBe("Update Partner after confirmation");
    expect(copy.requiresReason).toBe(true);
    expect(copy.reasonLabel).toBeTruthy();
    expect(copy.lead).toContain("replaces");
  });
  it("a plain Agreement-side action has no dialog", () => {
    const confirm = rows([field({ fieldKey: "emailAddress", state: "MATCH", canonicalValue: "a@b.co" })])[0]!.actions[0]!;
    expect(describeMasterDataAction(fill, confirm, "PARTNER")).toBeNull();
  });

  it("validates the reason (3-1000 characters, trimmed)", () => {
    expect(validateReason("  ").ok).toBe(false);
    expect(validateReason("ab").ok).toBe(false);
    expect(validateReason("  new number  ")).toEqual({ ok: true, value: "new number" });
    expect(validateReason("x".repeat(REASON_MAX + 1)).ok).toBe(false);
  });

  it("builds the contact fill request with the counterparty's own version and no resolution", () => {
    expect(buildMasterDataRequest(fillAction, { reason: null, expectedCounterpartyVersion: 4 })).toEqual({ ok: true, request: { via: "contact", input: { fieldKey: "emailAddress", mode: "FILL_MISSING", expectedCounterpartyVersion: 4 } } });
  });
  it("builds the replace request with the acknowledged reason", () => {
    expect(buildMasterDataRequest(overwriteAction, { reason: " The Agreement is newer ", expectedCounterpartyVersion: 2 })).toEqual({
      ok: true,
      request: { via: "contact", input: { fieldKey: "contactNumber", mode: "OVERWRITE_MISMATCH", expectedCounterpartyVersion: 2, resolution: { acknowledged: true, reason: "The Agreement is newer" } } },
    });
    expect(buildMasterDataRequest(overwriteAction, { reason: "", expectedCounterpartyVersion: 2 })).toMatchObject({ ok: false });
  });
  it("refuses a contact command without a readable counterparty version", () => {
    expect(buildMasterDataRequest(fillAction, { reason: null, expectedCounterpartyVersion: null })).toMatchObject({ ok: false });
    expect(buildMasterDataRequest(fillAction, { reason: null, expectedCounterpartyVersion: 0 })).toMatchObject({ ok: false });
  });
  it("builds the KYC command by component and needs no counterparty version (the server reads its own)", () => {
    expect(buildMasterDataRequest(kycAction, { reason: null, expectedCounterpartyVersion: null })).toEqual({ ok: true, request: { via: "kyc", input: { components: ["pan"], mode: "FILL_MISSING" } } });
  });
});
