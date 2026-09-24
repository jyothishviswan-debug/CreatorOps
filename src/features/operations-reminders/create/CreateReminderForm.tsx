"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { FormLayout, FormSection, Fields, Field } from "@/ui/Form";

import { createReminder } from "@/features/operations/api-client";
import { TargetPicker, type SelectedTarget } from "@/features/operations/TargetPicker";
import { AssigneePicker } from "@/features/operations/AssigneePicker";

const NO_EXTERNAL_NOTICE = "CreatorOps will track when this reminder is due. External notifications are not enabled.";

// Step 18B: Create Reminder - compact single-screen form. No email/SMS/Slack channel selector
// anywhere (spec: "Do not add external email/SMS/Slack integrations") - the supporting copy below
// says so explicitly rather than leaving it implied.
export function CreateReminderForm() {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [reminderAt, setReminderAt] = useState("");
  const [owner, setOwner] = useState<{ userRef: string; displayName: string } | null>(null);
  const [target, setTarget] = useState<SelectedTarget | null>(null);
  const [taskRef, setTaskRef] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ message?: string; reminderAt?: string; owner?: string; target?: string }>({});

  async function submit() {
    const nextErrors: typeof fieldErrors = {};
    if (!message.trim()) nextErrors.message = "A reminder message is required.";
    if (!reminderAt) nextErrors.reminderAt = "A reminder date/time is required.";
    if (!owner) nextErrors.owner = "Select an owner/recipient.";
    if (!target) nextErrors.target = "Select a target record.";
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !owner || !target) return;

    setSubmitting(true);
    setError(null);
    const iso = new Date(reminderAt).toISOString();
    const result = await createReminder({
      target: { targetType: target.targetType, targetRef: target.targetRef, targetVersion: null },
      recipientUserRef: owner.userRef,
      message: message.trim(),
      reminderAt: iso,
      taskRef: taskRef.trim() || null,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(`/operations/reminders/${encodeURIComponent(result.data.reminderRef)}`);
  }

  return (
    <div className="panel">
      <FormLayout>
        <div>
          <FormSection title="Reminder" description="What to follow up on and when">
            <Fields>
              <Field label="Reminder summary/message" full hint={fieldErrors.message}>
                <textarea id="reminder-message" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
              </Field>
              <Field label="Reminder date/time" hint={fieldErrors.reminderAt}>
                <input id="reminder-at" type="datetime-local" value={reminderAt} onChange={(e) => setReminderAt(e.target.value)} />
              </Field>
              <Field label="Linked Task ref" hint="Optional - tsk_…">
                <input id="reminder-task-ref" type="text" value={taskRef} onChange={(e) => setTaskRef(e.target.value)} />
              </Field>
            </Fields>
            <p className="foundationnote" style={{ marginTop: 14 }}>
              {NO_EXTERNAL_NOTICE}
            </p>
          </FormSection>
        </div>
        <aside>
          <FormSection title="Target" description="The record this reminder is about">
            <TargetPicker value={target} onChange={setTarget} />
            {fieldErrors.target && (
              <p className="foundationnote" role="alert" style={{ color: "var(--red)" }}>
                {fieldErrors.target}
              </p>
            )}
          </FormSection>
          <FormSection title="Owner / recipient" description="Who this reminder is for">
            <AssigneePicker id="reminder-owner" label="Owner" value={owner} onChange={setOwner} />
            {fieldErrors.owner && (
              <p className="foundationnote" role="alert" style={{ color: "var(--red)" }}>
                {fieldErrors.owner}
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
        <button type="button" className="btn primary" disabled={submitting} onClick={() => void submit()} data-testid="submit-create-reminder">
          {submitting ? "Creating…" : "Create Reminder"}
        </button>
      </div>
    </div>
  );
}
