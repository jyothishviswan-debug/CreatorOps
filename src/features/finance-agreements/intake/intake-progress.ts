import type { AgreementDetailDto } from "@/server/finance-agreements/client-dto";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { CounterpartyPreviewDto } from "@/server/finance-agreements/workspace-dto";

import type { FieldViewModel, IntakeSectionId } from "../field-view-model";
import { sectionAnchorId } from "../confirm-blockers";

// Step 14B intake: the ten sections of the staged form, their anchors, and the progress the right-hand checklist shows (pure).

export type IntakeSectionKey =
  | "agreement_for"
  | "contract_source"
  | "existing_details"
  | "extracted"
  | "cross_verification"
  | "commercial_terms"
  | "performance_targets"
  | "kyc"
  | "additional_details"
  | "review";

export const INTAKE_SECTIONS: ReadonlyArray<{ key: IntakeSectionKey; number: number; title: string }> = [
  { key: "agreement_for", number: 1, title: "Agreement for" },
  { key: "contract_source", number: 2, title: "Contract source" },
  { key: "existing_details", number: 3, title: "Existing CreatorOps details" },
  { key: "extracted", number: 4, title: "Extracted from Agreement" },
  { key: "cross_verification", number: 5, title: "Cross-verification" },
  { key: "commercial_terms", number: 6, title: "Commercial terms" },
  { key: "performance_targets", number: 7, title: "Performance targets" },
  { key: "kyc", number: 8, title: "KYC & restricted details" },
  { key: "additional_details", number: 9, title: "Additional details" },
  { key: "review", number: 10, title: "Review & confirm" },
];

// The six sections that other agents / blockers already address through sectionAnchorId keep that id; the three sections owned by the
// orchestrator agent get the same `section-<key>` shape.
export function intakeSectionAnchor(key: IntakeSectionKey): string {
  if (key === "review" || key === "agreement_for" || key === "cross_verification" || key === "commercial_terms" || key === "performance_targets" || key === "kyc" || key === "additional_details") {
    return sectionAnchorId(key as IntakeSectionId | "review");
  }
  return `section-${key}`;
}

export type ProgressState = "done" | "todo" | "optional" | "locked";
export type ProgressItem = { key: IntakeSectionKey; number: number; title: string; state: ProgressState; anchorId: string };

export const PROGRESS_STATE_LABELS: Record<ProgressState, string> = { done: "Done", todo: "To do", optional: "Optional", locked: "Start a draft first" };

export type ProgressInput = {
  agreement: AgreementDetailDto | null;
  preview: CounterpartyPreviewDto | null;
  extraction: ExtractionResultDto | null;
  extractionAttached: boolean;
  kyc: AgreementKycStatusDto | null;
  fields: Record<IntakeSectionId, FieldViewModel[]>;
};

const sectionDone = (models: readonly FieldViewModel[]): boolean => models.every((model) => !model.unresolved);

// One line per section: whether the person still has something to do there. This is guidance only - the server's confirm gate decides.
export function computeIntakeProgress(input: ProgressInput): ProgressItem[] {
  const hasDraft = input.agreement !== null;
  const confirmed = input.agreement?.selectedVersion?.confirmed ?? false;
  const stateFor = (key: IntakeSectionKey): ProgressState => {
    if (key === "agreement_for") return hasDraft ? "done" : "todo";
    if (key === "existing_details") return input.preview ? "done" : hasDraft ? "todo" : "locked";
    if (!hasDraft) return "locked";
    switch (key) {
      case "contract_source":
        return input.extraction ? "done" : "optional";
      case "extracted":
        return input.extraction ? (input.extractionAttached ? "done" : "todo") : "optional";
      case "cross_verification":
        return sectionDone(input.fields.cross_verification) ? "done" : "todo";
      case "commercial_terms":
        return sectionDone(input.fields.commercial_terms) ? "done" : "todo";
      case "performance_targets":
        return input.fields.performance_targets.some((model) => model.hasEntry) ? (sectionDone(input.fields.performance_targets) ? "done" : "todo") : "optional";
      case "kyc":
        return input.kyc?.state === "AVAILABLE" ? "done" : "todo";
      case "additional_details":
        return sectionDone(input.fields.additional_details) ? "done" : "todo";
      case "review":
        return confirmed ? "done" : "todo";
      default:
        return "todo";
    }
  };
  return INTAKE_SECTIONS.map((section) => ({ key: section.key, number: section.number, title: section.title, state: stateFor(section.key), anchorId: intakeSectionAnchor(section.key) }));
}

export function progressSummary(items: readonly ProgressItem[]): { done: number; total: number } {
  const counted = items.filter((item) => item.state !== "optional");
  return { done: counted.filter((item) => item.state === "done").length, total: counted.length };
}
