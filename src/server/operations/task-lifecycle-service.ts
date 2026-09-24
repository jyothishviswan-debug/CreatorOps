import { canTransitionLifecycle, TASK_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toTaskDetailDto, type TaskDto } from "./client-dto";
import { resolveDisplayName } from "./display-names";
import { taskHeadDisplaySchema } from "./types";
import { getTaskVersionDoc, txGetTaskHead, txSetTaskHead } from "./firestore";
import { loadAuthorizedTask, requireAdmittedActiveUser, requireOperationsAccess } from "./operations-gate";
import { appendTaskEvent } from "./task-events";
import { formatIssues } from "./task-service";
import {
  blockTaskInputSchema,
  cancelTaskInputSchema,
  completeTaskInputSchema,
  operationsConflictResult,
  operationsInvalidInputResult,
  operationsNotFoundResult,
  operationsStaleResult,
  operationsUnauthorizedResult,
  reassignTaskInputSchema,
  reopenTaskInputSchema,
  startTaskInputSchema,
  unblockTaskInputSchema,
  type OperationsServiceResult,
  type OperationsTaskHeadDoc,
} from "./types";

// Step 18A: Task lifecycle transitions (section 5/14). Every transition is a Firestore transaction:
// re-reads the head, checks the docVersion precondition (optimistic concurrency - section 13's
// "two actors complete same Task" is resolved by whichever transaction commits first; the loser
// sees a docVersion mismatch and reports stale_write), checks canTransitionLifecycle against the
// centralized TASK_LIFECYCLE_TRANSITIONS table, writes the new head, and appends an audit event -
// all atomically. Mirrors src/server/finance-payments/payment-lifecycle-service.ts's own shape.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };
function failureResult(failure: Failure) {
  if (failure.kind === "not_found") return operationsNotFoundResult();
  if (failure.kind === "stale") return operationsStaleResult();
  return operationsConflictResult(failure.message);
}
type OkResult = { kind: "ok"; head: OperationsTaskHeadDoc };

async function runTransition(taskRef: string, expectedDocVersion: number, next: OperationsTaskHeadDoc["status"], mutate: (head: OperationsTaskHeadDoc, now: string) => Partial<OperationsTaskHeadDoc>, record: (tx: FirebaseFirestore.Transaction, head: OperationsTaskHeadDoc, nextHead: OperationsTaskHeadDoc, now: string) => void): Promise<OkResult | Failure> {
  return getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetTaskHead(tx, taskRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, next, TASK_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: `A task in ${head.status} cannot transition to ${next}.` };

    const now = new Date().toISOString();
    const patch = mutate(head, now);
    const nextHead: OperationsTaskHeadDoc = { ...head, ...patch, status: next, display: taskHeadDisplaySchema.parse({ ...head.display, status: next }), docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: patch.updatedByUserRef ?? head.updatedByUserRef };
    txSetTaskHead(tx, nextHead);
    record(tx, head, nextHead, now);
    return { kind: "ok", head: nextHead };
  });
}

async function respond(result: OkResult | Failure): Promise<OperationsServiceResult<TaskDto>> {
  if (result.kind !== "ok") return failureResult(result);
  const [version, assigneeDisplayName] = await Promise.all([txlessVersion(result.head), resolveDisplayName(result.head.assigneeUserRef)]);
  return { ok: true, data: toTaskDetailDto(result.head, version, new Date().toISOString(), assigneeDisplayName) };
}

// A plain (non-transactional) read of the head's latest version for the response DTO - the mutation
// itself already committed; this is read-after-write display only.
async function txlessVersion(head: OperationsTaskHeadDoc) {
  return getTaskVersionDoc(head.taskRef, head.latestVersion);
}

export async function startTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = startTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "IN_PROGRESS",
    (head, now) => ({ startedAt: now, startedByUserRef: actor!.userRef, blockedAt: null, blockedByUserRef: null, blockedReason: head.status === "BLOCKED" ? null : head.blockedReason }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_STARTED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "IN_PROGRESS" }, requestId, createdAt: now }),
  );
  return respond(result);
}

