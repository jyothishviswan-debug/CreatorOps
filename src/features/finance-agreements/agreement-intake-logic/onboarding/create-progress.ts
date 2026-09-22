import type { OnboardingMode, OnboardingOutcomeDto, OnboardingStepName } from "@/server/finance-agreements/onboarding-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";

// Step 14B.1 onboarding: turning the server's step ledger outcome into what the person sees (pure).
//
//   Validated  ->  Partner / Vendor created  ->  Accounts created  ->  Agreement draft created
//
// The outcome is the SERVER'S truth: `completedSteps` are safe to keep, `failedStep` says where it stopped, `retryable` says whether sending the
// same request again resumes it. Nothing here decides anything the server did not.

const noun = (type: CounterpartyType): string => (type === "PARTNER" ? "Partner" : "Vendor");

export type StepState = "done" | "current" | "pending" | "failed";
export type StepRow = { step: OnboardingStepName; label: string; state: StepState };

export type ProgressContext = { type: CounterpartyType; mode: OnboardingMode; accountCount: number };

// The steps that apply: Partner Accounts only exist for a NEW Partner with at least one account.
export function applicableSteps(context: ProgressContext): OnboardingStepName[] {
  const steps: OnboardingStepName[] = ["VALIDATED", "COUNTERPARTY_CREATED"];
  if (context.type === "PARTNER" && context.mode === "CREATE_NEW" && context.accountCount > 0) steps.push("ACCOUNTS_CREATED");
  steps.push("AGREEMENT_DRAFT_CREATED");
  return steps;
}

export function stepLabel(step: OnboardingStepName, context: ProgressContext, done: boolean): string {
  const name = noun(context.type);
  switch (step) {
    case "VALIDATED":
      return done ? "Details validated" : "Validate the details";
    case "COUNTERPARTY_CREATED":
      if (context.mode === "USE_EXISTING") return done ? `Existing ${name} confirmed` : `Confirm the existing ${name}`;
      return done ? `${name} created` : `Create the ${name}`;
    case "ACCOUNTS_CREATED":
      return done ? "Partner Accounts created" : "Create the Partner Accounts";
    case "AGREEMENT_DRAFT_CREATED":
      return done ? "Agreement draft created" : "Create the Agreement draft";
  }
}

// One row per applicable step. `running` (a request is in flight and nothing has come back yet) shows the first step as current.
export function stepRows(outcome: OnboardingOutcomeDto | null, context: ProgressContext & { running?: boolean }): StepRow[] {
  const steps = applicableSteps(context);
  const completed = new Set<OnboardingStepName>(outcome ? outcome.completedSteps : []);
  // The AGREEMENT step is reported only once the whole run is COMPLETED or the draft exists; an outcome that says COMPLETED marks everything done.
  if (outcome?.outcome === "COMPLETED") for (const step of steps) completed.add(step);
  let currentAssigned = false;
  return steps.map((step) => {
    const done = completed.has(step);
    let state: StepState;
    if (done) state = "done";
    else if (outcome?.outcome === "FAILED" && outcome.failedStep === step) state = "failed";
    else if (!currentAssigned && (context.running === true || outcome?.outcome === "IN_PROGRESS") && !(outcome?.outcome === "FAILED")) {
      state = "current";
      currentAssigned = true;
    } else state = "pending";
    return { step, label: stepLabel(step, context, done), state };
  });
}

// --- What the outcome means ---------------------------------------------------------------------------------------------------------
export type OutcomeAction = "CONTINUE" | "RETRY" | "CHECK_AGAIN" | "START_AGAIN";

export type OutcomeView = {
  tone: "success" | "error" | "info";
  title: string;
  message: string;
  // The primary action the person is offered.
  action: OutcomeAction;
  actionLabel: string;
  // Starting over with different details is possible without leaving a record behind (nothing was created yet), or the failure is not
  // retryable so it is the only way forward.
  canStartAgain: boolean;
  // Records that DO exist and stay (named, so nothing is created twice by accident).
  keptRecords: string[];
  // A collision with another Partner's Account: a strong duplicate signal (the copy says so).
  duplicateSignal: boolean;
};

