import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";
import { notifyActionItemPromoted } from "@/server/notifications";
import { generateSystemTask } from "@/server/operations";
import { buildSourceKey } from "@/server/operations/ids";

import { buildActionItemDto, formatIssues, latestAssignee } from "./action-item-service";
import type { ActionItemDto } from "./client-dto";
import { actionItemEventsCollection, findActionItemByPromotedTask, getActionItemVersionDoc, txGetActionItemHead, txSetActionItemHead } from "./firestore";
import { appendEvent } from "./notes-meetings-events";
import { loadAuthorizedActionItem } from "./notes-meetings-gate";
import { ownerToOperationsTarget } from "./owner-registry";
import { requireAdmittedActiveUser } from "./participant-guard";
import { resolvePromotedTaskDisplayName } from "./promoted-task-display";
import { notesMeetingsInvalidInputResult, notesMeetingsNotFoundResult, promoteActionItemInputSchema, type ActionItemHeadDoc, type NotesMeetingsServiceResult, type PromoteActionItemInput } from "./types";

// Notes/Meetings Completion (spec sections 2C/9/11/19): the explicit, user-triggered, permission-
// gated, idempotent MeetingActionItem -> OperationsTask promotion. Kept in its own file because it is
// the ONE place this module writes into another module's domain, and the ONE place a judgment call
// about idempotency mechanism had to be made explicitly (documented below and in the completion
// report).
//
// IDEMPOTENCY DESIGN (deliberately deviates from the literal "add createTaskWithProvenance mirroring
// createAgreementDraftWithProvenance" suggestion in the reconnaissance): a plain createTask/
// createTaskWithProvenance has NO built-in idempotency claim - two concurrent calls would each mint a
// fresh random taskRef with nothing to make them converge, so satisfying section 11's hard requirement
// ("two concurrent promote attempts must not create two Tasks") would need a SECOND, hand-built
// two-phase claim mechanism spanning two Firestore transactions across a module boundary (this
// module's own claim, then Operations' Task-creation transaction) - inherently weaker than a single
// atomic transaction, and a wheel Operations has already built and tested.
//
// Instead this reuses Operations' OWN existing generateSystemTask entry point exactly as designed:
// deterministic sourceKey + a claim document created in the SAME transaction as the Task itself
// (task-service.ts's own doc comment: "two racing calls for the exact same source event always
// converge on the SAME taskRef"). The sourceKey is built deterministically from the actionItemRef
// alone, so it is stable across retries and literally embeds the actionItemRef in the Task's own
// (non-sensitive, already-stored) `sourceKey` field - an authorized Operations viewer inspecting a
// MODULE_ACTION-origin Task can read exactly which Meeting Action Item created it. The durable
// Meeting -> Task reverse link required by section 19 ("navigable in both directions") is the
// `promotedTaskRef` field persisted on the MeetingActionItem head, set transactionally on THIS side
// after Operations confirms the Task exists - itself naturally idempotent (see below) since two
// concurrent callers of generateSystemTask with the identical sourceKey always get back the identical
// taskRef, so both writes here converge on the same value.
function promotionSourceKey(actionItemRef: string, targetType: string, targetRef: string): string {
  return buildSourceKey({ origin: "MODULE_ACTION", targetType, targetRef, qualifier: `MEETING_ACTION_ITEM_PROMOTED:${actionItemRef}` });
}

