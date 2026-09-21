import type { ProgressState } from "../intake-progress";
import { intakeSectionAnchor } from "../intake-progress";
import type { WizardGates, WizardState } from "./wizard-state";

// Step 14B.1 onboarding: the right-hand checklist while a NEW Partner / Vendor is being set up (pure). Once the record exists the standard ten
// sections take over again. Guidance only - the server decides.

export type OnboardingStepKey = "upload" | "record" | "duplicates" | "create";

export const ONBOARDING_STEP_ANCHORS: Record<OnboardingStepKey, string> = {
  upload: "section-onboarding-upload",
  record: "section-onboarding-record",
  duplicates: "section-onboarding-duplicates",
  create: "section-onboarding-create",
};

export type OnboardingProgressItem = { key: "agreement_for" | OnboardingStepKey; number: number; title: string; state: ProgressState; anchorId: string; stateLabel: string };

export const ONBOARDING_STATE_LABELS: Record<ProgressState, string> = { done: "Done", todo: "To do", optional: "Optional", locked: "Complete the step before" };

export function onboardingProgress(state: WizardState, gates: WizardGates): OnboardingProgressItem[] {
  const noun = state.type === "PARTNER" ? "Partner" : "Vendor";
  const previewReady = state.preview.status === "ready";
  const validForm = previewReady && gates.issues.length === 0;
  const checked = gates.duplicates !== null && gates.decisionReady;
  const completed = state.create.status === "outcome" && state.create.outcome.outcome === "COMPLETED";
  const items: Array<{ key: OnboardingProgressItem["key"]; title: string; state: ProgressState; anchorId: string }> = [
    { key: "agreement_for", title: "Agreement for", state: "done", anchorId: intakeSectionAnchor("agreement_for") },
    { key: "upload", title: "Signed Agreement", state: previewReady ? "done" : "todo", anchorId: ONBOARDING_STEP_ANCHORS.upload },
    { key: "record", title: `New ${noun} details`, state: !previewReady ? "locked" : validForm ? "done" : "todo", anchorId: ONBOARDING_STEP_ANCHORS.record },
    { key: "duplicates", title: `Check for an existing ${noun}`, state: !validForm ? "locked" : checked ? "done" : "todo", anchorId: ONBOARDING_STEP_ANCHORS.duplicates },
    { key: "create", title: `Create and start the Agreement`, state: completed ? "done" : !checked ? "locked" : "todo", anchorId: ONBOARDING_STEP_ANCHORS.create },
  ];
  return items.map((item, index) => ({ ...item, number: index + 1, stateLabel: ONBOARDING_STATE_LABELS[item.state] }));
}
