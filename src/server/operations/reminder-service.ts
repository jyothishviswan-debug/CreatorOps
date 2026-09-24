import type { ActorContext } from "@/server/authz/types";
import { getActorScopeGrants, hasGlobalScope } from "@/server/authz/scope";
import { getAdminFirestore } from "@/server/firebase/admin";

import { toReminderDto, toReminderEventDto, type ReminderDto, type ReminderEventDto } from "./client-dto";
import { resolveDisplayName, resolveDisplayNames } from "./display-names";
import {
  getReminderGenerationClaimDoc,
  getReminderHeadDoc,
  listReminderEventDocs,
  listReminderHeadsBounded,
  listReminderHeadsByRecipient,
  listReminderHeadsByTask,
  txCreateReminderGenerationClaim,
  txGetReminderGenerationClaim,
  txGetReminderHead,
  txSetReminderHead,
} from "./firestore";
import { generateReminderRef } from "./ids";
import { isOperationsRecordInScope, loadAuthorizedReminder, requireAdmittedActiveUser, requireOperationsAccess } from "./operations-gate";
import { appendReminderEvent } from "./reminder-events";
import { formatIssues } from "./task-service";
import {
  createReminderInputSchema,
  listRemindersQuerySchema,
  operationsInvalidInputResult,
  operationsUnauthorizedResult,
  reminderGenerationClaimDocSchema,
  DEFAULT_REMINDER_PAGE_SIZE,
  type ListRemindersQuery,
  type OperationsReminderHeadDoc,
  type OperationsServiceResult,
} from "./types";

// Step 18A: Reminder authoring - create (with the same deterministic-sourceKey idempotency
// discipline as generateSystemTask when a system origin is supplied), get, list/query. Reschedule/
// dismiss/complete/cancel live in reminder-lifecycle-service.ts.

export async function createReminder(actor: ActorContext | null, rawInput: unknown, requestId: string): Promise<OperationsServiceResult<{ outcome: "created" | "existing"; reminder: ReminderDto }>> {
  const access = await requireOperationsAccess(actor, "manage_reminders");
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = createReminderInputSchema.safeParse(rawInput);
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const input = parsed.data;

  const recipient = await requireAdmittedActiveUser(input.recipientUserRef);
  if (!recipient.ok) return recipient.error;

  const now = new Date().toISOString();

  if (input.sourceKey) {
    const existingClaim = await getReminderGenerationClaimDoc(input.sourceKey);
    if (existingClaim) {
      const existingHead = await getReminderHeadDoc(existingClaim.reminderRef);
      if (existingHead) return { ok: true, data: { outcome: "existing", reminder: toReminderDto(existingHead, now, await resolveDisplayName(existingHead.recipientUserRef)) } };
    }
  }

  type Outcome = { kind: "ok"; head: OperationsReminderHeadDoc; outcome: "created" | "existing" };
  const result = await getAdminFirestore().runTransaction<Outcome>(async (tx) => {
    if (input.sourceKey) {
      const claim = await txGetReminderGenerationClaim(tx, input.sourceKey);
      if (claim) {
        const head = await txGetReminderHead(tx, claim.reminderRef);
        if (head) return { kind: "ok", head, outcome: "existing" };
      }
    }

    const reminderRef = generateReminderRef();
    const head: OperationsReminderHeadDoc = {
      reminderRef,
      docVersion: 1,
      target: input.target,
      taskRef: input.taskRef ?? null,
      approvalItemRef: input.approvalItemRef ?? null,
      recipientUserRef: input.recipientUserRef,
      createdByUserRef: actor!.userRef,
      origin: input.origin ?? "MANUAL",
      sourceKey: input.sourceKey ?? null,
      ownerUid: recipient.uid,
      regionIds: input.regionIds ?? [],
      teamIds: input.teamIds ?? [],
      message: input.message,
      reminderAt: input.reminderAt,
      status: "SCHEDULED",
      dismissedAt: null,
      dismissedByUserRef: null,
      completedAt: null,
      completedByUserRef: null,
      cancelledAt: null,
      cancelledByUserRef: null,
      cancelledReason: null,
      rescheduleCount: 0,
      createdAt: now,
      updatedAt: now,
      updatedByUserRef: actor!.userRef,
    };

    if (input.sourceKey) txCreateReminderGenerationClaim(tx, reminderGenerationClaimDocSchema.parse({ sourceKey: input.sourceKey, reminderRef, createdAt: now }));
    txSetReminderHead(tx, head);
    appendReminderEvent(tx, reminderRef, { kind: "REMINDER_CREATED", actorUserRef: actor!.userRef, metadata: { origin: head.origin, reminderAt: head.reminderAt, taskRef: head.taskRef ?? undefined, approvalItemRef: head.approvalItemRef ?? undefined }, requestId, createdAt: now });
    return { kind: "ok", head, outcome: "created" };
  });

  return { ok: true, data: { outcome: result.outcome, reminder: toReminderDto(result.head, now, await resolveDisplayName(result.head.recipientUserRef)) } };
}