export async function promoteActionItem(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<NotesMeetingsServiceResult<ActionItemDto>> {
  const parsed = promoteActionItemInputSchema.safeParse(rawInput);
  if (!parsed.success) return notesMeetingsInvalidInputResult(formatIssues(parsed.error));
  const input: PromoteActionItemInput = parsed.data;

  const loaded = await loadAuthorizedActionItem(actor, input.actionItemRef, "promote_action_item");
  if (!loaded.ok) return loaded.error;
  const { head, meeting } = loaded.authorized;

  if (head.status === "CANCELLED") return { ok: false, code: "conflict", message: "A cancelled action item cannot be promoted." };

  // Idempotent fast path: already promoted - hand back the existing link, no new Task, no re-check
  // of the assignee/target below (a already-completed promotion never re-runs its own preconditions).
  if (head.promotedTaskRef) {
    const assignee = await latestAssignee(head.actionItemRef, head.latestVersion);
    const promotedTaskDisplayName = await resolvePromotedTaskDisplayName(actor, head.promotedTaskRef);
    return { ok: true, data: await buildActionItemDto(actor, head, assignee, promotedTaskDisplayName) };
  }

  const target = ownerToOperationsTarget(meeting.head.owner);
  if (!target) return notesMeetingsInvalidInputResult(`Promotion is not supported for owner type ${meeting.head.owner.ownerType} yet.`);

  const existingAssignee = await latestAssignee(head.actionItemRef, head.latestVersion);
  const assigneeUserRef = input.assigneeUserRef ?? existingAssignee ?? undefined;
  if (!assigneeUserRef) return notesMeetingsInvalidInputResult("Choose an assignee to promote this action item to a Task.");
  const assigneeCheck = await requireAdmittedActiveUser(assigneeUserRef);
  if (!assigneeCheck.ok) return notesMeetingsInvalidInputResult("The Task assignee must be an active CreatorOps user.");

  const version = await getActionItemVersionDoc(head.actionItemRef, head.latestVersion);
  const text = version?.text ?? head.display.text;
  const dueAt = version?.dueAt ?? head.display.dueAt ?? undefined;

  const sourceKey = promotionSourceKey(head.actionItemRef, target.targetType, target.targetRef);
  const generated = await generateSystemTask(
    actor,
    { origin: "MODULE_ACTION", sourceKey, title: `Meeting action item: ${text}`.slice(0, 200), target, assigneeUserRef, priority: input.priority ?? "NORMAL", dueAt: dueAt ?? null },
    requestId,
  );
  if (!generated.ok) {
    // Operations' own error codes map onto this module's own error family; a code Notes/Meetings has
    // no equivalent for (`not_ready`) is surfaced as a conflict rather than dropped.
    const code = generated.code === "unauthorized" || generated.code === "not_found" || generated.code === "invalid_input" || generated.code === "stale_write" || generated.code === "conflict" || generated.code === "internal" ? generated.code : "conflict";
    return { ok: false, code, message: generated.message, reason: code === "unauthorized" ? "action_denied" : undefined };
  }

  const taskRef = generated.data.task.taskRef;

  type Outcome = { kind: "ok" | "already"; head: ActionItemHeadDoc } | { kind: "not_found" };
  const now = new Date().toISOString();
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const current = await txGetActionItemHead(tx, head.actionItemRef);
    if (!current) return { kind: "not_found" };
    // Another concurrent/prior call already recorded this exact link (both calls resolved the SAME
    // deterministic sourceKey -> the SAME taskRef, so this is a true no-op, never a divergent write).
    if (current.promotedTaskRef) return { kind: "already", head: current };
    const nextHead: ActionItemHeadDoc = { ...current, docVersion: current.docVersion + 1, promotedTaskRef: taskRef, promotedAt: now, promotedByUserRef: actor!.userRef, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetActionItemHead(tx, nextHead);
    appendEvent(tx, actionItemEventsCollection(head.actionItemRef), { kind: "ACTION_ITEM_PROMOTED", actorUserRef: actor!.userRef, metadata: { taskRef, meetingRef: head.meetingRef, actionItemRef: head.actionItemRef }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind === "not_found") return notesMeetingsNotFoundResult();
  const finalHead = result.head;

  // Notifications Completion (spec section 4/21): fires only on the genuinely NEW link (result.kind
  // === "ok", i.e. this call is the one that actually recorded promotedTaskRef) - the "already"
  // idempotent-fast-path re-hit does not re-emit. See this file's own header comment for why the
  // generic "Task assigned" hook is deliberately absent from generateSystemTask's own call path,
  // making this the ONE notification a promotion ever produces.
  if (result.kind === "ok") {
    await notifyActionItemPromoted({ actionItemRef: head.actionItemRef, taskRef, taskTitle: generated.data.task.title, assigneeUserRef, actorUserRef: actor!.userRef, requestId }).catch(() => undefined);
  }

  const promotedTaskDisplayName = await resolvePromotedTaskDisplayName(actor, taskRef);
  const assignee = await latestAssignee(finalHead.actionItemRef, finalHead.latestVersion);
  return { ok: true, data: await buildActionItemDto(actor, finalHead, assignee, promotedTaskDisplayName) };
}

// Reverse navigation (spec section 19: "navigable in both directions where authorized"). The caller
// is an Operations Task detail page - it already re-authorized the Task itself via Operations' own
// getTask; this only needs to prove that SAME actor can also see the owning Meeting before handing
// back a deep link (an actor who can see the Task but not the Meeting's owner record gets nothing).
export type MeetingOriginLookup = { actionItemRef: string; meetingRef: string; ownerType: string; ownerRef: string };

export async function findMeetingActionItemByTask(actor: ActorContext | null, taskRef: string): Promise<MeetingOriginLookup | null> {
  const head = await findActionItemByPromotedTask(taskRef);
  if (!head) return null;
  const authorized = await loadAuthorizedActionItem(actor, head.actionItemRef);
  if (!authorized.ok) return null;
  return { actionItemRef: head.actionItemRef, meetingRef: head.meetingRef, ownerType: authorized.authorized.meeting.head.owner.ownerType, ownerRef: authorized.authorized.meeting.head.owner.ownerRef };
}
