import { describe, expect, it } from "vitest";

import { AGREEMENT_FIELDS, AGREEMENT_FIELD_KEYS, type AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AgreementDraftEntryDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";

import { buildExtractionRows, buildFieldViewModels, editorKindFor, fieldPlacement, fieldsInSubsection, groupFieldViewModels, unresolvedCount, unresolvedFields } from "./field-view-model";

function entry(over: Partial<AgreementDraftEntryDto> = {}): AgreementDraftEntryDto {
  return { value: null, origin: "MANUAL", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null }, ...over };
}

describe("placement and editors cover the whole registry", () => {
  it("every registry key has a placement and an editor kind", () => {
    for (const key of AGREEMENT_FIELD_KEYS) {
      expect(fieldPlacement(key).section).toBeTruthy();
      expect(editorKindFor(key)).toBeTruthy();
    }
  });

  it("assigns the intake sections the design names", () => {
    expect(fieldPlacement("paymentCycle")).toEqual({ section: "commercial_terms", subsection: "commercial" });
    expect(fieldPlacement("incentive")).toEqual({ section: "commercial_terms", subsection: "commercial" });
    expect(fieldPlacement("effectiveDate")).toEqual({ section: "commercial_terms", subsection: "dates" });
    expect(fieldPlacement("performanceTargets")).toEqual({ section: "performance_targets", subsection: "targets" });
    expect(fieldPlacement("emailAddress")).toEqual({ section: "cross_verification", subsection: "contact" });
    expect(fieldPlacement("collaboratorPageLink")).toEqual({ section: "cross_verification", subsection: "platform" });
    expect(fieldPlacement("gstin").section).toBe("kyc");
    expect(fieldPlacement("panNumber").section).toBe("kyc");
    expect(fieldPlacement("panDocumentStatus")).toEqual({ section: "kyc", subsection: "status" });
    expect(fieldPlacement("remarks").section).toBe("additional_details");
    expect(fieldPlacement("agreementType").section).toBe("additional_details");
    expect(fieldPlacement("partnerAccountRefs").section).toBe("agreement_for");
  });

  it("picks type-specific editors from the registry", () => {
    const expected: Partial<Record<AgreementFieldKey, string>> = {
      counterpartyName: "text",
      pinCode: "text",
      servicesMandated: "longText",
      remarks: "longText",
      effectiveDate: "date",
      signedDate: "date",
      currency: "currency",
      paymentCycle: "paymentCycle",
      monthlyRequiredQualifyingContentCount: "count",
      qualifyingUnit: "qualifyingUnit",
      invoiceRequired: "boolean",
      onboardingProcessCompleted: "boolean",
      platforms: "platforms",
      fixedComponent: "fixedComponent",
      accountTransferFee: "accountTransferFee",
      advancePayment: "advancePayment",
      incentive: "incentive",
      lfcSfc: "lfcSfc",
      performanceTargets: "performanceTargets",
    };
    for (const [key, kind] of Object.entries(expected)) expect(editorKindFor(key as AgreementFieldKey)).toBe(kind);
  });

  it("identity VALUES only ever get an acknowledgement; computed fields are read-only", () => {
    for (const key of ["gstin", "panNumber", "panHolderName", "aadhaarNumber", "bankAccountNumber", "ifsc"] as const) expect(editorKindFor(key)).toBe("acknowledge");
    for (const key of ["agreementType", "partnerRef", "partnerAccountRefs", "aadhaarStatus", "panDocumentStatus", "gstCertificateStatus", "aadhaarDocumentStatus"] as const) expect(editorKindFor(key)).toBe("computed");
  });
});

