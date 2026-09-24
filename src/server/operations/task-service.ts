import type { z } from "zod";

import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toTaskDetailDto, toTaskEventDto, type TaskDto, type TaskEventDto } from "./client-dto";
import {
  getTaskGenerationClaimDoc,
  getTaskHeadDoc,
  getTaskVersionDoc,
  listTaskEventDocs,
  listTaskHeadsByAssignee,
  listTaskHeadsBounded,
  listTaskHeadsByTarget,
  listTaskVersionDocs,
  txCreateTaskGenerationClaim,
  txCreateTaskVersion,
  txGetTaskGenerationClaim,
  txGetTaskHead,
  txGetTaskVersion,
  txSetTaskHead,
} from "./firestore";
import { generateTaskRef } from "./ids";
import { isOperationsRecordInScope, loadAuthorizedTask, requireAdmittedActiveUser, requireOperationsAccess } from "./operations-gate";
import { appendTaskEvent } from "./task-events";
import {
  createTaskInputSchema,
  generateSystemTaskInputSchema,
  listTasksQuerySchema,
  operationsInvalidInputResult,
  operationsNotFoundResult,
  operationsUnauthorizedResult,
  reviseTaskInputSchema,
  taskGenerationClaimDocSchema,
  taskHeadDisplaySchema,
  taskVersionDocSchema,
  DEFAULT_TASK_PAGE_SIZE,
  type GenerateSystemTaskInput,
  type ListTasksQuery,
  type OperationsErrorResult,
  type OperationsServiceResult,
  type OperationsTaskHeadDoc,
  type ReviseTaskInput,
  type TaskHeadDisplay,
  type TaskVersionDoc,
} from "./types";

// Step 18A: Task authoring - create, get, revise, list/query. Lifecycle transitions (start, block,
// unblock, complete, reopen, cancel, reassign) live in task-lifecycle-service.ts, and the one
// system-generation entry point (generateSystemTask) lives there too, since it shares the same
// idempotent-claim transaction shape as the reassignment/lifecycle writers.

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

function buildDisplay(input: { title: string; priority: TaskVersionDoc["priority"]; status: OperationsTaskHeadDoc["status"]; dueAt: string | null; projectedAt: string }): TaskHeadDisplay {
  return taskHeadDisplaySchema.parse({ title: input.title, titleLower: input.title.toLocaleLowerCase(), priority: input.priority, status: input.status, dueAt: input.dueAt, projectedAt: input.projectedAt });
}

export async function createTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "manage_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = createTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const assignee = await requireAdmittedActiveUser(input.assigneeUserRef);
  if (!assignee.ok) return assignee.error;

  const now = new Date().toISOString();
  const taskRef = generateTaskRef();
  const version: TaskVersionDoc = taskVersionDocSchema.parse({
    taskRef,
    version: 1,
    title: input.title,
    notes: input.notes ?? null,
    target: input.target,
    priority: input.priority ?? "NORMAL",
    dueAt: input.dueAt ?? null,
    changeKind: "created",
    reason: null,
    createdAt: now,
    createdByUserRef: actor!.userRef,
  });

  const head: OperationsTaskHeadDoc = {
    taskRef,
    docVersion: 1,
    target: input.target,
    assigneeUserRef: input.assigneeUserRef,
    createdByUserRef: actor!.userRef,
    origin: "MANUAL",
    sourceKey: null,
    ownerUid: assignee.uid,
    regionIds: input.regionIds ?? [],
    teamIds: input.teamIds ?? [],
    status: "OPEN",
    latestVersion: 1,
    startedAt: null,
    startedByUserRef: null,
    blockedAt: null,
    blockedByUserRef: null,
    blockedReason: null,
    doneAt: null,
    doneByUserRef: null,
    cancelledAt: null,
    cancelledByUserRef: null,
    cancelledReason: null,
    reopenedAt: null,
    reopenedByUserRef: null,
    display: buildDisplay({ title: input.title, priority: version.priority, status: "OPEN", dueAt: version.dueAt, projectedAt: now }),
    createdAt: now,
    updatedAt: now,
    updatedByUserRef: actor!.userRef,
  };

  await getAdminFirestore().runTransaction(async (tx) => {
    txCreateTaskVersion(tx, version);
    txSetTaskHead(tx, head);
    appendTaskEvent(tx, taskRef, {
      kind: "TASK_CREATED",
      version: 1,
      actorUserRef: actor!.userRef,
      metadata: { targetType: input.target.targetType, targetRef: input.target.targetRef, priority: version.priority, origin: "MANUAL" },
      requestId,
      createdAt: now,
    });
  });

  return { ok: true, data: toTaskDetailDto(head, version, now) };
}

