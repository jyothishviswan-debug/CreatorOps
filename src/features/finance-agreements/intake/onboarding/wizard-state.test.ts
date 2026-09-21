import { describe, expect, it } from "vitest";

import { permissionsDto } from "../intake-fixtures";
import { buildOnboardingRequest } from "./create-request";
import { candidate, duplicatesDto, outcomeDto, previewDto } from "./onboarding-fixtures";
import { accountFieldKey } from "./wizard-form";
import { duplicateSignature } from "./wizard-form";
import { currentDecision, formIssues, freshDuplicates, initialWizardState, isLocked, syncToChoice, wizardGates, wizardReducer, type WizardAction, type WizardState } from "./wizard-state";

const CAN_CREATE = permissionsDto({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
const run = (state: WizardState, ...actions: WizardAction[]): WizardState => actions.reduce(wizardReducer, state);

const START = initialWizardState("PARTNER", ["instagram"]);
const FILE = { name: "signed.pdf", size: 1000 };

// A wizard whose preview is in and whose form is complete (Instagram Partner).
const reviewed = (): WizardState => run(START, { type: "pickFile", file: FILE, error: null }, { type: "previewStart" }, { type: "previewDone", data: previewDto() });
const done = (state: WizardState, data: ReturnType<typeof duplicatesDto>): WizardAction => ({ type: "duplicatesDone", data, signature: duplicateSignature(state.form, state.type) });
const checked = (dto = duplicatesDto()): WizardState => {
  const state = run(reviewed(), { type: "duplicatesStart" });
  return run(state, done(state, dto));
};
const phase = (state: WizardState, permissions = CAN_CREATE) => wizardGates(state, permissions).phase;

describe("upload -> review", () => {
  it("starts empty in the upload phase; extract needs a valid picked file", () => {
    expect(phase(START)).toBe("upload");
    expect(wizardGates(START, CAN_CREATE).canPreview).toBe(false);
    const picked = run(START, { type: "pickFile", file: FILE, error: null });
    expect(wizardGates(picked, CAN_CREATE).canPreview).toBe(true);
    expect(wizardGates(run(START, { type: "pickFile", file: null, error: "Only PDF files can be uploaded." }), CAN_CREATE).canPreview).toBe(false);
    expect(wizardGates(picked, permissionsDto({ canManage: false })).canPreview).toBe(false);
    expect(wizardGates(run(picked, { type: "previewStart" }), CAN_CREATE).canPreview).toBe(false);
  });

  it("a preview moves to review and prefills the proposed record", () => {
    const state = reviewed();
    expect(phase(state)).toBe("review");
    expect(state.form).toMatchObject({ displayName: "Asha Rao", regionId: "Karnataka" });
    expect(state.form.accounts[0]!.locator).toBe("https://www.instagram.com/asha.travels");
    expect(formIssues(state)).toEqual([]);
  });

  it("a failed preview stays in upload with the message", () => {
    const state = run(START, { type: "pickFile", file: FILE, error: null }, { type: "previewStart" }, { type: "previewFailed", message: "This is not a PDF." });
    expect(state.preview).toEqual({ status: "error", message: "This is not a PDF." });
    expect(phase(state)).toBe("upload");
  });

  it("picking a different file drops the preview and everything downstream but keeps what was typed", () => {
    let state = checked();
    state = run(state, { type: "edit", field: "legalName", value: "Asha Rao Pvt" }, { type: "continueNew" });
    state = run(state, { type: "pickFile", file: { name: "other.pdf", size: 5 }, error: null });
    expect(state.preview.status).toBe("idle");
    expect(state.duplicates.load.status).toBe("idle");
    expect(state.decision.kind).toBe("NONE");
    expect(state.form.legalName).toBe("Asha Rao Pvt");
    expect(phase(state)).toBe("upload");
  });

  it("a second preview never overwrites a field the reviewer typed", () => {
    let state = run(START, { type: "pickFile", file: FILE, error: null }, { type: "edit", field: "displayName", value: "Asha R." });
    state = run(state, { type: "previewDone", data: previewDto() });
    expect(state.form.displayName).toBe("Asha R.");
    expect(state.form.email).toBe("asha@example.com");
  });
});

describe("review -> decide -> confirm", () => {
  it("cannot check for an existing record until the form is valid", () => {
    const blank = run(reviewed(), { type: "edit", field: "displayName", value: "" });
    expect(wizardGates(blank, CAN_CREATE).canCheck).toBe(false);
    expect(wizardGates(blank, CAN_CREATE).createBlockedReason).toMatch(/Complete the details above/);
    expect(wizardGates(reviewed(), CAN_CREATE).canCheck).toBe(true);
  });

  it("`none` needs no click: straight to confirm, and the create is enabled for someone who may create", () => {
    const state = checked();
    expect(phase(state)).toBe("confirm");
    expect(currentDecision(state)).toEqual({ kind: "CREATE_NEW", acknowledged: false, reason: "" });
    expect(wizardGates(state, CAN_CREATE)).toMatchObject({ canCreate: true, createBlockedReason: null });
  });

  it("a possible match waits in `decide` for the person's own choice", () => {
    const state = checked(duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x" })] }));
    expect(phase(state)).toBe("decide");
    expect(wizardGates(state, CAN_CREATE).canCreate).toBe(false);
    expect(wizardGates(state, CAN_CREATE).createBlockedReason).toMatch(/Choose an existing Partner, or continue creating/);
  });

  it("Use existing needs only manage_agreements (no create right); Continue creating needs the checkbox and a reason for a STRONG match", () => {
    const state = checked(duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x" })] }));
    const existing = run(state, { type: "useExisting", ref: "prt_x" });
    expect(wizardGates(existing, permissionsDto()).canCreate).toBe(true); // no create right at all

    const creating = run(state, { type: "continueNew" });
    expect(wizardGates(creating, CAN_CREATE).canCreate).toBe(false);
    const acknowledged = run(creating, { type: "setAcknowledged", value: true });
    expect(wizardGates(acknowledged, CAN_CREATE).createBlockedReason).toMatch(/short reason/);
    const ready = run(acknowledged, { type: "setReason", value: "Different person" });
    expect(wizardGates(ready, CAN_CREATE)).toMatchObject({ canCreate: true, phase: "confirm" });
  });

  it("without the create right the final step is disabled with the plain reason, while review and Use existing still work", () => {
    const state = checked();
    const gates = wizardGates(state, permissionsDto());
    expect(gates.canCreate).toBe(false);
    expect(gates.createBlockedReason).toMatch(/do not have permission to create a new Partner/);
    expect(gates.canCheck).toBe(true);
    const accounts = wizardGates(state, permissionsDto({ canCreatePartner: true }));
    expect(accounts.createBlockedReason).toMatch(/permission to add Partner Accounts/);
    expect(wizardGates(state, permissionsDto({ canManage: false })).createBlockedReason).toMatch(/Manage Agreements/);
  });

  it("a Vendor needs the Vendor create right (and never the account right)", () => {
    const vendor = run(initialWizardState("VENDOR", []), { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto({ counterpartyType: "VENDOR" }) }, { type: "edit", field: "vendorType", value: "AGENCY" });
    const decided = run(vendor, done(vendor, duplicatesDto({ type: "VENDOR" })));
    expect(wizardGates(decided, permissionsDto({ canCreateVendor: true })).canCreate).toBe(true);
    expect(wizardGates(decided, permissionsDto({ canCreatePartner: true, canManagePartnerAccounts: true })).createBlockedReason).toMatch(/new Vendor/);
  });

  it("a strong match outside access, or an account collision, blocks creating new for everyone", () => {
    const outside = run(checked(duplicatesDto({ status: "possible", strongMatchOutsideYourAccess: true })), { type: "continueNew" });
    expect(wizardGates(outside, CAN_CREATE)).toMatchObject({ canCreate: false });
    expect(wizardGates(outside, CAN_CREATE).createBlockedReason).toMatch(/outside your access/);
    const collision = run(checked(duplicatesDto({ status: "possible", candidates: [candidate({ signals: ["ACCOUNT_IDENTITY"] })] })), { type: "continueNew" }, { type: "setAcknowledged", value: true }, { type: "setReason", value: "Really different" });
    expect(wizardGates(collision, CAN_CREATE).createBlockedReason).toMatch(/already belongs to an existing Partner/);
  });

  it("an unknown check needs acknowledgement before creating", () => {
    const state = run(checked(duplicatesDto({ status: "unknown" })), { type: "continueNew" });
    expect(wizardGates(state, CAN_CREATE).canCreate).toBe(false);
    expect(wizardGates(run(state, { type: "setAcknowledged", value: true }, { type: "setReason", value: "Check was down" }), CAN_CREATE).canCreate).toBe(true);
  });

  it("editing the name, contact or an account voids the duplicate result and the decision; editing the region does not", () => {
    const state = run(checked(duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x", strength: "SUPPORTING", signals: ["DISPLAY_NAME"] })] })), { type: "useExisting", ref: "prt_x" });
    expect(currentDecision(state).kind).toBe("USE_EXISTING");
    expect(freshDuplicates(run(state, { type: "edit", field: "regionId", value: "Kerala" }))).not.toBeNull();
    for (const field of ["displayName", "email", "phone", accountFieldKey(0, "locator")] as const) {
      const edited = run(state, { type: "edit", field, value: "changed-value@example.com" });
      expect(freshDuplicates(edited)).toBeNull();
      expect(currentDecision(edited).kind).toBe("NONE");
      expect(wizardGates(edited, CAN_CREATE).phase).toBe("review");
    }
  });

  it("a new duplicate check clears the previous decision; a failed check leaves no result", () => {
    let state = run(checked(duplicatesDto({ status: "possible", candidates: [candidate()] })), { type: "continueNew" });
    state = run(state, { type: "duplicatesStart" });
    expect(state.decision.kind).toBe("NONE");
    state = run(state, { type: "duplicatesFailed", message: "Could not check." });
    expect(state.duplicates.load).toEqual({ status: "error", message: "Could not check." });
    expect(freshDuplicates(state)).toBeNull();
  });
});

describe("a duplicate check that was in flight while the form changed", () => {
  it("does not count as fresh for the new values", () => {
    const sent = run(reviewed(), { type: "duplicatesStart" });
    const signature = duplicateSignature(sent.form, sent.type);
    const edited = run(sent, { type: "edit", field: "displayName", value: "Someone Else" });
    const late = run(edited, { type: "duplicatesDone", data: duplicatesDto(), signature });
    expect(freshDuplicates(late)).toBeNull();
    expect(wizardGates(late, CAN_CREATE).phase).toBe("review");
  });
});

describe("following the card chosen in section 1", () => {
  it("a different kind of counterparty starts over", () => {
    expect(syncToChoice(START, { type: "VENDOR", platforms: [] })).toEqual({ type: "reset", counterpartyType: "VENDOR", platforms: [] });
    expect(syncToChoice(START, { type: "PARTNER", platforms: ["instagram"] })).toBeNull();
  });

  it("the same Partner on other platforms keeps everything typed, adds a blank row, and places the extracted page again", () => {
    const withTyped = run(reviewed(), { type: "edit", field: "legalName", value: "Asha Rao Pvt" });
    const action = syncToChoice(withTyped, { type: "PARTNER", platforms: ["instagram", "youtube"] })!;
    expect(action).toEqual({ type: "setPlatforms", platforms: ["instagram", "youtube"] });
    const next = run(withTyped, action);
    expect(next.form.legalName).toBe("Asha Rao Pvt");
    expect(next.form.accounts.map((row) => row.platform)).toEqual(["instagram", "youtube"]);
    expect(next.form.accounts[0]!.locator).toBe("https://www.instagram.com/asha.travels");
    expect(next.form.accounts[1]!.locator).toBe("");
    expect(next.preview.status).toBe("ready");
    // dropping a platform drops its row; the duplicate result (which covered the accounts) is void
    const back = run(next, { type: "setPlatforms", platforms: ["youtube"] });
    expect(back.form.accounts.map((row) => row.platform)).toEqual(["youtube"]);
  });

  it("is ignored once a create request has been sent", () => {
    const sent = run(checked(), { type: "createStart" });
    expect(run(sent, { type: "setPlatforms", platforms: ["instagram", "youtube"] })).toBe(sent);
  });
});

describe("create -> outcome", () => {
  const confirm = () => checked();

  it("sending locks the inputs; the phase follows the server's answer", () => {
    let state = run(confirm(), { type: "createStart" });
    expect(isLocked(state)).toBe(true);
    expect(phase(state)).toBe("creating");
    const locked = run(state, { type: "edit", field: "displayName", value: "Changed" }, { type: "pickFile", file: null, error: null }, { type: "duplicatesStart" }, { type: "useExisting", ref: "x" });
    expect(locked.form.displayName).toBe("Asha Rao");
    expect(locked.file).toEqual(FILE);
    expect(locked.duplicates.load.status).toBe("ready");
    state = run(state, { type: "createOutcome", outcome: outcomeDto({ outcome: "FAILED", failedStep: "ACCOUNTS_CREATED", retryable: true }) });
    expect(phase(state)).toBe("outcome");
    expect(isLocked(state)).toBe(true);
    expect(wizardGates(state, CAN_CREATE).canCreate).toBe(false);
  });

  it("a `none` duplicate result keeps its implied CREATE_NEW decision while the request runs and after it stops (the confirmed values must not vanish on Create)", () => {
    const running = run(confirm(), { type: "createStart" });
    expect(currentDecision(running)).toEqual({ kind: "CREATE_NEW", acknowledged: false, reason: "" });
    expect(wizardGates(running, CAN_CREATE).decision.kind).toBe("CREATE_NEW");
    const lost = run(running, { type: "createError", message: "Could not reach the server." });
    expect(currentDecision(lost).kind).toBe("CREATE_NEW");
    const failed = run(running, { type: "createOutcome", outcome: outcomeDto({ outcome: "FAILED", failedStep: "ACCOUNTS_CREATED", retryable: true }) });
    expect(currentDecision(failed).kind).toBe("CREATE_NEW");
  });

  it("a refusal before anything was written unlocks the inputs; a duplicate-rule refusal also voids the check", () => {
    const refused = run(confirm(), { type: "createStart" }, { type: "createRefused", message: "You do not have permission.", code: "counterparty_create_not_permitted", recheck: false });
    expect(refused.create).toEqual({ status: "refused", message: "You do not have permission.", code: "counterparty_create_not_permitted" });
    expect(isLocked(refused)).toBe(false);
    expect(phase(refused)).toBe("stopped");
    expect(freshDuplicates(refused)).not.toBeNull();
    const recheck = run(confirm(), { type: "createStart" }, { type: "createRefused", message: "A very likely match exists.", code: "duplicate_acknowledgement_required", recheck: true });
    expect(freshDuplicates(recheck)).toBeNull();
    expect(recheck.decision.kind).toBe("NONE");
    // editing after a refusal clears the message
    expect(run(refused, { type: "edit", field: "legalName", value: "X" }).create.status).toBe("idle");
  });

  it("a lost answer keeps the inputs locked (the request may have reached the server) until the same request is sent again", () => {
    const lost = run(confirm(), { type: "createStart" }, { type: "createError", message: "Could not reach the server." });
    expect(lost.create.status).toBe("error");
    expect(isLocked(lost)).toBe(true);
    expect(phase(lost)).toBe("stopped");
    const again = run(lost, { type: "createStart" });
    expect(phase(again)).toBe("creating");
  });

  it("Start again unlocks the inputs; when a record was created the check must run again", () => {
    const failed = run(confirm(), { type: "createStart" }, { type: "createOutcome", outcome: outcomeDto({ outcome: "FAILED", retryable: false, failedStep: "ACCOUNTS_CREATED" }) });
    const keep = run(failed, { type: "startAgain", recheck: false });
    expect(isLocked(keep)).toBe(false);
    expect(freshDuplicates(keep)).not.toBeNull();
    expect(phase(keep)).toBe("confirm");
    const recheck = run(failed, { type: "startAgain", recheck: true });
    expect(freshDuplicates(recheck)).toBeNull();
    expect(phase(recheck)).toBe("review");
    expect(recheck.form.displayName).toBe("Asha Rao");
  });

  it("restores a remembered request after a reload: locked, with the server's outcome, form and decision rebuilt", () => {
    const request = buildOnboardingRequest({ clientRequestId: "onboard-abc12345", type: "PARTNER", form: reviewed().form, decision: { kind: "CREATE_NEW", acknowledged: false, reason: "" } })!;
    const outcome = outcomeDto({ outcome: "FAILED", failedStep: "COUNTERPARTY_CREATED", retryable: true });
    const state = run(START, { type: "resumeStart" }, { type: "restore", request, outcome });
    expect(state).toMatchObject({ requestSent: true, restored: true, resume: { status: "idle" } });
    expect(state.form.displayName).toBe("Asha Rao");
    expect(state.decision).toEqual({ kind: "CREATE_NEW", acknowledged: false, reason: "" });
    expect(phase(state)).toBe("outcome");
    // without a server outcome the answer is treated as lost (Retry sends the same request)
    expect(run(START, { type: "restore", request, outcome: null }).create.status).toBe("error");
    expect(run(START, { type: "resumeUnavailable", message: "Offline." }).resume).toEqual({ status: "unavailable", message: "Offline." });
  });

  it("reset (a different kind of counterparty) starts over", () => {
    const state = run(checked(), { type: "reset", counterpartyType: "VENDOR", platforms: [] });
    expect(state).toEqual(initialWizardState("VENDOR", []));
  });
});
