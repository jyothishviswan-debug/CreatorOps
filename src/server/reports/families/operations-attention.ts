import type { ActorContext } from "@/server/authz/types";
import { listApprovalQueue, listReminders, listTasks } from "@/server/operations";

import { buildReportResult } from "../result-builder";
import { mapSourceError } from "../source-errors";
import type { AppliedReportFilters, ReportResult, ReportRow, ReportsServiceResult } from "../types";

// Section 12: Operations Attention - open Tasks, live pending Approval Queue items, and due
// Reminders, each read straight through Operations' own already actor-scoped list functions. The
// Approval Queue section stays exactly as live/read-only as Operations' own Step 18A design (section
// 21: "live read-only report execution need not create noisy persistent audit entries") - Reports
// persists nothing about it, ever.
const TASK_PAGE_SIZE = 100;
const REMINDER_PAGE_SIZE = 100;

export async function runOperationsAttentionReport(actor: ActorContext, appliedFilters: AppliedReportFilters): Promise<ReportsServiceResult<ReportResult>> {
  const generatedAt = new Date().toISOString();
  const status = appliedFilters.status;

  const [tasksResult, remindersResult, approvalsResult] = await Promise.all([listTasks(actor, { limit: TASK_PAGE_SIZE }), listReminders(actor, { limit: REMINDER_PAGE_SIZE }), listApprovalQueue(actor, {})]);
  if (!tasksResult.ok) return mapSourceError(tasksResult);
  if (!remindersResult.ok) return mapSourceError(remindersResult);
  if (!approvalsResult.ok) return mapSourceError(approvalsResult);

  const tasks = tasksResult.data.tasks.filter((task) => (status ? task.status === status : true));
  const reminders = remindersResult.data.reminders.filter((reminder) => (status ? reminder.status === status : true));
  const approvals = approvalsResult.data.items;

  const openTaskCount = tasks.filter((t) => t.status === "OPEN" || t.status === "IN_PROGRESS" || t.status === "BLOCKED").length;
  const overdueTaskCount = tasks.filter((t) => t.isOverdue).length;
  const dueReminderCount = reminders.filter((r) => r.status === "DUE").length;

  const rows: ReportRow[] = [
    ...tasks.map((t) => ({ kind: "task" as const, ref: t.taskRef, title: t.title, status: t.status, priority: t.priority, dueAt: t.dueAt, overdue: t.isOverdue })),
    ...reminders.map((r) => ({ kind: "reminder" as const, ref: r.reminderRef, title: r.message, status: r.status, dueAt: r.reminderAt, overdue: r.status === "DUE" })),
    ...approvals.map((a) => ({ kind: "approval" as const, ref: a.approvalItemRef, title: a.title, status: a.currentSourceStatus, sourceModule: a.sourceModule, overdue: false })),
  ];

  // Bug class B fix (this stage's completion report): TaskDto/ReminderDto both carry `target` as a
  // NESTED OBJECT ({targetType, targetRef, targetVersion}), and ApprovalItemDto carries
  // `safeDisplayData` as a nested Record - the RAW `tasks`/`reminders`/`approvals` arrays were being
  // passed straight into `sections` below (not the already-flat `rows` array above, which itself never
  // included target info at all), which would hand buildGenericTable an object-valued column and crash
  // the PDF renderer's text layout exactly like the finance-status.ts case. Each section below is its
  // own flat, scalar-only projection - `title`/`assigneeDisplayName`/`targetDisplayName` are already
  // resolved labels (never a raw ref) from TaskDto/ReminderDto itself; the raw `target.targetRef` is
  // kept as a demoted, secondary field alongside its own `targetType`, never the primary column.
  const taskSectionRows: ReportRow[] = tasks.map((t) => ({
    title: t.title,
    status: t.status,
    priority: t.priority,
    assigneeDisplayName: t.assigneeDisplayName,
    dueAt: t.dueAt,
    overdue: t.isOverdue,
    targetType: t.target.targetType,
    targetDisplayName: t.targetDisplayName ?? null,
    targetRef: t.target.targetRef,
    taskRef: t.taskRef,
  }));
  const reminderSectionRows: ReportRow[] = reminders.map((r) => ({
    message: r.message,
    status: r.status,
    recipientDisplayName: r.recipientDisplayName,
    reminderAt: r.reminderAt,
    targetType: r.target.targetType,
    targetDisplayName: r.targetDisplayName ?? null,
    targetRef: r.target.targetRef,
    reminderRef: r.reminderRef,
  }));
  const approvalSectionRows: ReportRow[] = approvals.map((a) => ({
    title: a.title,
    summary: a.summary,
    sourceModule: a.sourceModule,
    currentSourceStatus: a.currentSourceStatus,
    requestedByDisplayName: a.requestedByDisplayName,
    requestedAt: a.requestedAt,
    approvalItemRef: a.approvalItemRef,
  }));

  return {
    ok: true,
    data: buildReportResult({
      reportId: "operations_attention",
      generatedAt,
      evidenceCutoff: generatedAt,
      appliedFilters,
      scopeSummary: { basis: "actor-scope (listTasks/listReminders/listApprovalQueue)", note: "Every actor-scoped Task/Reminder plus every Approval Queue item the actor's own source-module grants already permit." },
      metrics: { openTaskCount, overdueTaskCount, pendingApprovalCount: approvals.length, dueReminderCount },
      rows,
      sections: { tasks: taskSectionRows, approvalQueue: approvalSectionRows, reminders: reminderSectionRows },
      truncated: false,
      rowCount: rows.length,
      provenance: [
        { sourceModule: "operations", sourceFunction: "listTasks", recordCount: tasks.length },
        { sourceModule: "operations", sourceFunction: "listReminders", recordCount: reminders.length },
        { sourceModule: "operations", sourceFunction: "listApprovalQueue", recordCount: approvals.length },
      ],
    }),
  };
}