export async function blockTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = blockTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "BLOCKED",
    () => ({ blockedAt: new Date().toISOString(), blockedByUserRef: actor!.userRef, blockedReason: input.reason }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_BLOCKED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "BLOCKED", reason: input.reason }, requestId, createdAt: now }),
  );
  return respond(result);
}

export async function unblockTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = unblockTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "IN_PROGRESS",
    () => ({ blockedAt: null, blockedByUserRef: null, blockedReason: null }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_UNBLOCKED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "IN_PROGRESS" }, requestId, createdAt: now }),
  );
  return respond(result);
}

export async function completeTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = completeTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "DONE",
    () => ({ doneAt: new Date().toISOString(), doneByUserRef: actor!.userRef }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_COMPLETED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "DONE" }, requestId, createdAt: now }),
  );
  return respond(result);
}

export async function cancelTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = cancelTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "CANCELLED",
    () => ({ cancelledAt: new Date().toISOString(), cancelledByUserRef: actor!.userRef, cancelledReason: input.reason }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_CANCELLED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "CANCELLED", reason: input.reason }, requestId, createdAt: now }),
  );
  return respond(result);
}

// Reopen (DONE|CANCELLED -> OPEN, section 5's own explicit-action requirement). Deliberately its
// own action gate (complete_tasks, the same lifecycle-closing permission that closed it) rather than
// a silent side effect of any other call.
export async function reopenTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "complete_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = reopenTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedTask(actor, input.taskRef, "complete_tasks");
  if (!loaded.ok) return loaded.error;

  const result = await runTransition(
    input.taskRef,
    input.expectedDocVersion,
    "OPEN",
    () => ({ doneAt: null, doneByUserRef: null, cancelledAt: null, cancelledByUserRef: null, cancelledReason: null, reopenedAt: new Date().toISOString(), reopenedByUserRef: actor!.userRef }),
    (tx, head, nextHead, now) => appendTaskEvent(tx, head.taskRef, { kind: "TASK_REOPENED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "OPEN", reason: input.reason }, requestId, createdAt: now }),
  );
  return respond(result);
}

// Reassignment (assign_tasks - its own action, distinct from manage_tasks/complete_tasks - section
// 5/9). Does NOT change lifecycle status; only the assignee + scope snapshot. Section 13's
// "reassignment vs completion" race: both are optimistic-concurrency-guarded on the same
// docVersion, so whichever commits first wins and the other reports stale_write - there is no
// special-case interaction beyond that (a completed task can still be "reassigned" as a record of
// who now owns follow-up, but the new assignee must independently be admitted/active/in-scope).
export async function reassignTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "assign_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = reassignTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const loaded = await loadAuthorizedTask(actor, input.taskRef, "assign_tasks");
  if (!loaded.ok) return loaded.error;

  const assignee = await requireAdmittedActiveUser(input.assigneeUserRef);
  if (!assignee.ok) return assignee.error;

  type Outcome = { kind: "ok"; head: OperationsTaskHeadDoc } | Failure;
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetTaskHead(tx, input.taskRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "CANCELLED") return { kind: "conflict", message: "A cancelled task cannot be reassigned." };

    const now = new Date().toISOString();
    const previousAssignee = head.assigneeUserRef;
    const nextHead: OperationsTaskHeadDoc = { ...head, assigneeUserRef: input.assigneeUserRef, ownerUid: assignee.uid, docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetTaskHead(tx, nextHead);
    appendTaskEvent(tx, head.taskRef, { kind: "TASK_REASSIGNED", version: head.latestVersion, actorUserRef: actor!.userRef, metadata: { previousAssigneeUserRef: previousAssignee, newAssigneeUserRef: input.assigneeUserRef, reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  const [version, assigneeDisplayName] = await Promise.all([txlessVersion(result.head), resolveDisplayName(result.head.assigneeUserRef)]);
  return { ok: true, data: toTaskDetailDto(result.head, version, new Date().toISOString(), assigneeDisplayName) };
}
