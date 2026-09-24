import { z } from "zod";

import { targetReferenceSchema } from "./target-ref";

// Step 18A: the canonical Operations Tasks + Reminders domain.
//
// Shapes follow the same head/version/event discipline every Finance module already established
// (src/server/finance-payments/types.ts is the closest structural analog): one HEAD carrying only
// current workflow / indexable projection fields, an append-only chain of numbered, IMMUTABLE
// VERSIONS carrying the declared Task content, and an append-only event history. A Reminder is
// simpler (no competing "declared content vs money" distinction to version) - it carries its own
// mutable-by-explicit-action head plus an append-only event history, no versions subcollection.
//
// Hard rule encoded here (section 3/6): Operations never persists a second, competing status for a
// Campaign/Assignment/Content/Partner-Review/Agreement/Payable/Invoice/Payment. Nothing in this
// file represents any of those modules' own lifecycle states - only the bounded TargetReference
// (target-ref.ts) a Task/Reminder may point AT, and (in approval-queue/types.ts, deliberately a
// separate file) a READ-ONLY projection of a pending action already decided by its own authoritative
// module.

const isoTimestamp = z.string().min(1);
const nonEmpty = z.string().min(1);
const refString = z.string().min(1).max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);

// --- Task lifecycle / priority / origin (section 5) ---------------------------------------------
export const TASK_STATUSES = ["OPEN", "IN_PROGRESS", "BLOCKED", "DONE", "CANCELLED"] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

// Origin/source (section 5): where a Task came from. MODULE_ACTION/APPROVAL_FOLLOW_UP/
// REMINDER_GENERATED Tasks are always created through generateSystemTask with a deterministic
// sourceKey (section 5: "Generated Tasks must use deterministic/idempotent source keys") - never
// hand-authored with these origins.
export const TASK_ORIGINS = ["MANUAL", "MODULE_ACTION", "APPROVAL_FOLLOW_UP", "REMINDER_GENERATED"] as const;
export const taskOriginSchema = z.enum(TASK_ORIGINS);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;

export const MAX_TASK_VERSIONS = 500;

// --- Version document (operationsTasks/{taskRef}/versions/{n}) ----------------------------------
// IMMUTABLE. Created with tx.create and never rewritten - every change (a revision, a reopen) opens
// the NEXT version, exactly like every Finance module's own version discipline.
export const TASK_VERSION_CHANGE_KINDS = ["created", "revised", "reopened"] as const;
export const taskVersionChangeKindSchema = z.enum(TASK_VERSION_CHANGE_KINDS);
export type TaskVersionChangeKind = z.infer<typeof taskVersionChangeKindSchema>;

export const taskVersionDocSchema = z
  .object({
    taskRef: nonEmpty,
    version: z.number().int().min(1).max(MAX_TASK_VERSIONS),
    title: shortText(200),
    notes: shortText(4000).nullable(),
    target: targetReferenceSchema,
    priority: taskPrioritySchema,
    dueAt: isoTimestamp.nullable(),
    changeKind: taskVersionChangeKindSchema,
    reason: shortText(1000).nullable(),
    createdAt: isoTimestamp,
    createdByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (doc.version === 1 && doc.changeKind !== "created") issue("changeKind", "Version 1 is the creation.");
    if (doc.version > 1 && doc.changeKind === "created") issue("changeKind", "Only version 1 is the creation.");
  });
export type TaskVersionDoc = z.infer<typeof taskVersionDocSchema>;

// --- Head list projection --------------------------------------------------------------------------
export const taskHeadDisplaySchema = z.object({ title: shortText(200), titleLower: shortText(200), priority: taskPrioritySchema, status: taskStatusSchema, dueAt: isoTimestamp.nullable(), projectedAt: isoTimestamp }).strict();
export type TaskHeadDisplay = z.infer<typeof taskHeadDisplaySchema>;

