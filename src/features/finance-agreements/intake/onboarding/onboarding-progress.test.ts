import { describe, expect, it } from "vitest";

import { permissionsDto } from "../intake-fixtures";
import { candidate, duplicatesDto, outcomeDto, previewDto } from "./onboarding-fixtures";
import { ONBOARDING_STEP_ANCHORS, onboardingProgress } from "./onboarding-progress";
import { duplicateSignature } from "./wizard-form";
import { initialWizardState, wizardGates, wizardReducer, type WizardAction, type WizardState } from "./wizard-state";

const PERMS = permissionsDto({ canCreatePartner: true, canManagePartnerAccounts: true });
const run = (state: WizardState, ...actions: WizardAction[]): WizardState => actions.reduce(wizardReducer, state);
const states = (state: WizardState) => onboardingProgress(state, wizardGates(state, PERMS)).map((item) => `${item.key}:${item.state}`);
const FILE = { name: "a.pdf", size: 1 };
const withDuplicates = (state: WizardState, data: ReturnType<typeof duplicatesDto>): WizardState => run(state, { type: "duplicatesDone", data, signature: duplicateSignature(state.form, state.type) });

describe("onboarding checklist", () => {
  it("starts with Agreement for done, the upload to do and the rest locked", () => {
    expect(states(initialWizardState("PARTNER", ["instagram"]))).toEqual(["agreement_for:done", "upload:todo", "record:locked", "duplicates:locked", "create:locked"]);
  });

  it("advances with the preview, the valid form, the decided duplicate check and the completed create", () => {
    let state = run(initialWizardState("PARTNER", ["instagram"]), { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto() });
    expect(states(state)).toEqual(["agreement_for:done", "upload:done", "record:done", "duplicates:todo", "create:locked"]);
    state = withDuplicates(state, duplicatesDto());
    expect(states(state)).toEqual(["agreement_for:done", "upload:done", "record:done", "duplicates:done", "create:todo"]);
    state = run(state, { type: "createStart" }, { type: "createOutcome", outcome: outcomeDto() });
    expect(states(state).at(-1)).toBe("create:done");
  });

  it("an invalid form keeps the record step open and the check locked; an undecided match keeps the check open", () => {
    const invalid = run(initialWizardState("PARTNER", ["instagram"]), { type: "previewDone", data: previewDto() }, { type: "edit", field: "displayName", value: "" });
    expect(states(invalid)).toEqual(["agreement_for:done", "upload:done", "record:todo", "duplicates:locked", "create:locked"]);
    const undecided = withDuplicates(run(initialWizardState("PARTNER", ["instagram"]), { type: "previewDone", data: previewDto() }), duplicatesDto({ status: "possible", candidates: [candidate()] }));
    expect(states(undecided)).toEqual(["agreement_for:done", "upload:done", "record:done", "duplicates:todo", "create:locked"]);
  });

  it("numbers the steps, words the Vendor steps and gives each a jump anchor and a state label", () => {
    const items = onboardingProgress(initialWizardState("VENDOR", []), wizardGates(initialWizardState("VENDOR", []), PERMS));
    expect(items.map((item) => item.number)).toEqual([1, 2, 3, 4, 5]);
    expect(items.map((item) => item.title)).toEqual(["Agreement for", "Signed Agreement", "New Vendor details", "Check for an existing Vendor", "Create and start the Agreement"]);
    expect(items[2]!.anchorId).toBe(ONBOARDING_STEP_ANCHORS.record);
    expect(items[0]!.anchorId).toBe("section-agreement_for");
    expect(items[3]!.stateLabel).toBe("Complete the step before");
  });
});
