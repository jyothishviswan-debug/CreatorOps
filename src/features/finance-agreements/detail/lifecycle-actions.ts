import type { FinanceApiBlocker, FinanceApiFailure } from "../api-client";
import type { AgreementHeadDto, AgreementVersionSummaryDto } from "@/server/finance-agreements/client-dto";
import { MAX_AGREEMENT_VERSIONS, type AgreementHeadStatus } from "@/server/finance-agreements/types";

// Step 14B: WHICH lifecycle actions the detail page renders (pure). Two inputs only:
//   - the SERVER-computed permission booleans (computeFinanceAgreementPermissions): canManage = prepare / confirm,
//     canActivate = activate / revise / suspend / resume / end;
//   - the head + version summaries (state).
// A button that is not returned here does not exist in the DOM - nothing is revealed and then hidden. Every action
// is still re-authorized by the server; these booleans never replace that check. There is NO delete action anywhere.
export type ActionPermissions = { canManage: boolean; canActivate: boolean };

export type ActionHead = Pick<AgreementHeadDto, "status" | "openVersion" | "activeVersion" | "lastEndedVersion" | "latestVersion">;
export type ActionVersion = Pick<AgreementVersionSummaryDto, "version" | "status" | "confirmed">;

export type AgreementActionState = {
  // The open (editable / awaiting-activation) version, if any.
  openVersion: number | null;
  // The open version is confirmed (frozen) and only waits for activation.
  openConfirmed: boolean;
  // The version that governs today (ACTIVE / SUSPENDED); null for a first draft or an ended Agreement.
  governingVersion: number | null;
  // Primary actions (page header): open the intake editor / start a revision.
  canContinueDraft: boolean;
  canCreateRevision: boolean;
  // Lifecycle panel actions.
  canConfirm: boolean;
  canActivate: boolean;
  canSuspend: boolean;
  canResume: boolean;
  canEnd: boolean;
  // Any button at all (header or panel).
  any: boolean;
  // A short sentence for the panel when nothing is available (never blank, never a guess about WHY access is missing).
  note: string;
};

export function computeAgreementActionState(input: { permissions: ActionPermissions; head: ActionHead; versions: readonly ActionVersion[] }): AgreementActionState {
  const { permissions, head } = input;
  const open = head.openVersion === null ? null : (input.versions.find((version) => version.version === head.openVersion) ?? null);
  const openIsDraft = open !== null && open.status === "DRAFT";
  const openConfirmed = openIsDraft && open.confirmed;
  const hasGoverning = head.activeVersion !== null && (head.status === "ACTIVE" || head.status === "SUSPENDED");

  const canContinueDraft = permissions.canManage && openIsDraft && !openConfirmed;
  const canConfirm = canContinueDraft;
  const canActivate = permissions.canActivate && openConfirmed;
  const canCreateRevision = permissions.canActivate && head.openVersion === null && head.status !== "DRAFT" && head.latestVersion < MAX_AGREEMENT_VERSIONS;
  const canSuspend = permissions.canActivate && hasGoverning && head.status === "ACTIVE";
  const canResume = permissions.canActivate && hasGoverning && head.status === "SUSPENDED";
  const canEnd = permissions.canActivate && hasGoverning;
  const any = canContinueDraft || canConfirm || canActivate || canCreateRevision || canSuspend || canResume || canEnd;

  return {
    openVersion: head.openVersion,
    openConfirmed,
    governingVersion: hasGoverning ? head.activeVersion : null,
    canContinueDraft,
    canCreateRevision,
    canConfirm,
    canActivate,
    canSuspend,
    canResume,
    canEnd,
    any,
    note: noActionNote(permissions, head.status, openIsDraft, openConfirmed),
  };
}

function noActionNote(permissions: ActionPermissions, status: AgreementHeadStatus, openIsDraft: boolean, openConfirmed: boolean): string {
  if (!permissions.canManage && !permissions.canActivate) return "You can view this Agreement. Editing and lifecycle changes need permission you do not currently have.";
  if (openConfirmed && !permissions.canActivate) return "This version is confirmed and waiting to be activated by someone with activation permission.";
  if (openIsDraft && !permissions.canManage) return "This draft is being prepared by someone with permission to edit Agreements.";
  if (status === "ENDED") return "This Agreement has ended. Ended versions stay readable; a new revision can be started by someone with activation permission.";
  return "No lifecycle change is available for you on this Agreement right now.";
}

// --- Failures ---------------------------------------------------------------------------------------------------------------------------
// One classification of every mutation failure. `stale` / `denied` / `not_found` are PAGE-level (a banner with its own recovery: Reload
// latest); the others stay next to the action that failed. Nothing here is ever a silent overwrite.
export type ActionFailureKind = "stale" | "denied" | "not_found" | "not_ready" | "conflict" | "invalid" | "network" | "error";
export type ActionFailureView = { kind: ActionFailureKind; message: string; blockers?: FinanceApiBlocker[] };

export const STALE_MESSAGE = "This Agreement changed elsewhere since you opened it. Reload the latest version, review it, then try again.";
export const NOT_FOUND_MESSAGE = "This Agreement could not be found.";

export function classifyActionFailure(failure: Pick<FinanceApiFailure, "kind" | "message" | "blockers">): ActionFailureView {
  switch (failure.kind) {
    case "stale":
      return { kind: "stale", message: STALE_MESSAGE };
    case "unauthorized":
    case "forbidden":
      return { kind: "denied", message: failure.message };
    case "not_found":
      return { kind: "not_found", message: NOT_FOUND_MESSAGE };
    case "not_ready":
      return { kind: "not_ready", message: failure.message, blockers: failure.blockers ?? [] };
    case "conflict":
      return { kind: "conflict", message: failure.message };
    case "invalid":
      return { kind: "invalid", message: failure.message };
    case "network":
      return { kind: "network", message: failure.message };
    default:
      return { kind: "error", message: failure.message };
  }
}

// Page-level failures close the dialog and show the banner; the rest stay in the dialog beside the button that failed.
export const isPageLevelFailure = (failure: ActionFailureView): boolean => failure.kind === "stale" || failure.kind === "denied" || failure.kind === "not_found";

// --- Reason (suspend / end) ---------------------------------------------------------------------------------------------------------------
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 1000;

// null = acceptable (after trimming); otherwise the message to show. The server applies the same 3-1000 rule.
export function reasonIssue(reason: string): string | null {
  const length = reason.trim().length;
  if (length < REASON_MIN_LENGTH) return `Enter a reason (at least ${REASON_MIN_LENGTH} characters).`;
  if (length > REASON_MAX_LENGTH) return `The reason is too long (at most ${REASON_MAX_LENGTH} characters).`;
  return null;
}