export function keptRecords(outcome: OnboardingOutcomeDto): string[] {
  const kept: string[] = [];
  if (outcome.counterparty) kept.push(outcome.counterparty.created ? `${noun(outcome.counterparty.type)} created: ${outcome.counterparty.displayName}` : `Existing ${noun(outcome.counterparty.type)}: ${outcome.counterparty.displayName}`);
  if (outcome.accounts.length > 0) kept.push(`${outcome.accounts.length} Partner ${outcome.accounts.length === 1 ? "Account" : "Accounts"} created`);
  if (outcome.agreementRef) kept.push("Agreement draft created");
  return kept;
}

export function describeOutcome(outcome: OnboardingOutcomeDto): OutcomeView {
  const name = noun(outcome.counterpartyType);
  const kept = keptRecords(outcome);
  if (outcome.outcome === "COMPLETED") {
    return {
      tone: "success",
      title: outcome.mode === "USE_EXISTING" ? "Agreement draft started" : `${name} created and Agreement draft started`,
      message: outcome.replayed ? "This onboarding had already finished. Nothing new was created." : "Everything was created once. Opening the Agreement draft…",
      action: "CONTINUE",
      actionLabel: "Continue to the Agreement",
      canStartAgain: false,
      keptRecords: kept,
      duplicateSignal: false,
    };
  }
  if (outcome.outcome === "IN_PROGRESS") {
    return {
      tone: "info",
      title: "Still working",
      message: outcome.message ?? "This onboarding is still running, or it was interrupted. Check again to resume it. Nothing is created twice.",
      action: "CHECK_AGAIN",
      actionLabel: "Check again",
      canStartAgain: false,
      keptRecords: kept,
      duplicateSignal: false,
    };
  }
  const message = outcome.message ?? "Something went wrong.";
  if (outcome.retryable) {
    return {
      tone: "error",
      title: `${failureStepLabel(outcome.failedStep, outcome.counterpartyType)} did not finish`,
      message: `${message} Retry resumes from where it stopped. Nothing is created twice.`,
      action: "RETRY",
      actionLabel: "Retry",
      // Changing the details is only clean while no record exists yet.
      canStartAgain: !outcome.completedSteps.includes("COUNTERPARTY_CREATED"),
      keptRecords: kept,
      duplicateSignal: false,
    };
  }
  return {
    tone: "error",
    title: outcome.duplicateSignal ? `A matching ${name} account already exists` : `${failureStepLabel(outcome.failedStep, outcome.counterpartyType)} cannot be completed`,
    message,
    action: "START_AGAIN",
    actionLabel: "Change the details and start again",
    canStartAgain: true,
    keptRecords: kept,
    duplicateSignal: outcome.duplicateSignal,
  };
}

function failureStepLabel(step: OnboardingStepName | null, type: CounterpartyType): string {
  switch (step) {
    case "COUNTERPARTY_CREATED":
      return `Creating the ${noun(type)}`;
    case "ACCOUNTS_CREATED":
      return "Creating the Partner Accounts";
    case "AGREEMENT_DRAFT_CREATED":
      return "Starting the Agreement draft";
    case "VALIDATED":
      return "Validating the details";
    default:
      return "The onboarding";
  }
}

// The polite live-region text for each stage of the create step.
export function outcomeAnnouncement(outcome: OnboardingOutcomeDto | null, running: boolean): { tone: "info" | "success" | "error"; text: string } | null {
  if (running) return { tone: "info", text: "Creating the record and starting the Agreement draft…" };
  if (!outcome) return null;
  const view = describeOutcome(outcome);
  return { tone: view.tone, text: `${view.title}. ${view.message}` };
}

// After a COMPLETED outcome the wizard leaves for the normal intake; this is the sentence the new form announces.
export function completionAnnouncement(outcome: OnboardingOutcomeDto, options: { fileHeld: boolean }): string {
  const name = noun(outcome.counterpartyType);
  const source = outcome.mode === "USE_EXISTING" ? `Agreement draft started for the existing ${name}.` : `${name} created from Finance Agreement onboarding, and the Agreement draft started.`;
  return options.fileHeld ? `${source} Adding the signed Agreement to the draft…` : `${source} Choose the signed Agreement file again in Contract source to continue.`;
}
