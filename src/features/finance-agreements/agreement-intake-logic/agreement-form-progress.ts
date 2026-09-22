import type { AgreementDetailDto } from "@/server/finance-agreements/client-dto";
import type { ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { CounterpartyPreviewDto } from "@/server/finance-agreements/workspace-dto";

import type { FieldViewModel, IntakeSectionId } from "../field-view-model";

// Step 14C.3: the SEVEN visible steps of the rebuilt Agreement form (IA section 7 of the hard-reset instruction) - Agreement
// party / Source Agreement / Identity review / KYC / Agreement terms / Performance targets / Review. "Agreement terms" covers
// both the commercial_terms and additional_details field groups (still the same underlying registry grouping from
// field-view-model.ts; only the page-level walkthrough merges their steps). There is no separate "Extracted from Agreement"
// step: Source Agreement already shows the extraction result, and every proposed value is visible next to its decision in
// Identity review / Agreement terms.
export type AgreementFormSectionKey = "party" | "source" | "identity" | "kyc" | "terms" | "targets" | "review";

export const AGREEMENT_FORM_SECTIONS: ReadonlyArray<{ key: AgreementFormSectionKey; number: number; title: string }> = [
  { key: "party", number: 1, title: "Agreement party" },
  { key: "source", number: 2, title: "Source Agreement" },
  { key: "identity", number: 3, title: "Identity review" },
  { key: "kyc", number: 4, title: "KYC" },
  { key: "terms", number: 5, title: "Agreement terms" },
  { key: "targets", number: 6, title: "Performance targets" },
  { key: "review", number: 7, title: "Review" },
];

export type FormProgressState = "done" | "todo" | "optional" | "locked";
export type FormProgressItem = { key: AgreementFormSectionKey; number: number; title: string; state: FormProgressState; anchorId: string };

export const FORM_PROGRESS_STATE_LABELS: Record<FormProgressState, string> = { done: "Done", todo: "To do", optional: "Optional", locked: "Start a draft first" };

export const agreementFormAnchorId = (key: AgreementFormSectionKey): string => `section-${key}`;

export type AgreementFormProgressInput = {
  agreement: AgreementDetailDto | null;
  preview: CounterpartyPreviewDto | null;
  extraction: ExtractionResultDto | null;
  kyc: AgreementKycStatusDto | null;
  fields: Record<IntakeSectionId, FieldViewModel[]>;
};

const sectionDone = (models: readonly FieldViewModel[]): boolean => models.every((model) => !model.unresolved);

export function computeAgreementFormProgress(input: AgreementFormProgressInput): FormProgressItem[] {
  const hasDraft = input.agreement !== null;
  const confirmed = input.agreement?.selectedVersion?.confirmed ?? false;
  const stateFor = (key: AgreementFormSectionKey): FormProgressState => {
    if (key === "party") return hasDraft ? "done" : "todo";
    if (key === "identity") return input.preview ? "done" : hasDraft ? "todo" : "locked";
    if (!hasDraft) return "locked";
    switch (key) {
      case "source":
        return input.extraction ? "done" : "optional";
      case "terms":
        return sectionDone(input.fields.commercial_terms) && sectionDone(input.fields.additional_details) ? "done" : "todo";
      case "targets":
        return input.fields.performance_targets.some((model) => model.hasEntry) ? (sectionDone(input.fields.performance_targets) ? "done" : "todo") : "optional";
      case "kyc":
        return input.kyc?.state === "AVAILABLE" ? "done" : "todo";
      case "review":
        return confirmed ? "done" : "todo";
      default:
        return "todo";
    }
  };
  return AGREEMENT_FORM_SECTIONS.map((section) => ({ key: section.key, number: section.number, title: section.title, state: stateFor(section.key), anchorId: agreementFormAnchorId(section.key) }));
}

export function agreementFormProgressSummary(items: ReadonlyArray<{ state: FormProgressState }>): { done: number; total: number } {
  const counted = items.filter((item) => item.state !== "optional");
  return { done: counted.filter((item) => item.state === "done").length, total: counted.length };
}
