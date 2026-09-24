import type { ActionId } from "@/server/authz/actions";
import { canAccessFeature, canPerformAction } from "@/server/authz/capabilities";
import { getUserDocByRef } from "@/server/authz/firestore";
import { getActorScopeGrants, hasGlobalScope, isRegionInScope, isSelfInScope, isTeamInScope } from "@/server/authz/scope";
import type { ActorContext, ScopeGrant } from "@/server/authz/types";

import { getReminderHeadDoc, getTaskHeadDoc } from "./firestore";
import { operationsNotFoundResult, operationsUnauthorizedResult, reminderRefSchema, taskRefSchema, type OperationsDenialReason, type OperationsErrorResult, type OperationsReminderHeadDoc, type OperationsTaskHeadDoc } from "./types";

// Step 18A: the Operations gate. Mirrors src/server/finance-payments/finance-payments-gate.ts's own
// chain: Authentication -> Admission (a resolved, active ActorContext) -> FeatureAccess(operations)
// -> ActionPermission -> RecordScope -> lifecycle preconditions (inside the transaction). Explicit
// grants only: no role rank, no wildcard, no minimumRole, and a missing grant fails closed.
//
// Record Scope (section 9) is deliberately NOT derived live from a Task's/Reminder's own `target`
// (see types.ts's own comment on operationsTaskHeadDocSchema): the target may live in any of eleven
// different modules, each with its own scope shape, and reaching into all of them here would be
// both a large new coupling surface and a re-implementation of each module's own RecordScope rule
// rather than a reuse of it. Instead a Task/Reminder carries its OWN explicit scope snapshot
// (ownerUid = the primary assignee/recipient, regionIds/teamIds settable at creation/reassignment) -
// the same "explicit, settable scope dimensions" shape Partners/Vendors already use for their own
// head docs, not a target-derived one. The creator can always see what they created (see
// isOperationsRecordInScope below) even outside their own region/team grants, exactly like a
// Finance module's own "author sees their own draft" expectation.
export type OperationsAction = Extract<ActionId, "manage_tasks" | "assign_tasks" | "complete_tasks" | "view_approval_queue" | "manage_reminders">;

export type OperationsAccessResult = { ok: true } | { ok: false; reason: OperationsDenialReason };

export async function requireOperationsAccess(actor: ActorContext | null, action?: OperationsAction): Promise<OperationsAccessResult> {
  if (!actor) return { ok: false, reason: "not_authenticated" };
  const hasFeature = await canAccessFeature(actor, "operations");
  if (!hasFeature) return { ok: false, reason: "feature_denied" };
  if (action) {
    const hasAction = await canPerformAction(actor, "operations", action);
    if (!hasAction) return { ok: false, reason: "action_denied" };
  }
  return { ok: true };
}

// --- Record Scope -----------------------------------------------------------------------------
export type ScopedRecord = { ownerUid: string | null; regionIds: string[]; teamIds: string[]; createdByUserRef: string };

export function isOperationsRecordInScope(grants: ScopeGrant[], actor: ActorContext, record: ScopedRecord): boolean {
  return (
    hasGlobalScope(grants) ||
    isSelfInScope(grants, actor.uid, record.ownerUid ?? undefined) ||
    record.createdByUserRef === actor.userRef ||
    record.regionIds.some((region) => isRegionInScope(grants, region)) ||
    record.teamIds.some((teamId) => isTeamInScope(grants, teamId))
  );
}

function neutral(): { ok: false; error: OperationsErrorResult } {
  return { ok: false, error: operationsNotFoundResult() };
}

// --- Assignee eligibility (section 5: "Assignee must be admitted/active") --------------------
export type AssigneeCheckResult = { ok: true; uid: string } | { ok: false; error: OperationsErrorResult };

export async function requireAdmittedActiveUser(userRef: string): Promise<AssigneeCheckResult> {
  const user = await getUserDocByRef(userRef);
  if (!user || !user.active) return { ok: false, error: operationsUnauthorizedResult("scope_denied") };
  return { ok: true, uid: user.uid };
}

// --- Task (gate + head + live scope) ------------------------------------------------------------
export type AuthorizedTask = { head: OperationsTaskHeadDoc };
export type LoadAuthorizedTaskResult = { ok: true; authorized: AuthorizedTask } | { ok: false; error: OperationsErrorResult };

export async function loadAuthorizedTask(actor: ActorContext | null, taskRef: string, action?: OperationsAction): Promise<LoadAuthorizedTaskResult> {
  const access = await requireOperationsAccess(actor, action);
  if (!access.ok) return { ok: false, error: operationsUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: operationsUnauthorizedResult("not_authenticated") };

  if (!taskRefSchema.safeParse(taskRef).success) return neutral();
  const head = await getTaskHeadDoc(taskRef);
  if (!head) return neutral();

  const grants = await getActorScopeGrants(actor);
  if (!isOperationsRecordInScope(grants, actor, { ownerUid: head.ownerUid, regionIds: head.regionIds, teamIds: head.teamIds, createdByUserRef: head.createdByUserRef })) return neutral();

  return { ok: true, authorized: { head } };
}

// --- Reminder (gate + head + live scope) ---------------------------------------------------------
export type AuthorizedReminder = { head: OperationsReminderHeadDoc };
export type LoadAuthorizedReminderResult = { ok: true; authorized: AuthorizedReminder } | { ok: false; error: OperationsErrorResult };

export async function loadAuthorizedReminder(actor: ActorContext | null, reminderRef: string, action?: OperationsAction): Promise<LoadAuthorizedReminderResult> {
  const access = await requireOperationsAccess(actor, action);
  if (!access.ok) return { ok: false, error: operationsUnauthorizedResult(access.reason) };
  if (!actor) return { ok: false, error: operationsUnauthorizedResult("not_authenticated") };

  if (!reminderRefSchema.safeParse(reminderRef).success) return neutral();
  const head = await getReminderHeadDoc(reminderRef);
  if (!head) return neutral();

  const grants = await getActorScopeGrants(actor);
  if (!isOperationsRecordInScope(grants, actor, { ownerUid: head.ownerUid, regionIds: head.regionIds, teamIds: head.teamIds, createdByUserRef: head.createdByUserRef })) return neutral();

  return { ok: true, authorized: { head } };
}
