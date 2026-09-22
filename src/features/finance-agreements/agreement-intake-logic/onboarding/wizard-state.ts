import type { OnboardingDuplicatesDto, OnboardingOutcomeDto, OnboardingPreviewDto } from "@/server/finance-agreements/onboarding-dto";
import type { OnboardingRequest } from "@/server/finance-agreements/onboarding-input";
import type { CounterpartyType } from "@/server/finance-agreements/types";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import { decisionFromRequest, formFromRequest } from "./create-request";
import { decisionReadiness, effectiveDecision, NO_DECISION, summarizeDuplicates, type WizardDecision } from "./duplicate-rules";
import { createRight, canUseExisting, type CreateRight } from "./onboarding-mode";
import { accountFieldKey, duplicateSignature, emptyForm, locatorRowIndex, prefillFromPreview, reshapeAccounts, setFormField, suggestPageNameFromLink, validateForm, type FormFieldKey, type FormIssue, type OnboardingForm } from "./wizard-form";

// Step 14B.1 onboarding: the STATE MACHINE of the new-counterparty wizard (pure reducer + derived facts).
//
//   upload -> review -> decide -> confirm -> creating -> ( outcome: COMPLETED | FAILED | IN_PROGRESS | stopped )
//
//   upload    no extraction preview yet (pick the signed Agreement PDF, `Extract from Agreement`)
//   review    the preview is in: the proposed new record is edited and validated; `Check for existing` when it is valid
//   decide    the duplicate check result is in (for THESE name / contact / account values): `Use existing` or `Continue creating new`
//   confirm   the decision is complete: confirmed onboarding values, and the final `Create ... and start Agreement`
//   creating  the create request is in flight
//   outcome   the server's step ledger answered: COMPLETED (the wizard leaves), FAILED (Retry), IN_PROGRESS (Check again)
//   stopped   a refusal before anything was written, or a lost answer: the same request can be sent again
//
// Rules the reducer enforces (so no component has to):
//   - once a create request has been SENT the inputs are read-only: the body cannot drift under a live clientRequestId;
//   - a duplicate result is good only for the name / contact / account values it was checked for (derived, never trusted);
//   - picking a different file drops the preview and everything downstream (the file that is previewed is the file that is handed on);
//   - a preview never overwrites a field the reviewer typed.

export type LoadState<T> = { status: "idle" } | { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };
export type FileInfo = { name: string; size: number };

export type CreateState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "outcome"; outcome: OnboardingOutcomeDto }
  // Refused BEFORE anything was written (a typed blocker, a field problem, a denial). `code` is the blocker code when there is one.
  | { status: "refused"; message: string; code: string | null }
  // The answer was lost (network / server error): the request MAY have reached the server. The same request can be sent again safely.
  | { status: "error"; message: string };

export type ResumeState = { status: "idle" } | { status: "checking" } | { status: "unavailable"; message: string };

export type WizardState = {
  type: CounterpartyType;
  // Normalized platform ids of the Partner Account rows (fixed by the platform choice; empty for a Vendor).
  platforms: string[];
  file: FileInfo | null;
  fileError: string | null;
  preview: LoadState<OnboardingPreviewDto>;
  form: OnboardingForm;
  // Form fields the reviewer edited (a preview never overwrites them).
  touched: string[];
  showIssues: boolean;
  duplicates: { load: LoadState<OnboardingDuplicatesDto>; signature: string | null };
  decision: WizardDecision;
  create: CreateState;
  // A create request has been sent (it may have reached the server): the inputs are locked.
  requestSent: boolean;
  // The create step was restored from this tab's remembered request after a reload.
  restored: boolean;
  resume: ResumeState;
};

export function initialWizardState(type: CounterpartyType, platforms: readonly string[]): WizardState {
  return {
    type,
    platforms: [...platforms],
    file: null,
    fileError: null,
    preview: { status: "idle" },
    form: emptyForm(type, platforms),
    touched: [],
    showIssues: false,
    duplicates: { load: { status: "idle" }, signature: null },
    decision: NO_DECISION,
    create: { status: "idle" },
    requestSent: false,
    restored: false,
    resume: { status: "idle" },
  };
}