// --- Head document (operationsTasks/{taskRef}) --------------------------------------------------
// Record Scope (section 9): a Task's own scope, NOT derived live from its target (the target may
// live in any of eleven different modules, each with its own scope shape - see operations-gate.ts's
// own comment for why deriving it live from the target is deliberately out of scope for this step).
// `ownerUid` is the PRIMARY ASSIGNEE's uid (the actor whose SELF grant should always see their own
// work) - regionIds/teamIds are explicit, settable dimensions, exactly like Partners'/Vendors' own
// scope fields (never inferred from the target or the creator).
export const operationsTaskHeadDocSchema = z
  .object({
    taskRef: nonEmpty,
    docVersion: z.number().int().min(1),

    target: targetReferenceSchema,
    assigneeUserRef: nonEmpty,
    createdByUserRef: nonEmpty,
    origin: taskOriginSchema,
    // Present only for a system-generated Task (section 8) - the deterministic key that makes
    // generation idempotent. Null for MANUAL Tasks.
    sourceKey: nonEmpty.nullable().default(null),

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),

    status: taskStatusSchema,
    latestVersion: z.number().int().min(1).max(MAX_TASK_VERSIONS),

    startedAt: isoTimestamp.nullable().default(null),
    startedByUserRef: nonEmpty.nullable().default(null),
    blockedAt: isoTimestamp.nullable().default(null),
    blockedByUserRef: nonEmpty.nullable().default(null),
    blockedReason: shortText(1000).nullable().default(null),
    doneAt: isoTimestamp.nullable().default(null),
    doneByUserRef: nonEmpty.nullable().default(null),
    cancelledAt: isoTimestamp.nullable().default(null),
    cancelledByUserRef: nonEmpty.nullable().default(null),
    cancelledReason: shortText(1000).nullable().default(null),
    reopenedAt: isoTimestamp.nullable().default(null),
    reopenedByUserRef: nonEmpty.nullable().default(null),

    display: taskHeadDisplaySchema,

    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.status === "BLOCKED" && (head.blockedAt === null || head.blockedByUserRef === null || head.blockedReason === null)) issue("blockedReason", "A blocked task records when, by whom and why.");
    if (head.status !== "BLOCKED" && head.blockedReason !== null && head.status !== "DONE" && head.status !== "CANCELLED") issue("blockedReason", "Only a blocked (or previously-blocked, now closed) task carries a block reason.");
    if (head.status === "DONE" && (head.doneAt === null || head.doneByUserRef === null)) issue("doneAt", "A done task records when and by whom.");
    if (head.status === "CANCELLED" && (head.cancelledAt === null || head.cancelledByUserRef === null || head.cancelledReason === null)) issue("cancelledReason", "A cancelled task records when, by whom and why.");
    if ((head.origin === "MODULE_ACTION" || head.origin === "APPROVAL_FOLLOW_UP" || head.origin === "REMINDER_GENERATED") && head.sourceKey === null) issue("sourceKey", "A system-generated task always carries its deterministic source key.");
    if (head.origin === "MANUAL" && head.sourceKey !== null) issue("sourceKey", "A manually-created task never carries a source key.");
  });
export type OperationsTaskHeadDoc = z.infer<typeof operationsTaskHeadDocSchema>;

// --- Idempotency claim (operationsTaskGenerationClaims/{sourceKey}) - section 8 -------------------
// One claim per deterministic sourceKey: guards against two racing "generate the follow-up Task for
// this exact source event" calls creating two different Task heads. Mirrors
// financePaymentReferenceClaims's own "claim doc read/created inside the SAME transaction as the
// record it protects" shape.
export const taskGenerationClaimDocSchema = z.object({ sourceKey: nonEmpty, taskRef: nonEmpty, createdAt: isoTimestamp }).strict();
export type TaskGenerationClaimDoc = z.infer<typeof taskGenerationClaimDocSchema>;

// --- Append-only event history (operationsTasks/{taskRef}/events/{eventId}) ----------------------
export const TASK_EVENT_KINDS = [
  "TASK_CREATED",
  "TASK_REVISED",
  "TASK_ASSIGNED",
  "TASK_REASSIGNED",
  "TASK_STARTED",
  "TASK_BLOCKED",
  "TASK_UNBLOCKED",
  "TASK_COMPLETED",
  "TASK_REOPENED",
  "TASK_CANCELLED",
  "TASK_DUE_DATE_CHANGED",
  "TASK_PRIORITY_CHANGED",
] as const;
export const taskEventKindSchema = z.enum(TASK_EVENT_KINDS);
export type TaskEventKind = z.infer<typeof taskEventKindSchema>;

