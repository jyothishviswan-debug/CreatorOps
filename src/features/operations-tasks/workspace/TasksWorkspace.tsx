"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { Toolbar, SearchInput } from "@/ui/Table";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { TaskDto } from "@/server/operations/client-dto";
import type { TaskPriority, TaskStatus } from "@/server/operations/types";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/server/operations/types";

import { listTasks } from "@/features/operations/api-client";
import { deriveDueState, displayNameOrRef, DUE_STATE_LABEL, DUE_STATE_TONE, TARGET_TYPE_LABEL, TASK_PRIORITY_LABEL, TASK_PRIORITY_TONE, TASK_STATUS_LABEL, TASK_STATUS_TONE, formatDateTime, type DueState } from "@/features/operations/copy";
import { targetLabel } from "@/features/operations/target-links";
import { useNarrowViewport } from "@/features/operations/use-narrow-viewport";

export type TasksWorkspaceProps = { initialTasks: TaskDto[]; canManageTasks: boolean };

const ALL = "ALL";
type DueFilter = "ALL" | DueState;

export function TasksWorkspace({ initialTasks, canManageTasks }: TasksWorkspaceProps) {
  const [tasks, setTasks] = useState(initialTasks);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const narrow = useNarrowViewport();

  const [status, setStatus] = useState<typeof ALL | TaskStatus>(ALL);
  const [priority, setPriority] = useState<typeof ALL | TaskPriority>(ALL);
  const [due, setDue] = useState<DueFilter>(ALL);
  const [targetType, setTargetType] = useState<string>(ALL);
  const [assigneeText, setAssigneeText] = useState("");
  const [search, setSearch] = useState("");

  const nowIso = new Date().toISOString();

  async function reload(nextStatus: typeof ALL | TaskStatus, nextTargetType: string, nextAssignee: string) {
    setLoading(true);
    setError(null);
    const result = await listTasks({
      status: nextStatus === ALL ? undefined : nextStatus,
      targetType: nextTargetType === ALL ? undefined : nextTargetType,
      assigneeUserRef: nextAssignee.trim() || undefined,
      limit: 100,
    });
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setTasks(result.data.tasks);
  }

  useEffect(() => {
    const timer = setTimeout(() => void reload(status, targetType, assigneeText), 250);
    return () => clearTimeout(timer);
  }, [status, targetType, assigneeText]);

  const filtered = tasks.filter((task) => {
    if (priority !== ALL && task.priority !== priority) return false;
    const dueState = deriveDueState(task, nowIso);
    if (due !== ALL && dueState !== due) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = `${task.title} ${task.taskRef} ${task.target.targetRef}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  function resetFilters() {
    setStatus(ALL);
    setPriority(ALL);
    setDue(ALL);
    setTargetType(ALL);
    setAssigneeText("");
    setSearch("");
    void reload(ALL, ALL, "");
  }

  const summary = useMemo(() => {
    const counts = { open: 0, inProgress: 0, blocked: 0, overdue: 0 };
    for (const task of tasks) {
      if (task.status === "OPEN") counts.open += 1;
      if (task.status === "IN_PROGRESS") counts.inProgress += 1;
      if (task.status === "BLOCKED") counts.blocked += 1;
      if (task.isOverdue) counts.overdue += 1;
    }
    return counts;
  }, [tasks]);

  return (
    <>
      <div className="panel" style={{ marginBottom: 14 }} data-testid="tasks-status-strip">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 0 }}>
          {[
            { label: "Open", value: summary.open },
            { label: "In progress", value: summary.inProgress },
            { label: "Blocked", value: summary.blocked },
            { label: "Overdue", value: summary.overdue },
          ].map((item, index) => (
            <div key={item.label} style={{ flex: "1 1 130px", padding: "14px 18px", borderRight: index < 3 ? "1px solid var(--line)" : undefined, minWidth: 120 }}>
              <small className="muted" style={{ display: "block", marginBottom: 4 }}>
                {item.label}
              </small>
              <b style={{ fontSize: 20, letterSpacing: "-0.5px" }}>{item.value}</b>
            </div>
          ))}
        </div>
        <p className="foundationnote" style={{ padding: "0 18px 12px", margin: 0 }}>
          Counts are of the current bounded Tasks read, not a total.
        </p>
      </div>

      <section className="panel" aria-busy={loading}>
        <Toolbar>
          <select aria-label="Status" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value as typeof ALL | TaskStatus)}>
            <option value={ALL}>All statuses</option>
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <select aria-label="Priority" style={{ width: 130 }} value={priority} onChange={(e) => setPriority(e.target.value as typeof ALL | TaskPriority)}>
            <option value={ALL}>All priorities</option>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TASK_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
          <select aria-label="Due state" style={{ width: 150 }} value={due} onChange={(e) => setDue(e.target.value as DueFilter)}>
            <option value={ALL}>Any due state</option>
            {(Object.keys(DUE_STATE_LABEL) as DueState[])
              .filter((k) => k !== "scheduled")
              .map((state) => (
                <option key={state} value={state}>
                  {DUE_STATE_LABEL[state]}
                </option>
              ))}
          </select>
          <select aria-label="Target type" style={{ width: 160 }} value={targetType} onChange={(e) => setTargetType(e.target.value)}>
            <option value={ALL}>All target types</option>
            {Object.entries(TARGET_TYPE_LABEL).map(([type, label]) => (
              <option key={type} value={type}>
                {label}
              </option>
            ))}
          </select>
          <div className="inputwrap" style={{ minWidth: 180 }}>
            <Icon name="search" />
            <input type="search" aria-label="Assignee ref" placeholder="Assignee user ref…" value={assigneeText} onChange={(e) => setAssigneeText(e.target.value)} />
          </div>
          <SearchInput aria-label="Search tasks" placeholder="Search title or ref…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button type="button" className="btn ghost" onClick={resetFilters}>
            Reset
          </button>
        </Toolbar>

        {error && (
          <div className="banner" role="alert" style={{ margin: "0 18px 10px" }}>
            {error}
          </div>
        )}

        {loading ? (
          <div style={{ padding: "0 18px 18px" }} aria-hidden="true">
            <Skeleton lines={5} />
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No tasks match these filters" description="Try clearing filters, or create a new task." action={<button className="btn" type="button" onClick={resetFilters}>Clear filters</button>} />
        ) : narrow ? (
          <TaskCards rows={filtered} nowIso={nowIso} />
        ) : (
          <TasksTable rows={filtered} nowIso={nowIso} />
        )}

        <div className="panelfoot">
          <span>{filtered.length} task(s) shown</span>
          {canManageTasks && (
            <Link className="btn" href="/operations/tasks/new">
              Create Task
            </Link>
          )}
        </div>
      </section>
    </>
  );
}

function TasksTable({ rows, nowIso }: { rows: TaskDto[]; nowIso: string }) {
  return (
    <div className="tablewrap" data-testid="tasks-table">
      <table className="compact">
        <caption className="sr">Tasks workspace</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Target</th>
            <th scope="col">Assignee</th>
            <th scope="col">Priority</th>
            <th scope="col">Due</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className="sr">Action</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((task) => {
            const dueState = deriveDueState(task, nowIso);
            return (
              <tr key={task.taskRef} data-testid="task-row" data-task-ref={task.taskRef}>
                <td style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                  <b>{task.title}</b>
                  <small style={{ display: "block" }}>{task.taskRef}</small>
                </td>
                <td style={{ overflowWrap: "anywhere" }}>{targetLabel(task.target)}</td>
                <td style={{ overflowWrap: "anywhere" }}>{displayNameOrRef(task.assigneeDisplayName, task.assigneeUserRef)}</td>
                <td>
                  <Pill tone={TASK_PRIORITY_TONE[task.priority]}>{TASK_PRIORITY_LABEL[task.priority]}</Pill>
                </td>
                <td>
                  <Pill tone={DUE_STATE_TONE[dueState]}>{DUE_STATE_LABEL[dueState]}</Pill>
                </td>
                <td>
                  <Pill tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Pill>
                </td>
                <td>{formatDateTime(task.updatedAt)}</td>
                <td>
                  <Link className="btn" href={`/operations/tasks/${encodeURIComponent(task.taskRef)}`} data-testid="open-task">
                    Open
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TaskCards({ rows, nowIso }: { rows: TaskDto[]; nowIso: string }) {
  return (
    <div className="recordgrid" data-testid="tasks-cards">
      {rows.map((task) => {
        const dueState = deriveDueState(task, nowIso);
        return (
          <article className="record" key={task.taskRef} data-testid="task-card" data-task-ref={task.taskRef}>
            <b>{task.title}</b>
            <small style={{ display: "block", marginBottom: 8 }}>{task.taskRef}</small>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              <Pill tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Pill>
              <Pill tone={TASK_PRIORITY_TONE[task.priority]}>{TASK_PRIORITY_LABEL[task.priority]}</Pill>
              <Pill tone={DUE_STATE_TONE[dueState]}>{DUE_STATE_LABEL[dueState]}</Pill>
            </div>
            <div className="recordmeta">
              <span>{targetLabel(task.target)}</span>
              <span>{displayNameOrRef(task.assigneeDisplayName, task.assigneeUserRef)}</span>
            </div>
            <div style={{ marginTop: 12 }}>
              <Link className="btn" style={{ width: "100%" }} href={`/operations/tasks/${encodeURIComponent(task.taskRef)}`} data-testid="open-task">
                Open
              </Link>
            </div>
          </article>
        );
      })}
    </div>
  );
}
