import type { ReviewActionPermissions } from "@/server/partner-reviews/ui-dto";
import type { PartnerReviewFreshnessState, PartnerReviewStatus } from "@/server/partner-reviews/types";

// Step 13B: the PURE decision of which lifecycle buttons a Review Detail renders. It only combines the
// server-computed permission booleans (the actor's explicit Feature + Action grants) with the state of
// the version on screen. It mirrors the server and never replaces it: every button still calls the
// accepted route, which re-authorizes (feature + action + live Partner scope) and re-checks the
// version, its docVersion and the stale-evidence guard. No role name is consulted anywhere.

export type ReviewActionInput = {
  permissions: ReviewActionPermissions;
  // The version on screen.
  version: { version: number; status: PartnerReviewStatus; docVersion: number };
  head: { openVersion: number | null; currentFinalizedVersion: number | null; docVersion: number };
  freshnessState: PartnerReviewFreshnessState | null;
};

export type ReviewActionState = {
  canRefresh: boolean;
  canSubmit: boolean;
  canFinalize: boolean;
  canCreateRevision: boolean;
  // The version on screen is the head's open version (the only one that can be refreshed / submitted / finalized).
  onOpenVersion: boolean;
  // Any lifecycle action is available at all (the action bar renders nothing otherwise).
  any: boolean;
};

export function computeReviewActionState(input: ReviewActionInput): ReviewActionState {
  const { permissions, version, head } = input;
  const onOpenVersion = head.openVersion !== null && head.openVersion === version.version && (version.status === "DRAFT" || version.status === "IN_REVIEW");

  const canRefresh = permissions.canRefresh && onOpenVersion;
  const canSubmit = permissions.canSubmit && onOpenVersion && version.status === "DRAFT";
  const canFinalize = permissions.canFinalize && onOpenVersion && version.status === "IN_REVIEW";
  // A revision starts from the CURRENT finalized version, only while no version is open and the recorded
  // freshness says the finalized evidence is behind upstream. (The server re-checks all of it.)
  const canCreateRevision = permissions.canCreateRevision && head.openVersion === null && version.status === "FINALIZED" && head.currentFinalizedVersion === version.version && input.freshnessState === "revision_available";

  return { canRefresh, canSubmit, canFinalize, canCreateRevision, onOpenVersion, any: canRefresh || canSubmit || canFinalize || canCreateRevision };
}

// What a failed action means for the UI, derived from the accepted HTTP contract:
//   409 + blockers[REFRESH_REQUIRED]  -> the In Review evidence is out of date: "Refresh required" (never auto-refresh)
//   409 + blockers[REVISION_NOT_NEEDED] -> finalized evidence still matches upstream
//   409 without blockers (stale_write / conflict) -> the review changed elsewhere: reload
export type ActionFailure =
  | { kind: "refresh_required"; message: string }
  | { kind: "revision_not_needed"; message: string }
  | { kind: "changed_elsewhere"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export function classifyActionFailure(failure: { status: number; code: string; error: string; blockers?: { code: string }[] }): ActionFailure {
  const blockerCodes = (failure.blockers ?? []).map((blocker) => blocker.code);
  if (blockerCodes.includes("REFRESH_REQUIRED")) return { kind: "refresh_required", message: failure.error };
  if (blockerCodes.includes("REVISION_NOT_NEEDED")) return { kind: "revision_not_needed", message: failure.error };
  if (failure.status === 409) return { kind: "changed_elsewhere", message: failure.error };
  if (failure.status === 401 || failure.status === 403) return { kind: "denied", message: "You don't have permission to do that." };
  return { kind: "error", message: failure.error };
}
