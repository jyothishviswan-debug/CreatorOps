"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { contentDisplayTitle, contentTypeLabel, platformLabel, STATUS_LABELS, statusTone } from "@/features/content/format";
import { useAssignmentContentFulfillment } from "./useAssignmentContentFulfillment";
import { PlanContentDialog } from "./PlanContentDialog";

const PLANNABLE_STATUSES = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

// Step 11B: replaces the "Not yet built" Content panel on Assignment
// Detail with a real, stateful, bounded read of Content attached to this
// Assignment. Keeps the exact same Panel span={4} / title "Content" /
// description "Content attached to this assignment" shell.
// `onContentPlanned` mirrors AssignmentDetail's own `handleAssignmentUpdated`
// signature so it can be wired in directly - planning Content never
// mutates the Assignment itself (no Assignment API call happens here), so
// it is invoked with the same, unchanged AssignmentDto purely as a
// "something happened here" signal for the parent.
export function AssignmentContentPanel({ assignment, onContentPlanned }: { assignment: AssignmentDto; onContentPlanned: (assignment: AssignmentDto) => void }) {
  const [planOpen, setPlanOpen] = useState(false);
  const requiredCount = assignment.brief.requiredCount ?? 1;
  const fulfillment = useAssignmentContentFulfillment(assignment.assignmentRef, requiredCount);

  const plannedRequiredSlots = fulfillment.contentList.filter((c) => c.requiredSlotIndex !== null).length;
  const canPlan = PLANNABLE_STATUSES.has(assignment.status);

  function handleCreated() {
    fulfillment.refresh();
    onContentPlanned(assignment);
  }

  return (
    <Panel span={4}>
      <PanelHead title="Content" description="Content attached to this assignment" />
      <PanelBody>
        {fulfillment.loading ? (
          <Skeleton lines={3} />
        ) : fulfillment.error ? (
          <div className="banner" role="alert">
            {fulfillment.error}
          </div>
        ) : fulfillment.contentList.length === 0 ? (
          <EmptyState title="No Content yet" description="Content created for this Assignment will appear here." icon="clock" />
        ) : (
          <>
            <p className="detailcopy" style={{ marginBottom: 12 }}>
              {fulfillment.qualifyingCount} of {requiredCount} required Content completed
            </p>
            <div>
              {fulfillment.contentList.map((c) => (
                <Link key={c.contentRef} href={`/content/${c.contentRef}`} className="rowlink" style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                  <span>
                    <b>{contentDisplayTitle(c)}</b>
                    <br />
                    <small>
                      {contentTypeLabel(c.contentType)} · {platformLabel(c.platform)}
                    </small>
                  </span>
                  <Pill tone={statusTone(c.status)}>{STATUS_LABELS[c.status]}</Pill>
                </Link>
              ))}
            </div>
          </>
        )}

        {canPlan && (
          <div className="actions" style={{ marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => setPlanOpen(true)}>
              Plan Content
            </button>
          </div>
        )}
      </PanelBody>

      <PlanContentDialog assignment={assignment} plannedRequiredSlots={plannedRequiredSlots} open={planOpen} onClose={() => setPlanOpen(false)} onCreated={handleCreated} />
    </Panel>
  );
}
