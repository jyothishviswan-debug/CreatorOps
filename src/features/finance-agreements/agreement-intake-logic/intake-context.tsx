"use client";

// Step 14B intake: THE state + actions of the staged Agreement intake form. Every section (1-10) reads from `useIntake()` and takes no props.
//
// Rules the context enforces so no section has to:
//   - server truth: every successful mutation returns the new AgreementDetailDto (or its outcome wrapper) and the context REPLACES its
//     `agreement` with it - the client never patches a stale copy. Each write sends the right optimistic-concurrency counter itself
//     (field decisions / attach / confirm: the VERSION doc's docVersion; activate: the HEAD's; master-data: the counterparty's own version).
//   - one write at a time: every action is guarded by ONE busy key + a synchronous ref, so a double click / Enter-repeat / two sections
//     firing together can never submit twice. A refused call resolves `{ ok: false, aborted: true }` - ignore it.
//   - nothing is ever overwritten silently: a stale / conflict outcome sets `conflict` (a banner with `Reload latest`); local unsaved edits
//     survive a reload and are only written by an explicit `saveDraft()`.
//   - master data is never written by saving an Agreement: only `updateCounterpartyContact` / `applyExtractedKyc` touch it, and only when
//     a section calls them after an explicit, acknowledged confirmation.
//
// Every action returns the api-client result: `{ ok: true, status, data } | { ok: false, status, kind, message, blockers?, aborted? }`.
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import type { AgreementDetailDto, AgreementDraftEntryDto, AgreementVersionDto, ContractArtifactDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { AttachExtractionOutcome } from "@/server/finance-agreements/agreement-service";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { ApplyExtractedKycOutcome, UpdateCounterpartyContactOutcome } from "@/server/finance-agreements/master-data-commands";
import type { AgreementCounterpartyInput, AgreementParty, CounterpartyType } from "@/server/finance-agreements/types";
import type { CounterpartyPreviewDto, FinanceAgreementPermissionsDto } from "@/server/finance-agreements/workspace-dto";

import * as api from "../api-client";
import type { ApplyKycInput, FinanceApiFailure, FinanceApiResult, UpdateMasterDataInput } from "../api-client";
import { describeConfirmBlockers, type ConfirmBlockerView } from "../confirm-blockers";
import { buildFieldViewModels, fieldPlacement, groupFieldViewModels, unresolvedFields, type FieldViewModel, type IntakeSectionId } from "../field-view-model";
import { diffDraftAgainstPrior, type ConfirmedTermSet, type FieldChange } from "../revision-diff";
import { counterpartyInputKey } from "../agreement-for";
import {
  buildLocalEdit,
  clientRequestIdFor,
  counterpartyOfAgreement,
  countLocalEdits,
  deriveIntakeFlags,
  describeFlush,
  flushLocalEdits,
  intakeHref,
  resolveEditDecision,
  withEdit,
  withoutEdit,
  type ClientRequestIdHolder,
  type FieldDecisionKind,
  type IntakeCounterparty,
  type IntakeFlags,
  type LocalEdits,
  type LocalFieldEdit,
} from "./intake-logic";
import { createInitialIntakeData, failureToNotice, intakeReducer, type IntakeInitialData, type IntakeNotice, type IntakeNoticeTone } from "./intake-state";
import { reuploadAgreement, type ReuploadResult } from "./onboarding/handoff";
import { initialOnboardingSelection } from "./onboarding/onboarding-mode";
import { ONBOARDING_BUSY, useOnboarding, type IntakeOnboarding } from "./onboarding/use-onboarding";
import { useOnboardingHandoff, type HandoffStatus } from "./onboarding/use-onboarding-handoff";
import { scrollToAnchor as scrollToAnchorImpl } from "./scroll-to-anchor";

// --- Public types (STABLE - other sections depend on these names) ---------------------------------------------------------------------------------
export type { FieldDecisionKind, IntakeAccountMode, IntakeCounterparty, IntakeFlags, LocalEdits, LocalFieldEdit } from "./intake-logic";
export type { IntakeNotice, IntakeNoticeTone } from "./intake-state";

// "Start draft" replaces the URL, which REMOUNTS the whole form on the server-loaded draft (its key carries the agreement ref). The
// control the person just pressed is gone and keyboard / screen-reader focus would fall to <body>. This flag survives the remount (module
// scope) and is consumed ONCE by the NEWLY mounted form, which announces "Draft created" and moves focus deliberately.
let draftJustStarted = false;
export function consumeDraftJustStarted(): boolean {
  const started = draftJustStarted;
  draftJustStarted = false;
  return started;
}

// The busy keys. `busyKey` is the key of the ONE write in flight (null = idle); `isBusy(key)` tests one, `isBusy()` tests any.
export const INTAKE_BUSY = {
  startDraft: "start-draft",
  save: "save-draft",
  upload: "upload",
  extract: "extract",
  attach: "attach",
  confirm: "confirm",
  activate: "activate",
  master: "master-data",
  applyKyc: "apply-kyc",
  detail: "detail",
  // FINAL_EXECUTION #10: replacing the whole `parties` array.
  parties: "set-parties",
  // Step 14B.1 (agreement-led onboarding of a NEW Partner / Vendor): the wizard's three writes share the same one-at-a-time lock.
  onboardPreview: ONBOARDING_BUSY.preview,
  onboardDuplicates: ONBOARDING_BUSY.duplicates,
  onboardCreate: ONBOARDING_BUSY.create,
  // `field:<fieldKey>` is the key while ONE field decision is written (see fieldBusyKey).
} as const;
export const fieldBusyKey = (fieldKey: AgreementFieldKey): string => `field:${fieldKey}`;

export type ExtractionPhase = "idle" | "uploading" | "extracting";
export type PreviewLoad = { status: "idle" | "loading" | "ready" | "error"; message?: string };

export type DecideFieldAction = { fieldKey: AgreementFieldKey; decision: FieldDecisionKind; value?: unknown; note?: string };

export type SaveDraftOutcome = {
  // Every buffered edit written (true also when there was nothing to save).
  ok: boolean;
  savedCount: number;
  // The first failure (the rest stay buffered); null when ok.
  failure: FinanceApiFailure | null;
  failedFieldKey: AgreementFieldKey | null;
  // The person-facing status sentence (also pushed to `notices`).
  message: string;
};

export type StartDraftInput = {
  // The counterparty (built by buildAgreementFor: Partner + accounts, or Vendor).
  counterparty: AgreementCounterpartyInput;
  // Partner-level only: the intended platforms to RECORD through the `platforms` field decision (null otherwise).
  recordPlatformsField: string[] | null;
  // Optional: the display name to show until the server head is read again.
  displayName?: string | null;
  // FINAL_EXECUTION #10: this brand-new Agreement renews/supersedes an IDENTIFIED prior Agreement.
  priorAgreementRef?: string | null;
};

export type IntakeContextValue = {
  // ---- who may do what (SERVER-computed, passed in - no flash) ----
  permissions: FinanceAgreementPermissionsDto;
  // Permission-derived UI flags for the current counterparty type / version (canEdit, canConfirm, canActivate, canViewIdentity, ...).
  flags: IntakeFlags;

  // ---- the draft ----
  // null until a draft is started.
  agreement: AgreementDetailDto | null;
  hasDraft: boolean;
  agreementRef: string | null;
  // The selected version doc (draft entries, docVersion, source, identityStatus) - shorthand for agreement.selectedVersion.
  version: AgreementVersionDto | null;
  // The version doc's docVersion (the counter field decisions / attach / confirm send).
  docVersion: number | null;
  // The counterparty of the draft (locked after creation); null before a draft exists.
  counterparty: IntakeCounterparty | null;
  // CreatorOps master data for the counterparty (null while not loaded / no access). Before a draft exists it is the PICKED counterparty's.
  preview: CounterpartyPreviewDto | null;
  // Load state of `preview` (section 1 sets it while the picked counterparty loads; after a draft it is "ready" / "idle").
  previewLoad: PreviewLoad;
  // Section 1's hooks: replace the preview / its load state (a draft that exists refreshes through refreshPreview() instead).
  setPreview: (preview: CounterpartyPreviewDto | null) => void;
  setPreviewLoad: (load: PreviewLoad) => void;

  // ---- fields (buildFieldViewModels of the draft, in registry order) ----
  // Every field, and the same grouped by intake section (agreement_for | cross_verification | commercial_terms | performance_targets | kyc | additional_details).
  fieldModels: FieldViewModel[];
  fields: Record<IntakeSectionId, FieldViewModel[]>;
  // One field's view model (undefined when it does not apply to this counterparty type).
  getField: (fieldKey: AgreementFieldKey) => FieldViewModel | undefined;
  // The draft entry of a field, if any (raw DTO).
  getEntry: (fieldKey: AgreementFieldKey) => AgreementDraftEntryDto | undefined;
  unresolvedFields: FieldViewModel[];
  unresolvedCount: number;

  // ---- contract / extraction ----
  extraction: ExtractionResultDto | null;
  artifact: ContractArtifactDto | null;
  // The draft already holds this extraction run's proposals (version.source.extractionRunRef === extraction.run.runRef).
  extractionAttached: boolean;
  // idle | uploading | extracting (derived from busyKey).
  extractionPhase: ExtractionPhase;

  // ---- cross-verification / KYC / revision ----
  reconciliation: AgreementReconciliationDto | null;
  kyc: AgreementKycStatusDto | null;
  // A revision draft's changed fields vs the prior CONFIRMED terms; null when this is not a revision. Recomputed live from the draft.
  revisionDiff: FieldChange[] | null;
  // The prior confirmed version number the diff compares against (null when not a revision).
  revisionBaseVersion: number | null;

  // ---- feedback ----
  // The ONE write in flight (null = idle). Disable controls with isBusy(); use isBusy(key) to show a spinner label on one.
  busyKey: string | null;
  isBusy: (key?: string) => boolean;
  // Status notices (aria-live in the form shell). Newest last, bounded.
  notices: IntakeNotice[];
  notify: (tone: IntakeNoticeTone, message: string, id?: string) => void;
  dismissNotice: (id: string) => void;
  // A stale / conflict outcome ("changed elsewhere"): show a banner with Reload latest; cleared by a successful reload / write.
  conflict: { message: string } | null;
  reloadLatest: () => Promise<FinanceApiResult<AgreementDetailDto>>;
  // The last confirm attempt's `not_ready` blockers, humanized, each with a jump anchor. Cleared by the next successful write.
  confirmBlockers: ConfirmBlockerView[];

  // ---- local edit buffering (unsaved, in memory only) ----
  localEdits: LocalEdits;
  unsavedCount: number;
  hasUnsavedEdits: boolean;
  // Buffers an edit. `decision` omitted = derived (CORRECTED when the value differs from the entry's current one, else ACCEPTED).
  // For UNAVAILABLE / NOT_APPLICABLE the value is ignored. Nothing is sent until saveDraft().
  setLocalEdit: (fieldKey: AgreementFieldKey, value: unknown, decision?: FieldDecisionKind) => void;
  clearLocalEdit: (fieldKey: AgreementFieldKey) => void;
  clearAllLocalEdits: () => void;

  // ---- actions (all double-submit guarded; all return the api-client result) ----
  // Starts the draft (POST agreements) then replaces the URL with ?agreementRef=&version= . One clientRequestId per mount.
  startDraft: (input: StartDraftInput) => Promise<FinanceApiResult<AgreementDetailDto>>;
  // Writes ONE decision immediately (an explicit button: use value / not applicable / unavailable, or a committed editor).
  decideField: (action: DecideFieldAction) => Promise<FinanceApiResult<AgreementDetailDto>>;
  // Writes every buffered edit sequentially (registry order, fresh docVersion each time) and reports the saved state. Never throws.
  saveDraft: () => Promise<SaveDraftOutcome>;
  // Upload the PDF then extract it (state: extractionPhase, artifact, extraction). Needs a draft.
  extractFromFile: (file: File) => Promise<FinanceApiResult<ExtractionResultDto>>;
  // Copies the run's proposals into the draft as PENDING (never accepted).
  attachExtraction: () => Promise<FinanceApiResult<AttachExtractionOutcome>>;
  refreshDetail: () => Promise<FinanceApiResult<AgreementDetailDto>>;
  refreshReconciliation: () => Promise<FinanceApiResult<AgreementReconciliationDto>>;
  refreshKyc: () => Promise<FinanceApiResult<AgreementKycStatusDto>>;
  refreshPreview: () => Promise<FinanceApiResult<CounterpartyPreviewDto>>;
  // Explicit master-data command (ONE email / phone onto the Partner / Vendor through the owning module). Supplies version + docVersion.
  updateCounterpartyContact: (input: Omit<UpdateMasterDataInput, "version" | "expectedDocVersion">) => Promise<FinanceApiResult<UpdateCounterpartyContactOutcome>>;
  // Fills MISSING KYC components on the canonical record from the attached extraction (owning module). Bank is refused server-side.
  applyExtractedKyc: (input: Omit<ApplyKycInput, "version">) => Promise<FinanceApiResult<ApplyExtractedKycOutcome>>;
  // Saves buffered edits first, then confirms. A `not_ready` result sets `confirmBlockers` (kind "not_ready", blockers on the result too).
  confirmAgreement: () => Promise<FinanceApiResult<AgreementDetailDto>>;
  // Activates the confirmed open version (only offered when flags.canActivate). Uses the HEAD's docVersion.
  activateAgreement: () => Promise<FinanceApiResult<AgreementDetailDto>>;
  // FINAL_EXECUTION #10: replaces the OPEN, unconfirmed version's whole `parties` array with the full given list.
  setParties: (parties: AgreementParty[]) => Promise<FinanceApiResult<AgreementDetailDto>>;

  // ---- Step 14B.1: new Partner / Vendor from the Agreement (ADDED; nothing above changed) ----
  // Section 1's mode choice, the wizard's state machine and its actions (see onboarding/use-onboarding.ts). `onboarding.active` = the wizard shows.
  onboarding: IntakeOnboarding;
  // Uploads the given File, extracts it and attaches its proposals to the (just created) draft, in that order (onboarding/handoff.ts). Resolves null when refused.
  extractAndAttachFromFile: (file: File) => Promise<ReuploadResult | null>;
  // The automatic re-upload of the File the person selected in the wizard, after the record was created (idle when the form was not opened by an onboarding).
  onboardingHandoff: HandoffStatus & { canRetry: boolean; retry: () => void };

  // ---- navigation helpers ----
  // Scrolls to and focuses an anchor (`fieldAnchorId(key)` / `sectionAnchorId(section)`, from confirm-blockers via view-models).
  scrollToAnchor: (anchorId: string) => boolean;
  // Jumps to a blocker's target.
  goToBlocker: (blocker: Pick<ConfirmBlockerView, "anchorId">) => void;
};

const IntakeContext = createContext<IntakeContextValue | null>(null);

export function useIntake(): IntakeContextValue {
  const value = useContext(IntakeContext);
  if (!value) throw new Error("useIntake() must be used inside <IntakeProvider>.");
  return value;
}

// Returned for a refused (already busy / not possible) call. `aborted: true` = ignore it (no message to show).
const REFUSED: FinanceApiFailure = { ok: false, status: 0, kind: "error", message: "Another action is still in progress.", aborted: true };
const noDraft = (): FinanceApiFailure => ({ ok: false, status: 0, kind: "error", message: "Start a draft first." });
const notEditable = (): FinanceApiFailure => ({ ok: false, status: 0, kind: "error", message: "This version can no longer be edited." });

// Sections whose fields the reconciliation compares - a decision there changes the "confirmed value" column.
const RECONCILED_SECTIONS: ReadonlySet<IntakeSectionId> = new Set<IntakeSectionId>(["agreement_for", "cross_verification", "kyc"]);

export type IntakeProviderProps = {
  // Computed on the server for the (possibly resumed) counterparty type - nothing about access is decided in the browser.
  permissions: FinanceAgreementPermissionsDto;
  // Server-resolved state of a resumed draft / revision (all optional; absent = a brand-new intake).
  initial?: IntakeInitialData & {
    // The prior CONFIRMED terms a revision is compared against (the page fetches that version) and its number.
    revisionBase?: ConfirmedTermSet | null;
    revisionBaseVersion?: number | null;
    // Deep link ?counterpartyType=&mode=new: open with "Create new ... from Agreement" already chosen.
    onboarding?: { mode: "new"; counterpartyType: CounterpartyType } | null;
  };
  children: ReactNode;
};

export function IntakeProvider({ permissions, initial, children }: IntakeProviderProps) {
  const router = useRouter();
  const [data, dispatch] = useReducer(intakeReducer, initial, (seed) => createInitialIntakeData(seed ?? {}));
  // The busy key is React state (drives re-render); the exclusive lock itself is the synchronous busyRef below.
  const [busyKey, setBusyKeyState] = useState<string | null>(null);
  const [previewLoad, setPreviewLoad] = useState<PreviewLoad>({ status: initial?.preview ? "ready" : "idle" });
  const setPreview = useCallback((preview: CounterpartyPreviewDto | null) => dispatch({ type: "preview", preview }), []);

  // Synchronous mirrors: sequential writes (a flush) must read the docVersion the PREVIOUS response returned before React re-renders.
  const agreementRef = useRef<AgreementDetailDto | null>(data.agreement);
  const editsRef = useRef<LocalEdits>(data.localEdits);
  const dataRef = useRef(data);
  const busyRef = useRef<string | null>(null);
  const requestIdRef = useRef<ClientRequestIdHolder>(null);
  const gates = useRef({ reconciliation: 0, kyc: 0, preview: 0 });
  useEffect(() => {
    dataRef.current = data;
  });

  const setAgreement = useCallback((agreement: AgreementDetailDto, decidedFieldKeys?: readonly AgreementFieldKey[]) => {
    agreementRef.current = agreement;
    dispatch({ type: "agreement", agreement, decidedFieldKeys });
  }, []);

  const notify = useCallback((tone: IntakeNoticeTone, message: string, id?: string) => {
    dispatch({ type: "notice", notice: { id: id ?? `${tone}-${message}`, tone, message } });
  }, []);
  const dismissNotice = useCallback((id: string) => dispatch({ type: "dismissNotice", id }), []);

  // One write at a time. `fn` may switch the visible key mid-flight (upload -> extract).
  const runExclusive = useCallback(
    async <T,>(key: string, fn: (setKey: (next: string) => void) => Promise<T>, refused: T): Promise<T> => {
      if (busyRef.current !== null) return refused;
      busyRef.current = key;
      setBusyKeyState(key);
      try {
        return await fn((next) => {
          busyRef.current = next;
          setBusyKeyState(next);
        });
      } finally {
        busyRef.current = null;
        setBusyKeyState(null);
      }
    },
    [setBusyKeyState],
  );

  const reportFailure = useCallback((id: string, failure: FinanceApiFailure) => {
    if (failure.aborted) return;
    const { notice, conflict } = failureToNotice(id, failure);
    dispatch({ type: "notice", notice });
    if (conflict) dispatch({ type: "conflict", message: `${conflict} Reload the latest version before continuing.` });
  }, []);

  // ---- derived ----
  const agreement = data.agreement;
  const version = agreement?.selectedVersion ?? null;
  const counterparty = useMemo(() => counterpartyOfAgreement(agreement, data.preview?.displayName ?? null), [agreement, data.preview]);
  const counterpartyType: CounterpartyType | null = counterparty?.type ?? null;
  const flags = useMemo(() => deriveIntakeFlags({ permissions, counterpartyType, agreement }), [permissions, counterpartyType, agreement]);

  const fieldModels = useMemo(() => (counterpartyType ? buildFieldViewModels({ draft: version?.draft ?? {}, counterpartyType }) : []), [counterpartyType, version]);
  const fields = useMemo(() => groupFieldViewModels(fieldModels), [fieldModels]);
  const unresolved = useMemo(() => unresolvedFields(fieldModels), [fieldModels]);
  const fieldIndex = useMemo(() => new Map(fieldModels.map((model) => [model.fieldKey, model])), [fieldModels]);
  const getField = useCallback((fieldKey: AgreementFieldKey) => fieldIndex.get(fieldKey), [fieldIndex]);
  const getEntry = useCallback((fieldKey: AgreementFieldKey) => version?.draft[fieldKey], [version]);

  const revisionBase = initial?.revisionBase ?? null;
  const revisionBaseVersion = revisionBase && version && version.version > 1 && version.status === "DRAFT" ? (initial?.revisionBaseVersion ?? null) : null;
  const revisionDiff = useMemo(() => (revisionBase && revisionBaseVersion !== null && version ? diffDraftAgainstPrior(version.draft, revisionBase) : null), [revisionBase, revisionBaseVersion, version]);

  const extractionAttached = !!version && !!data.extraction && version.source.extractionRunRef === data.extraction.run.runRef;
  const extractionPhase: ExtractionPhase = busyKey === INTAKE_BUSY.upload ? "uploading" : busyKey === INTAKE_BUSY.extract ? "extracting" : "idle";

  // ---- local edits ----
  const setLocalEdit = useCallback((fieldKey: AgreementFieldKey, value: unknown, decision?: FieldDecisionKind) => {
    const entry = agreementRef.current?.selectedVersion?.draft[fieldKey];
    const edit: LocalFieldEdit = buildLocalEdit(fieldKey, value, entry, decision);
    editsRef.current = withEdit(editsRef.current, fieldKey, edit);
    dispatch({ type: "setEdit", fieldKey, edit });
  }, []);
  const clearLocalEdit = useCallback((fieldKey: AgreementFieldKey) => {
    editsRef.current = withoutEdit(editsRef.current, fieldKey);
    dispatch({ type: "clearEdit", fieldKey });
  }, []);
  const clearAllLocalEdits = useCallback(() => {
    editsRef.current = {};
    dispatch({ type: "clearEdits" });
  }, []);

  const unsavedCount = countLocalEdits(data.localEdits);
  const hasUnsavedEdits = unsavedCount > 0;
  // Warn on leaving the page ONLY while edits exist.
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedEdits]);

  // ---- reads (not exclusive: a refresh never blocks a write, the newest response wins) ----
  const currentRef = () => agreementRef.current?.head.agreementRef ?? null;
  const currentVersionNumber = () => agreementRef.current?.selectedVersion?.version ?? null;

  const refreshReconciliation = useCallback(async (): Promise<FinanceApiResult<AgreementReconciliationDto>> => {
    const ref = currentRef();
    if (!ref) return noDraft();
    const token = ++gates.current.reconciliation;
    const result = await api.getAgreementReconciliation(ref, currentVersionNumber() === null ? {} : { version: currentVersionNumber()! });
    if (token !== gates.current.reconciliation) return { ...REFUSED, message: "Superseded by a newer refresh." };
    if (result.ok) dispatch({ type: "reconciliation", reconciliation: result.data });
    else if (!result.aborted) notify("warning", `Cross-verification could not be refreshed. ${result.message}`, "reconciliation-refresh");
    return result;
  }, [notify]);

  const refreshKyc = useCallback(async (): Promise<FinanceApiResult<AgreementKycStatusDto>> => {
    const ref = currentRef();
    if (!ref) return noDraft();
    const token = ++gates.current.kyc;
    const result = await api.getAgreementKycStatus(ref);
    if (token !== gates.current.kyc) return { ...REFUSED, message: "Superseded by a newer refresh." };
    if (result.ok) dispatch({ type: "kyc", kyc: result.data });
    else if (!result.aborted) notify("warning", `KYC status could not be refreshed. ${result.message}`, "kyc-refresh");
    return result;
  }, [notify]);

  const refreshPreview = useCallback(async (): Promise<FinanceApiResult<CounterpartyPreviewDto>> => {
    const target = agreementRef.current?.head.counterparty;
    if (!target) return noDraft();
    const token = ++gates.current.preview;
    const result = await api.getCounterpartyPreview({ counterpartyType: target.type, ref: target.ref });
    if (token !== gates.current.preview) return { ...REFUSED, message: "Superseded by a newer refresh." };
    if (result.ok) {
      dispatch({ type: "preview", preview: result.data });
      setPreviewLoad({ status: "ready" });
    } else if (!result.aborted) notify("warning", `CreatorOps details could not be refreshed. ${result.message}`, "preview-refresh");
    return result;
  }, [notify]);

  const refreshDetail = useCallback(async (): Promise<FinanceApiResult<AgreementDetailDto>> => {
    const ref = currentRef();
    if (!ref) return noDraft();
    const versionNumber = currentVersionNumber();
    const result = await api.getAgreementDetail(ref, versionNumber === null ? {} : { version: versionNumber });
    if (result.ok) setAgreement(result.data);
    else reportFailure("detail-refresh", result);
    return result;
  }, [reportFailure, setAgreement]);

  // Reloads the latest server state after a conflict. Unsaved local edits are KEPT (and reported), never written or dropped silently.
  const reloadLatest = useCallback(async (): Promise<FinanceApiResult<AgreementDetailDto>> => {
    const result = await refreshDetail();
    if (result.ok) {
      dispatch({ type: "conflict", message: null });
      void refreshReconciliation();
      void refreshKyc();
      const pending = countLocalEdits(editsRef.current);
      notify("info", pending > 0 ? `Loaded the latest version. Your ${pending} unsaved ${pending === 1 ? "change is" : "changes are"} still pending - review them, then save again.` : "Loaded the latest version.", "reloaded");
    }
    return result;
  }, [notify, refreshDetail, refreshKyc, refreshReconciliation]);

  // After a decision touched a field the reconciliation compares, refresh it in the background.
  const syncReconciliationFor = useCallback(
    (fieldKey: AgreementFieldKey) => {
      if (dataRef.current.reconciliation !== null && RECONCILED_SECTIONS.has(fieldPlacement(fieldKey).section)) void refreshReconciliation();
    },
    [refreshReconciliation],
  );

  // ---- writes ----
  // One decideField call using the docVersion of the LATEST response. Not exclusive by itself (the caller holds the lock).
  const writeDecision = useCallback(async (action: DecideFieldAction): Promise<FinanceApiResult<AgreementDetailDto>> => {
    const current = agreementRef.current;
    const selected = current?.selectedVersion ?? null;
    if (!current || !selected) return noDraft();
    return api.decideField(current.head.agreementRef, {
      version: selected.version,
      expectedDocVersion: selected.docVersion,
      fieldKey: action.fieldKey,
      decision: action.decision,
      ...(action.value !== undefined && action.decision !== "UNAVAILABLE" && action.decision !== "NOT_APPLICABLE" ? { value: action.value } : {}),
      ...(action.note ? { note: action.note } : {}),
    });
  }, []);

  const decideField = useCallback(
    (action: DecideFieldAction) =>
      runExclusive<FinanceApiResult<AgreementDetailDto>>(
        fieldBusyKey(action.fieldKey),
        async () => {
          const result = await writeDecision(action);
          if (result.ok) {
            setAgreement(result.data, [action.fieldKey]);
            // The explicit decision supersedes any buffered edit of the same field.
            if (editsRef.current[action.fieldKey] !== undefined) clearLocalEdit(action.fieldKey);
            syncReconciliationFor(action.fieldKey);
          } else reportFailure(`decide-${action.fieldKey}`, result);
          return result;
        },
        REFUSED,
      ),
    [clearLocalEdit, reportFailure, runExclusive, setAgreement, syncReconciliationFor, writeDecision],
  );

  // The flush itself (no lock): writes every buffered edit in registry order. Used by saveDraft and confirmAgreement.
  const flushBuffered = useCallback(async (): Promise<SaveDraftOutcome> => {
    const edits = editsRef.current;
    const outcome = await flushLocalEdits(
      edits,
      (item) => writeDecision(item),
      (next, fieldKey) => {
        setAgreement(next, [fieldKey]);
        clearLocalEdit(fieldKey);
      },
    );
    const summary = describeFlush(outcome);
    if (outcome.saved.length > 0 && dataRef.current.reconciliation !== null) void refreshReconciliation();
    if (outcome.failed) reportFailure("save-draft", outcome.failed.failure);
    else notify(summary.tone, summary.message, "save-draft");
    return { ok: outcome.failed === null, savedCount: outcome.saved.length, failure: outcome.failed?.failure ?? null, failedFieldKey: outcome.failed?.fieldKey ?? null, message: summary.message };
  }, [clearLocalEdit, notify, refreshReconciliation, reportFailure, setAgreement, writeDecision]);

  const saveDraft = useCallback(
    (): Promise<SaveDraftOutcome> =>
      runExclusive<SaveDraftOutcome>(
        INTAKE_BUSY.save,
        async () => {
          if (!agreementRef.current) return { ok: false, savedCount: 0, failure: noDraft(), failedFieldKey: null, message: "Start a draft first." };
          if (!deriveIntakeFlags({ permissions, counterpartyType: null, agreement: agreementRef.current }).canEdit) return { ok: false, savedCount: 0, failure: notEditable(), failedFieldKey: null, message: "This version can no longer be edited." };
          return flushBuffered();
        },
        { ok: false, savedCount: 0, failure: REFUSED, failedFieldKey: null, message: REFUSED.message },
      ),
    [flushBuffered, permissions, runExclusive],
  );

  const startDraft = useCallback(
    (input: StartDraftInput) =>
      runExclusive<FinanceApiResult<AgreementDetailDto>>(
        INTAKE_BUSY.startDraft,
        async () => {
          // ONE id per mount + counterparty: a retry (network error, 409 then fix) reuses it so it can never create a second Agreement.
          requestIdRef.current = clientRequestIdFor(requestIdRef.current, counterpartyInputKey(input.counterparty));
          const created = await api.createAgreementDraft({ clientRequestId: requestIdRef.current.id, counterparty: input.counterparty, sourceMode: "MANUAL", priorAgreementRef: input.priorAgreementRef ?? null });
          if (!created.ok) {
            // A create failure is never a "reload the latest version" conflict: there is no version yet. The same id is kept for a retry.
            if (!created.aborted) {
              const message = created.kind === "conflict" ? `${created.message} Reload this page and start the draft again.` : created.message;
              dispatch({ type: "notice", notice: { id: "start-draft", tone: "error", message } });
            }
            return created;
          }
          requestIdRef.current = null; // a success consumes the id
          draftJustStarted = true;
          setAgreement(created.data);
          let latest = created.data;
          // Partner-level: the intended platforms are RECORDED through the `platforms` field.
          if (input.recordPlatformsField && input.recordPlatformsField.length > 0 && latest.selectedVersion) {
            const entry = latest.selectedVersion.draft.platforms;
            const decision = resolveEditDecision(entry, input.recordPlatformsField, "platforms");
            const recorded = await writeDecision({ fieldKey: "platforms", decision, value: input.recordPlatformsField });
            if (recorded.ok) {
              setAgreement(recorded.data);
              latest = recorded.data;
            } else {
              notify("warning", "The draft was started, but the intended platforms could not be recorded. Set them in Cross-verification.", "platforms-record");
            }
          }
          const versionNumber = latest.selectedVersion?.version ?? latest.head.openVersion ?? 1;
          router.replace(intakeHref({ agreementRef: latest.head.agreementRef, version: versionNumber }));
          return { ok: true, status: created.status, data: latest };
        },
        REFUSED,
      ),
    [notify, router, runExclusive, setAgreement, writeDecision],
  );

  const extractFromFile = useCallback(
    (file: File) =>
      runExclusive<FinanceApiResult<ExtractionResultDto>>(
        INTAKE_BUSY.upload,
        async (setKey) => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return noDraft();
          const target = current.head.counterparty;
          const uploaded = await api.uploadContractArtifact({ file, counterpartyType: target.type, counterpartyRef: target.ref });
          if (!uploaded.ok) {
            reportFailure("extract", uploaded);
            return uploaded;
          }
          dispatch({ type: "artifact", artifact: uploaded.data });
          setKey(INTAKE_BUSY.extract);
          const extracted = await api.extractContract({ agreementRef: current.head.agreementRef, version: selected.version, artifactRef: uploaded.data.artifactRef });
          if (!extracted.ok) {
            reportFailure("extract", extracted);
            return extracted;
          }
          dispatch({ type: "extraction", extraction: extracted.data });
          return extracted;
        },
        REFUSED,
      ),
    [reportFailure, runExclusive],
  );

  const attachExtraction = useCallback(
    () =>
      runExclusive<FinanceApiResult<AttachExtractionOutcome>>(
        INTAKE_BUSY.attach,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          const extraction = dataRef.current.extraction;
          if (!current || !selected) return noDraft();
          if (!extraction) return { ok: false, status: 0, kind: "error", message: "Extract the Agreement first." } as FinanceApiFailure;
          const result = await api.attachExtractionProposals(current.head.agreementRef, { version: selected.version, expectedDocVersion: selected.docVersion, extractionRunRef: extraction.run.runRef });
          if (result.ok) {
            setAgreement(result.data.agreement);
            const { attachedCount, keptDecisionCount } = result.data;
            notify("success", `${attachedCount} extracted ${attachedCount === 1 ? "value was" : "values were"} added to the draft as pending. ${keptDecisionCount > 0 ? `${keptDecisionCount} already-decided ${keptDecisionCount === 1 ? "field was" : "fields were"} left unchanged. ` : ""}Review each one before confirming.`, "attach");
            if (dataRef.current.reconciliation !== null) void refreshReconciliation();
          } else reportFailure("attach", result);
          return result;
        },
        REFUSED,
      ),
    [notify, refreshReconciliation, reportFailure, runExclusive, setAgreement],
  );

  // Step 14B.1: the automatic re-upload after an onboarding: upload -> extract -> attach as ONE guarded write. The attach uses the run the
  // extract just returned (never a re-read of state, which has not re-rendered yet) and the docVersion of the newest response.
  const extractAndAttachFromFile = useCallback(
    (file: File) =>
      runExclusive<ReuploadResult | null>(
        INTAKE_BUSY.upload,
        async (setKey) => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return null;
          const target = current.head.counterparty;
          const ref = current.head.agreementRef;
          return reuploadAgreement(file, {
            upload: async (picked) => {
              const uploaded = await api.uploadContractArtifact({ file: picked, counterpartyType: target.type, counterpartyRef: target.ref });
              if (uploaded.ok) dispatch({ type: "artifact", artifact: uploaded.data });
              return uploaded;
            },
            extract: async (artifactRef) => {
              setKey(INTAKE_BUSY.extract);
              const extracted = await api.extractContract({ agreementRef: ref, version: selected.version, artifactRef });
              if (extracted.ok) dispatch({ type: "extraction", extraction: extracted.data });
              return extracted;
            },
            attach: async (extractionRunRef) => {
              setKey(INTAKE_BUSY.attach);
              const latest = agreementRef.current?.selectedVersion ?? selected;
              const attached = await api.attachExtractionProposals(ref, { version: latest.version, expectedDocVersion: latest.docVersion, extractionRunRef });
              if (attached.ok) {
                setAgreement(attached.data.agreement);
                if (dataRef.current.reconciliation !== null) void refreshReconciliation();
              }
              return attached;
            },
          });
        },
        null,
      ),
    [refreshReconciliation, runExclusive, setAgreement],
  );

  // Step 14B.1: the platform(s) chosen for a Partner started from an EXISTING record (Partner-level, no Account named) are RECORDED through the `platforms` field, as
  // `Start draft` does for a Partner-level Agreement. One guarded write; resolves false when it could not be written.
  const recordPlatformsOnDraft = useCallback(
    (platforms: string[]) =>
      runExclusive<boolean>(
        INTAKE_BUSY.save,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected || platforms.length === 0) return false;
          const decision = resolveEditDecision(selected.draft.platforms, platforms, "platforms");
          const recorded = await writeDecision({ fieldKey: "platforms", decision, value: platforms });
          if (!recorded.ok) return false;
          setAgreement(recorded.data, ["platforms"]);
          return true;
        },
        false,
      ),
    [runExclusive, setAgreement, writeDecision],
  );

  const updateCounterpartyContact = useCallback(
    (input: Omit<UpdateMasterDataInput, "version" | "expectedDocVersion">) =>
      runExclusive<FinanceApiResult<UpdateCounterpartyContactOutcome>>(
        INTAKE_BUSY.master,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return noDraft();
          const result = await api.updateCounterpartyContact(current.head.agreementRef, { ...input, version: selected.version, expectedDocVersion: selected.docVersion });
          if (result.ok) {
            notify("success", `${result.data.counterpartyType === "PARTNER" ? "Partner" : "Vendor"} record updated in CreatorOps master data.`, "master-data");
            // The outcome carries no Agreement: read the new state, the comparison and the master data back.
            void refreshDetail();
            void refreshReconciliation();
            void refreshPreview();
          } else reportFailure("master-data", result);
          return result;
        },
        REFUSED,
      ),
    [notify, refreshDetail, refreshPreview, refreshReconciliation, reportFailure, runExclusive],
  );

  const applyExtractedKyc = useCallback(
    (input: Omit<ApplyKycInput, "version">) =>
      runExclusive<FinanceApiResult<ApplyExtractedKycOutcome>>(
        INTAKE_BUSY.applyKyc,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return noDraft();
          const result = await api.applyExtractedKyc(current.head.agreementRef, { ...input, version: selected.version });
          if (result.ok) {
            notify("success", "KYC values from the Agreement were applied to the CreatorOps record.", "apply-kyc");
            void refreshKyc();
            void refreshReconciliation();
            void refreshPreview();
          } else reportFailure("apply-kyc", result);
          return result;
        },
        REFUSED,
      ),
    [notify, refreshKyc, refreshPreview, refreshReconciliation, reportFailure, runExclusive],
  );

  const confirmAgreement = useCallback(
    () =>
      runExclusive<FinanceApiResult<AgreementDetailDto>>(
        INTAKE_BUSY.confirm,
        async () => {
          if (!agreementRef.current?.selectedVersion) return noDraft();
          // Unsaved edits are written first - the person confirms what they see, not what was last saved.
          if (countLocalEdits(editsRef.current) > 0) {
            const flushed = await flushBuffered();
            if (!flushed.ok && flushed.failure) return flushed.failure;
          }
          const current = agreementRef.current!;
          const selected = current.selectedVersion!;
          const result = await api.confirmAgreementVersion(current.head.agreementRef, { version: selected.version, expectedDocVersion: selected.docVersion });
          if (result.ok) {
            setAgreement(result.data);
            notify("success", "Agreement confirmed. Its terms are now frozen.", "confirm");
            void refreshKyc();
          } else if (result.kind === "not_ready") {
            const views = describeConfirmBlockers(result.blockers, current.head.counterparty.type);
            dispatch({ type: "blockers", blockers: views });
            notify("error", `${views.length} ${views.length === 1 ? "item needs" : "items need"} attention before this Agreement can be confirmed.`, "confirm");
          } else reportFailure("confirm", result);
          return result;
        },
        REFUSED,
      ),
    [flushBuffered, notify, refreshKyc, reportFailure, runExclusive, setAgreement],
  );

  const activateAgreement = useCallback(
    () =>
      runExclusive<FinanceApiResult<AgreementDetailDto>>(
        INTAKE_BUSY.activate,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return noDraft();
          const result = await api.activateAgreementVersion(current.head.agreementRef, { version: selected.version, expectedDocVersion: current.head.docVersion });
          if (result.ok) {
            setAgreement(result.data);
            notify("success", "Agreement activated.", "activate");
          } else reportFailure("activate", result);
          return result;
        },
        REFUSED,
      ),
    [notify, reportFailure, runExclusive, setAgreement],
  );

  // FINAL_EXECUTION #10: replaces the OPEN, unconfirmed version's whole `parties` array.
  const setParties = useCallback(
    (parties: AgreementParty[]) =>
      runExclusive<FinanceApiResult<AgreementDetailDto>>(
        INTAKE_BUSY.parties,
        async () => {
          const current = agreementRef.current;
          const selected = current?.selectedVersion ?? null;
          if (!current || !selected) return noDraft();
          const result = await api.setAgreementParties(current.head.agreementRef, { version: selected.version, expectedDocVersion: selected.docVersion, parties });
          if (result.ok) setAgreement(result.data);
          else reportFailure("parties", result);
          return result;
        },
        REFUSED,
      ),
    [reportFailure, runExclusive, setAgreement],
  );

  const scrollToAnchor = useCallback((anchorId: string) => scrollToAnchorImpl(anchorId), []);
  const goToBlocker = useCallback((blocker: Pick<ConfirmBlockerView, "anchorId">) => void scrollToAnchorImpl(blocker.anchorId), []);
  const isBusy = useCallback((key?: string) => (key === undefined ? busyKey !== null : busyKey === key), [busyKey]);

  // Step 14B.1: the new-counterparty wizard (state machine + actions) and the receiving end of its hand-off.
  const navigateTo = useCallback((href: string) => router.replace(href), [router]);
  const onboarding = useOnboarding({ permissions, hasDraft: agreement !== null, initialSelection: initialOnboardingSelection(initial?.onboarding), runExclusive, notify, navigate: navigateTo });
  const handoffControl = useOnboardingHandoff({ agreementRef: agreement?.head.agreementRef ?? null, extractAndAttach: extractAndAttachFromFile, notify, focusAnchor: scrollToAnchorImpl, recordPlatforms: recordPlatformsOnDraft });
  const onboardingHandoff = { ...handoffControl.handoff, canRetry: handoffControl.canRetry, retry: handoffControl.retry };

  const value: IntakeContextValue = {
    permissions,
    flags,
    agreement,
    hasDraft: agreement !== null,
    agreementRef: agreement?.head.agreementRef ?? null,
    version,
    docVersion: version?.docVersion ?? null,
    counterparty,
    preview: data.preview,
    previewLoad,
    setPreview,
    setPreviewLoad,
    fieldModels,
    fields,
    getField,
    getEntry,
    unresolvedFields: unresolved,
    unresolvedCount: unresolved.length,
    extraction: data.extraction,
    artifact: data.artifact,
    extractionAttached,
    extractionPhase,
    reconciliation: data.reconciliation,
    kyc: data.kyc,
    revisionDiff,
    revisionBaseVersion,
    busyKey,
    isBusy,
    notices: data.notices,
    notify,
    dismissNotice,
    conflict: data.conflict,
    reloadLatest,
    confirmBlockers: data.confirmBlockers,
    localEdits: data.localEdits,
    unsavedCount,
    hasUnsavedEdits,
    setLocalEdit,
    clearLocalEdit,
    clearAllLocalEdits,
    startDraft,
    decideField,
    saveDraft,
    extractFromFile,
    attachExtraction,
    refreshDetail,
    refreshReconciliation,
    refreshKyc,
    refreshPreview,
    updateCounterpartyContact,
    applyExtractedKyc,
    confirmAgreement,
    activateAgreement,
    setParties,
    onboarding,
    extractAndAttachFromFile,
    onboardingHandoff,
    scrollToAnchor,
    goToBlocker,
  };

  return <IntakeContext.Provider value={value}>{children}</IntakeContext.Provider>;
}
