"use client";

import { useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Pill } from "@/ui/Badge";
import { EmptyState, Skeleton } from "@/ui/States";
import type { AssignmentDto } from "@/server/assignments/client-dto";
import { recordContentLinksOnBehalf } from "@/features/content/api-client";
import { absoluteTime, contentDisplayTitle, STATUS_LABELS, statusTone } from "@/features/content/format";
import { useAssignmentContentFulfillment } from "./useAssignmentContentFulfillment";

const CONTENT_GENERATION_STATUSES = new Set(["ASSIGNED", "ACCEPTED", "IN_PROGRESS"]);

// Finding #44 (user-decided): a Manager recording a content link on the Partner's behalf - the one
// place this action lives, since it always requires an Assignment context (never orphan Content). A
// compact inline form, not a dialog - this is a narrow, occasional action, not a primary workflow step.
function RecordLinkOnBehalfForm({ assignment, onRecorded }: { assignment: AssignmentDto; onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState(assignment.brief.platforms[0] ?? "");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await recordContentLinksOnBehalf({ assignmentRef: assignment.assignmentRef, rows: [{ platform, url }] });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setUrl("");
    setOpen(false);
    onRecorded();
  }

  if (!open) {
    return (
      <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        Record link on Partner&apos;s behalf
      </button>
    );
  }

  return (
    <div className="fields" style={{ marginTop: 10 }}>
      <div className="field">
        <label>Platform</label>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {assignment.brief.platforms.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="field full">
        <label>Post URL</label>
        <input type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      {error && (
        <div className="banner" role="alert" style={{ marginBottom: 0 }}>
          {error}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy || !url.trim() || !platform}>
          {busy ? "Recording…" : "Record link"}
        </button>
      </div>
    </div>
  );
}

// Finding #50 (reopened): replaces the old "at most one thread" single-row
// shape - an Assignment may now own several Content records over its
// lifetime (one per submission cycle), created automatically each time a
// public submission link is shared for it while its current record (if
// any) is already closed (see resolveOrCreateContentThread, called from
// createExternalSubmissionSession). PlanContentDialog.tsx (a manual, no-
// links "plan the deliverable" control) is retired - it would contradict
// the automatic-creation design. Finding #44 (user-decided) adds the ONE
// real manual control back: a Manager recording an actual link on the
// Partner's behalf, which reuses this exact automatic-thread mechanism
// under the hood (see RecordLinkOnBehalfForm above).
export function AssignmentContentPanel({ assignment }: { assignment: AssignmentDto }) {
  const requiredCount = assignment.brief.requiredCount ?? 1;
  const fulfillment = useAssignmentContentFulfillment(assignment.assignmentRef, requiredCount);
  const threads = fulfillment.threads;

  return (
    <Panel span={4}>
      <PanelHead
        title="Content"
        description={fulfillment.loading || fulfillment.error ? "This Assignment's submission history" : `${fulfillment.qualifyingCount} of ${fulfillment.requiredCount} approved`}
      />
      <PanelBody>
        {fulfillment.loading ? (
          <Skeleton lines={3} />
        ) : fulfillment.error ? (
          <div className="banner" role="alert">
            {fulfillment.error}
          </div>
        ) : threads.length === 0 ? (
          <EmptyState
            title="No submission thread yet"
            description="A submission thread is created automatically the first time a public submission link is shared for this Assignment."
            icon="clock"
          />
        ) : (
          threads.map((thread) => (
            <Link
              key={thread.contentRef}
              href={`/content/${thread.contentRef}`}
              className="rowlink"
              style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}
            >
              <span>
                <b>{contentDisplayTitle(thread)}</b>
                <br />
                <small>{thread.lastSubmittedAt ? `Last submitted ${absoluteTime(thread.lastSubmittedAt)}` : "No submission yet"}</small>
              </span>
              <Pill tone={statusTone(thread.status)}>{STATUS_LABELS[thread.status]}</Pill>
            </Link>
          ))
        )}
        {CONTENT_GENERATION_STATUSES.has(assignment.status) && assignment.brief.platforms.length > 0 && (
          <RecordLinkOnBehalfForm assignment={assignment} onRecorded={fulfillment.refresh} />
        )}
      </PanelBody>
    </Panel>
  );
}