export type WizardAction =
  | { type: "pickFile"; file: FileInfo | null; error: string | null }
  | { type: "previewStart" }
  | { type: "previewDone"; data: OnboardingPreviewDto }
  | { type: "previewFailed"; message: string }
  | { type: "edit"; field: FormFieldKey; value: string }
  | { type: "showIssues" }
  | { type: "duplicatesStart" }
  // `signature` is the duplicateSignature of the values the check was RUN for (taken when it was sent): the form may have been edited while it
  // was in flight, and the result must then not count as fresh for the new values.
  | { type: "duplicatesDone"; data: OnboardingDuplicatesDto; signature: string }
  | { type: "setPlatforms"; platforms: readonly string[] }
  | { type: "duplicatesFailed"; message: string }
  | { type: "useExisting"; ref: string }
  | { type: "continueNew" }
  | { type: "setAcknowledged"; value: boolean }
  | { type: "setReason"; value: string }
  | { type: "clearDecision" }
  | { type: "createStart" }
  | { type: "createOutcome"; outcome: OnboardingOutcomeDto }
  | { type: "createRefused"; message: string; code: string | null; recheck: boolean }
  | { type: "createError"; message: string }
  | { type: "resumeStart" }
  | { type: "resumeUnavailable"; message: string }
  | { type: "restore"; request: OnboardingRequest; outcome: OnboardingOutcomeDto | null }
  | { type: "startAgain"; recheck: boolean }
  | { type: "reset"; counterpartyType: CounterpartyType; platforms: readonly string[] };

// The action that brings a wizard in line with the card chosen in section 1 (null = already in line). A different KIND of counterparty
// changes the whole form and starts over; the same Partner on other platforms only re-shapes the account rows.
export function syncToChoice(state: WizardState, target: { type: CounterpartyType; platforms: readonly string[] }): WizardAction | null {
  if (state.type !== target.type) return { type: "reset", counterpartyType: target.type, platforms: target.platforms };
  if (state.platforms.join() !== target.platforms.join()) return { type: "setPlatforms", platforms: target.platforms };
  return null;
}

