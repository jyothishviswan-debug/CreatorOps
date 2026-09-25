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
      sections: { tasks, approvalQueue: approvals, reminders },
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
