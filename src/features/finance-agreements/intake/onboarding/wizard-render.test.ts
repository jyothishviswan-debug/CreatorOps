import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import { permissionsDto } from "../intake-fixtures";
import { describeOutcome, stepRows } from "./create-progress";
import { candidate, duplicatesDto, outcomeDto, previewDto, previewField } from "./onboarding-fixtures";
import { onboardingProgress } from "./onboarding-progress";
import { duplicateSignature } from "./wizard-form";
import { initialWizardState, isLocked, wizardGates, wizardReducer, type WizardAction, type WizardState } from "./wizard-state";

// The wizard's components read everything from useIntake(); here it is replaced by a value built from the REAL state machine, so each block is
// rendered (server-side, no DOM) in every state the person can be in and the markup that matters is asserted: which controls EXIST, which are
// disabled with a reason, what is announced, and that nothing sensitive is ever printed.
const holder = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../intake-context", () => ({
  INTAKE_BUSY: { onboardPreview: "onboarding-preview", onboardDuplicates: "onboarding-duplicates", onboardCreate: "onboarding-create" },
  useIntake: () => holder.current,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));

import { OnboardingWizard } from "./OnboardingWizard";
import { WizardCreateBlock } from "./WizardCreateBlock";
import { WizardDuplicatesBlock } from "./WizardDuplicatesBlock";
import { WizardRecordBlock } from "./WizardRecordBlock";
import { WizardUploadBlock } from "./WizardUploadBlock";

const noop = () => undefined;
const asyncNoop = async () => undefined;
const CAN_CREATE = permissionsDto({ canCreatePartner: true, canCreateVendor: true, canManagePartnerAccounts: true });
const run = (state: WizardState, ...actions: WizardAction[]): WizardState => actions.reduce(wizardReducer, state);

