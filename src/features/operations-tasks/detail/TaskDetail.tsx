"use client";

import { useState } from "react";
import Link from "next/link";

import { LocalTabs } from "@/ui/LocalTabs";
import { Pill } from "@/ui/Badge";
import { Skeleton, EmptyState } from "@/ui/States";
import type { TaskDto, TaskEventDto } from "@/server/operations/client-dto";

import { listTaskEvents } from "@/features/operations/api-client";
import { deriveDueState, displayNameOrRef, DUE_STATE_LABEL, DUE_STATE_TONE, TASK_PRIORITY_LABEL, TASK_PRIORITY_TONE, TASK_STATUS_LABEL, TASK_STATUS_TONE, TARGET_TYPE_LABEL, formatDateTime } from "@/features/operations/copy";
import { targetHref, targetLabel } from "@/features/operations/target-links";

import { LifecycleActions } from "./LifecycleActions";

const EVENT_LABEL: Record<string, string> = {
  TASK_CREATED: "Created",
  TASK_REVISED: "Revised",
  TASK_ASSIGNED: "Assigned",
  TASK_REASSIGNED: "Reassigned",
  TASK_STARTED: "Started",
  TASK_BLOCKED: "Blocked",
  TASK_UNBLOCKED: "Unblocked",
  TASK_COMPLETED: "Completed",
  TASK_REOPENED: "Reopened",
  TASK_CANCELLED: "Cancelled",
  TASK_DUE_DATE_CHANGED: "Due date changed",
  TASK_PRIORITY_CHANGED: "Priority changed",
};

export function TaskDetail({ initialTask, canCompleteTasks, canManageTasks }: { initialTask: TaskDto; canCompleteTasks: boolean; canManageTasks: boolean }) {
  const [task, setTask] = useState(initialTask);
  const [tab, setTab] = useState<"summary" | "activity">("summary");
  const [events, setEvents] = useState<TaskEventDto[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  const nowIso = new Date().toISOString();
  const dueState = deriveDueState(task, nowIso);
  const href = targetHref(task.target);

  function onTabChange(next: string) {
    setTab(next as "summary" | "activity");
    if (next === "activity" && events === null && !eventsLoading) {
      setEventsLoading(true);
      setEventsError(null);
      void listTaskEvents(task.taskRef).then((result) => {
        setEventsLoading(false);
        if (!result.ok) {
          setEventsError(result.message);
          return;
        }
        setEvents(result.data.events);
      });
    }
  }

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">OPERATIONS / TASK DETAIL</div>
          <h1 style={{ overflowWrap: "anywhere" }}>{task.title}</h1>
          <p style={{ overflowWrap: "anywhere" }}>
            {targetLabel(task.target)} · {task.taskRef}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/operations">
            Back to Tasks
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={TASK_STATUS_TONE[task.status]}>{TASK_STATUS_LABEL[task.status]}</Pill>
        </div>
        <div>
          <small>Priority</small>
          <Pill tone={TASK_PRIORITY_TONE[task.priority]}>{TASK_PRIORITY_LABEL[task.priority]}</Pill>
        </div>
        <div>
          <small>Due</small>
          <Pill tone={DUE_STATE_TONE[dueState]}>{DUE_STATE_LABEL[dueState]}</Pill>
        </div>
        <div>
          <small>Assignee</small>
          <b style={{ overflowWrap: "anywhere" }}>{displayNameOrRef(task.assigneeDisplayName, task.assigneeUserRef)}</b>
        </div>
      </div>

      <LocalTabs tabs={[{ key: "summary", label: "Summary" }, { key: "activity", label: "Activity" }]} active={tab} onChange={onTabChange} />

      {tab === "summary" ? (
        <div className="grid">
          <section className="panel s8">
            <div className="panelhead">
              <div>
                <h2>Task</h2>
                <p>Full description and target</p>
              </div>
            </div>
            <div className="panelbody">
              <p className="detailcopy">{task.notes ?? "No description."}</p>
              <div style={{ marginTop: 14 }}>
                <div className="kv">
                  <span>Target</span>
                  <b style={{ overflowWrap: "anywhere" }}>
                    {TARGET_TYPE_LABEL[task.target.targetType]} · {task.target.targetRef}
                  </b>
                </div>
                <div className="kv">
                  <span>Origin</span>
                  <b>{task.origin}</b>
                </div>
                <div className="kv">
                  <span>Created</span>
                  <b>{formatDateTime(task.createdAt)}</b>
                </div>
                <div className="kv">
                  <span>Updated</span>
                  <b>{formatDateTime(task.updatedAt)}</b>
                </div>
                {task.blockedReason && (
                  <div className="kv">
                    <span>Blocked reason</span>
                    <b>{task.blockedReason}</b>
                  </div>
                )}
                {task.cancelledReason && (
                  <div className="kv">
                    <span>Cancelled reason</span>
                    <b>{task.cancelledReason}</b>
                  </div>
                )}
              </div>
              {href && (
                <div style={{ marginTop: 14 }}>
                  <Link className="btn" href={href} data-testid="open-linked-record">
                    Open linked record
                  </Link>
                </div>
              )}
            </div>
          </section>
          <section className="panel s4">
            <div className="panelhead">
              <div>
                <h2>Lifecycle</h2>
                <p>Available actions from your grants</p>
              </div>
            </div>
            <div className="panelbody">
              <LifecycleActions task={task} canComplete={canCompleteTasks} canEdit={canManageTasks} onUpdated={setTask} />
              {!canCompleteTasks && !canManageTasks && <p className="foundationnote">You do not have permission to change this task&apos;s lifecycle.</p>}
            </div>
          </section>
        </div>
      ) : (
        <section className="panel">
          <div className="panelbody">
            {eventsLoading && <Skeleton lines={5} />}
            {eventsError && (
              <div className="banner" role="alert">
                {eventsError}
              </div>
            )}
            {!eventsLoading && events !== null && events.length === 0 && <EmptyState title="No activity yet" icon="clock" />}
            {!eventsLoading && events !== null && events.length > 0 && (
              <div className="tablewrap">
                <table className="compact">
                  <caption className="sr">Task activity history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date/time</th>
                      <th scope="col">Event</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Version</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event, index) => (
                      <tr key={`${event.kind}-${event.createdAt}-${index}`} data-testid="task-activity-row">
                        <td>{formatDateTime(event.createdAt)}</td>
                        <td>{EVENT_LABEL[event.kind] ?? event.kind}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{event.actorUserRef}</td>
                        <td>{event.version}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{event.metadata ? Object.entries(event.metadata).map(([k, v]) => `${k}: ${String(v)}`).join(", ") : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
