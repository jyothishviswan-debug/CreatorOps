"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { LeadLifecycle } from "@/server/discovery/types";
import { restoreLead, transitionLifecycle } from "./api-client";
import { LIFECYCLE_LABELS } from "./format";
import { isAlternativeOutcome } from "./workflow";

const SET_ASIDE_TARGETS: { to: LeadLifecycle; label: string }[] = [
  { to: "WATCHLIST", label: "Watchlist" },
  { to: "REJECTED", label: "Reject" },
  { to: "ARCHIVED", label: "Archive" },
  { to: "DUPLICATE", label: "Mark duplicate" },
];

// Step 6B: "Watchlist/Reject/Archive require reasoned authorized
// restore/reactivation. Duplicate is terminal and must not show a
// restore action." This panel is purely a UI convenience over the
// existing transitionLifecycle/restoreLead trusted endpoints - it never
// decides what's allowed, the server does (a rejected transition simply
// surfaces the server's own error).
export function AlternativeOutcomes({ lead, onSaved, span = 12 }: { lead: LeadDto; onSaved: (lead: LeadDto) => void; span?: 6 | 12 }) {
  const [pending, setPending] = useState<LeadLifecycle | "restore" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (lead.lifecycle === "CONVERTED") return null;

  const isAltOutcome = isAlternativeOutcome(lead.lifecycle);
  const canRestore = isAltOutcome && lead.lifecycle !== "DUPLICATE";

  function startAction(action: LeadLifecycle | "restore") {
    setPending(action);
    setReason("");
    setError(null);
  }

  async function confirmAction() {
    if (!pending || !reason.trim()) return;
    setBusy(true);
    setError(null);
    const result =
      pending === "restore"
        ? await restoreLead(lead.leadRef, { reason: reason.trim(), expectedVersion: lead.version })
        : await transitionLifecycle(lead.leadRef, { to: pending, reason: reason.trim(), expectedVersion: lead.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPending(null);
    // transitionLifecycle/restoreLead only return {version, lifecycle} -
    // the reason just submitted is known client-side already (it's what
    // the server was just asked to record), so it's merged in directly
    // rather than requiring a second round-trip just to read it back.
    onSaved({ ...lead, lifecycle: result.data.lifecycle, lifecycleReason: reason.trim(), version: result.data.version });
  }

  return (
    <Panel span={span}>
      <PanelHead title="Alternative outcomes" description="Reasoned, authorized set-aside/restore - workflow context, never a second lifecycle authority." />
      <PanelBody>
        {isAltOutcome && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <b>{LIFECYCLE_LABELS[lead.lifecycle]}.</b> {lead.lifecycleReason ?? "No reason recorded."}
          </div>
        )}

        {pending ? (
          <div>
            <div className="field full">
              <label htmlFor="alt-outcome-reason">Reason {pending === "restore" ? "for restoring" : `for moving to ${LIFECYCLE_LABELS[pending as LeadLifecycle]}`} (required)</label>
              <textarea id="alt-outcome-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
            </div>
            {error && (
              <div className="banner" role="alert" style={{ marginTop: 10 }}>
                {error}
              </div>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={busy || !reason.trim()} onClick={confirmAction}>
                {busy ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            {!isAltOutcome &&
              SET_ASIDE_TARGETS.map((target) => (
                <button key={target.to} type="button" className="btn" onClick={() => startAction(target.to)}>
                  {target.label}
                </button>
              ))}
            {canRestore && (
              <button type="button" className="btn primary" onClick={() => startAction("restore")}>
                Restore
              </button>
            )}
            {lead.lifecycle === "DUPLICATE" && <small>Duplicate is terminal - no restore action is available.</small>}
          </div>
        )}
      </PanelBody>
    </Panel>
  );
}
