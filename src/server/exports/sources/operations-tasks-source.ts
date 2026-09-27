import type { ActorContext } from "@/server/authz/types";
import { listTasks } from "@/server/operations/task-service";
import type { TaskDto } from "@/server/operations/client-dto";

import { mapSourceError } from "../source-errors";
import type { AppliedExportFilters, ExportRow, ExportsServiceResult } from "../types";
import type { FetchRowsOptions } from "./types";

// Composes ONLY Operations' own published, already actor-scoped, already-bounded listTasks - never a
// raw Firestore read, never a second Task query of this module's own invention. listTasks itself
// already returns only the actor's own assigned Tasks when the actor lacks global scope (see its own
// comment) - this fetcher adds no scope logic of its own.

function projectRow(task: TaskDto): ExportRow {
  return {
    taskRef: task.taskRef,
    title: task.title,
    targetDisplayName: task.targetDisplayName ?? null,
    assigneeDisplayName: task.assigneeDisplayName,
    origin: task.origin,
    priority: task.priority,
    status: task.status,
    dueAt: task.dueAt,
    isOverdue: task.isOverdue,
    blockedReason: task.blockedReason,
    cancelledReason: task.cancelledReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

// listTasks (unlike every other source this module composes) has no nextCursor of its own - it
// returns a single bounded page and nothing else. To still honor "never silently truncate a complete
// export" without a cursor to tell "exactly N matches" apart from "more than N matches", this fetcher
// always requests the domain's own full page bound (MAX_TASK_PAGE_SIZE, the highest listTasksQuerySchema
// accepts) and treats getting a full page back as "more rows may exist" - see catalog.ts's own comment
// on why operations_tasks.maxRows is deliberately ONE LESS than MAX_TASK_PAGE_SIZE.
const DOMAIN_FULL_PAGE_SIZE = 100;

export async function fetchOperationsTasksRows(actor: ActorContext, appliedFilters: AppliedExportFilters, options: FetchRowsOptions): Promise<ExportsServiceResult<{ rows: ExportRow[]; rowCount: number; truncated: boolean }>> {
  const result = await listTasks(actor, {
    limit: DOMAIN_FULL_PAGE_SIZE,
    status: appliedFilters.status,
    priority: appliedFilters.priority,
    targetType: appliedFilters.targetType,
  });
  if (!result.ok) return mapSourceError(result);

  const allRows = result.data.tasks.map(projectRow);
  const truncated = allRows.length > options.limit;
  const rows = allRows.slice(0, options.limit);
  return { ok: true, data: { rows, rowCount: rows.length, truncated } };
}
