"use client";

import { useState } from "react";
import Link from "next/link";

import { LocalTabs } from "@/ui/LocalTabs";
import { Pill } from "@/ui/Badge";
import { Skeleton, EmptyState } from "@/ui/States";
import type { ReminderDto, ReminderEventDto } from "@/server/operations/client-dto";

import { listReminderEvents } from "@/features/operations/api-client";
import { REMINDER_STATUS_LABEL, REMINDER_STATUS_TONE, TARGET_TYPE_LABEL, formatDateTime } from "@/features/operations/copy";
import { targetHref, targetLabel } from "@/features/operations/target-links";

import { ReminderLifecycleActions } from "./ReminderLifecycleActions";

const EVENT_LABEL: Record<string, string> = {
  REMINDER_CREATED: "Created",
  REMINDER_RESCHEDULED: "Rescheduled",
  REMINDER_DISMISSED: "Dismissed",
  REMINDER_COMPLETED: "Completed",
  REMINDER_CANCELLED: "Cancelled",
};

export function ReminderDetail({ initialReminder, canManageReminders }: { initialReminder: ReminderDto; canManageReminders: boolean }) {
  const [reminder, setReminder] = useState(initialReminder);
  const [tab, setTab] = useState<"summary" | "activity">("summary");
  const [events, setEvents] = useState<ReminderEventDto[] | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  const href = targetHref(reminder.target);

  function onTabChange(next: string) {
    setTab(next as "summary" | "activity");
    if (next === "activity" && events === null && !eventsLoading) {
      setEventsLoading(true);
      setEventsError(null);
      void listReminderEvents(reminder.reminderRef).then((result) => {
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
          <div className="eyebrow">OPERATIONS / REMINDER DETAIL</div>
          <h1 style={{ overflowWrap: "anywhere" }}>{reminder.message}</h1>
          <p style={{ overflowWrap: "anywhere" }}>
            {targetLabel(reminder.target)} · {reminder.reminderRef}
          </p>
        </div>
        <div className="actions">
          <Link className="btn" href="/operations/reminders">
            Back to Reminders
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={REMINDER_STATUS_TONE[reminder.status]}>{REMINDER_STATUS_LABEL[reminder.status]}</Pill>
        </div>
        <div>
          <small>Reminder time</small>
          <b>{formatDateTime(reminder.reminderAt)}</b>
        </div>
        <div>
          <small>Owner</small>
          <b style={{ overflowWrap: "anywhere" }}>{reminder.recipientUserRef}</b>
        </div>
        <div>
          <small>Source</small>
          <b>{reminder.taskRef ? "Linked task" : reminder.approvalItemRef ? "Approval follow-up" : "Manual"}</b>
        </div>
      </div>

      <LocalTabs tabs={[{ key: "summary", label: "Summary" }, { key: "activity", label: "Activity" }]} active={tab} onChange={onTabChange} />

      {tab === "summary" ? (
        <div className="grid">
          <section className="panel s8">
            <div className="panelhead">
              <div>
                <h2>Reminder</h2>
                <p>Full message and target</p>
              </div>
            </div>
            <div className="panelbody">
              <p className="detailcopy">{reminder.message}</p>
              <div style={{ marginTop: 14 }}>
                <div className="kv">
                  <span>Target</span>
                  <b style={{ overflowWrap: "anywhere" }}>
                    {TARGET_TYPE_LABEL[reminder.target.targetType]} · {reminder.target.targetRef}
                  </b>
                </div>
                {reminder.taskRef && (
                  <div className="kv">
                    <span>Linked Task</span>
                    <Link className="textlink" href={`/operations/tasks/${encodeURIComponent(reminder.taskRef)}`}>
                      {reminder.taskRef}
                    </Link>
                  </div>
                )}
                <div className="kv">
                  <span>Created</span>
                  <b>{formatDateTime(reminder.createdAt)}</b>
                </div>
                <div className="kv">
                  <span>Updated</span>
                  <b>{formatDateTime(reminder.updatedAt)}</b>
                </div>
              </div>
              {href && (
                <div style={{ marginTop: 14 }}>
                  <Link className="btn" href={href} data-testid="open-linked-record">
                    Open linked record
                  </Link>
                </div>
              )}
              <p className="foundationnote" style={{ marginTop: 14 }}>
                CreatorOps tracks when this reminder is due. External notifications are not enabled.
              </p>
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
              <ReminderLifecycleActions reminder={reminder} canManage={canManageReminders} onUpdated={setReminder} />
              {!canManageReminders && <p className="foundationnote">You do not have permission to change this reminder.</p>}
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
                  <caption className="sr">Reminder activity history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date/time</th>
                      <th scope="col">Event</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((event, index) => (
                      <tr key={`${event.kind}-${event.createdAt}-${index}`} data-testid="reminder-activity-row">
                        <td>{formatDateTime(event.createdAt)}</td>
                        <td>{EVENT_LABEL[event.kind] ?? event.kind}</td>
                        <td style={{ overflowWrap: "anywhere" }}>{event.actorUserRef}</td>
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
