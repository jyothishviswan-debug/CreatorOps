"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Icon } from "@/ui/icons";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import type { AssignmentStatus } from "@/server/assignments/types";
import { transitionAssignmentLifecycle } from "./api-client";
import { useAssignmentContentFulfillment } from "./useAssignmentContentFulfillment";

// Step 10B: the frozen golden-master "Next action" panel (title/subtitle
// preserved verbatim) - mapped to the single real primary lifecycle CTA
// for the assignment's CURRENT status. Ordinary (non-reasoned) edges only
// - Cancel lives in AssignmentWorkflowPanel instead, since this panel is
// reserved for the one forward-moving next step, matching the doc's own
// authority correction. IN_PROGRESS never renders an actionable Complete
// button - IN_PROGRESS -> COMPLETED is unconditionally not_ready right
// now (no Content evidence exists yet), so inviting the click would be a
// fake success path. The backend transition itself is untouched/still
// callable - only the guaranteed-to-fail invitation is removed.
const NEXT_ACTION: Partial<Record<AssignmentStatus, { to: AssignmentStatus; label: string }>> = {
  DRAFT: { to: "ASSIGNED", label: "Issue Assignment" },
  ASSIGNED: { to: "ACCEPTED", label: "Mark Accepted" },
  ACCEPTED: { to: "IN_PROGRESS", label: "Start Work" },
};

export function AssignmentNextActionPanel({ assignment, onSaved }: { assignment: AssignmentDto; onSaved: (assignment: AssignmentDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = NEXT_ACTION[assignment.status];
  const requiredCount = assignment.brief.requiredCount ?? 1;
  // Step 11B: Content is real now (Step 11A) - IN_PROGRESS's own
  // completion picture is fetched via the SAME shared tally helper
  // AssignmentContentPanel uses, never a second independent
  // implementation. Only enabled while IN_PROGRESS, to avoid an
  // unnecessary read on every other status.
  const fulfillment = useAssignmentContentFulfillment(assignment.assignmentRef, requiredCount, assignment.status === "IN_PROGRESS");

  async function run() {
    if (!next) return;
    setBusy(true);
    setError(null);
    const result = await transitionAssignmentLifecycle(assignment.assignmentRef, { to: next.to, expectedVersion: assignment.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved({ ...assignment, status: result.data.status, version: result.data.version, statusReason: null });
  }

  async function runComplete() {
    setBusy(true);
    setError(null);
    const result = await transitionAssignmentLifecycle(assignment.assignmentRef, { to: "COMPLETED", expectedVersion: assignment.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved({ ...assignment, status: result.data.status, version: result.data.version, statusReason: null });
  }

  const fulfilled = assignment.status === "IN_PROGRESS" && !fulfillment.loading && fulfillment.qualifyingCount >= fulfillment.requiredCount;

  return (
    <Panel span={4}>
      <PanelHead title="Next action" description="Keep the workflow moving" />
      <PanelBody>
        <span className="tile">
          <Icon name="check" />
        </span>
        {next ? (
          <>
            <h3 style={{ marginTop: 12 }}>{next.label}</h3>
            <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
              Server remains authoritative - this action is re-verified on every attempt.
            </p>
            <button type="button" className="btn primary" disabled={busy} onClick={run}>
              {busy ? "Saving…" : next.label}
            </button>
          </>
        ) : assignment.status === "IN_PROGRESS" ? (
          fulfilled ? (
            <>
              <h3 style={{ marginTop: 12 }}>Complete Assignment</h3>
              <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
                {fulfillment.qualifyingCount} of {fulfillment.requiredCount} required Content completed. Server remains authoritative - this action is re-verified on every attempt.
              </p>
              <button type="button" className="btn primary" disabled={busy} onClick={runComplete}>
                {busy ? "Saving…" : "Complete Assignment"}
              </button>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 12 }}>Content fulfillment in progress</h3>
              <p className="detailcopy" style={{ margin: "8px 0 0" }}>
                {fulfillment.loading ? "Loading Content fulfillment…" : `${fulfillment.qualifyingCount} of ${fulfillment.requiredCount} required Content completed`}
              </p>
            </>
          )
        ) : (
          <>
            <h3 style={{ marginTop: 12 }}>{assignment.status === "CANCELLED" ? "Cancelled" : "Completed"}</h3>
            <p className="detailcopy" style={{ margin: "8px 0 0" }}>This Assignment is in a terminal state - no further action is available.</p>
          </>
        )}
        {error && (
          <div className="banner" role="alert" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