export async function getTask(actor: ActorContext | null, rawTaskRef: unknown): Promise<OperationsServiceResult<TaskDto>> {
  const loaded = await loadAuthorizedTask(actor, typeof rawTaskRef === "string" ? rawTaskRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;
  const version = await getTaskVersionDoc(head.taskRef, head.latestVersion);
  return { ok: true, data: toTaskDetailDto(head, version, new Date().toISOString()) };
}

export async function listTaskEvents(actor: ActorContext | null, rawTaskRef: unknown, rawLimit?: unknown): Promise<OperationsServiceResult<{ events: TaskEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedTask(actor, typeof rawTaskRef === "string" ? rawTaskRef : "");
  if (!loaded.ok) return loaded.error;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) ? rawLimit : undefined;
  const page = await listTaskEventDocs(loaded.authorized.head.taskRef, limit);
  return { ok: true, data: { events: page.events.map(toTaskEventDto), hasMore: page.hasMore } };
}

export async function reviseTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<TaskDto>> {
  const access = await requireOperationsAccess(actor, "manage_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = reviseTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input: ReviseTaskInput = parsed.data;

  const loaded = await loadAuthorizedTask(actor, input.taskRef, "manage_tasks");
  if (!loaded.ok) return loaded.error;

  type Outcome = { kind: "ok"; head: OperationsTaskHeadDoc; version: TaskVersionDoc } | { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };

  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const head = await txGetTaskHead(tx, input.taskRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status === "DONE" || head.status === "CANCELLED") return { kind: "conflict", message: "A done or cancelled task cannot be revised - reopen it first." };
    const current = await txGetTaskVersion(tx, input.taskRef, head.latestVersion);
    if (!current) return { kind: "not_found" };

    const now = new Date().toISOString();
    const nextNumber = head.latestVersion + 1;
    const nextTitle = input.title ?? current.title;
    const nextPriority = input.priority ?? current.priority;
    const nextDueAt = input.dueAt !== undefined ? input.dueAt : current.dueAt;
    const version = taskVersionDocSchema.parse({
      taskRef: input.taskRef,
      version: nextNumber,
      title: nextTitle,
      notes: input.notes !== undefined ? input.notes : current.notes,
      target: current.target,
      priority: nextPriority,
      dueAt: nextDueAt,
      changeKind: "revised",
      reason: input.reason,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });
    txCreateTaskVersion(tx, version);

    const nextHead: OperationsTaskHeadDoc = { ...head, latestVersion: nextNumber, display: buildDisplay({ title: nextTitle, priority: nextPriority, status: head.status, dueAt: nextDueAt, projectedAt: now }), updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetTaskHead(tx, nextHead);

    appendTaskEvent(tx, input.taskRef, { kind: "TASK_REVISED", version: nextNumber, actorUserRef: actor!.userRef, metadata: { previousVersion: head.latestVersion, newVersion: nextNumber, reason: input.reason }, requestId, createdAt: now });
    if (nextPriority !== current.priority) {
      appendTaskEvent(tx, input.taskRef, { kind: "TASK_PRIORITY_CHANGED", version: nextNumber, actorUserRef: actor!.userRef, metadata: { priority: nextPriority, previousPriority: current.priority }, requestId, createdAt: now });
    }
    if (nextDueAt !== current.dueAt) {
      appendTaskEvent(tx, input.taskRef, { kind: "TASK_DUE_DATE_CHANGED", version: nextNumber, actorUserRef: actor!.userRef, metadata: { dueAt: nextDueAt ?? undefined, previousDueAt: current.dueAt ?? undefined }, requestId, createdAt: now });
    }
    return { kind: "ok", head: nextHead, version };
  });

  if (result.kind === "not_found") return operationsNotFoundResult();
  if (result.kind === "stale") return { ok: false, code: "stale_write", message: "This task was changed elsewhere. Reload and try again." };
  if (result.kind === "conflict") return { ok: false, code: "conflict", message: result.message };
  return { ok: true, data: toTaskDetailDto(result.head, result.version, result.version.createdAt) };
}

