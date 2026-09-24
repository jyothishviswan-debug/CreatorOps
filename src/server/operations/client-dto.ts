import type { TargetReference } from "./target-ref";
import type {
  OperationsReminderHeadDoc,
  OperationsTaskHeadDoc,
  ReminderEffectiveStatus,
  ReminderEvent,
  TaskEvent,
  TaskEventKind,
  TaskOrigin,
  TaskPriority,
  TaskStatus,
  TaskVersionDoc,
} from "./types";

// Step 18A: the only shapes of a Task/Reminder ever handed to the browser. No Firestore doc ids
// beyond the opaque taskRef/reminderRef, no raw Firebase uid anywhere (only userRefs), and no scope
// snapshot fields (ownerUid/regionIds/teamIds stay server-side) - same discipline as
// src/server/finance-payments/client-dto.ts.

export type TaskDto = {
  taskRef: string;
  title: string;
  notes: string | null;
  target: TargetReference;
  assigneeUserRef: string;
  // Resolved by the SERVICE layer (never here - see this file's own "never imports Firestore, the
  // gate, or any business module's internals" boundary, proved by operations-static.test.ts) from
  // assigneeUserRef via the same safe users/{uid} displayName every other module's own
  // ownerDisplayName/partnerDisplayName field already resolves (see e.g. CampaignDto). Null only
  // when the lookup itself fails (a since-removed user) - the UI falls back to the raw ref.
  assigneeDisplayName: string | null;
  createdByUserRef: string;
  origin: TaskOrigin;
  priority: TaskPriority;
  status: TaskStatus;
  dueAt: string | null;
  // Derived, never stored (section 5: "Overdue is derived, not priority").
  isOverdue: boolean;
  latestVersion: number;
  docVersion: number;
  blockedReason: string | null;
  cancelledReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskEventDto = { kind: TaskEventKind; version: number; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

export function isTaskOverdue(head: Pick<OperationsTaskHeadDoc, "status" | "display">, nowIso: string): boolean {
  if (head.display.dueAt === null) return false;
  if (head.status === "DONE" || head.status === "CANCELLED") return false;
  return head.display.dueAt < nowIso;
}

export function toTaskDto(head: OperationsTaskHeadDoc, nowIso: string, assigneeDisplayName: string | null = null): TaskDto {
  return {
    taskRef: head.taskRef,
    title: head.display.title,
    notes: null,
    target: head.target,
    assigneeUserRef: head.assigneeUserRef,
    assigneeDisplayName,
    createdByUserRef: head.createdByUserRef,
    origin: head.origin,
    priority: head.display.priority,
    status: head.status,
    dueAt: head.display.dueAt,
    isOverdue: isTaskOverdue(head, nowIso),
    latestVersion: head.latestVersion,
    docVersion: head.docVersion,
    blockedReason: head.blockedReason,
    cancelledReason: head.cancelledReason,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  };
}

export function toTaskDetailDto(head: OperationsTaskHeadDoc, version: TaskVersionDoc | null, nowIso: string, assigneeDisplayName: string | null = null): TaskDto {
  const base = toTaskDto(head, nowIso, assigneeDisplayName);
  return { ...base, notes: version?.notes ?? null };
}

export function toTaskEventDto(event: TaskEvent): TaskEventDto {
  return { kind: event.kind, version: event.version, actorUserRef: event.actorUserRef, metadata: event.metadata, createdAt: event.createdAt };
}

// --- Reminders --------------------------------------------------------------------------------
export type ReminderDto = {
  reminderRef: string;
  target: TargetReference;
  taskRef: string | null;
  approvalItemRef: string | null;
  recipientUserRef: string;
  // Same resolved-by-the-service-layer discipline as TaskDto.assigneeDisplayName above.
  recipientDisplayName: string | null;
  message: string;
  reminderAt: string;
  status: ReminderEffectiveStatus;
  docVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type ReminderEventDto = { kind: string; actorUserRef: string; metadata: Record<string, unknown> | null; createdAt: string };

// Section 7/9: DUE is derived at query time from already-loaded fields, never stored and never
// itself a trigger for any mutation (a due Reminder never approves/completes/pays/mutates a source
// record - this function performs no write, ever).
export function deriveReminderEffectiveStatus(head: Pick<OperationsReminderHeadDoc, "status" | "reminderAt">, nowIso: string): ReminderEffectiveStatus {
  if (head.status === "SCHEDULED" && head.reminderAt <= nowIso) return "DUE";
  return head.status;
}

export function toReminderDto(head: OperationsReminderHeadDoc, nowIso: string, recipientDisplayName: string | null = null): ReminderDto {
  return {
    reminderRef: head.reminderRef,
    target: head.target,
    taskRef: head.taskRef,
    approvalItemRef: head.approvalItemRef,
    recipientUserRef: head.recipientUserRef,
    recipientDisplayName,
    message: head.message,
    reminderAt: head.reminderAt,
    status: deriveReminderEffectiveStatus(head, nowIso),
    docVersion: head.docVersion,
    createdAt: head.createdAt,
    updatedAt: head.updatedAt,
  };
}

export function toReminderEventDto(event: ReminderEvent): ReminderEventDto {
  return { kind: event.kind, actorUserRef: event.actorUserRef, metadata: event.metadata, createdAt: event.createdAt };
}

// --- Permissions --------------------------------------------------------------------------------
export type OperationsPermissionsDto = {
  canView: boolean;
  canManageTasks: boolean;
  canAssignTasks: boolean;
  canCompleteTasks: boolean;
  canViewApprovalQueue: boolean;
  canManageReminders: boolean;
};
