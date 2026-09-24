"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { Fields, Field } from "@/ui/Form";
import { TASK_PRIORITIES } from "@/server/operations/types";
import type { TaskDto } from "@/server/operations/client-dto";
import type { TaskPriority } from "@/server/operations/types";

import { reviseTask } from "@/features/operations/api-client";
import { TASK_PRIORITY_LABEL, formatDateTimeInputValue } from "@/features/operations/copy";

// Step 18B follow-up: the spec's own required OPEN/IN_PROGRESS/BLOCKED Task detail action, wired to
// the real 18A `reviseTask` endpoint (POST /api/operations/tasks/[taskRef]/revise) - the same
// expectedDocVersion optimistic-concurrency discipline every other lifecycle action here uses.
// Every revise call requires a reason (reviseTaskInputSchema.reason), same as block/cancel/reopen.
export function EditTaskDialog({ task, open, onClose, onUpdated }: { task: TaskDto; open: boolean; onClose: () => void; onUpdated: (next: TaskDto) => void }) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [dueAt, setDueAt] = useState(formatDateTimeInputValue(task.dueAt));
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTitle(task.title);
    setNotes(task.notes ?? "");
    setPriority(task.priority);
    setDueAt(formatDateTimeInputValue(task.dueAt));
    setReason("");
    setError(null);
  }

  function close() {
    reset();
    onClose();
  }

  async function submit() {
    if (!title.trim() || reason.trim().length < 3) return;
    setSubmitting(true);
    setError(null);
    const result = await reviseTask(task.taskRef, {
      expectedDocVersion: task.docVersion,
      title: title.trim(),
      notes: notes.trim() || null,
      priority,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
      reason: reason.trim(),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onUpdated(result.data);
    close();
  }

  return (
    <DialogShell
      open={open}
      title="Edit Task"
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={submitting || !title.trim() || reason.trim().length < 3} onClick={() => void submit()} data-testid="edit-task-submit">
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </>
      }
    >
      <Fields>
        <Field label="Title" full>
          <input id="edit-task-title" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} data-testid="edit-task-title" />
        </Field>
        <Field label="Description" full>
          <textarea id="edit-task-notes" maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Field label="Priority">
          <select id="edit-task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {TASK_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due date/time">
          <input id="edit-task-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
        <Field label="Reason for this change" full hint="Required, at least 3 characters">
          <input id="edit-task-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="edit-task-reason" />
        </Field>
      </Fields>
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
    </DialogShell>
  );
}
