"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { CONTENT_LIFECYCLE_TRANSITIONS, canTransitionLifecycle } from "@/server/authz/lifecycle";
import type { ContentDto } from "@/server/content/client-dto";
import { cancelContent, type ContentReadinessIssue } from "./api-client";
import { dateLabel } from "./format";

// Step 11A.1: "Content workflow" panel - Due date / Fulfillment kv rows
// only now (reviewPolicy is retired from Content's own state machine -
// review is always required, unconditionally, for every thread; the
// owning Campaign's/Assignment's own reviewPolicy field still exists for
// other purposes but no longer drives anything shown here). The
// legal-cancel check is derived DIRECTLY from the same single lifecycle
// table the server itself enforces (CONTENT_LIFECYCLE_TRANSITIONS's own
// CANCELLED predecessor list), via canTransitionLifecycle - never a
// second, separately-hand-maintained status list that could drift from
// the real backend rule.
function fulfillmentLabel(content: ContentDto): string {
  if (!content.qualifyingFulfillment) return "Pending qualification";
  if (content.qualifyingFulfillment.kind === "QUALIFYING_REQUIRED") return "Qualifying required Content";
  if (content.qualifyingFulfillment.kind === "QUALIFYING_EXTRA") return "Extra Content";
  return "Not qualifying — no longer matches Assignment obligation";
}

export function ContentWorkflowPanel({ content, onSaved }: { content: ContentDto; onSaved: (content: ContentDto) => void }) {
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ContentReadinessIssue[]>([]);

  const canCancel = canTransitionLifecycle(content.status, "CANCELLED", CONTENT_LIFECYCLE_TRANSITIONS);

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
    const result = await cancelContent(content.contentRef, { reason: reason.trim(), expectedVersion: content.version });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "not_ready") setBlockers(result.blockers ?? []);
      setError(result.error);
      return;
    }
    setCancelling(false);
    onSaved(result.data);
  }

  return (
    <Panel span={4}>
      <PanelHead title="Content workflow" description="Canonical source remains authoritative" />
      <PanelBody>
        <div className="kv">
          <span>Due date</span>
          <b>{content.dueAt ? dateLabel(content.dueAt) : "—"}</b>
        </div>
        <div className="kv">
          <span>Fulfillment</span>
          <b>{fulfillmentLabel(content)}</b>
        </div>

        {cancelling ? (
          <div style={{ marginTop: 14 }}>
            <div className="field full">
              <label htmlFor="content-cancel-reason">Reason for cancelling (required)</label>
              <textarea id="content-cancel-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
                Cancel Content
              </button>
            </div>
          )
        )}
      </PanelBody>
    </Panel>
  );
}