export const isLocked = (state: WizardState): boolean => state.requestSent || state.create.status === "running";

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "pickFile": {
      if (isLocked(state)) return state;
      // A different file (or none) invalidates everything read from the previous one.
      return { ...state, file: action.file, fileError: action.error, preview: { status: "idle" }, duplicates: { load: { status: "idle" }, signature: null }, decision: NO_DECISION, create: { status: "idle" } };
    }
    case "previewStart":
      return isLocked(state) ? state : { ...state, preview: { status: "loading" } };
    case "previewDone": {
      if (isLocked(state)) return state;
      return { ...state, preview: { status: "ready", data: action.data }, form: prefillFromPreview(state.form, action.data, state.touched), duplicates: { load: { status: "idle" }, signature: null }, decision: NO_DECISION };
    }
    case "previewFailed":
      return isLocked(state) ? state : { ...state, preview: { status: "error", message: action.message } };
    case "edit": {
      if (isLocked(state)) return state;
      let form = setFormField(state.form, action.field, action.value);
      if (form === state.form) return state;
      const touched = state.touched.includes(action.field) ? state.touched : [...state.touched, action.field];
      // Typing a page LINK suggests the "Page or account name" from the link's own path - but only while the reviewer
      // has not typed into that field themselves (it is a suggestion, never an override of their own entry), and only
      // while the row is identified BY that link (switching to "Handle" leaves whatever name is already there alone).
      const rowIndex = locatorRowIndex(action.field);
      if (rowIndex !== null) {
        const row = form.accounts[rowIndex];
        const nameField = accountFieldKey(rowIndex, "pageName");
        if (row && row.locatorKind === "LINK" && !touched.includes(nameField)) {
          form = setFormField(form, nameField, suggestPageNameFromLink(row.locator) ?? "");
        }
      }
      const create = state.create.status === "refused" || state.create.status === "error" ? ({ status: "idle" } as const) : state.create;
      return { ...state, form, touched, create };
    }
    case "showIssues":
      return { ...state, showIssues: true };
    case "duplicatesStart":
      return isLocked(state) ? state : { ...state, duplicates: { load: { status: "loading" }, signature: null }, decision: NO_DECISION };
    case "duplicatesDone":
      return isLocked(state) ? state : { ...state, duplicates: { load: { status: "ready", data: action.data }, signature: action.signature }, decision: NO_DECISION, create: { status: "idle" } };
    case "setPlatforms": {
      if (isLocked(state) || state.platforms.join() === action.platforms.join()) return state;
      // The same Partner on another platform choice: keep everything typed, re-shape the account rows, and place the extracted page again
      // for the fields nobody has touched.
      const reshaped = reshapeAccounts(state.form, state.type, action.platforms);
      const form = state.preview.status === "ready" ? prefillFromPreview(reshaped, state.preview.data, state.touched) : reshaped;
      return { ...state, platforms: [...action.platforms], form };
    }
    case "duplicatesFailed":
      return isLocked(state) ? state : { ...state, duplicates: { load: { status: "error", message: action.message }, signature: null }, decision: NO_DECISION };
    case "useExisting":
      return isLocked(state) ? state : { ...state, decision: { kind: "USE_EXISTING", ref: action.ref }, create: { status: "idle" } };
    case "continueNew":
      return isLocked(state) ? state : { ...state, decision: { kind: "CREATE_NEW", acknowledged: false, reason: "" }, create: { status: "idle" } };
    case "setAcknowledged": {
      if (isLocked(state) || state.decision.kind !== "CREATE_NEW") return state;
      return { ...state, decision: { ...state.decision, acknowledged: action.value } };
    }
    case "setReason": {
      if (isLocked(state) || state.decision.kind !== "CREATE_NEW") return state;
      return { ...state, decision: { ...state.decision, reason: action.value } };
    }
    case "clearDecision":
      return isLocked(state) ? state : { ...state, decision: NO_DECISION };
    case "createStart":
      return { ...state, create: { status: "running" }, requestSent: true, showIssues: true };
    case "createOutcome":
      return { ...state, create: { status: "outcome", outcome: action.outcome }, requestSent: true };
    case "createRefused": {
      // Nothing was written: the inputs are editable again. A refusal about the duplicate rules makes the earlier check void.
      const duplicates = action.recheck ? { load: { status: "idle" } as const, signature: null } : state.duplicates;
      return { ...state, create: { status: "refused", message: action.message, code: action.code }, requestSent: false, duplicates, decision: action.recheck ? NO_DECISION : state.decision };
    }
    case "createError":
      return { ...state, create: { status: "error", message: action.message }, requestSent: true };
    case "resumeStart":
      return { ...state, resume: { status: "checking" } };
    case "resumeUnavailable":
      return { ...state, resume: { status: "unavailable", message: action.message } };
    case "restore":
      return {
        ...state,
        form: formFromRequest(action.request, state.platforms),
        decision: decisionFromRequest(action.request),
        touched: [],
        create: action.outcome ? { status: "outcome", outcome: action.outcome } : { status: "error", message: "The last attempt may not have finished." },
        requestSent: true,
        restored: true,
        resume: { status: "idle" },
      };
    case "startAgain":
      // A deliberate restart (the caller mints a new clientRequestId): the inputs unlock. If the earlier attempt created the record, the
      // duplicate check must run again (it will find that record).
      return {
        ...state,
        create: { status: "idle" },
        requestSent: false,
        restored: false,
        duplicates: action.recheck ? { load: { status: "idle" }, signature: null } : state.duplicates,
        decision: action.recheck ? NO_DECISION : state.decision,
      };
    case "reset":
      return initialWizardState(action.counterpartyType, action.platforms);
  }
}

// --- Derived facts -----------------------------------------------------------------------------------------------------------------
export function formIssues(state: WizardState): FormIssue[] {
  return validateForm(state.form, state.type);
}