export const taskEventSchema = z
  .object({
    kind: taskEventKindSchema,
    version: z.number().int().min(1),
    actorUserRef: nonEmpty,
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

// --- Result/error plumbing - same shape family as every Finance module's own ----------------------
export type OperationsDenialReason = "not_authenticated" | "feature_denied" | "action_denied" | "scope_denied";

export type OperationsServiceErrorCode = "unauthorized" | "not_found" | "invalid_input" | "stale_write" | "not_ready" | "conflict" | "internal";

export type OperationsReadinessIssue = { code: string; message: string };

export type OperationsServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: OperationsServiceErrorCode; message: string; reason?: OperationsDenialReason; blockers?: OperationsReadinessIssue[] };

export type OperationsErrorResult = Extract<OperationsServiceResult<unknown>, { ok: false }>;

export function operationsUnauthorizedResult(reason: OperationsDenialReason): OperationsErrorResult {
  return { ok: false, code: "unauthorized", message: `Operations access denied (${reason}).`, reason };
}

export function operationsInvalidInputResult(message: string): OperationsErrorResult {
  return { ok: false, code: "invalid_input", message };
}

export const NEUTRAL_NOT_FOUND_MESSAGE = "Not found.";
export function operationsNotFoundResult(message: string = NEUTRAL_NOT_FOUND_MESSAGE): OperationsErrorResult {
  return { ok: false, code: "not_found", message };
}

export function operationsStaleResult(message = "This record was changed elsewhere. Reload and try again."): OperationsErrorResult {
  return { ok: false, code: "stale_write", message };
}

export function operationsConflictResult(message: string): OperationsErrorResult {
  return { ok: false, code: "conflict", message };
}

export function operationsNotReadyResult(message: string, blockers: OperationsReadinessIssue[]): OperationsErrorResult {
  return { ok: false, code: "not_ready", message, blockers };
}

export function operationsInternalResult(message = "Something went wrong."): OperationsErrorResult {
  return { ok: false, code: "internal", message };
}

// --- Strict command INPUT schemas ------------------------------------------------------------------
export const taskRefSchema = z.string().regex(/^tsk_[0-9a-f]{20}$/, "Invalid task reference.");
const expectedDocVersionSchema = z.number().int().min(1);
const reasonSchema = z.string().trim().min(3).max(1000);

export const createTaskInputSchema = z
  .object({
    title: shortText(200),
    notes: shortText(4000).nullable().optional(),
    target: targetReferenceSchema,
    assigneeUserRef: nonEmpty,
    priority: taskPrioritySchema.optional(),
    dueAt: isoTimestamp.nullable().optional(),
    regionIds: z.array(nonEmpty).max(50).optional(),
    teamIds: z.array(nonEmpty).max(50).optional(),
  })
  .strict();
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const taskRefParamsSchema = z.object({ taskRef: taskRefSchema }).strict();

export const reviseTaskInputSchema = z
  .object({
    taskRef: taskRefSchema,
    expectedDocVersion: expectedDocVersionSchema,
    title: shortText(200).optional(),
    notes: shortText(4000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    dueAt: isoTimestamp.nullable().optional(),
    reason: reasonSchema,
  })
  .strict();
export type ReviseTaskInput = z.infer<typeof reviseTaskInputSchema>;

export const reassignTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema, assigneeUserRef: nonEmpty, reason: reasonSchema }).strict();
export type ReassignTaskInput = z.infer<typeof reassignTaskInputSchema>;

export const startTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type StartTaskInput = z.infer<typeof startTaskInputSchema>;

export const blockTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type BlockTaskInput = z.infer<typeof blockTaskInputSchema>;

export const unblockTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type UnblockTaskInput = z.infer<typeof unblockTaskInputSchema>;

export const completeTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

export const reopenTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type ReopenTaskInput = z.infer<typeof reopenTaskInputSchema>;

