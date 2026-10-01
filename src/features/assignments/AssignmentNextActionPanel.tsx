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
// authority correction.
//
// Finding #50 (reopened): IN_PROGRESS's Complete button is real (the
// trusted fulfillment evaluator counts how many of this Assignment's
// Content records have reached APPROVED and compares that count to its
// own requiredCount) - it renders only once the shared
// useAssignmentContentFulfillment hook reports enough approved records;
// until then, a neutral truthful status line is shown instead of inviting
// a guaranteed-to-fail click. There is no separate "Complete Content"
// step anywhere - approving the record that crosses the required count IS
// what completes the Assignment, in the same server transaction.
const NEXT_ACTION: Partial<Record<AssignmentStatus, { to: AssignmentStatus; label: string }>> = {
  DRAFT: { to: "ASSIGNED", label: "Issue Assignment" },
};

// Findings #42/#51 (user-decided): a new Assignment created through the bulk-create path starts
// IN_PROGRESS directly (skipping ASSIGNED/ACCEPTED entirely) - the everyday workflow never resurrects
// "Mark Accepted"/"Start Work" as if they were normal next steps for those two states any more. An
// Assignment still stranded in ASSIGNED or ACCEPTED (legacy data, or one issued through the still-
// supported single-create API path) instead gets ONE narrow, visually-distinct recovery action that
// fast-forwards it to IN_PROGRESS - through the SAME unchanged transition table
// (ASSIGNED->ACCEPTED->IN_PROGRESS is still the only valid path; transitionAssignmentLifecycle itself is
// untouched, so the recovery button simply chains the required intermediate step(s) in sequence rather
// than inventing a shortcut edge).
const LEGACY_RECOVERY_STATUSES: readonly AssignmentStatus[] = ["ASSIGNED", "ACCEPTED"];

export function AssignmentNextActionPanel({ assignment, onSaved }: { assignment: AssignmentDto; onSaved: (assignment: AssignmentDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = NEXT_ACTION[assignment.status];
  // Finding #50 (reopened): IN_PROGRESS's own completion picture is
  // fetched via the SAME shared count-based hook AssignmentContentPanel
  // uses, never a second independent implementation. Only enabled while
  // IN_PROGRESS, to avoid an unnecessary read on every other status.
  const fulfillment = useAssignmentContentFulfillment(assignment.assignmentRef, assignment.brief.requiredCount ?? 1, assignment.status === "IN_PROGRESS");

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

  // Findings #42/#51: chains ASSIGNED->ACCEPTED->IN_PROGRESS (only the first hop is skipped when
  // already ACCEPTED) - the same unchanged transition table, never a new shortcut edge.
  async function runRecovery() {
    setBusy(true);
    setError(null);
    let version = assignment.version;
    if (assignment.status === "ASSIGNED") {
      const toAccepted = await transitionAssignmentLifecycle(assignment.assignmentRef, { to: "ACCEPTED", expectedVersion: version });
      if (!toAccepted.ok) {
        setBusy(false);
        setError(toAccepted.error);
        return;
      }
      version = toAccepted.data.version;
    }
    const toInProgress = await transitionAssignmentLifecycle(assignment.assignmentRef, { to: "IN_PROGRESS", expectedVersion: version });
    setBusy(false);
    if (!toInProgress.ok) {
      setError(toInProgress.error);
      return;
    }
    onSaved({ ...assignment, status: toInProgress.data.status, version: toInProgress.data.version, statusReason: null });
  }

  const fulfilled = assignment.status === "IN_PROGRESS" && !fulfillment.loading && fulfillment.fulfilled;
  const legacyRecovery = LEGACY_RECOVERY_STATUSES.includes(assignment.status);

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
        ) : legacyRecovery ? (
          <>
            <h3 style={{ marginTop: 12 }}>Legacy assignment — needs recovery</h3>
            <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
              This Assignment is stranded in an old workflow step ({assignment.status === "ASSIGNED" ? "Assigned" : "Accepted"}) that new Assignments no longer use. Advancing it moves it straight
              to In Progress, the normal working state.
            </p>
            <button type="button" className="btn" disabled={busy} onClick={runRecovery}>
              {busy ? "Advancing…" : "Advance legacy assignment"}
            </button>
          </>
        ) : assignment.status === "IN_PROGRESS" ? (
          fulfilled ? (
            <>
              <h3 style={{ marginTop: 12 }}>Complete Assignment</h3>
              <p className="detailcopy" style={{ margin: "8px 0 17px" }}>
                {fulfillment.qualifyingCount} of {fulfillment.requiredCount} required submission(s) approved. Server remains authoritative - this action is re-verified on every attempt.
              </p>
              <button type="button" className="btn primary" disabled={busy} onClick={runComplete}>
                {busy ? "Saving…" : "Complete Assignment"}
              </button>
            </>
          ) : (
            <>
              <h3 style={{ marginTop: 12 }}>Content fulfillment in progress</h3>
              <p className="detailcopy" style={{ margin: "8px 0 0" }}>
                {fulfillment.loading ? "Loading Content fulfillment…" : `${fulfillment.qualifyingCount} of ${fulfillment.requiredCount} required submission(s) approved`}
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
