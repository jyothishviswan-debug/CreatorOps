import { describe, expect, it } from "vitest";

import type { AgreementDraftEntryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { buildFieldViewModels } from "../../field-view-model";
import type { LocalEdits } from "../intake-logic";
import { agreementTypeHint, commercialIssues, issuesByField, resolveField, terminationDateIssue, type FieldResolver } from "./commercial-logic";
import { buildFieldRowView, requiredTextOf } from "./field-row-view";

function entry(over: Partial<AgreementDraftEntryDto> = {}): AgreementDraftEntryDto {
  return { value: null, origin: "MANUAL", decision: "PENDING", extractedValue: null, decidedByUserRef: null, decidedAt: null, provenance: { label: "Manual entry", extractionRunRef: null, page: null, confidence: null }, ...over };
}
const decided = (value: unknown, over: Partial<AgreementDraftEntryDto> = {}) => entry({ value, decision: "ACCEPTED", ...over });

function resolverFor(draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>, localEdits: LocalEdits = {}): FieldResolver {
  const models = buildFieldViewModels({ draft, counterpartyType: "PARTNER" });
  const byKey = new Map(models.map((model) => [model.fieldKey, model]));
  return (key) => resolveField(key, byKey.get(key), localEdits[key]);
}

describe("resolveField", () => {
  it("a PENDING proposal / prefill is undecided, never a value", () => {
    const resolve = resolverFor({ currency: entry({ value: "INR", extractedValue: "INR", origin: "EXTRACTED" }) });
    expect(resolve("currency")).toEqual({ state: "undecided" });
  });
  it("accepted / corrected entries are values; unavailable and not applicable resolve to their own states", () => {
    const resolve = resolverFor({
      currency: decided("INR"),
      paymentCycle: entry({ decision: "UNAVAILABLE" }),
      fixedComponent: entry({ decision: "NOT_APPLICABLE" }),
    });
    expect(resolve("currency")).toEqual({ state: "value", value: "INR" });
    expect(resolve("paymentCycle")).toEqual({ state: "unavailable" });
    expect(resolve("fixedComponent")).toEqual({ state: "not_applicable", value: { applicable: false, amountMinor: null } });
    expect(resolve("incentive")).toEqual({ state: "undecided" });
  });
  it("an unsaved edit wins over the saved entry", () => {
    const resolve = resolverFor({ currency: decided("INR") }, { currency: { decision: "CORRECTED", value: "USD" }, paymentCycle: { decision: "UNAVAILABLE" } });
    expect(resolve("currency")).toEqual({ state: "value", value: "USD" });
    expect(resolve("paymentCycle")).toEqual({ state: "unavailable" });
  });
});

describe("commercial cross-field rules", () => {
  it("an amount without a decided currency is reported against the currency field", () => {
    const issues = commercialIssues(resolverFor({ fixedComponent: decided({ applicable: true, amountMinor: 100 }) }));
    expect(issues.map((issue) => issue.fieldKey)).toEqual(["currency"]);
    expect(issuesByField(issues).currency?.[0]).toContain("currency is required");
  });
  it("no issue once the currency is decided, or when there is no amount", () => {
    expect(commercialIssues(resolverFor({ fixedComponent: decided({ applicable: true, amountMinor: 100 }), currency: decided("INR") }))).toEqual([]);
    expect(commercialIssues(resolverFor({}))).toEqual([]);
  });
  it("the required count and its unit go together - judged only once BOTH are decided", () => {
    expect(commercialIssues(resolverFor({ monthlyRequiredQualifyingContentCount: decided(4) }))).toEqual([]);
    const missingUnit = commercialIssues(resolverFor({ monthlyRequiredQualifyingContentCount: decided(4), qualifyingUnit: entry({ decision: "UNAVAILABLE" }) }));
    expect(missingUnit.map((issue) => issue.fieldKey)).toEqual(["qualifyingUnit"]);
    const unsupported = commercialIssues(resolverFor({ monthlyRequiredQualifyingContentCount: decided(4), qualifyingUnit: decided("reel") }));
    expect(unsupported.some((issue) => issue.fieldKey === "qualifyingUnit")).toBe(true);
    expect(commercialIssues(resolverFor({ monthlyRequiredQualifyingContentCount: decided(4), qualifyingUnit: decided("approved_content_thread") }))).toEqual([]);
  });
  it("the termination date cannot precede the effective date", () => {
    expect(terminationDateIssue(resolverFor({ effectiveDate: decided("2026-09-01"), terminationDate: decided("2026-08-01") }))).toContain("cannot precede");
    expect(terminationDateIssue(resolverFor({ effectiveDate: decided("2026-09-01"), terminationDate: decided("2027-08-31") }))).toBeNull();
    expect(terminationDateIssue(resolverFor({ terminationDate: decided("2026-08-01") }))).toBeNull();
  });
});

describe("Agreement type hint (the server is authoritative)", () => {
  it("derives from the commercial structure as decided so far", () => {
    expect(agreementTypeHint(resolverFor({}))).toBe("UNSPECIFIED");
    expect(agreementTypeHint(resolverFor({ fixedComponent: decided({ applicable: true, amountMinor: 100 }) }))).toBe("FIXED_ONLY");
    expect(agreementTypeHint(resolverFor({ fixedComponent: decided({ applicable: true, amountMinor: 100 }), monthlyRequiredQualifyingContentCount: decided(3) }))).toBe("FIXED_PLUS_REQUIRED_CONTENT");
  });
  it("an extractor-proposed (PENDING) structure is not counted", () => {
    expect(agreementTypeHint(resolverFor({ fixedComponent: entry({ value: { applicable: true, amountMinor: 100 }, origin: "EXTRACTED" }) }))).toBe("UNSPECIFIED");
  });
});

describe("field row view", () => {
  const model = (key: AgreementFieldKey, draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>>) => buildFieldViewModels({ draft, counterpartyType: "PARTNER" }).find((item) => item.fieldKey === key)!;

  it("shows an extracted proposal as unaccepted, with its source, page and confidence", () => {
    const extracted = entry({ value: "MONTHLY", extractedValue: "MONTHLY", origin: "EXTRACTED", provenance: { label: "Agreement", extractionRunRef: "run_1", page: 3, confidence: "HIGH" } });
    const view = buildFieldRowView({ model: model("paymentCycle", { paymentCycle: extracted }), currency: null });
    expect(view.isProposal).toBe(true);
    expect(view.currentLines).toEqual(["Monthly"]);
    expect(view.sourceText).toBe("Proposed from Agreement");
    expect(view.page).toBe(3);
    expect(view.confidence).toBe("HIGH");
    expect(view.statusChip.label).toBe("Needs confirmation");
    expect(view.canUseCandidate).toBe(true);
  });

  it("a master-data prefill is labelled as CreatorOps master data, never as extracted", () => {
    const prefilled = entry({ value: "Acme", origin: "MASTER_DATA" });
    const view = buildFieldRowView({ model: model("counterpartyName", { counterpartyName: prefilled }), currency: null });
    expect(view.sourceText).toBe("Prefilled from CreatorOps master data");
    expect(view.confidence).toBeNull();
  });

  it("an unsupported qualifying unit is shown as written, needs mapping and cannot be accepted as is", () => {
    const extracted = entry({ value: "reel", extractedValue: "reel", origin: "EXTRACTED" });
    const view = buildFieldRowView({ model: model("qualifyingUnit", { qualifyingUnit: extracted }), currency: null });
    expect(view.needsMapping).toBe(true);
    expect(view.extractedWording).toBe("reel");
    expect(view.currentLines).toEqual(["reel"]);
    expect(view.canUseCandidate).toBe(false);
  });

  it("an unsaved edit is on show and flagged; the proposal is kept apart when it differs", () => {
    const extracted = entry({ value: "MONTHLY", extractedValue: "MONTHLY", origin: "EXTRACTED" });
    const view = buildFieldRowView({ model: model("paymentCycle", { paymentCycle: extracted }), pending: { decision: "CORRECTED", value: "QUARTERLY" }, currency: null });
    expect(view.unsaved).toBe(true);
    expect(view.currentLines).toEqual(["Quarterly"]);
    expect(view.agreementProposedLines).toEqual(["Monthly"]);
    expect(view.isProposal).toBe(false);
  });

  it("decisions without values read as plain words", () => {
    expect(buildFieldRowView({ model: model("incentive", { incentive: entry({ decision: "NOT_APPLICABLE" }) }), currency: null }).currentLines).toEqual(["Not applicable"]);
    expect(buildFieldRowView({ model: model("incentive", { incentive: entry({ decision: "UNAVAILABLE" }) }), currency: null }).currentKind).toBe("unavailable");
    expect(buildFieldRowView({ model: model("incentive", {}), currency: null }).currentKind).toBe("none");
  });

  it("formats money against the decided currency", () => {
    const view = buildFieldRowView({ model: model("fixedComponent", { fixedComponent: decided({ applicable: true, amountMinor: 3500000 }) }), currency: "INR" });
    expect(view.currentLines).toEqual(["₹35,000"]);
  });

  it("marks a field changed from the previous version", () => {
    const changes = [{ fieldKey: "paymentCycle" as const, label: "Payment cycle", section: "commercial_terms" as const, before: "MONTHLY", after: "QUARTERLY", beforeText: "Monthly", afterText: "Quarterly" }];
    const view = buildFieldRowView({ model: model("paymentCycle", { paymentCycle: decided("QUARTERLY") }), currency: null, changes });
    expect(view.changedFromPrevious).toEqual({ beforeText: "Monthly" });
  });

  it("states what is required", () => {
    expect(requiredTextOf(model("effectiveDate", {}))).toBe("Required");
    expect(requiredTextOf(model("currency", {}))).toBe("Required when any amount is present");
    expect(requiredTextOf(model("remarks", {}))).toBeNull();
  });
});