function show(state: WizardState, permissions: FinanceAgreementPermissionsDto = CAN_CREATE, busyKey: string | null = null): void {
  const gates = wizardGates(state, permissions);
  const outcome = state.create.status === "outcome" ? state.create.outcome : null;
  holder.current = {
    permissions,
    isBusy: (key?: string) => (key === undefined ? busyKey !== null : busyKey === key),
    onboarding: {
      selection: { mode: "new", choice: state.type === "VENDOR" ? "VENDOR" : "INSTAGRAM_PARTNER" },
      setSelection: noop,
      active: true,
      locked: isLocked(state),
      type: state.type,
      state,
      gates,
      progress: onboardingProgress(state, gates),
      steps: stepRows(outcome, { type: state.type, mode: outcome?.mode ?? (gates.decision.kind === "USE_EXISTING" ? "USE_EXISTING" : "CREATE_NEW"), accountCount: state.form.accounts.length, running: state.create.status === "running" }),
      outcomeView: outcome ? describeOutcome(outcome) : null,
      pickFile: noop,
      extractPreview: asyncNoop,
      edit: noop,
      revealIssues: noop,
      checkDuplicates: asyncNoop,
      chooseExisting: noop,
      continueNew: noop,
      setAcknowledged: noop,
      setReason: noop,
      clearDecision: noop,
      create: asyncNoop,
      startAgain: noop,
    },
  };
}
const html = (component: Parameters<typeof createElement>[0]) => renderToStaticMarkup(createElement(component));
// The opening tag of the element carrying a data-testid (attribute order is not part of what is asserted).
const openTag = (markup: string, testId: string): string => markup.match(new RegExp(`<[a-z]+\\b[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
const isDisabled = (markup: string, testId: string): boolean => openTag(markup, testId).includes('disabled=""');

const FILE = { name: "signed-agreement.pdf", size: 204800 };
const START = initialWizardState("PARTNER", ["instagram"]);
const previewed = (state = START) => run(state, { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto() });
const checked = (dto = duplicatesDto()) => {
  const state = previewed();
  return run(state, { type: "duplicatesDone", data: dto, signature: duplicateSignature(state.form, state.type) });
};

beforeEach(() => {
  holder.current = null;
});

describe("upload block", () => {
  it("starts with a PDF input, a disabled Extract button and the exact wording", () => {
    show(START);
    const markup = html(WizardUploadBlock);
    expect(markup).toContain("Agreement PDF");
    expect(markup).toContain("PDF only · up to 10 MB");
    expect(markup).toContain("Extract from Agreement");
    expect(isDisabled(markup, "onboarding-extract")).toBe(true);
    expect(markup).toContain("Choose a PDF to enable extraction.");
    expect(markup).not.toContain("Extracted Agreement values");
  });

  it("with a picked file the Extract button is enabled and the file is named", () => {
    show(run(START, { type: "pickFile", file: FILE, error: null }));
    const markup = html(WizardUploadBlock);
    expect(isDisabled(markup, "onboarding-extract")).toBe(false);
    expect(openTag(markup, "onboarding-extract")).not.toBe("");
    expect(markup).toContain("signed-agreement.pdf");
    expect(markup).toContain("200 KB");
  });

  it("an invalid file shows its message as an alert", () => {
    show(run(START, { type: "pickFile", file: null, error: "Only PDF files can be uploaded." }));
    expect(html(WizardUploadBlock)).toMatch(/role="alert"[^>]*>Only PDF files can be uploaded\./);
  });

  it("shows the extracted values, the status chip, the note, and identity as PRESENCE only", () => {
    show(previewed());
    const markup = html(WizardUploadBlock);
    expect(markup).toContain("Extracted Agreement values");
    expect(markup).toContain("Asha Rao");
    expect(markup).toContain("asha@example.com");
    expect(markup).toContain("Needs confirmation");
    expect(markup).toContain('data-testid="onboarding-extraction-chip"');
    expect(markup).toContain("Extraction suggests values only. Review every field before confirming the Agreement.");
    expect(markup).toContain("PAN found in Agreement");
    expect(markup).not.toMatch(/[A-Z]{5}\d{4}[A-Z]/);
    expect(markup).not.toContain("Missing in CreatorOps");
  });

  it("a scanned Agreement shows the required message and no values table", () => {
    const blank = { counterpartyName: null, contactNumber: null, emailAddress: null, state: null, collaboratorPageName: null, collaboratorPageLink: null };
    show(run(START, { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto({ extraction: { status: "MANUAL_REVIEW_REQUIRED", reasons: [{ code: "no_extractable_text", message: "No text." }], pageCount: 2 }, detectedPlatform: null, identityFound: { pan: false, aadhaar: false, gst: false, bank: false } }, blank) }));
    const markup = html(WizardUploadBlock);
    expect(markup).toContain("Manual review required — no extractable text was found.");
    expect(markup).not.toContain("onboarding-extracted-values");
  });

  it("while reading it says so in the polite status region and disables the button", () => {
    show(run(START, { type: "pickFile", file: FILE, error: null }, { type: "previewStart" }), CAN_CREATE, "onboarding-preview");
    const markup = html(WizardUploadBlock);
    expect(markup).toContain("Reading Agreement…");
    expect(markup).toContain("Reading signed-agreement.pdf… Nothing is saved.");
  });
});

describe("proposed record block", () => {
  it("before a preview: only the explanation, no form fields and no check button", () => {
    show(START);
    const markup = html(WizardRecordBlock);
    expect(markup).toContain("Read the signed Agreement above first");
    expect(markup).not.toContain("Check for existing");
  });

  it("a Partner shows label-bound fields, a canonical region select and one account row per selected platform", () => {
    show(previewed(run(START, { type: "setPlatforms", platforms: ["instagram", "youtube"] })));
    const markup = html(WizardRecordBlock);
    expect(markup).toMatch(/<label for="([^"]+)-displayName">Name/);
    expect(markup).toContain("Legal name");
    expect(markup).toContain("Email address");
    expect(markup).toContain("Phone number");
    expect(markup).toContain("<optgroup");
    expect(markup).toContain("Karnataka");
    expect(markup).toContain("Instagram account");
    expect(markup).toContain("YouTube account");
    expect(markup).toContain("Page link");
    expect(markup).toContain("Handle");
    expect(markup).toContain("Check for existing Partner");
    expect(markup).not.toContain("Vendor type");
    // the Agreement's page and name were prefilled on the Instagram row
    expect(markup).toContain("https://www.instagram.com/asha.travels");
    expect(markup).toContain("Asha Travels");
  });

  it("a Vendor shows the Vendor type select and no accounts", () => {
    const vendor = run(initialWizardState("VENDOR", []), { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto({ counterpartyType: "VENDOR", detectedPlatform: null }) });
    show(vendor);
    const markup = html(WizardRecordBlock);
    expect(markup).toContain("Vendor type");
    expect(markup).toContain("Management company");
    expect(markup).toContain("Check for existing Vendor");
    expect(markup).not.toContain("Partner Accounts");
  });

  it("a state the Agreement states that is not canonical is left blank with a note", () => {
    show(run(START, { type: "pickFile", file: FILE, error: null }, { type: "previewDone", data: previewDto({}, { state: previewField("Bengalooru") }) }));
    expect(html(WizardRecordBlock)).toContain("Bengalooru");
  });

  it("locks every field once a request was sent", () => {
    const locked = run(checked(), { type: "createStart" });
    show(locked);
    const markup = html(WizardRecordBlock);
    expect(markup).toMatch(/<input[^>]*id="[^"]*-displayName"[^>]*disabled=""/);
    expect(isDisabled(markup, "onboarding-check-duplicates")).toBe(true);
  });
});

describe("duplicates block", () => {
  it("names the check and says what is missing before it can run", () => {
    show(START);
    expect(html(WizardDuplicatesBlock)).toContain("Complete the Partner details above, then check for an existing Partner.");
  });

  it("`possible`: the exact heading, candidate cards with STRONG label and human signals, Use existing and Continue creating new", () => {
    show(checked(duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x", displayName: "Asha R. Rao", signals: ["EMAIL", "PHONE"] })] })));
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("Possible existing Partner found");
    expect(markup).toContain("Asha R. Rao");
    expect(markup).toContain("Strong match");
    expect(markup).toContain("Same email address");
    expect(markup).toContain("Same phone number");
    expect(markup).toContain("Use existing");
    expect(markup).toContain("Continue creating new");
    // no acknowledgement until the person chooses to continue
    expect(markup).not.toContain("onboarding-acknowledge");
  });

  it("continuing over a STRONG match shows the acknowledgement checkbox and a required reason", () => {
    show(run(checked(duplicatesDto({ status: "possible", candidates: [candidate()] })), { type: "continueNew" }));
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("onboarding-acknowledge");
    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain("Reason for creating a new Partner");
    expect(markup).toContain("At least 3 characters.");
    expect(markup).toContain("Confirm that you want to create a new Partner even though a very likely match exists.");
  });

  it("a strong match outside access blocks with the neutral message, offers no Continue and reveals nothing else", () => {
    show(checked(duplicatesDto({ status: "possible", strongMatchOutsideYourAccess: true })));
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("A matching Partner already exists outside your access. Ask an administrator to check it before creating a new one.");
    expect(markup).not.toContain("Continue creating new");
    expect(markup).not.toContain("onboarding-candidate-");
  });

  it("an Account that belongs to another Partner blocks creating and offers only Use existing", () => {
    show(checked(duplicatesDto({ status: "possible", candidates: [candidate({ signals: ["ACCOUNT_IDENTITY"] })] })));
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("One of these accounts already belongs to an existing Partner.");
    expect(markup).toContain("Use existing");
    expect(markup).not.toContain("Continue creating new");
  });

  it("an unknown check says it could not be completed and needs acknowledgement", () => {
    show(run(checked(duplicatesDto({ status: "unknown" })), { type: "continueNew" }));
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("Could not check for an existing Partner");
    expect(markup).toContain("I understand the check could not be completed");
  });

  it("`none` says a new record can be created and asks for nothing", () => {
    show(checked());
    const markup = html(WizardDuplicatesBlock);
    expect(markup).toContain("No existing Partner found");
    expect(markup).not.toContain("Continue creating new");
    expect(markup).not.toContain("onboarding-acknowledge");
  });

  it("a Vendor uses the Vendor wording", () => {
    const vendor = run(initialWizardState("VENDOR", []), { type: "previewDone", data: previewDto({ counterpartyType: "VENDOR" }) }, { type: "edit", field: "vendorType", value: "AGENCY" });
    show(run(vendor, { type: "duplicatesDone", data: duplicatesDto({ type: "VENDOR", status: "possible", candidates: [candidate({ type: "VENDOR", ref: "vnd_1" })] }), signature: duplicateSignature(vendor.form, "VENDOR") }));
    expect(html(WizardDuplicatesBlock)).toContain("Possible existing Vendor found");
  });
});

describe("create block", () => {
  it("before the decision is complete: disabled create with the plain reason", () => {
    show(previewed());
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("Check for an existing record first.");
  });

  it("someone who can create sees the confirmed values and an enabled `Create Partner and start Agreement`", () => {
    show(checked());
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("onboarding-confirmed-values");
    expect(markup).toContain("Create a new Partner and start the Agreement draft.");
    expect(openTag(markup, "onboarding-create")).not.toBe("");
    expect(isDisabled(markup, "onboarding-create")).toBe(false);
    expect(markup).toContain(">Create Partner and start Agreement</button>");
    expect(markup).not.toContain("onboarding-create-blocked");
    expect(markup).toContain("PAN, Aadhaar, GSTIN and bank details are not collected here.");
  });

  it("someone who can manage Agreements but not create sees a DISABLED final step with the plain reason", () => {
    show(checked(), permissionsDto());
    const markup = html(WizardCreateBlock);
    expect(isDisabled(markup, "onboarding-create")).toBe(true);
    expect(markup).toContain("onboarding-create-blocked");
    expect(markup).toContain("you do not have permission to create a new Partner");
  });

  it("Using an existing record needs no create right and reads `Use existing Partner and start Agreement`", () => {
    const state = run(checked(duplicatesDto({ status: "possible", candidates: [candidate({ ref: "prt_x", displayName: "Asha R. Rao" })] })), { type: "useExisting", ref: "prt_x" });
    show(state, permissionsDto());
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("Use existing Partner and start Agreement");
    expect(markup).toContain("Use the existing Partner: Asha R. Rao. No new Partner is created.");
    expect(isDisabled(markup, "onboarding-create")).toBe(false);
  });

  it("running: step progress with text states, a polite announcement and no double-submit", () => {
    show(run(checked(), { type: "createStart" }), CAN_CREATE, "onboarding-create");
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("Creating the record and starting the Agreement draft…");
    expect(markup).toContain("Validate the details");
    expect(markup).toContain("In progress");
    expect(markup).toContain("Waiting");
    // Step 14B.1 e2e finding: the action stays on screen while the request runs (never vanishes under the person's focus), DISABLED and reading `Creating…`
    // - so it still cannot be pressed twice - and the values being created stay visible too.
    expect(isDisabled(markup, "onboarding-create")).toBe(true);
    expect(markup).toContain("Creating…");
    expect(markup).toContain('data-testid="onboarding-confirmed-values"');
  });

  it("a recoverable failure shows what finished, where it stopped, Retry, and that nothing is created twice", () => {
    const failed = outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"], failedStep: "ACCOUNTS_CREATED", retryable: true, code: "account_create_failed", message: "The Partner Account could not be created right now. Try again to resume.", agreementRef: null, accounts: [] });
    show(run(checked(), { type: "createStart" }, { type: "createOutcome", outcome: failed }));
    const markup = html(WizardCreateBlock);
    expect(markup).toContain('data-outcome="FAILED"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Partner created");
    expect(markup).toContain("Did not finish");
    expect(markup).toContain("Nothing is created twice");
    expect(markup).toContain("Partner created: Asha Rao");
    expect(markup).toMatch(/data-testid="onboarding-retry"[^>]*>Retry</);
    // the record exists, so changing the details is not offered (it would create a second one)
    expect(markup).not.toContain("onboarding-start-again");
    expect(markup).not.toContain("Create Partner and start Agreement");
  });

  it("a non-retryable account collision is named a duplicate signal and only offers a fresh start", () => {
    const collided = outcomeDto({ outcome: "FAILED", completedSteps: ["VALIDATED", "COUNTERPARTY_CREATED"], failedStep: "ACCOUNTS_CREATED", retryable: false, code: "account_identity_collision", message: "This account already belongs to another Partner.", duplicateSignal: true, agreementRef: null, accounts: [] });
    show(run(checked(), { type: "createStart" }, { type: "createOutcome", outcome: collided }));
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("A matching Partner account already exists");
    expect(markup).toContain("This is a strong sign that the Partner already exists.");
    expect(markup).toContain("onboarding-start-again");
    expect(markup).not.toContain("onboarding-retry");
  });

  it("IN_PROGRESS offers `Check again`", () => {
    show(run(checked(), { type: "createStart" }, { type: "createOutcome", outcome: outcomeDto({ outcome: "IN_PROGRESS", completedSteps: ["VALIDATED"], code: "onboarding_in_progress", message: null, agreementRef: null, counterparty: null, accounts: [] }) }));
    expect(html(WizardCreateBlock)).toMatch(/data-testid="onboarding-retry"[^>]*>Check again</);
  });

  it("a refusal before anything was written says nothing was created and keeps the create button", () => {
    show(run(checked(), { type: "createStart" }, { type: "createRefused", message: "You can review this Agreement, but you do not have permission to create a new Partner.", code: "counterparty_create_not_permitted", recheck: false }));
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("Nothing was created.");
    expect(markup).toContain('data-testid="onboarding-refused"');
    expect(markup).toContain('data-testid="onboarding-create"');
  });

  it("a lost answer offers Retry (same request) and a fresh start", () => {
    show(run(checked(), { type: "createStart" }, { type: "createError", message: "We could not confirm whether it was created. Retry sends the same request, and nothing is created twice." }));
    const markup = html(WizardCreateBlock);
    expect(markup).toContain("We could not confirm the result.");
    expect(markup).toContain("onboarding-retry");
    expect(markup).toContain("onboarding-start-again");
    expect(markup).not.toContain('data-testid="onboarding-create"');
  });

  it("COMPLETED shows the success message (the page then opens the draft)", () => {
    show(run(checked(), { type: "createStart" }, { type: "createOutcome", outcome: outcomeDto() }));
    const markup = html(WizardCreateBlock);
    expect(markup).toContain('data-outcome="COMPLETED"');
    expect(markup).toContain("Partner created and Agreement draft started");
    expect(markup).toContain("Agreement draft created");
  });
});

describe("the whole wizard", () => {
  it("frames the four steps under one heading and tells a reviewer who cannot create so up front", () => {
    show(START, permissionsDto());
    const markup = html(OnboardingWizard);
    expect(markup).toContain("New Partner from Agreement");
    for (const number of ["1. Signed Agreement", "2. New Partner details", "3. Check for an existing Partner", "4. Confirm and start the Agreement"]) expect(markup).toContain(number);
    expect(markup).toContain("You can review, but not create.");
    expect(markup).toContain("Nothing is created until the last step.");
  });

  it("does not print the permission note to someone who can create", () => {
    show(START, CAN_CREATE);
    expect(html(OnboardingWizard)).not.toContain("You can review, but not create.");
  });

  it("never uses the Cross-verification vocabulary for a new record", () => {
    show(checked());
    const markup = html(OnboardingWizard);
    for (const banned of ["Missing in CreatorOps", "Cross-verification", "Keep CreatorOps value", "Use Agreement value"]) expect(markup).not.toContain(banned);
  });
});
