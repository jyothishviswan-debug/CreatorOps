"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { AssignmentStatus } from "@/server/assignments/types";
import { transitionAssignmentLifecycle, type ReadinessIssue } from "./api-client";
import { dateLabel, STATUS_LABELS, statusTone } from "./format";

// Step 10B: the frozen golden-master "Assignment workflow" panel (title/
// subtitle "Canonical source remains authoritative" preserved verbatim).
// Wires: status, due date, owner (kv rows - the golden master's own
// "Priority" field is dropped, since there's no real Assignment-backend
// equivalent to fabricate), the legal reasoned Cancel action, and the
// not_ready blockers banner - the SAME generic path that naturally
// surfaces "cancellation blocked by existing external-submission
// evidence" (Step 10A.1's own real backend message, shown verbatim, no
// special-casing needed here).
const CAN_CANCEL: AssignmentStatus[] = ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS"];

export function AssignmentWorkflowPanel({ assignment, onSaved }: { assignment: AssignmentDto; onSaved: (assignment: AssignmentDto) => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ReadinessIssue[]>([]);

  function startCancel() {
    setCancelling(true);
    setReason("");
    setError(null);
    setBlockers([]);
  }

  async function confirmCancel() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    setBlockers([]);
    const result = await transitionAssignmentLifecycle(assignment.assignmentRef, { to: "CANCELLED", reason: reason.trim(), expectedVersion: assignment.version });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "not_ready") setBlockers(result.blockers ?? []);
      setError(result.error);
      return;
    }
    setCancelling(false);
    onSaved({ ...assignment, status: result.data.status, version: result.data.version, statusReason: reason.trim() });
  }

  const canCancel = CAN_CANCEL.includes(assignment.status);

  return (
    <Panel span={4}>
      <PanelHead title="Assignment workflow" description="Canonical source remains authoritative" />
      <PanelBody>
        {(assignment.status === "CANCELLED" || assignment.status === "COMPLETED") && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <b>{STATUS_LABELS[assignment.status]}.</b> {assignment.statusReason ?? "No reason recorded."}
          </div>
        )}

        <div className="kv">
          <span>Status</span>
          <Pill tone={statusTone(assignment.status)}>{STATUS_LABELS[assignment.status]}</Pill>
        </div>
        <div className="kv">
          <span>Due date</span>
          <b>{assignment.brief.dueAt ? dateLabel(assignment.brief.dueAt) : "—"}</b>
        </div>
        <div className="kv">
          <span>Owner</span>
          <b>{assignment.ownerDisplayName ?? "Unassigned"}</b>
        </div>

        {cancelling ? (
          <div style={{ marginTop: 14 }}>
            <div className="field full">
              <label htmlFor="assignment-cancel-reason">Reason for cancelling (required)</label>
              <textarea id="assignment-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
            </div>
            {blockers.length > 0 && (
              <div className="banner" role="alert" style={{ marginTop: 10 }}>
                <b>Not ready.</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {blockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && blockers.length === 0 && (
              <div className="banner" role="alert" style={{ marginTop: 10 }}>
                {error}
              </div>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setCancelling(false)} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn primary" disabled={busy || !reason.trim()} onClick={confirmCancel}>
                {busy ? "Saving…" : "Confirm cancellation"}
              </button>
            </div>
          </div>
        ) : (
          canCancel && (
            <div className="actions" style={{ marginTop: 14 }}>
              <button type="button" className="btn" onClick={startCancel}>
                Cancel assignment
              </button>
            </div>
          )
        )}
      </PanelBody>
    </Panel>
  );
}