// The duplicate result, only while it still describes the values in the form.
export function freshDuplicates(state: WizardState): OnboardingDuplicatesDto | null {
  const { load, signature } = state.duplicates;
  return load.status === "ready" && signature !== null && signature === duplicateSignature(state.form, state.type) ? load.data : null;
}

// The decision as it stands: void while there is no fresh result (except in a locked request, where it is the request's own decision).
export function currentDecision(state: WizardState): WizardDecision {
  const duplicates = freshDuplicates(state);
  // A `none` result needs no click: its decision is the implied CREATE_NEW. That must hold while a request is in flight and after it stopped too
  // (the inputs, so the result, cannot change once locked) - otherwise the confirmed values and the decision vanish the moment Create is pressed.
  if (isLocked(state)) return duplicates ? effectiveDecision(summarizeDuplicates(duplicates), state.decision) : state.decision;
  return duplicates ? effectiveDecision(summarizeDuplicates(duplicates), state.decision) : NO_DECISION;
}

export type WizardPhase = "upload" | "review" | "decide" | "confirm" | "creating" | "outcome" | "stopped";

export type WizardGates = {
  locked: boolean;
  issues: FormIssue[];
  canPreview: boolean;
  canCheck: boolean;
  duplicates: OnboardingDuplicatesDto | null;
  decision: WizardDecision;
  // Whether the decision is complete (and the message when it is not).
  decisionReady: boolean;
  decisionMessage: string | null;
  // The right that applies to the DECISION: creating a new record needs the owning create right; using an existing one does not.
  right: CreateRight | null;
  canCreate: boolean;
  // The plain reason the final step is disabled (null when it is enabled).
  createBlockedReason: string | null;
  phase: WizardPhase;
};

export function wizardGates(state: WizardState, permissions: FinanceAgreementPermissionsDto): WizardGates {
  const locked = isLocked(state);
  const issues = formIssues(state);
  const previewReady = state.preview.status === "ready";
  const duplicates = freshDuplicates(state);
  const decision = currentDecision(state);
  const readiness = duplicates ? decisionReadiness(duplicates, decision) : null;
  const decisionReady = readiness?.ok === true;
  const decisionMessage = readiness && !readiness.ok && readiness.message ? readiness.message : null;

  const creatingNew = decision.kind === "CREATE_NEW";
  const right = decision.kind === "NONE" ? null : creatingNew ? createRight(permissions, state.type, state.form.accounts.length > 0) : { canCreate: canUseExisting(permissions), reason: canUseExisting(permissions) ? null : "You need the Manage Agreements permission to start an Agreement.", missing: canUseExisting(permissions) ? null : ("MANAGE" as const) };

  const canPreview = permissions.canManage && !locked && state.file !== null && state.fileError === null && state.preview.status !== "loading";
  const canCheck = permissions.canManage && !locked && previewReady && issues.length === 0 && state.duplicates.load.status !== "loading";
  const canCreate = !locked && duplicates !== null && decisionReady && right !== null && right.canCreate;
  let createBlockedReason: string | null = null;
  if (!canCreate && !locked) {
    if (!permissions.canManage) createBlockedReason = "You need the Manage Agreements permission to start an Agreement.";
    else if (right && !right.canCreate) createBlockedReason = right.reason;
    else if (duplicates === null) createBlockedReason = previewReady ? (issues.length > 0 ? "Complete the details above, then check for an existing record." : "Check for an existing record first.") : "Read the signed Agreement first.";
    else createBlockedReason = decisionMessage;
  }

  let phase: WizardPhase;
  if (state.create.status === "running") phase = "creating";
  else if (state.create.status === "outcome") phase = "outcome";
  else if (state.create.status === "error" || state.create.status === "refused") phase = "stopped";
  else if (!previewReady) phase = "upload";
  else if (duplicates === null) phase = "review";
  else if (!decisionReady) phase = "decide";
  else phase = "confirm";

  return { locked, issues, canPreview, canCheck, duplicates, decision, decisionReady, decisionMessage, right, canCreate, createBlockedReason, phase };
}
