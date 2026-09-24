import { canTransitionLifecycle, REMINDER_LIFECYCLE_TRANSITIONS } from "@/server/authz/lifecycle";
import type { ActorContext } from "@/server/authz/types";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toReminderDto, type ReminderDto } from "./client-dto";
import { txGetReminderHead, txSetReminderHead } from "./firestore";
import { loadAuthorizedReminder, requireOperationsAccess } from "./operations-gate";
import { appendReminderEvent } from "./reminder-events";
import { formatIssues } from "./task-service";
import {
  cancelReminderInputSchema,
  completeReminderInputSchema,
  dismissReminderInputSchema,
  operationsConflictResult,
  operationsInvalidInputResult,
  operationsNotFoundResult,
  operationsStaleResult,
  operationsUnauthorizedResult,
  rescheduleReminderInputSchema,
  type OperationsReminderHeadDoc,
  type OperationsServiceResult,
} from "./types";

// Step 18A: Reminder lifecycle transitions (section 7/13/14). A due Reminder never approves,
// completes, pays or mutates any source record (section 7's own explicit rule) - every function
// here writes ONLY this module's own operationsReminders collection, nothing else. Section 13's
// "reschedule vs dismiss" race is resolved by the same optimistic-concurrency docVersion precondition
// every other lifecycle writer in this codebase uses: whichever transaction commits first wins, the
// loser reports stale_write.

type Failure = { kind: "not_found" } | { kind: "stale" } | { kind: "conflict"; message: string };
function failureResult(failure: Failure) {
  if (failure.kind === "not_found") return operationsNotFoundResult();
  if (failure.kind === "stale") return operationsStaleResult();
  return operationsConflictResult(failure.message);
}
type OkResult = { kind: "ok"; head: OperationsReminderHeadDoc };

export async function rescheduleReminder(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<ReminderDto>> {
  const access = await requireOperationsAccess(actor, "manage_reminders");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = rescheduleReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedReminder(actor, input.reminderRef, "manage_reminders");
  if (!loaded.ok) return loaded.error;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetReminderHead(tx, input.reminderRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (head.status !== "SCHEDULED") return { kind: "conflict", message: "Only a scheduled (or due) reminder can be rescheduled." };

    const now = new Date().toISOString();
    const previousReminderAt = head.reminderAt;
    const nextHead: OperationsReminderHeadDoc = { ...head, reminderAt: input.reminderAt, rescheduleCount: head.rescheduleCount + 1, docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetReminderHead(tx, nextHead);
    appendReminderEvent(tx, head.reminderRef, { kind: "REMINDER_RESCHEDULED", actorUserRef: actor!.userRef, metadata: { reminderAt: input.reminderAt, previousReminderAt, rescheduleCount: nextHead.rescheduleCount, reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: toReminderDto(result.head, new Date().toISOString()) };
}

export async function dismissReminder(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<ReminderDto>> {
  const access = await requireOperationsAccess(actor, "manage_reminders");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = dismissReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedReminder(actor, input.reminderRef, "manage_reminders");
  if (!loaded.ok) return loaded.error;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetReminderHead(tx, input.reminderRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "DISMISSED", REMINDER_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a scheduled (or due) reminder can be dismissed." };

    const now = new Date().toISOString();
    const nextHead: OperationsReminderHeadDoc = { ...head, status: "DISMISSED", dismissedAt: now, dismissedByUserRef: actor!.userRef, docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetReminderHead(tx, nextHead);
    appendReminderEvent(tx, head.reminderRef, { kind: "REMINDER_DISMISSED", actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "DISMISSED" }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: toReminderDto(result.head, new Date().toISOString()) };
}

export async function completeReminder(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<ReminderDto>> {
  const access = await requireOperationsAccess(actor, "manage_reminders");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = completeReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedReminder(actor, input.reminderRef, "manage_reminders");
  if (!loaded.ok) return loaded.error;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetReminderHead(tx, input.reminderRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "COMPLETED", REMINDER_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a scheduled (or due) reminder can be completed." };

    const now = new Date().toISOString();
    const nextHead: OperationsReminderHeadDoc = { ...head, status: "COMPLETED", completedAt: now, completedByUserRef: actor!.userRef, docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetReminderHead(tx, nextHead);
    appendReminderEvent(tx, head.reminderRef, { kind: "REMINDER_COMPLETED", actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "COMPLETED" }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: toReminderDto(result.head, new Date().toISOString()) };
}

export async function cancelReminder(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<ReminderDto>> {
  const access = await requireOperationsAccess(actor, "manage_reminders");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);
  const parsed = cancelReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;
  const loaded = await loadAuthorizedReminder(actor, input.reminderRef, "manage_reminders");
  if (!loaded.ok) return loaded.error;

  const result = await getAdminFirestore().runTransaction<OkResult | Failure>(async (tx) => {
    const head = await txGetReminderHead(tx, input.reminderRef);
    if (!head) return { kind: "not_found" };
    if (head.docVersion !== input.expectedDocVersion) return { kind: "stale" };
    if (!canTransitionLifecycle(head.status, "CANCELLED", REMINDER_LIFECYCLE_TRANSITIONS)) return { kind: "conflict", message: "Only a scheduled (or due) reminder can be cancelled." };

    const now = new Date().toISOString();
    const nextHead: OperationsReminderHeadDoc = { ...head, status: "CANCELLED", cancelledAt: now, cancelledByUserRef: actor!.userRef, cancelledReason: input.reason, docVersion: head.docVersion + 1, updatedAt: now, updatedByUserRef: actor!.userRef };
    txSetReminderHead(tx, nextHead);
    appendReminderEvent(tx, head.reminderRef, { kind: "REMINDER_CANCELLED", actorUserRef: actor!.userRef, metadata: { fromStatus: head.status, toStatus: "CANCELLED", reason: input.reason }, requestId, createdAt: now });
    return { kind: "ok", head: nextHead };
  });

  if (result.kind !== "ok") return failureResult(result);
  return { ok: true, data: toReminderDto(result.head, new Date().toISOString()) };
}