export const cancelTaskInputSchema = z.object({ taskRef: taskRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type CancelTaskInput = z.infer<typeof cancelTaskInputSchema>;

export const MAX_TASK_PAGE_SIZE = 100;
export const DEFAULT_TASK_PAGE_SIZE = 25;

export const listTasksQuerySchema = z
  .object({
    status: taskStatusSchema.optional(),
    assigneeUserRef: nonEmpty.optional(),
    targetType: targetReferenceSchema.shape.targetType.optional(),
    targetRef: refString.optional(),
    priority: taskPrioritySchema.optional(),
    limit: z.number().int().min(1).max(MAX_TASK_PAGE_SIZE).optional(),
    cursor: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// The one system-generation entry point (section 5/8): a deterministic sourceKey plus the same
// declared content a manual Task would carry. Never called with origin "MANUAL".
export const generateSystemTaskInputSchema = z
  .object({
    origin: z.enum(["MODULE_ACTION", "APPROVAL_FOLLOW_UP", "REMINDER_GENERATED"]),
    sourceKey: nonEmpty.max(300),
    title: shortText(200),
    notes: shortText(4000).nullable().optional(),
    target: targetReferenceSchema,
    assigneeUserRef: nonEmpty,
    priority: taskPrioritySchema.optional(),
    dueAt: isoTimestamp.nullable().optional(),
  })
  .strict();
export type GenerateSystemTaskInput = z.infer<typeof generateSystemTaskInputSchema>;

// ==================================================================================================
// Reminders (section 7)
// ==================================================================================================

// The PERSISTED status. DUE is deliberately absent (see lifecycle.ts's own comment) - it is a
// read-time overlay computed by deriveReminderEffectiveStatus, never written to Firestore.
export const REMINDER_STATUSES = ["SCHEDULED", "DISMISSED", "COMPLETED", "CANCELLED"] as const;
export const reminderStatusSchema = z.enum(REMINDER_STATUSES);
export type ReminderStatus = z.infer<typeof reminderStatusSchema>;

// The EFFECTIVE status a client actually sees (section 7's full five-state lifecycle) - SCHEDULED
// overlaid with DUE once `reminderAt` has passed, computed purely from already-loaded fields, never
// stored.
export const REMINDER_EFFECTIVE_STATUSES = ["SCHEDULED", "DUE", "DISMISSED", "COMPLETED", "CANCELLED"] as const;
export const reminderEffectiveStatusSchema = z.enum(REMINDER_EFFECTIVE_STATUSES);
export type ReminderEffectiveStatus = z.infer<typeof reminderEffectiveStatusSchema>;

export const REMINDER_ORIGINS = ["MANUAL", "MODULE_ACTION", "APPROVAL_FOLLOW_UP", "TASK_DUE_FOLLOW_UP"] as const;
export const reminderOriginSchema = z.enum(REMINDER_ORIGINS);
export type ReminderOrigin = z.infer<typeof reminderOriginSchema>;

export const operationsReminderHeadDocSchema = z
  .object({
    reminderRef: nonEmpty,
    docVersion: z.number().int().min(1),

    target: targetReferenceSchema,
    taskRef: nonEmpty.nullable().default(null),
    // An opaque key identifying the Approval Queue item this Reminder is about, when relevant -
    // NEVER a second copy of that item's own approval status (see approval-queue/types.ts). Purely
    // a linking handle for display/deep-link purposes.
    approvalItemRef: nonEmpty.nullable().default(null),

    recipientUserRef: nonEmpty,
    createdByUserRef: nonEmpty,
    origin: reminderOriginSchema,
    sourceKey: nonEmpty.nullable().default(null),

    ownerUid: nonEmpty.nullable().default(null),
    regionIds: z.array(nonEmpty).max(50).default([]),
    teamIds: z.array(nonEmpty).max(50).default([]),

    message: shortText(1000),
    reminderAt: isoTimestamp,

    status: reminderStatusSchema,

    dismissedAt: isoTimestamp.nullable().default(null),
    dismissedByUserRef: nonEmpty.nullable().default(null),
    completedAt: isoTimestamp.nullable().default(null),
    completedByUserRef: nonEmpty.nullable().default(null),
    cancelledAt: isoTimestamp.nullable().default(null),
    cancelledByUserRef: nonEmpty.nullable().default(null),
    cancelledReason: shortText(1000).nullable().default(null),
    rescheduleCount: z.number().int().min(0).default(0),

    createdAt: isoTimestamp,
    updatedAt: isoTimestamp,
    updatedByUserRef: nonEmpty,
  })
  .strict()
  .superRefine((head, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (head.status === "DISMISSED" && (head.dismissedAt === null || head.dismissedByUserRef === null)) issue("dismissedAt", "A dismissed reminder records when and by whom.");
    if (head.status === "COMPLETED" && (head.completedAt === null || head.completedByUserRef === null)) issue("completedAt", "A completed reminder records when and by whom.");
    if (head.status === "CANCELLED" && (head.cancelledAt === null || head.cancelledByUserRef === null || head.cancelledReason === null)) issue("cancelledReason", "A cancelled reminder records when, by whom and why.");
  });
export type OperationsReminderHeadDoc = z.infer<typeof operationsReminderHeadDocSchema>;

// One claim per deterministic sourceKey (section 8: "one Reminder per task/source + recipient +
// reminderAt") - mirrors taskGenerationClaimDocSchema exactly.
export const reminderGenerationClaimDocSchema = z.object({ sourceKey: nonEmpty, reminderRef: nonEmpty, createdAt: isoTimestamp }).strict();
export type ReminderGenerationClaimDoc = z.infer<typeof reminderGenerationClaimDocSchema>;

export const REMINDER_EVENT_KINDS = ["REMINDER_CREATED", "REMINDER_RESCHEDULED", "REMINDER_DISMISSED", "REMINDER_COMPLETED", "REMINDER_CANCELLED"] as const;
export const reminderEventKindSchema = z.enum(REMINDER_EVENT_KINDS);
export type ReminderEventKind = z.infer<typeof reminderEventKindSchema>;

export const reminderEventSchema = z
  .object({
    kind: reminderEventKindSchema,
    actorUserRef: nonEmpty,
    metadata: z.record(z.string(), z.unknown()).nullable(),
    requestId: nonEmpty,
    createdAt: isoTimestamp,
  })
  .strict();
export type ReminderEvent = z.infer<typeof reminderEventSchema>;

export const reminderRefSchema = z.string().regex(/^rmd_[0-9a-f]{20}$/, "Invalid reminder reference.");

export const createReminderInputSchema = z
  .object({
    target: targetReferenceSchema,
    taskRef: taskRefSchema.nullable().optional(),
    approvalItemRef: nonEmpty.nullable().optional(),
    recipientUserRef: nonEmpty,
    message: shortText(1000),
    reminderAt: isoTimestamp,
    regionIds: z.array(nonEmpty).max(50).optional(),
    teamIds: z.array(nonEmpty).max(50).optional(),
    // Present only for a system-generated Reminder; omitted (undefined) for a manual one.
    origin: z.enum(["MODULE_ACTION", "APPROVAL_FOLLOW_UP", "TASK_DUE_FOLLOW_UP"]).optional(),
    sourceKey: nonEmpty.max(300).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if ((input.origin !== undefined) !== (input.sourceKey !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["sourceKey"], message: "A system origin and a source key are always supplied together." });
    }
  });
export type CreateReminderInput = z.infer<typeof createReminderInputSchema>;

export const reminderRefParamsSchema = z.object({ reminderRef: reminderRefSchema }).strict();

export const rescheduleReminderInputSchema = z.object({ reminderRef: reminderRefSchema, expectedDocVersion: expectedDocVersionSchema, reminderAt: isoTimestamp, reason: reasonSchema.optional() }).strict();
export type RescheduleReminderInput = z.infer<typeof rescheduleReminderInputSchema>;

export const dismissReminderInputSchema = z.object({ reminderRef: reminderRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type DismissReminderInput = z.infer<typeof dismissReminderInputSchema>;

export const completeReminderInputSchema = z.object({ reminderRef: reminderRefSchema, expectedDocVersion: expectedDocVersionSchema }).strict();
export type CompleteReminderInput = z.infer<typeof completeReminderInputSchema>;

export const cancelReminderInputSchema = z.object({ reminderRef: reminderRefSchema, expectedDocVersion: expectedDocVersionSchema, reason: reasonSchema }).strict();
export type CancelReminderInput = z.infer<typeof cancelReminderInputSchema>;

export const MAX_REMINDER_PAGE_SIZE = 100;
export const DEFAULT_REMINDER_PAGE_SIZE = 25;

export const listRemindersQuerySchema = z
  .object({
    status: reminderStatusSchema.optional(),
    recipientUserRef: nonEmpty.optional(),
    taskRef: taskRefSchema.optional(),
    dueOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_REMINDER_PAGE_SIZE).optional(),
    cursor: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type ListRemindersQuery = z.infer<typeof listRemindersQuerySchema>;
