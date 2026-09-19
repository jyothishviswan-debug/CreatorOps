"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { EmptyState } from "@/ui/States";
import type { CampaignDownstreamSummaryDto } from "@/server/campaigns/detail-downstream-service";
import { getCampaignDownstream } from "./api-client";
import { analyticsReadinessLabel, assignmentsTotalLabel, countLabel, partnersLabel } from "./downstream-format";
import { CreateAssignmentDialog } from "./CreateAssignmentDialog";
import { dateLabel } from "./format";

// Step 12C.1: the existing "Downstream availability" area of Campaign
// Detail's Overview tab, now wired to real trusted data - SAME Panel ->
// PanelHead -> PanelBody -> .stategrid -> 3 .statecard structure and
// order as before (Assignments, Content, Analytics); no new panel, tab,
// page or sidebar. Every number comes from the server's own
// getCampaignDownstreamSummary DTO (bounded, actor-scoped, no browser-side
// joins). The "Create Assignment" action lives in the Assignments card and
// is rendered ONLY when the server DTO says canCreateAssignment - the
// client performs no role or lifecycle checks of its own, so nothing
// flashes before the server has decided.
export function CampaignDownstreamPanel({
  campaignRef,
  summary,
  summaryKey,
  onSummaryChange,
  refreshKey,
}: {
  campaignRef: string;
  // Lifted into CampaignDetail so the last-known summary survives the
  // Overview tab unmounting/remounting when the user switches tabs.
  summary: CampaignDownstreamSummaryDto | null;
  // The refreshKey the held summary was derived at - a mismatch with the
  // current refreshKey (a lifecycle/plan edit happened, possibly while this
  // panel was unmounted on another tab) means the summary is stale.
  summaryKey: number;
  onSummaryChange: (summary: CampaignDownstreamSummaryDto, key: number) => void;
  refreshKey: number;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // On failure the last-shown numbers are kept (never blanked or guessed);
  // the alert below only appears when there is nothing to show at all.
  const refresh = useCallback(async () => {
    const result = await getCampaignDownstream(campaignRef);
    if (result.ok) onSummaryChange(result.data, refreshKey);
  }, [campaignRef, onSummaryChange, refreshKey]);

  // A Campaign lifecycle/plan mutation elsewhere on the page bumps
  // refreshKey - the create-action's visibility (lifecycle-dependent) and
  // the counts are re-derived by the server, never guessed client-side.
  useEffect(() => {
    if (summaryKey === refreshKey) return;
    void refresh();
  }, [summaryKey, refreshKey, refresh]);

  function handleDialogClose(changed: boolean) {
    setDialogOpen(false);
    if (changed) void refresh();
    // The dialog unmounts on close, so the native "restore focus to the
    // opener" step cannot be relied on for the Done button path - put focus
    // back on the trigger explicitly.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <Panel span={12}>
      <PanelHead title="Downstream availability" description="Assignments, Content and Analytics linked to this Campaign - counts come from the trusted records you are allowed to see." />
      <PanelBody>
        {!summary && (
          <div className="banner" role="alert">
            Could not load the linked-records summary.
            <button type="button" className="btn" onClick={() => void refresh()}>
              Retry
            </button>
          </div>
        )}
        <div className="stategrid">
          <div className="statecard">
            {summary?.assignments.available ? (
              <>
                <h3>Assignments</h3>
                <div className="kv">
                  <span>Total</span>
                  <span>{assignmentsTotalLabel(summary.assignments.total, summary.assignments.truncated)}</span>
                </div>
                <div className="kv">
                  <span>Partners</span>
                  <span>{partnersLabel(summary.assignments.distinctPartnerCount, summary.assignments.truncated)}</span>
                </div>
                <div className="kv">
                  <span>Status</span>
                  <span>
                    {countLabel(summary.assignments.draftCount, summary.assignments.truncated)} draft · {countLabel(summary.assignments.issuedCount, summary.assignments.truncated)} issued
                  </span>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  {summary.canCreateAssignment && (
                    <button type="button" ref={triggerRef} className="btn primary" onClick={() => setDialogOpen(true)}>
                      Create Assignment
                    </button>
                  )}
                  <Link href="/assignments" className="btn">
                    Open Assignments
                  </Link>
                </div>
              </>
            ) : (
              <EmptyState title="Assignments" description={summary ? "You don't have access to Assignments." : "Not available right now."} icon="lock" />
            )}
          </div>

          <div className="statecard">
            {summary?.content.available ? (
              <>
                <h3>Content</h3>
                <div className="kv">
                  <span>Approved</span>
                  <span>{countLabel(summary.content.approvedCount, summary.content.truncated)}</span>
                </div>
                <div className="kv">
                  <span>Awaiting review</span>
                  <span>{countLabel(summary.content.underReviewCount, summary.content.truncated)}</span>
                </div>
                <div className="kv">
                  <span>Changes requested</span>
                  <span>{countLabel(summary.content.revisionRequestedCount, summary.content.truncated)}</span>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <Link href="/content" className="btn">
                    Open Content
                  </Link>
                </div>
              </>
            ) : (
              <EmptyState title="Content" description={summary ? "You don't have access to Content." : "Not available right now."} icon="lock" />
            )}
          </div>

          <div className="statecard">
            {summary?.analytics.available ? (
              <>
                <h3>Analytics</h3>
                <div className="kv">
                  <span>Readiness</span>
                  <span>{analyticsReadinessLabel(summary.analytics)}</span>
                </div>
                <div className="kv">
                  <span>Last data</span>
                  <span>{summary.analytics.lastDataAt ? dateLabel(summary.analytics.lastDataAt) : "—"}</span>
                </div>
                <div className="actions" style={{ marginTop: 12 }}>
                  <Link href="/analytics/explorer" className="btn">
                    Open Analytics Explorer
                  </Link>
                </div>
              </>
            ) : (
              <EmptyState title="Analytics" description={summary ? "You don't have access to Analytics data." : "Not available right now."} icon="lock" />
            )}
          </div>
        </div>
      </PanelBody>
      {dialogOpen && <CreateAssignmentDialog campaignRef={campaignRef} onClose={handleDialogClose} />}
    </Panel>
  );
}
