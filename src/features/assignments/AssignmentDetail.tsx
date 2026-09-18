"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelGrid, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState } from "@/ui/States";
import { Icon } from "@/ui/icons";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { ASSIGNMENT_STATUSES, type AssignmentStatus } from "@/server/assignments/types";
import { absoluteTime, dateLabel, platformLabel, STATUS_LABELS, statusTone } from "./format";
import { AssignmentHistoryDialog } from "./AssignmentHistoryDialog";
import { AssignmentNotesDialog } from "./AssignmentNotesDialog";
import { AssignmentNextActionPanel } from "./AssignmentNextActionPanel";
import { AssignmentWorkflowPanel } from "./AssignmentWorkflowPanel";

// Step 10B: the frozen golden-master Assignment Detail structure,
// verified directly against docs/reference/CreatorOps_UI_Golden_Master.html's
// `isAssignment` branch - a single scrolling page, no route-based tabs.
// Order: header/actions -> 4-box context strip -> tab/action strip
// (Overview/Notes & meetings/History + scope chip) -> workflow step strip
// -> first grid (Record context span8, Next action span4) -> second grid
// (Content, Assignment workflow, Notes & meetings).
//
// The 5 real lifecycle states only - the golden master's own literal
// step list includes Submitted/Approved (Content-review states the
// backend explicitly forbids surfacing on Assignment), so those two are
// dropped from the strip; CANCELLED is a terminal state, not a strip
// position (reachable from every non-terminal state, not one linear
// point).
const WORKFLOW_STEPS: AssignmentStatus[] = ["DRAFT", "ASSIGNED", "ACCEPTED", "IN_PROGRESS", "COMPLETED"];

export function AssignmentDetail({ initialAssignment }: { initialAssignment: AssignmentDto }) {
  const [assignment, setAssignment] = useState(initialAssignment);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);

  function handleAssignmentUpdated(updated: AssignmentDto) {
    setAssignment(updated);
  }

  const currentStepIndex = assignment.status === "CANCELLED" ? -1 : ASSIGNMENT_STATUSES.indexOf(assignment.status);

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">ASSIGNMENTS / RECORD DETAIL</div>
          <h1>{assignment.partnerDisplayName ?? "Unknown Partner"}</h1>
          {/* Frozen brief snapshot, not the live-resolved campaignName -
              a later Campaign rename must never visually replace this
              historical identity (Step 10B section 6's own rule). */}
          <p>{assignment.brief.campaignName}</p>
        </div>
        <div className="actions">
          <Link href="/assignments" className="btn">
            Back to assignments
          </Link>
        </div>
      </div>

      <div className="detailcontext">
        <div>
          <small>Status</small>
          <Pill tone={statusTone(assignment.status)}>{STATUS_LABELS[assignment.status]}</Pill>
        </div>
        <div>
          <small>Responsible owner</small>
          <b>{assignment.ownerDisplayName ?? "Unassigned"}</b>
        </div>
        <div>
          <small>Region</small>
          <b>{assignment.regionIds.length > 0 ? assignment.regionIds.join(", ") : "—"}</b>
        </div>
        <div>
          <small>Last updated</small>
          <b>{absoluteTime(assignment.updatedAt)}</b>
        </div>
      </div>

      <div className="workflow" role="tablist" aria-label="Assignment sections" style={{ justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 23 }}>
          <span className="step current" role="tab" aria-selected="true">
            Overview
          </span>
          <button type="button" className="step" role="tab" aria-selected="false" onClick={() => setNotesOpen(true)}>
            Notes &amp; meetings
          </button>
          <button type="button" className="step" role="tab" aria-selected="false" onClick={() => setHistoryOpen(true)}>
            History
          </button>
        </div>
        <span className="scope">
          <Icon name="shield" />
          Authorized record preview
        </span>
      </div>

      {assignment.status !== "CANCELLED" && (
        <div className="workflow" aria-hidden="true">
          {WORKFLOW_STEPS.map((step, i) => (
            <div key={step} className={`step ${i < currentStepIndex ? "done" : i === currentStepIndex ? "current" : ""}`}>
              <i>{i < currentStepIndex ? "✓" : i + 1}</i>
              {STATUS_LABELS[step]}
            </div>
          ))}
        </div>
      )}

      <PanelGrid>
        <Panel span={8}>
          <PanelHead title="Record context" description="Essential details stay visible" />
          <PanelBody>
            <p className="detailcopy">{assignment.brief.instructions ?? assignment.brief.contentRequirementSummary ?? "No brief instructions recorded yet."}</p>
            <div style={{ marginTop: 14 }}>
              <div className="kv">
                <span>Campaign</span>
                <b>{assignment.brief.campaignName}</b>
              </div>
              <div className="kv">
                <span>Partner</span>
                <b>{assignment.partnerDisplayName ?? "Unknown Partner"}</b>
              </div>
              <div className="kv">
                <span>Platform / account context</span>
                <b>
                  {assignment.brief.platforms.length > 0 ? assignment.brief.platforms.map(platformLabel).join(", ") : "—"}
                  {assignment.partnerAccountLabels.length > 0 ? ` · ${assignment.partnerAccountLabels.join(", ")}` : ""}
                </b>
              </div>
              <div className="kv">
                <span>Due date</span>
                <b>{assignment.brief.dueAt ? dateLabel(assignment.brief.dueAt) : "—"}</b>
              </div>
            </div>
          </PanelBody>
        </Panel>
        <AssignmentNextActionPanel assignment={assignment} onSaved={handleAssignmentUpdated} />
      </PanelGrid>

      <div className="grid three">
        <Panel span={4}>
          <PanelHead title="Content" description="Content attached to this assignment" />
          <PanelBody>
            <EmptyState title="Not yet built" description="No real trusted source is wired to this Assignment yet." icon="clock" />
          </PanelBody>
        </Panel>
        <AssignmentWorkflowPanel assignment={assignment} onSaved={handleAssignmentUpdated} />
        <Panel span={4}>
          <PanelHead title="Notes & meetings" description="Keep the conversation with the record" />
          <PanelBody>
            <EmptyState title="Not yet built" description="No real trusted source is wired to this Assignment yet." icon="clock" />
          </PanelBody>
        </Panel>
      </div>

      <AssignmentHistoryDialog assignmentRef={assignment.assignmentRef} open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <AssignmentNotesDialog open={notesOpen} onClose={() => setNotesOpen(false)} />
    </>
  );
}
