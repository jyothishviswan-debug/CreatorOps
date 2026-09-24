"use client";

import { useState } from "react";

import type { TaskDto } from "@/server/operations/client-dto";

import { blockTask, cancelTask, completeTask, reopenTask, startTask, unblockTask } from "@/features/operations/api-client";

import { EditTaskDialog } from "./EditTaskDialog";

// Step 18B: Task lifecycle action buttons. Every button calls the corresponding /api/operations/
// tasks/[taskRef]/** endpoint with the task's own expectedDocVersion - the SERVER re-checks
// complete_tasks/manage_tasks and the lifecycle transition table (src/server/authz/lifecycle.ts) on
// every call; these buttons are a convenience, never the authority. Reason-requiring transitions
// (block/cancel/reopen/revise) show an inline reason field or dialog before submitting, mirroring
// Payments' own fail/reopen/void reason-capture pattern. `Edit` is gated on manage_tasks (the
// reviseTask endpoint's own grant), separate from the complete_tasks-gated status transitions below -
// a canManageTasks-only actor can still edit a Task they cannot start/complete, and vice versa.
export function LifecycleActions({ task, canComplete, canEdit, onUpdated }: { task: TaskDto; canComplete: boolean; canEdit: boolean; onUpdated: (next: TaskDto) => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reasonPrompt, setReasonPrompt] = useState<"block" | "cancel" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);

  if (!canComplete && !canEdit) return null;
  if (task.status === "DONE" || task.status === "CANCELLED") {
    if (!canComplete) return null;
    return (
      <div className="actions">
        <span className="pill gray">Read-only ({task.status === "DONE" ? "Done" : "Cancelled"})</span>
        <button type="button" className="btn" onClick={() => setReasonPrompt("reopen")} data-testid="task-action-reopen">
          Reopen
        </button>
        {reasonPrompt === "reopen" && <ReasonBar label="Reason for reopening" reason={reason} setReason={setReason} onCancel={() => setReasonPrompt(null)} onConfirm={() => void run("reopen")} pending={pending === "reopen"} />}
        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}
      </div>
    );
  }

  async function run(action: "start" | "block" | "unblock" | "complete" | "cancel" | "reopen") {
    setPending(action);
    setError(null);
    const expectedDocVersion = task.docVersion;
    const result =
      action === "start"
        ? await startTask(task.taskRef, expectedDocVersion)
        : action === "unblock"
          ? await unblockTask(task.taskRef, expectedDocVersion)
          : action === "complete"
            ? await completeTask(task.taskRef, expectedDocVersion)
            : action === "block"
              ? await blockTask(task.taskRef, { expectedDocVersion, reason })
              : action === "cancel"
                ? await cancelTask(task.taskRef, { expectedDocVersion, reason })
                : await reopenTask(task.taskRef, { expectedDocVersion, reason });
    setPending(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReasonPrompt(null);
    setReason("");
    onUpdated(result.data);
  }

  return (
    <div className="actions" style={{ flexWrap: "wrap" }}>
      {canComplete && task.status === "OPEN" && (
        <button type="button" className="btn primary" disabled={pending !== null} onClick={() => void run("start")} data-testid="task-action-start">
          Start
        </button>
      )}
      {canComplete && (task.status === "OPEN" || task.status === "IN_PROGRESS") && (
        <button type="button" className="btn primary" disabled={pending !== null} onClick={() => void run("complete")} data-testid="task-action-complete">
          Complete
        </button>
      )}
      {canComplete && task.status === "BLOCKED" && (
        <>
          <button type="button" className="btn primary" disabled={pending !== null} onClick={() => void run("unblock")} data-testid="task-action-unblock">
            Unblock / Resume
          </button>
          <button type="button" className="btn" disabled={pending !== null} onClick={() => void run("complete")} data-testid="task-action-complete">
            Complete
          </button>
        </>
      )}
      {canComplete && task.status === "IN_PROGRESS" && (
        <button type="button" className="btn" disabled={pending !== null} onClick={() => setReasonPrompt("block")} data-testid="task-action-block">
          Block
        </button>
      )}
      {canEdit && (
        <button type="button" className="btn" disabled={pending !== null} onClick={() => setEditing(true)} data-testid="task-action-edit">
          Edit
        </button>
      )}
      {canComplete && (
        <button type="button" className="btn" disabled={pending !== null} onClick={() => setReasonPrompt("cancel")} data-testid="task-action-cancel">
          Cancel
        </button>
      )}

      {reasonPrompt === "block" && <ReasonBar label="Reason for blocking" reason={reason} setReason={setReason} onCancel={() => setReasonPrompt(null)} onConfirm={() => void run("block")} pending={pending === "block"} />}
      {reasonPrompt === "cancel" && <ReasonBar label="Reason for cancelling" reason={reason} setReason={setReason} onCancel={() => setReasonPrompt(null)} onConfirm={() => void run("cancel")} pending={pending === "cancel"} />}

      {error && (
        <div className="banner" role="alert" style={{ width: "100%" }}>
          {error}
        </div>
      )}

      {canEdit && <EditTaskDialog task={task} open={editing} onClose={() => setEditing(false)} onUpdated={onUpdated} />}
    </div>
  );
}

function ReasonBar({ label, reason, setReason, onCancel, onConfirm, pending }: { label: string; reason: string; setReason: (v: string) => void; onCancel: () => void; onConfirm: () => void; pending: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", width: "100%", marginTop: 8 }}>
      <label htmlFor="lifecycle-reason" className="sr">
        {label}
      </label>
      <input id="lifecycle-reason" type="text" placeholder={label} value={reason} onChange={(e) => setReason(e.target.value)} style={{ flex: 1, minWidth: 200 }} aria-label={label} data-testid="lifecycle-reason-input" />
      <button type="button" className="btn primary" disabled={pending || reason.trim().length < 3} onClick={onConfirm} data-testid="lifecycle-reason-confirm">
        Confirm
      </button>
      <button type="button" className="btn ghost" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
