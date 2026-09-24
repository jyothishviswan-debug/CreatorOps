// Step 18A: the public service surface of the Operations backend/domain foundation.
//
// Routes import from here; internals (Firestore helpers, the gate, the event redactors) stay
// module-private. The HTTP mapper stays in ./http (it imports next/server; the services must stay
// importable without it). Mirrors every Finance module's own index.ts barrel shape.
export { createTask, generateSystemTask, getTask, listTaskEvents, listTasks, listTaskVersionDocs, reviseTask } from "./task-service";
export { blockTask, cancelTask, completeTask, reassignTask, reopenTask, startTask, unblockTask } from "./task-lifecycle-service";
export { createReminder, getReminder, listReminderEvents, listReminders } from "./reminder-service";
export { cancelReminder, completeReminder, dismissReminder, rescheduleReminder } from "./reminder-lifecycle-service";
export { computeOperationsPermissions } from "./operations-permissions";
export { getApprovalItem, listApprovalQueue, refreshApprovalItem } from "./approval-queue/approval-queue-service";
export type { ApprovalActionType, ApprovalItemDto, ApprovalQueueListDto, ApprovalSourceModule } from "./approval-queue/types";
export { APPROVAL_ACTION_TYPES, APPROVAL_SOURCE_MODULES } from "./approval-queue/types";
export type { OperationsPermissionsDto, ReminderDto, ReminderEventDto, TaskDto, TaskEventDto } from "./client-dto";
export { TARGET_TYPES, type TargetReference, type TargetType } from "./target-ref";
export {
  REMINDER_EFFECTIVE_STATUSES,
  REMINDER_ORIGINS,
  REMINDER_STATUSES,
  TASK_ORIGINS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type OperationsServiceResult,
  type ReminderEffectiveStatus,
  type ReminderOrigin,
  type ReminderStatus,
  type TaskOrigin,
  type TaskPriority,
  type TaskStatus,
} from "./types";
