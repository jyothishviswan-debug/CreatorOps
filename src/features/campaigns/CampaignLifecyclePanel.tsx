"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { CampaignDto } from "@/server/campaigns/client-dto";
import type { CampaignStatus } from "@/server/campaigns/types";
import { transitionCampaignLifecycle, type ReadinessIssue } from "./api-client";
import { STATUS_LABELS } from "./format";

// Step 9B section 8: the exact accepted 12-edge lifecycle graph, used
// ONLY to decide which buttons to show - never to duplicate readiness
// business rules (those stay exclusively server-side; a click always
// calls the real trusted transition endpoint, which is the sole
// authority on whether the move actually succeeds). Action visibility
// here follows the CURRENT STATUS only, never a role-name check - the
// server independently re-authorizes every attempt and returns a plain
// "Forbidden." error if the actor lacks the action, same idiom as
// Vendors'/Partners' own lifecycle panels (which also never hide a
// button by role, only by current state).
const ORDINARY_NEXT: Record<CampaignStatus, { to: CampaignStatus; label: string }[]> = {
  DRAFT: [{ to: "PLANNED", label: "Move to Planned" }],
  PLANNED: [
    { to: "ACTIVE", label: "Activate" },
    { to: "DRAFT", label: "Back to Draft" },
  ],
  ACTIVE: [
    { to: "PAUSED", label: "Pause" },
    { to: "COMPLETED", label: "Mark Completed" },
  ],
  PAUSED: [{ to: "ACTIVE", label: "Resume" }],
  COMPLETED: [],
  CANCELLED: [],
  ARCHIVED: [],
};

// CANCELLED is reachable from every one of these; ARCHIVED only from
// COMPLETED/CANCELLED - both always reasoned.
const CAN_CANCEL: CampaignStatus[] = ["DRAFT", "PLANNED", "ACTIVE", "PAUSED"];
const CAN_ARCHIVE: CampaignStatus[] = ["COMPLETED", "CANCELLED"];

type Pending = { kind: "ordinary"; to: CampaignStatus } | { kind: "cancel" } | { kind: "archive" } | null;

export function CampaignLifecyclePanel({ campaign, onSaved }: { campaign: CampaignDto; onSaved: (campaign: CampaignDto) => void }) {
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ReadinessIssue[]>([]);

  function start(next: Pending) {
    setPending(next);
    setReason("");
    setError(null);
    setBlockers([]);
  }

  async function runOrdinary(to: CampaignStatus) {
    setBusy(true);
    setError(null);
    setBlockers([]);
    const result = await transitionCampaignLifecycle(campaign.campaignRef, { to, expectedVersion: campaign.version });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "not_ready") setBlockers(result.blockers ?? []);
      setError(result.error);
      return;
    }
    setPending(null);
    onSaved({ ...campaign, status: result.data.status, version: result.data.version, statusReason: null });
  }

  async function confirmReasoned(to: "CANCELLED" | "ARCHIVED") {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    setBlockers([]);
    const result = await transitionCampaignLifecycle(campaign.campaignRef, { to, reason: reason.trim(), expectedVersion: campaign.version });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "not_ready") setBlockers(result.blockers ?? []);
      setError(result.error);
      return;
    }
    setPending(null);
    onSaved({ ...campaign, status: result.data.status, version: result.data.version, statusReason: reason.trim() });
  }

  const isTerminal = campaign.status === "ARCHIVED";
  const ordinaryOptions = ORDINARY_NEXT[campaign.status];
  const canCancel = CAN_CANCEL.includes(campaign.status);
  const canArchive = CAN_ARCHIVE.includes(campaign.status);

  return (
    <Panel span={12}>
      <PanelHead title="Lifecycle" description="Reasoned, authorized status transitions - workflow context, never a second lifecycle authority. Completion never implies Finance/Analytics/Content are closed." />
      <PanelBody>
        {(campaign.status === "CANCELLED" || campaign.status === "ARCHIVED") && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <b>{STATUS_LABELS[campaign.status]}.</b> {campaign.statusReason ?? "No reason recorded."}
          </div>
        )}

        {pending?.kind === "cancel" || pending?.kind === "archive" ? (
          <div>
            <div className="field full">
              <label htmlFor="campaign-lifecycle-reason">Reason for {pending.kind === "cancel" ? "cancelling" : "archiving"} (required)</label>
              <textarea id="campaign-lifecycle-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || !reason.trim()}
                onClick={() => confirmReasoned(pending.kind === "cancel" ? "CANCELLED" : "ARCHIVED")}
              >
                {busy ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions" style={{ flexWrap: "wrap" }}>
            {ordinaryOptions.map((opt) => (
              <button key={opt.to} type="button" className="btn" disabled={busy} onClick={() => runOrdinary(opt.to)}>
                {busy ? "Saving…" : opt.label}
              </button>
            ))}
            {canCancel && (
              <button type="button" className="btn" onClick={() => start({ kind: "cancel" })}>
                Cancel campaign
              </button>
            )}
            {canArchive && (
              <button type="button" className="btn" onClick={() => start({ kind: "archive" })}>
                Archive
              </button>
            )}
            {isTerminal && <p className="foundationnote">Archived is a terminal state - no restore is available.</p>}

            {blockers.length > 0 && (
              <div className="banner" role="alert" style={{ marginTop: 10, width: "100%" }}>
                <b>Not ready.</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {blockers.map((b) => (
                    <li key={b.code}>{b.message}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && blockers.length === 0 && (
              <div className="banner" role="alert" style={{ marginTop: 10, width: "100%" }}>
                {error}
              </div>
            )}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