export async function getReminder(actor: ActorContext | null, rawReminderRef: unknown): Promise<OperationsServiceResult<ReminderDto>> {
  const loaded = await loadAuthorizedReminder(actor, typeof rawReminderRef === "string" ? rawReminderRef : "");
  if (!loaded.ok) return loaded.error;
  const { head } = loaded.authorized;
  return { ok: true, data: toReminderDto(head, new Date().toISOString(), await resolveDisplayName(head.recipientUserRef)) };
}

export async function listReminderEvents(actor: ActorContext | null, rawReminderRef: unknown, rawLimit?: unknown): Promise<OperationsServiceResult<{ events: ReminderEventDto[]; hasMore: boolean }>> {
  const loaded = await loadAuthorizedReminder(actor, typeof rawReminderRef === "string" ? rawReminderRef : "");
  if (!loaded.ok) return loaded.error;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) ? rawLimit : undefined;
  const page = await listReminderEventDocs(loaded.authorized.head.reminderRef, limit);
  return { ok: true, data: { events: page.events.map(toReminderEventDto), hasMore: page.hasMore } };
}

export async function listReminders(actor: ActorContext | null, rawQuery: unknown): Promise<OperationsServiceResult<{ reminders: ReminderDto[] }>> {
  const access = await requireOperationsAccess(actor);
  if (!access.ok) return operationsUnauthorizedResult(access.reason);

  const parsed = listRemindersQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return operationsInvalidInputResult(formatIssues(parsed.error));
  const query: ListRemindersQuery = parsed.data;
  const limit = query.limit ?? DEFAULT_REMINDER_PAGE_SIZE;

  const grants = await getActorScopeGrants(actor!);
  const global = hasGlobalScope(grants);

  let heads: OperationsReminderHeadDoc[];
  if (query.taskRef) heads = await listReminderHeadsByTask(query.taskRef, query.status, limit);
  else if (query.recipientUserRef) heads = await listReminderHeadsByRecipient(query.recipientUserRef, query.status, limit);
  else if (global) heads = await listReminderHeadsBounded(query.status, limit);
  else heads = await listReminderHeadsByRecipient(actor!.userRef, query.status, limit);

  const now = new Date().toISOString();
  const scoped = heads.filter((head) => isOperationsRecordInScope(grants, actor!, { ownerUid: head.ownerUid, regionIds: head.regionIds, teamIds: head.teamIds, createdByUserRef: head.createdByUserRef }));
  const filtered = query.dueOnly ? scoped.filter((head) => head.status === "SCHEDULED" && head.reminderAt <= now) : scoped;
  const page = filtered.slice(0, limit);
  const displayNames = await resolveDisplayNames(page.map((head) => head.recipientUserRef));
  return { ok: true, data: { reminders: page.map((head) => toReminderDto(head, now, displayNames.get(head.recipientUserRef) ?? null)) } };
}
