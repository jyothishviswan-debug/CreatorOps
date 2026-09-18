"use client";

import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { absoluteTime, contentDisplayTitle, STATUS_LABELS, statusTone } from "@/features/content/format";
import { useAssignmentContentFulfillment } from "./useAssignmentContentFulfillment";

// Step 11A.1: replaces the old "list of Content rows + Plan Content
// button" shape - there is now at most ONE canonical Content thread per
// Assignment, created automatically the first time a public submission
// link is shared (see resolveOrCreateContentThread, called from
// createExternalSubmissionSession). No manual create control exists
// anymore (PlanContentDialog.tsx is retired) - it would contradict the
// automatic-creation design.
export function AssignmentContentPanel({ assignment }: { assignment: AssignmentDto }) {
  const fulfillment = useAssignmentContentFulfillment(assignment.assignmentRef);
  const thread = fulfillment.thread;

  return (
    <Panel span={4}>
      <PanelHead title="Content" description="This Assignment's submission thread" />
      <PanelBody>
        {fulfillment.loading ? (
          <Skeleton lines={3} />
        ) : fulfillment.error ? (
          <div className="banner" role="alert">
            {fulfillment.error}
          </div>
        ) : !thread ? (
          <EmptyState
            title="No submission thread yet"
            description="A submission thread is created automatically the first time a public submission link is shared for this Assignment."
            icon="clock"
          />
        ) : (
          <Link href={`/content/${thread.contentRef}`} className="rowlink" style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
            <span>
              <b>{contentDisplayTitle(thread)}</b>
              <br />
              <small>{thread.lastSubmittedAt ? `Last submitted ${absoluteTime(thread.lastSubmittedAt)}` : "No submission yet"}</small>
            </span>
            <Pill tone={statusTone(thread.status)}>{STATUS_LABELS[thread.status]}</Pill>
          </Link>
        )}
      </PanelBody>
    </Panel>
  );
}
