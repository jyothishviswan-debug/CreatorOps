"use client";

// Step 14B.1 onboarding: the CONTROLLER of the new-counterparty wizard - the React glue between the pure state machine (wizard-state.ts) and the
// Finance API. It is called ONCE, by IntakeProvider, and the result is exposed as `useIntake().onboarding`; no component talks to the API itself.
//
// Guarantees (each backed by a pure module with its own tests):
//   - one write at a time: preview / duplicate check / create all run through the intake's exclusive lock (`runExclusive`), so a double click,
//     Enter-repeat or two sections firing together can never submit twice;
//   - ONE clientRequestId per body: minted on the first send, reused by every retry, replaced only by a deliberate `startAgain`;
//   - the exact body last sent is kept (`sentRequestRef`) and re-sent on Retry, so a retry can never differ from what the server's ledger holds;
//   - the request is remembered in sessionStorage BEFORE it is sent, so a reload can ask the server for the ledger and resume;
//   - the File the person selected stays in memory only (never stored) and is handed to the new draft's form when the onboarding completes.
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { OnboardingOutcomeDto } from "@/server/finance-agreements/onboarding-dto";
import type { CounterpartyType } from "@/server/finance-agreements/types";
import type { FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import * as api from "../../api-client";
import type { AgreementForChoice } from "../../agreement-for";
import { pickContractFile } from "../contract-source-logic";
import { intakeHref } from "../intake-logic";
import { classifyCreateFailure } from "./create-failure";
import { completionAnnouncement, describeOutcome, stepRows, type OutcomeView, type StepRow } from "./create-progress";
import { buildOnboardingRequest, idForRequest, requestSignature, type RequestIdHolder } from "./create-request";
import { holdOnboardingHandoff } from "./handoff";
import { accountPlatformsFor, counterpartyTypeOfChoice, isWizardActive, type OnboardingSelection } from "./onboarding-mode";
import { onboardingProgress, type OnboardingProgressItem } from "./onboarding-progress";
import { browserSessionStorage, clearPersisted, decideResume, readPersisted, writePersisted } from "./resume";
import { buildDuplicatesRequest, duplicateSignature, type FormFieldKey } from "./wizard-form";
import { initialWizardState, isLocked, syncToChoice, wizardGates, wizardReducer, type WizardGates, type WizardState } from "./wizard-state";

export const ONBOARDING_BUSY = { preview: "onboarding-preview", duplicates: "onboarding-duplicates", create: "onboarding-create" } as const;

type Tone = "info" | "success" | "warning" | "error";
type RunExclusive = <T>(key: string, fn: (setKey: (next: string) => void) => Promise<T>, refused: T) => Promise<T>;

export type UseOnboardingDeps = {
  permissions: FinanceAgreementPermissionsDto;
  hasDraft: boolean;
  initialSelection: OnboardingSelection;
  runExclusive: RunExclusive;
  notify: (tone: Tone, message: string, id?: string) => void;
  // Client-side navigation to another intake URL (router.replace).
  navigate: (href: string) => void;
};

export type IntakeOnboarding = {
  // Section 1's choice: how the counterparty is identified, and which card (Partner platform context / Vendor).
  selection: OnboardingSelection;
  setSelection: (patch: Partial<OnboardingSelection>) => void;
  // The wizard is showing (no draft yet, the person chose to create, and chose which kind).
  active: boolean;
  // The wizard's inputs are read-only (a create request was sent): section 1's cards lock too.
  locked: boolean;
  type: CounterpartyType;
  state: WizardState;
  gates: WizardGates;
  // The right-hand checklist while a new counterparty is being set up.
  progress: OnboardingProgressItem[];
  steps: StepRow[];
  // The current outcome, worded (null until the server answered).
  outcomeView: OutcomeView | null;

  pickFile: (file: File | null | undefined) => void;
  extractPreview: () => Promise<void>;
  edit: (field: FormFieldKey, value: string) => void;
  revealIssues: () => void;
  checkDuplicates: () => Promise<void>;
  chooseExisting: (ref: string) => void;
  continueNew: () => void;
  setAcknowledged: (value: boolean) => void;
  setReason: (value: string) => void;
  clearDecision: () => void;
  // Sends the create request - or, after a failure / interruption, sends the SAME request again (Retry / Check again).
  create: () => Promise<void>;
  // A deliberate restart with different details (new clientRequestId).
  startAgain: () => void;
};

const defaultChoice = (type: CounterpartyType): AgreementForChoice => (type === "VENDOR" ? "VENDOR" : "INSTAGRAM_PARTNER");

export function useOnboarding(deps: UseOnboardingDeps): IntakeOnboarding {
  const { permissions, hasDraft, runExclusive, notify, navigate } = deps;
  const [selection, setSelectionState] = useState<OnboardingSelection>(deps.initialSelection);
  const [wizard, dispatch] = useReducer(wizardReducer, deps.initialSelection.choice, (choice) => initialWizardState(counterpartyTypeOfChoice(choice) ?? "PARTNER", accountPlatformsFor(choice)));

  // Synchronous mirrors: handlers run from events, after the render that produced them, but a chain of dispatches inside one handler must
  // see the newest values.
  const wizardRef = useRef(wizard);
  const selectionRef = useRef(selection);
  useEffect(() => {
    wizardRef.current = wizard;
  });
  const fileRef = useRef<File | null>(null);
  const idRef = useRef<RequestIdHolder>(null);
  const sentRequestRef = useRef<ReturnType<typeof buildOnboardingRequest>>(null);
  const resumeStartedRef = useRef(false);

  const forget = useCallback(() => {
    idRef.current = null;
    sentRequestRef.current = null;
    clearPersisted(browserSessionStorage());
  }, []);

  // ---- selection (section 1) ----
  const setSelection = useCallback(
    (patch: Partial<OnboardingSelection>) => {
      if (isLocked(wizardRef.current)) return;
      const next = { ...selectionRef.current, ...patch };
      selectionRef.current = next;
      setSelectionState(next);
      const type = counterpartyTypeOfChoice(next.choice);
      if (!type) return;
      const action = syncToChoice(wizardRef.current, { type, platforms: accountPlatformsFor(next.choice) });
      if (!action) return;
      if (action.type === "reset") {
        fileRef.current = null;
        forget();
      }
      dispatch(action);
    },
    [forget],
  );

  // ---- reads ----
  const pickFile = useCallback((file: File | null | undefined) => {
    if (isLocked(wizardRef.current)) return;
    const pick = pickContractFile(file);
    fileRef.current = pick.file;
    dispatch({ type: "pickFile", file: pick.file ? { name: pick.file.name, size: pick.file.size } : null, error: pick.error });
  }, []);

  const extractPreview = useCallback(
    () =>
      runExclusive<void>(
        ONBOARDING_BUSY.preview,
        async () => {
          const state = wizardRef.current;
          const file = fileRef.current;
          if (!file || !wizardGates(state, permissions).canPreview) return;
          dispatch({ type: "previewStart" });
          const result = await api.previewOnboardingFromContract({ file, counterpartyType: state.type });
          if (result.ok === false && result.aborted) return;
          if (fileRef.current !== file) return; // another file was picked meanwhile: this answer is for a file that is gone
          if (result.ok) dispatch({ type: "previewDone", data: result.data });
          else dispatch({ type: "previewFailed", message: result.message });
        },
        undefined,
      ),
    [permissions, runExclusive],
  );

  const checkDuplicates = useCallback(
    () =>
      runExclusive<void>(
        ONBOARDING_BUSY.duplicates,
        async () => {
          const state = wizardRef.current;
          if (!wizardGates(state, permissions).canCheck) {
            dispatch({ type: "showIssues" });
            return;
          }
          // The signature is taken NOW: the form may change while the check is in flight, and the answer is only good for these values.
          const signature = duplicateSignature(state.form, state.type);
          dispatch({ type: "duplicatesStart" });
          const result = await api.checkOnboardingDuplicates(buildDuplicatesRequest(state.form, state.type));
          if (result.ok === false && result.aborted) return;
          if (result.ok) dispatch({ type: "duplicatesDone", data: result.data, signature });
          else dispatch({ type: "duplicatesFailed", message: result.message });
        },
        undefined,
      ),
    [permissions, runExclusive],
  );

  // ---- the create step ----
  const finish = useCallback(
    (outcome: OnboardingOutcomeDto) => {
      const agreementRef = outcome.agreementRef;
      if (!agreementRef) return;
      const file = fileRef.current;
      // A Partner started from an EXISTING record has no Account named: the platform choice must not be lost, so it travels to the new form to be recorded.
      const recordPlatforms = outcome.mode === "USE_EXISTING" && outcome.counterpartyType === "PARTNER" ? accountPlatformsFor(selectionRef.current.choice) : [];
      holdOnboardingHandoff({ agreementRef, file, announcement: completionAnnouncement(outcome, { fileHeld: file !== null }), ...(recordPlatforms.length > 0 ? { recordPlatforms } : {}) });
      forget();
      // The whole form remounts on the new draft (its route key changes); the File travels in memory only.
      navigate(intakeHref({ agreementRef }));
    },
    [forget, navigate],
  );

  const create = useCallback(
    () =>
      runExclusive<void>(
        ONBOARDING_BUSY.create,
        async () => {
          const state = wizardRef.current;
          // After a send the exact body last sent is sent again - never a rebuilt one.
          let request = state.requestSent ? sentRequestRef.current : null;
          if (!request) {
            const gates = wizardGates(state, permissions);
            if (!gates.canCreate) {
              dispatch({ type: "showIssues" });
              return;
            }
            const draft = buildOnboardingRequest({ clientRequestId: "onboard-placeholder", type: state.type, form: state.form, decision: gates.decision });
            if (!draft) return;
            const holder = idForRequest(idRef.current, requestSignature(draft));
            idRef.current = holder;
            request = { ...draft, clientRequestId: holder.id };
          }
          sentRequestRef.current = request;
          writePersisted(browserSessionStorage(), {
            v: 1,
            clientRequestId: request.clientRequestId,
            type: request.type,
            choice: selectionRef.current.choice ?? defaultChoice(request.type),
            request,
            savedAt: new Date().toISOString(),
          });

          dispatch({ type: "createStart" });
          const result = await api.createCounterpartyFromOnboarding(request);
          if (result.ok) {
            dispatch({ type: "createOutcome", outcome: result.data });
            if (result.data.outcome === "COMPLETED") finish(result.data);
            return;
          }
          const view = classifyCreateFailure(result);
          if (view.kind === "refused") dispatch({ type: "createRefused", message: view.message, code: view.code, recheck: view.recheck });
          else dispatch({ type: "createError", message: view.message });
        },
        undefined,
      ),
    [finish, permissions, runExclusive],
  );

  const startAgain = useCallback(() => {
    const state = wizardRef.current;
    const outcome = state.create.status === "outcome" ? state.create.outcome : null;
    // Unless the server said no record exists yet, the record may exist: the next duplicate check must run again (and will find it).
    const recheck = !(outcome && !outcome.completedSteps.includes("COUNTERPARTY_CREATED"));
    forget();
    dispatch({ type: "startAgain", recheck });
  }, [forget]);

  // ---- resume after a reload ----
  // Runs once after mount, from a timer (never from the effect body: it sets state, and a strict-mode re-run must not start it twice - the guard
  // ref makes the second run a no-op, so the timer is deliberately not cancelled).
  const permissionsCanManage = permissions.canManage;
  useEffect(() => {
    if (resumeStartedRef.current) return;
    resumeStartedRef.current = true;
    if (hasDraft || !permissionsCanManage) return;
    const record = readPersisted(browserSessionStorage());
    if (!record) return;
    setTimeout(() => {
      const before = selectionRef.current;
      const next: OnboardingSelection = { mode: "new", choice: record.choice };
      selectionRef.current = next;
      setSelectionState(next);
      dispatch({ type: "reset", counterpartyType: record.type, platforms: accountPlatformsFor(record.choice) });
      dispatch({ type: "resumeStart" });
      void api.getOnboardingStatus({ clientRequestId: record.clientRequestId }).then((status) => {
        const decision = decideResume(status);
        if (decision.kind === "discard") {
          // Nothing reached the server: forget it and leave the form as the person found it.
          forget();
          selectionRef.current = before;
          setSelectionState(before);
          dispatch({ type: "reset", counterpartyType: counterpartyTypeOfChoice(before.choice) ?? "PARTNER", platforms: accountPlatformsFor(before.choice) });
          return;
        }
        idRef.current = { id: record.clientRequestId, signature: requestSignature(record.request) };
        sentRequestRef.current = record.request;
        if (decision.kind === "redirect") {
          holdOnboardingHandoff({ agreementRef: decision.agreementRef, file: null, announcement: completionAnnouncement(decision.outcome, { fileHeld: false }) });
          forget();
          navigate(intakeHref({ agreementRef: decision.agreementRef }));
          return;
        }
        if (decision.kind === "restore") {
          dispatch({ type: "restore", request: record.request, outcome: decision.outcome });
          notify("info", "Resuming your earlier attempt. Retry continues from where it stopped; nothing is created twice.", "onboarding-resume");
          return;
        }
        dispatch({ type: "restore", request: record.request, outcome: null });
        notify("warning", `We could not check the status of your earlier attempt. ${decision.message} Retry sends the same request; nothing is created twice.`, "onboarding-resume");
      });
    }, 0);
  }, [forget, hasDraft, navigate, notify, permissionsCanManage]);

  const edit = useCallback((field: FormFieldKey, value: string) => dispatch({ type: "edit", field, value }), []);
  const revealIssues = useCallback(() => dispatch({ type: "showIssues" }), []);
  const chooseExisting = useCallback((ref: string) => dispatch({ type: "useExisting", ref }), []);
  const continueNew = useCallback(() => dispatch({ type: "continueNew" }), []);
  const setAcknowledged = useCallback((value: boolean) => dispatch({ type: "setAcknowledged", value }), []);
  const setReason = useCallback((value: string) => dispatch({ type: "setReason", value }), []);
  const clearDecision = useCallback(() => dispatch({ type: "clearDecision" }), []);

  // ---- derived ----
  const gates = wizardGates(wizard, permissions);
  const type = wizard.type;
  const outcome = wizard.create.status === "outcome" ? wizard.create.outcome : null;
  const accountCount = wizard.form.accounts.length;
  const mode = outcome?.mode ?? (gates.decision.kind === "USE_EXISTING" ? "USE_EXISTING" : "CREATE_NEW");
  const steps = stepRows(outcome, { type, mode, accountCount, running: wizard.create.status === "running" });

  return {
    selection,
    setSelection,
    active: !hasDraft && isWizardActive(selection),
    locked: isLocked(wizard),
    type,
    state: wizard,
    gates,
    progress: onboardingProgress(wizard, gates),
    steps,
    outcomeView: outcome ? describeOutcome(outcome) : null,
    pickFile,
    extractPreview,
    edit,
    revealIssues,
    checkDuplicates,
    chooseExisting,
    continueNew,
    setAcknowledged,
    setReason,
    clearDecision,
    create,
    startAgain,
  };
}
