import type { AgreementDetailDto, ContractArtifactDto, ExtractionResultDto } from "@/server/finance-agreements/client-dto";
import type { AgreementKycStatusDto } from "@/server/finance-agreements/kyc-status-service";
import type { AgreementReconciliationDto } from "@/server/finance-agreements/reconciliation-service";
import type { AgreementFieldKey } from "@/server/finance-agreements/fields";
import type { CounterpartyPreviewDto } from "@/server/finance-agreements/workspace-dto";

import type { FinanceApiFailure } from "../api-client";
import type { ConfirmBlockerView } from "../confirm-blockers";
import { withEdit, withoutEdit, type LocalEdits, type LocalFieldEdit } from "./intake-logic";

// Step 14B intake: the state reducer of the intake context (pure). Every server response REPLACES the slice it belongs to - the client
// never patches a stale copy - and unsaved local edits live beside the server state, never inside it.

export type IntakeNoticeTone = "info" | "success" | "warning" | "error";
export type IntakeNotice = { id: string; tone: IntakeNoticeTone; message: string };

export type IntakeData = {
  agreement: AgreementDetailDto | null;
  preview: CounterpartyPreviewDto | null;
  extraction: ExtractionResultDto | null;
  artifact: ContractArtifactDto | null;
  reconciliation: AgreementReconciliationDto | null;
  kyc: AgreementKycStatusDto | null;
  localEdits: LocalEdits;
  confirmBlockers: ConfirmBlockerView[];
  notices: IntakeNotice[];
  // A stale / conflict outcome: the server changed under the person. Cleared only by reloading the latest.
  conflict: { message: string } | null;
};

export type IntakeAction =
  // `decidedFieldKeys`: the fields this write decided - only THEIR confirm blockers are pruned; any other write clears them all.
  | { type: "agreement"; agreement: AgreementDetailDto; decidedFieldKeys?: readonly AgreementFieldKey[] }
  | { type: "preview"; preview: CounterpartyPreviewDto | null }
  | { type: "extraction"; extraction: ExtractionResultDto | null; artifact?: ContractArtifactDto | null }
  | { type: "artifact"; artifact: ContractArtifactDto | null }
  | { type: "reconciliation"; reconciliation: AgreementReconciliationDto | null }
  | { type: "kyc"; kyc: AgreementKycStatusDto | null }
  | { type: "setEdit"; fieldKey: AgreementFieldKey; edit: LocalFieldEdit }
  | { type: "clearEdit"; fieldKey: AgreementFieldKey }
  | { type: "replaceEdits"; edits: LocalEdits }
  | { type: "clearEdits" }
  | { type: "blockers"; blockers: ConfirmBlockerView[] }
  | { type: "notice"; notice: IntakeNotice }
  | { type: "dismissNotice"; id: string }
  | { type: "conflict"; message: string | null };

export const MAX_NOTICES = 4;

export function createInitialIntakeData(seed: IntakeInitialData = {}): IntakeData {
  // Explicit picks: the page's initial object also carries revision-diff inputs that are not part of this state.
  return {
    agreement: seed.agreement ?? null,
    preview: seed.preview ?? null,
    extraction: seed.extraction ?? null,
    artifact: seed.artifact ?? null,
    reconciliation: seed.reconciliation ?? null,
    kyc: seed.kyc ?? null,
    localEdits: {},
    confirmBlockers: [],
    notices: [],
    conflict: null,
  };
}

export function pruneBlockers(blockers: readonly ConfirmBlockerView[], decided: readonly AgreementFieldKey[] | undefined): ConfirmBlockerView[] {
  if (!decided || decided.length === 0) return [];
  return blockers.filter((blocker) => blocker.fieldKey === null || !decided.includes(blocker.fieldKey));
}

export function intakeReducer(state: IntakeData, action: IntakeAction): IntakeData {
  switch (action.type) {
    case "agreement":
      // A fresh server copy replaces the old one and clears any conflict. The last confirm attempt's blockers are kept only for fields this
      // write did not decide (so fixing one item does not make the rest of the list vanish); a write that names no field clears them all.
      return { ...state, agreement: action.agreement, confirmBlockers: pruneBlockers(state.confirmBlockers, action.decidedFieldKeys), conflict: null };
    case "preview":
      return { ...state, preview: action.preview };
    case "extraction":
      return { ...state, extraction: action.extraction, artifact: action.artifact === undefined ? state.artifact : action.artifact };
    case "artifact":
      return { ...state, artifact: action.artifact };
    case "reconciliation":
      return { ...state, reconciliation: action.reconciliation };
    case "kyc":
      return { ...state, kyc: action.kyc };
    case "setEdit":
      return { ...state, localEdits: withEdit(state.localEdits, action.fieldKey, action.edit) };
    case "clearEdit":
      return { ...state, localEdits: withoutEdit(state.localEdits, action.fieldKey) };
    case "replaceEdits":
      return { ...state, localEdits: action.edits };
    case "clearEdits":
      return { ...state, localEdits: {} };
    case "blockers":
      return { ...state, confirmBlockers: action.blockers };
    case "notice": {
      // The newest notice wins a same-id slot (a status line is replaced, not stacked); the list is bounded.
      const others = state.notices.filter((notice) => notice.id !== action.notice.id);
      return { ...state, notices: [...others, action.notice].slice(-MAX_NOTICES) };
    }
    case "dismissNotice":
      return { ...state, notices: state.notices.filter((notice) => notice.id !== action.id) };
    case "conflict":
      return { ...state, conflict: action.message === null ? null : { message: action.message } };
  }
}

// A failed mutation -> the notice / conflict it produces. `stale` and `conflict` outcomes mean "reload the latest" - never a silent retry.
export function failureToNotice(id: string, failure: FinanceApiFailure): { notice: IntakeNotice; conflict: string | null } {
  const conflict = failure.kind === "stale" || failure.kind === "conflict" ? failure.message : null;
  return { notice: { id, tone: "error", message: failure.message }, conflict };
}

// Server-supplied initial state (the page resolves it before render, so nothing flashes).
export type IntakeInitialData = Partial<Pick<IntakeData, "agreement" | "preview" | "extraction" | "artifact" | "reconciliation" | "kyc">>;
