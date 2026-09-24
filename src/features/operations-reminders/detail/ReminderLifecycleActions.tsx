"use client";

import { useState } from "react";

import type { ReminderDto } from "@/server/operations/client-dto";

import { cancelReminder, completeReminder, dismissReminder, rescheduleReminder } from "@/features/operations/api-client";
import { formatDateTimeInputValue } from "@/features/operations/copy";

// Step 18B: Reminder lifecycle actions. No action here ever mutates the target record (spec: "No
// Reminder action may mutate the source target") - every call goes to /api/operations/reminders/**
// only.
export function ReminderLifecycleActions({ reminder, canManage, onUpdated }: { reminder: ReminderDto; canManage: boolean; onUpdated: (next: ReminderDto) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [nextAt, setNextAt] = useState(formatDateTimeInputValue(reminder.reminderAt));
  const [reason, setReason] = useState("");

  if (!canManage) return null;
  if (reminder.status !== "SCHEDULED" && reminder.status !== "DUE") {
    return <span className="pill gray">Read-only ({reminder.status === "DISMISSED" ? "Dismissed" : reminder.status === "COMPLETED" ? "Completed" : "Cancelled"})</span>;
  }

  async function run(action: "dismiss" | "complete") {
    setPending(action);
    setError(null);
    const result = action === "dismiss" ? await dismissReminder(reminder.reminderRef, reminder.docVersion) : await completeReminder(reminder.reminderRef, reminder.docVersion);
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onUpdated(result.data);
  }

  async function submitReschedule() {
    if (!nextAt) return;
    setPending("reschedule");
    setError(null);
    const result = await rescheduleReminder(reminder.reminderRef, { expectedDocVersion: reminder.docVersion, reminderAt: new Date(nextAt).toISOString() });
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRescheduling(false);
    onUpdated(result.data);
  }

  async function submitCancel() {
    if (reason.trim().length < 3) return;
    setPending("cancel");
    setError(null);
    const result = await cancelReminder(reminder.reminderRef, { expectedDocVersion: reminder.docVersion, reason });
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCancelling(false);
    setReason("");
    onUpdated(result.data);
  }

  return (
    <div className="actions" style={{ flexWrap: "wrap" }}>
      <button type="button" className="btn primary" disabled={pending !== null} onClick={() => setRescheduling((v) => !v)} data-testid="reminder-action-reschedule">
        Reschedule
      </button>
      <button type="button" className="btn" disabled={pending !== null} onClick={() => void run("dismiss")} data-testid="reminder-action-dismiss">
        Dismiss
      </button>
      <button type="button" className="btn" disabled={pending !== null} onClick={() => void run("complete")} data-testid="reminder-action-complete">
        Complete
      </button>
      <button type="button" className="btn" disabled={pending !== null} onClick={() => setCancelling((v) => !v)} data-testid="reminder-action-cancel">
        Cancel
      </button>

      {rescheduling && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", marginTop: 8 }}>
          <label htmlFor="reschedule-at" className="sr">
            New reminder time
          </label>
          <input id="reschedule-at" type="datetime-local" value={nextAt} onChange={(e) => setNextAt(e.target.value)} data-testid="reschedule-input" />
          <button type="button" className="btn primary" disabled={pending === "reschedule" || !nextAt} onClick={() => void submitReschedule()} data-testid="reschedule-confirm">
            Confirm
          </button>
          <button type="button" className="btn ghost" onClick={() => setRescheduling(false)}>
            Cancel
          </button>
        </div>
      )}

      {cancelling && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", marginTop: 8 }}>
          <label htmlFor="cancel-reason" className="sr">
            Reason for cancelling
          </label>
          <input id="cancel-reason" type="text" placeholder="Reason for cancelling" value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 200 }} data-testid="cancel-reason-input" />
          <button type="button" className="btn primary" disabled={pending === "cancel" || reason.trim().length < 3} onClick={() => void submitCancel()} data-testid="cancel-confirm">
            Confirm
          </button>
          <button type="button" className="btn ghost" onClick={() => setCancelling(false)}>
            Back
          </button>
        </div>
      )}

      {error && (
        <div className="banner" role="alert" style={{ width: "100%" }}>
          {error}
        </div>
      )}
    </div>
  );
}