// --- Bounded scoped list (section 12/18) -----------------------------------------------------------
export async function listTasks(actor: ActorContext | null, rawQuery: unknown): Promise<OperationsServiceResult<{ tasks: TaskDto[] }>> {
  const access = await requireOperationsAccess(actor);
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = listTasksQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const query: ListTasksQuery = parsed.data;
  const limit = query.limit ?? DEFAULT_TASK_PAGE_SIZE;

  const grants = await getActorScopeGrants(actor!);
  const global = hasGlobalScope(grants);

  let heads: OperationsTaskHeadDoc[];
  if (query.targetType && query.targetRef) {
    heads = await listTaskHeadsByTarget(query.targetType, query.targetRef, query.status, limit);
  } else if (query.assigneeUserRef) {
    heads = await listTaskHeadsByAssignee(query.assigneeUserRef, query.status, limit);
  } else if (global) {
    heads = await listTaskHeadsBounded(query.status, limit);
  } else {
    // A non-global actor with neither an assignee nor a target filter sees their OWN assigned work
    // - never an unscoped scan (section 12/18: "Do not fetch whole collections").
    heads = await listTaskHeadsByAssignee(actor!.userRef, query.status, limit);
  }

  const now = new Date().toISOString();
  const scoped = heads.filter((head) => isOperationsRecordInScope(grants, actor!, { ownerUid: head.ownerUid, regionIds: head.regionIds, teamIds: head.teamIds, createdByUserRef: head.createdByUserRef }));
  const filtered = query.priority ? scoped.filter((head) => head.display.priority === query.priority) : scoped;
  return { ok: true, data: { tasks: filtered.slice(0, limit).map((head) => toTaskDetailDto(head, null, now)) } };
}

// --- System generation (section 5/8) ---------------------------------------------------------------
// Idempotent: a claim document keyed by sourceKey is read/created inside the SAME transaction as
// the Task itself, so two racing calls for the exact same source event always converge on the SAME
// taskRef - the second call is a no-op that returns the first one's Task, never a second Task.
export async function generateSystemTask(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<{ outcome: "created" | "existing"; task: TaskDto }>> {
  const access = await requireOperationsAccess(actor, "manage_tasks");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = generateSystemTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input: GenerateSystemTaskInput = parsed.data;

  const assignee = await requireAdmittedActiveUser(input.assigneeUserRef);
  if (!assignee.ok) return assignee.error;

  const existingClaim = await getTaskGenerationClaimDoc(input.sourceKey);
  if (existingClaim) {
    const existingHead = await getTaskHeadDoc(existingClaim.taskRef);
    if (existingHead) {
      const version = await getTaskVersionDoc(existingHead.taskRef, existingHead.latestVersion);
      return { ok: true, data: { outcome: "existing", task: toTaskDetailDto(existingHead, version, new Date().toISOString()) } };
    }
  }

  type Outcome = { kind: "ok"; head: OperationsTaskHeadDoc; version: TaskVersionDoc; outcome: "created" | "existing" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    const claim = await txGetTaskGenerationClaim(tx, input.sourceKey);
    if (claim) {
      const head = await txGetTaskHead(tx, claim.taskRef);
      if (head) {
        const version = await txGetTaskVersion(tx, claim.taskRef, head.latestVersion);
        if (version) return { kind: "ok", head, version, outcome: "existing" };
      }
    }

    const now = new Date().toISOString();
    const taskRef = generateTaskRef();
    const version: TaskVersionDoc = taskVersionDocSchema.parse({
      taskRef,
      version: 1,
      title: input.title,
      notes: input.notes ?? null,
      target: input.target,
      priority: input.priority ?? "NORMAL",
      dueAt: input.dueAt ?? null,
      changeKind: "created",
      reason: null,
      createdAt: now,
      createdByUserRef: actor!.userRef,
    });
    const head: OperationsTaskHeadDoc = {
      taskRef,
      docVersion: 1,
      target: input.target,
      assigneeUserRef: input.assigneeUserRef,
      createdByUserRef: actor!.userRef,
      origin: input.origin,
      sourceKey: input.sourceKey,
      ownerUid: assignee.uid,
      regionIds: [],
      teamIds: [],
      status: "OPEN",
      latestVersion: 1,
      startedAt: null,
      startedByUserRef: null,
      blockedAt: null,
      blockedByUserRef: null,
      blockedReason: null,
      doneAt: null,
      doneByUserRef: null,
      cancelledAt: null,
      cancelledByUserRef: null,
      cancelledReason: null,
      reopenedAt: null,
      reopenedByUserRef: null,
      display: buildDisplay({ title: input.title, priority: version.priority, status: "OPEN", dueAt: version.dueAt, projectedAt: now }),
      createdAt: now,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };

    txCreateTaskGenerationClaim(tx, taskGenerationClaimDocSchema.parse({ sourceKey: input.sourceKey, taskRef, createdAt: now }));
    txCreateTaskVersion(tx, version);
    txSetTaskHead(tx, head);
    appendTaskEvent(tx, taskRef, { kind: "TASK_CREATED", version: 1, actorUserRef: actor!.userRef, metadata: { targetType: input.target.targetType, targetRef: input.target.targetRef, priority: version.priority, origin: input.origin }, requestId, createdAt: now });
    return { kind: "ok", head, version, outcome: "created" };
  });

  return { ok: true, data: { outcome: result.outcome, task: toTaskDetailDto(result.head, result.version, result.version.createdAt) } };
}

export type { OperationsErrorResult };
export { listTaskVersionDocs };