describe("buildFieldViewModels", () => {
  it("returns one model per applicable registry field in registry order; a Vendor has no Aadhaar rows", () => {
    const partner = buildFieldViewModels({ draft: {}, counterpartyType: "PARTNER" });
    expect(partner.map((m) => m.fieldKey)).toEqual(AGREEMENT_FIELDS.map((f) => f.key));
    const vendor = buildFieldViewModels({ draft: {}, counterpartyType: "VENDOR" });
    expect(vendor.map((m) => m.fieldKey)).not.toContain("aadhaarNumber");
    expect(vendor.map((m) => m.fieldKey)).not.toContain("partnerRef");
    expect(buildFieldViewModels({ draft: {}, counterpartyType: "VENDOR", includeNotApplicable: true })).toHaveLength(AGREEMENT_FIELDS.length);
  });

  it("an extracted proposal is NOT accepted: it is unresolved, undecided and reads 'Needs confirmation'", () => {
    const models = buildFieldViewModels({
      draft: { paymentCycle: entry({ value: "MONTHLY", extractedValue: "MONTHLY", origin: "EXTRACTED", decision: "PENDING", provenance: { label: "Extracted from Agreement", extractionRunRef: "run_1", page: 3, confidence: "HIGH" } }) },
      counterpartyType: "PARTNER",
    });
    const model = models.find((m) => m.fieldKey === "paymentCycle")!;
    expect(model.decided).toBe(false);
    expect(model.unresolved).toBe(true);
    expect(model.statusChip.label).toBe("Needs confirmation");
    expect(model.displayValue).toBe("Monthly");
    expect(model.sourceText).toBe("Agreement · page 3");
    expect(model.provenance).toMatchObject({ page: 3, confidence: "HIGH" });
  });

  it("a master-data prefill is labelled as such and is unresolved until decided", () => {
    const model = buildFieldViewModels({ draft: { emailAddress: entry({ value: "a@b.co", origin: "MASTER_DATA", provenance: { label: "CreatorOps master data", extractionRunRef: null, page: null, confidence: null } }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "emailAddress")!;
    expect(model.sourceText).toBe("CreatorOps master data");
    expect(model.unresolved).toBe(true);
    expect(model.hasValue).toBe(true);
  });

  it("decided entries are resolved: ACCEPTED / CORRECTED / UNAVAILABLE / NOT_APPLICABLE", () => {
    const decided = (decision: AgreementDraftEntryDto["decision"], value: unknown = null) => buildFieldViewModels({ draft: { paymentCycle: entry({ decision, value: value as never }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "paymentCycle")!;
    for (const decision of ["ACCEPTED", "CORRECTED", "UNAVAILABLE", "NOT_APPLICABLE"] as const) {
      const model = decided(decision, decision === "ACCEPTED" || decision === "CORRECTED" ? "WEEKLY" : null);
      expect(model.decided).toBe(true);
      expect(model.unresolved).toBe(false);
    }
  });

  it("a payment-affecting field with NO entry is unresolved (must be decided); an optional one is not", () => {
    const models = buildFieldViewModels({ draft: {}, counterpartyType: "PARTNER" });
    const byKey = (key: AgreementFieldKey) => models.find((m) => m.fieldKey === key)!;
    expect(byKey("paymentCycle").unresolved).toBe(true);
    expect(byKey("paymentCycle").statusChip.label).toBe("Needs decision");
    expect(byKey("effectiveDate").unresolved).toBe(true);
    expect(byKey("address").unresolved).toBe(false);
    expect(byKey("address").statusChip.label).toBe("Not set");
    // computed fields never need a human decision
    expect(byKey("agreementType").unresolved).toBe(false);
    expect(byKey("partnerAccountRefs").unresolved).toBe(false);
  });

  it("an identity VALUE never carries a value, even if an entry somehow does", () => {
    const model = buildFieldViewModels({ draft: { panNumber: entry({ value: "ABCDE1234F", extractedValue: "ABCDE1234F", decision: "ACCEPTED" }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "panNumber")!;
    expect(model.value).toBeNull();
    expect(model.extractedValue).toBeNull();
    expect(model.hasValue).toBe(false);
    expect(model.displayValue).toBe("—");
    expect(JSON.stringify(model)).not.toContain("ABCDE1234F");
  });

  it("flags unsupported qualifying-unit wording as Needs mapping (value or extracted wording) and never as supported", () => {
    const models = buildFieldViewModels({ draft: { qualifyingUnit: entry({ value: "reel", extractedValue: "reel", origin: "EXTRACTED" }) }, counterpartyType: "PARTNER" });
    const model = models.find((m) => m.fieldKey === "qualifyingUnit")!;
    expect(model.needsMapping).toBe(true);
    expect(model.displayValue).toBe("reel");
    const supported = buildFieldViewModels({ draft: { qualifyingUnit: entry({ value: "approved_content_thread" }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "qualifyingUnit")!;
    expect(supported.needsMapping).toBe(false);
    expect(supported.displayValue).toBe("Approved Content");
    expect(models.find((m) => m.fieldKey === "paymentCycle")!.needsMapping).toBe(false);
  });

  it("regression: once the person mapped the unit to a supported one, the extractor's leftover wording no longer shows Needs mapping", () => {
    const mapped = buildFieldViewModels({ draft: { qualifyingUnit: entry({ value: "approved_current_link", extractedValue: "reel", origin: "EXTRACTED", decision: "CORRECTED" }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "qualifyingUnit")!;
    expect(mapped.needsMapping).toBe(false);
    const unmapped = buildFieldViewModels({ draft: { qualifyingUnit: entry({ value: null, extractedValue: "reel", origin: "EXTRACTED" }) }, counterpartyType: "PARTNER" }).find((m) => m.fieldKey === "qualifyingUnit")!;
    expect(unmapped.needsMapping).toBe(true);
  });

  it("formats money with the draft's decided currency", () => {
    const models = buildFieldViewModels({
      draft: { currency: entry({ value: "INR", decision: "ACCEPTED" }), fixedComponent: entry({ value: { applicable: true, amountMinor: 3_500_000 }, decision: "ACCEPTED" }) },
      counterpartyType: "PARTNER",
    });
    expect(models.find((m) => m.fieldKey === "fixedComponent")!.displayValue).toBe("₹35,000");
  });
});

describe("grouping and counting", () => {
  const models = buildFieldViewModels({ draft: { paymentCycle: entry({ value: "MONTHLY", decision: "ACCEPTED" }), emailAddress: entry({ value: "a@b.co", origin: "MASTER_DATA" }) }, counterpartyType: "PARTNER" });

  it("groups by intake section, preserving registry order inside each", () => {
    const groups = groupFieldViewModels(models);
    expect(groups.commercial_terms.map((m) => m.fieldKey).slice(0, 7)).toEqual(["agreementNumber", "signedDate", "effectiveDate", "terminationDate", "renewalTerms", "noticeTerms", "terminationTerms"]);
    expect(groups.performance_targets.map((m) => m.fieldKey)).toEqual(["performanceTargets"]);
    expect(groups.additional_details.map((m) => m.fieldKey)).toEqual(["onboardingProcessCompleted", "remarks", "agreementType"]);
    expect(Object.values(groups).flat()).toHaveLength(models.length);
  });

  it("splits the commercial section into dates and payment-affecting terms", () => {
    expect(fieldsInSubsection(models, "dates").map((m) => m.fieldKey)).toContain("effectiveDate");
    expect(fieldsInSubsection(models, "commercial").map((m) => m.fieldKey)).toContain("paymentCycle");
    expect(fieldsInSubsection(models, "commercial").map((m) => m.fieldKey)).not.toContain("performanceTargets");
  });

  it("counts unresolved fields", () => {
    expect(unresolvedFields(models).every((m) => m.unresolved)).toBe(true);
    expect(unresolvedCount(models)).toBe(unresolvedFields(models).length);
    expect(unresolvedFields(models).map((m) => m.fieldKey)).toContain("emailAddress");
    expect(unresolvedFields(models).map((m) => m.fieldKey)).not.toContain("paymentCycle");
  });
});

describe("buildExtractionRows", () => {
  const field = (over: Partial<ExtractionResultDto["fields"][number]>): ExtractionResultDto["fields"][number] => ({ fieldKey: "paymentCycle", normalizedValue: "MONTHLY", confidence: "HIGH", warnings: [], requiresHumanConfirmation: true, page: 2, valueState: "VISIBLE", ...over });

  it("shows label, proposed value, confidence, page, warnings and 'Needs confirmation' for every row", () => {
    const rows = buildExtractionRows({ fields: [field({ warnings: ["Two dates were found"] })], contractDetailVisible: false, restricted: null });
    expect(rows).toEqual([
      {
        fieldKey: "paymentCycle",
        label: "Payment cycle",
        valueText: "Monthly",
        restricted: false,
        confidence: "HIGH",
        page: 2,
        warnings: ["Two dates were found"],
        hasWarnings: true,
        needsConfirmation: true,
        needsConfirmationLabel: "Needs confirmation",
        needsMapping: false,
        needsMappingLabel: null,
        snippet: null,
      },
    ]);
  });

  it("masks a restricted identity value and never shows its snippet", () => {
    const rows = buildExtractionRows({
      fields: [field({ fieldKey: "panNumber", normalizedValue: null, valueState: "RESTRICTED" })],
      contractDetailVisible: true,
      restricted: { snippets: [{ fieldKey: "panNumber", page: 1, locator: null, rawSnippet: "PAN ABCDE1234F", snippetState: "VISIBLE" }] },
    });
    expect(rows[0]).toMatchObject({ restricted: true, valueText: "Restricted", snippet: null });
    expect(JSON.stringify(rows)).not.toContain("ABCDE1234F");
  });

  it("an authorized actor sees an identity value MASKED and a snippet never prints a full identity number", () => {
    const rows = buildExtractionRows({
      fields: [field({ fieldKey: "panNumber", normalizedValue: "ABCDE1234F", valueState: "VISIBLE" })],
      contractDetailVisible: true,
      restricted: { snippets: [{ fieldKey: "panNumber", page: 1, locator: null, rawSnippet: "Name as per PAN: Asha PAN: ABCDE1234F Account Number: 123456789012", snippetState: "VISIBLE" }] },
    });
    expect(rows[0]!.valueText).toBe("••••••234F");
    expect(rows[0]!.snippet).toBe("Name as per PAN: Asha PAN: ••••••234F Account Number: ••••••••9012");
    expect(JSON.stringify(rows)).not.toMatch(/ABCDE1234F|123456789012/);
  });

  it("shows raw snippets only when the actor may see contract detail", () => {
    const snippets = { snippets: [{ fieldKey: "paymentCycle" as const, page: 2, locator: null, rawSnippet: "Payable monthly", snippetState: "VISIBLE" as const }] };
    expect(buildExtractionRows({ fields: [field({})], contractDetailVisible: true, restricted: snippets })[0]!.snippet).toBe("Payable monthly");
    expect(buildExtractionRows({ fields: [field({})], contractDetailVisible: false, restricted: snippets })[0]!.snippet).toBeNull();
    expect(buildExtractionRows({ fields: [field({})], contractDetailVisible: false, restricted: null })[0]!.snippet).toBeNull();
  });

  it("marks an unsupported qualifying unit as Needs mapping", () => {
    const rows = buildExtractionRows({ fields: [field({ fieldKey: "qualifyingUnit", normalizedValue: "reel" }), field({ fieldKey: "qualifyingUnit", normalizedValue: "approved_current_link" })], contractDetailVisible: false, restricted: null });
    expect(rows[0]).toMatchObject({ needsMapping: true, needsMappingLabel: "Needs mapping", valueText: "reel" });
    expect(rows[1]).toMatchObject({ needsMapping: false, valueText: "Approved current link" });
  });
});
