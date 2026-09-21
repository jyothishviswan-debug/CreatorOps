import { describe, expect, it } from "vitest";

import type { AgreementDraftEntryDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";

import { buildFieldViewModels, groupFieldViewModels } from "../field-view-model";
import { sectionAnchorId } from "../confirm-blockers";
import { agreementDto, draftEntry } from "./intake-fixtures";
import { computeIntakeProgress, INTAKE_SECTIONS, intakeSectionAnchor, progressSummary, type ProgressInput } from "./intake-progress";

function input(over: Partial<ProgressInput> & { draft?: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>> } = {}): ProgressInput {
  const agreement = over.agreement === undefined ? agreementDto({ draft: over.draft ?? {} }) : over.agreement;
  const models = agreement ? buildFieldViewModels({ draft: agreement.selectedVersion?.draft ?? {}, counterpartyType: "PARTNER" }) : [];
  return { agreement, preview: null, extraction: null, extractionAttached: false, kyc: null, fields: groupFieldViewModels(models), ...over };
}

const stateOf = (items: ReturnType<typeof computeIntakeProgress>, key: string) => items.find((item) => item.key === key)!.state;

describe("intake sections", () => {
  it("are the ten of the product doc, in order", () => {
    expect(INTAKE_SECTIONS.map((section) => section.title)).toEqual([
      "Agreement for",
      "Contract source",
      "Existing CreatorOps details",
      "Extracted from Agreement",
      "Cross-verification",
      "Commercial terms",
      "Performance targets",
      "KYC & restricted details",
      "Additional details",
      "Review & confirm",
    ]);
    expect(INTAKE_SECTIONS.map((section) => section.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
  it("reuse the blocker anchors for the sections blockers point at, and a section-<key> id for the rest", () => {
    expect(intakeSectionAnchor("cross_verification")).toBe(sectionAnchorId("cross_verification"));
    expect(intakeSectionAnchor("commercial_terms")).toBe(sectionAnchorId("commercial_terms"));
    expect(intakeSectionAnchor("kyc")).toBe(sectionAnchorId("kyc"));
    expect(intakeSectionAnchor("review")).toBe(sectionAnchorId("review"));
    expect(intakeSectionAnchor("contract_source")).toBe("section-contract_source");
    expect(intakeSectionAnchor("existing_details")).toBe("section-existing_details");
    expect(intakeSectionAnchor("extracted")).toBe("section-extracted");
  });
});

describe("progress checklist", () => {
  it("before a draft: only Agreement for is open, the preview section may already show, the rest are locked", () => {
    const items = computeIntakeProgress(input({ agreement: null }));
    expect(stateOf(items, "agreement_for")).toBe("todo");
    expect(stateOf(items, "existing_details")).toBe("locked");
    expect(stateOf(items, "contract_source")).toBe("locked");
    expect(stateOf(items, "review")).toBe("locked");
    const withPreview = computeIntakeProgress(input({ agreement: null, preview: { source: "CreatorOps master data" } as never }));
    expect(stateOf(withPreview, "existing_details")).toBe("done");
  });

  it("after a draft: contract source and extraction are optional until used; fields needing a decision are `todo`", () => {
    const items = computeIntakeProgress(input());
    expect(stateOf(items, "agreement_for")).toBe("done");
    expect(stateOf(items, "contract_source")).toBe("optional");
    expect(stateOf(items, "extracted")).toBe("optional");
    // A fresh draft has commercial fields that must be decided explicitly.
    expect(stateOf(items, "commercial_terms")).toBe("todo");
    expect(stateOf(items, "review")).toBe("todo");
  });

  it("an extraction that is not attached is `todo`; attached is `done`", () => {
    const extraction = { run: { runRef: "run_1" }, fields: [] } as never;
    expect(stateOf(computeIntakeProgress(input({ extraction })), "extracted")).toBe("todo");
    expect(stateOf(computeIntakeProgress(input({ extraction, extractionAttached: true })), "extracted")).toBe("done");
    expect(stateOf(computeIntakeProgress(input({ extraction })), "contract_source")).toBe("done");
  });

  it("a section is done once none of its fields is unresolved, and todo while one still is", () => {
    const fresh = buildFieldViewModels({ draft: {}, counterpartyType: "PARTNER" });
    const section = fresh.filter((model) => model.section === "cross_verification" && model.decidable);
    const draft: Partial<Record<AgreementFieldKey, AgreementDraftEntryDto>> = {};
    for (const model of section) draft[model.fieldKey] = draftEntry({ value: "x", decision: "ACCEPTED" });
    expect(stateOf(computeIntakeProgress(input({ draft })), "cross_verification")).toBe("done");
    // one PENDING proposal (an extracted / prefilled value nobody has decided) keeps the section open
    const pending = { ...draft, [section[0]!.fieldKey]: draftEntry({ value: "x", decision: "PENDING", origin: "EXTRACTED" }) };
    expect(stateOf(computeIntakeProgress(input({ draft: pending })), "cross_verification")).toBe("todo");
  });

  it("KYC is done only when the KYC state is AVAILABLE; Review is done once confirmed", () => {
    expect(stateOf(computeIntakeProgress(input({ kyc: { state: "AVAILABLE" } as never })), "kyc")).toBe("done");
    expect(stateOf(computeIntakeProgress(input({ kyc: { state: "MISSING" } as never })), "kyc")).toBe("todo");
    expect(stateOf(computeIntakeProgress(input({ agreement: agreementDto({ confirmed: true }) })), "review")).toBe("done");
  });

  it("summarizes done / total without counting optional steps", () => {
    const items = computeIntakeProgress(input());
    const summary = progressSummary(items);
    expect(summary.total).toBe(items.filter((item) => item.state !== "optional").length);
    expect(summary.done).toBe(items.filter((item) => item.state === "done").length);
    expect(summary.done).toBeGreaterThanOrEqual(1);
  });
});
