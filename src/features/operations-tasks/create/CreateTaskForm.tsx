"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field } from "@/ui/Form";
import { TASK_PRIORITIES } from "@/server/operations/types";
import type { TaskPriority } from "@/server/operations/types";

import { createTask } from "@/features/operations/api-client";
import { TASK_PRIORITY_LABEL } from "@/features/operations/copy";
import { TargetPicker, type SelectedTarget } from "@/features/operations/TargetPicker";
import { AssigneePicker } from "@/features/operations/AssigneePicker";

// Step 18B: Create Task - a compact single-screen form (spec: "not a wizard"), left = title/
// description/priority/due, right = target + assignee. The server remains authoritative for
// active-user validation, record scope and lifecycle defaults - this form only collects input.
export function CreateTaskForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("NORMAL");
  const [dueAt, setDueAt] = useState("");
  const [target, setTarget] = useState<SelectedTarget | null>(null);
  const [assignee, setAssignee] = useState<{ userRef: string; displayName: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; target?: string; assignee?: string }>({});

  async function submit() {
    const nextFieldErrors: typeof fieldErrors = {};
    if (!title.trim()) nextFieldErrors.title = "A title is required.";
    if (!target) nextFieldErrors.target = "Select a target record.";
    if (!assignee) nextFieldErrors.assignee = "Select an assignee.";
    setFieldErrors(nextFieldErrors);
    if (Object.keys(nextFieldErrors).length > 0 || !target || !assignee) return;

    setSubmitting(true);
    setError(null);
    const result = await createTask({
      title: title.trim(),
      notes: notes.trim() || null,
      target: { targetType: target.targetType, targetRef: target.targetRef, targetVersion: null },
      assigneeUserRef: assignee.userRef,
      priority,
      dueAt: dueAt ? new Date(dueAt).toISOString() : null,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/operations/tasks/${encodeURIComponent(result.data.taskRef)}`);
  }

  return (
    <div className="panel">
      <FormLayout>
        <div>
          <FormSection title="Task" description="What needs to be done">
            <Fields>
              <Field label="Title" full hint={fieldErrors.title}>
                <input id="task-title" type="text" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={Boolean(fieldErrors.title)} aria-describedby={fieldErrors.title ? "task-title-error" : undefined} />
              </Field>
              <Field label="Description" full>
                <textarea id="task-notes" maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Field label="Priority">
                <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {TASK_PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Due date/time" hint="Optional">
                <input id="task-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
              </Field>
            </Fields>
          </FormSection>
        </div>
        <aside>
          <FormSection title="Target" description="The record this task is about">
            <TargetPicker value={target} onChange={setTarget} />
            {fieldErrors.target && (
              <p className="foundationnote" role="alert" style={{ color: "var(--red)" }}>
                {fieldErrors.target}
              </p>
            )}
          </FormSection>
          <FormSection title="Assignee" description="Who owns this task">
            <AssigneePicker id="task-assignee" label="Assignee" value={assignee} onChange={setAssignee} />
            {fieldErrors.assignee && (
              <p className="foundationnote" role="alert" style={{ color: "var(--red)" }}>
                {fieldErrors.assignee}
              </p>
            )}
          </FormSection>
        </aside>
      </FormLayout>

      {error && (
        <div className="banner" role="alert" style={{ margin: "0 22px" }}>
          {error}
        </div>
      )}

      <div className="formfoot">
        <small>Server permissions and record scope are re-checked on submit.</small>
        <button type="button" className="btn primary" disabled={submitting} onClick={() => void submit()} data-testid="submit-create-task">
          {submitting ? "Creating…" : "Create Task"}
        </button>
      </div>
    </div>
  );
}
