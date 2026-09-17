"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Icon } from "@/ui/icons";
import type { PartnerDto } from "@/server/partners/client-dto";
import { archivePartner, blacklistPartner, restorePartner, setPartnerStatus, type ReadinessIssue } from "./api-client";
import { STATUS_LABELS } from "./format";

type PendingAction = "toggle" | "BLACKLISTED" | "ARCHIVED" | "restore" | null;

// Governance/lifecycle UI over the real Step 7A trusted endpoints - purely
// a convenience, never a second authority. ACTIVE<->INACTIVE is a
// freely reversible operational toggle (no reason); BLACKLISTED/ARCHIVED
// are reasoned governance transitions whose dependency check only runs
// server-side on the actual attempt (there is no separate precheck
// endpoint) - an "unready" result is shown inline without leaving the
// reason the operator already typed. Same inline-reason idiom as
// Discovery's AlternativeOutcomes (a native confirm() was rejected there
// as unreliable in embedded browser contexts).
export function PartnerLifecyclePanel({ partner, onSaved }: { partner: PartnerDto; onSaved: (partner: PartnerDto) => void }) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ReadinessIssue[]>([]);

  const isGovernance = partner.status === "BLACKLISTED" || partner.status === "ARCHIVED";

  function startAction(action: PendingAction) {
    setPending(action);
    setReason("");
    setError(null);
    setBlockers([]);
  }

  async function toggleActiveInactive() {
    setBusy(true);
    setError(null);
    const nextStatus = partner.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const result = await setPartnerStatus(partner.partnerRef, { status: nextStatus, expectedVersion: partner.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  async function confirmReasoned() {
    if (!pending || pending === "toggle" || !reason.trim()) return;
    setBusy(true);
    setError(null);
    setBlockers([]);
    const result =
      pending === "restore"
        ? await restorePartner(partner.partnerRef, { expectedVersion: partner.version })
        : pending === "BLACKLISTED"
          ? await blacklistPartner(partner.partnerRef, { reason: reason.trim(), expectedVersion: partner.version })
          : await archivePartner(partner.partnerRef, { reason: reason.trim(), expectedVersion: partner.version });
    setBusy(false);
    if (!result.ok) {
      if (result.code === "not_ready") setBlockers(result.blockers ?? []);
      setError(result.error);
      return;
    }
    setPending(null);
    onSaved(result.data);
  }

  async function confirmRestore() {
    setBusy(true);
    setError(null);
    const result = await restorePartner(partner.partnerRef, { expectedVersion: partner.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPending(null);
    onSaved(result.data);
  }

  return (
    <Panel span={12}>
      <PanelHead title="Lifecycle / governance" description="Reasoned, authorized status transitions - workflow context, never a second lifecycle authority." />
      <PanelBody>
        {isGovernance && (
          <div className="banner" role="status" style={{ marginBottom: 14 }}>
            <b>{STATUS_LABELS[partner.status]}.</b> {partner.statusReason ?? "No reason recorded."}
          </div>
        )}

        {pending === "BLACKLISTED" || pending === "ARCHIVED" ? (
          <div>
            <div className="field full">
              <label htmlFor="lifecycle-reason">Reason for moving to {STATUS_LABELS[pending]} (required)</label>
              <textarea id="lifecycle-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
              <button type="button" className="btn primary" disabled={busy || !reason.trim()} onClick={confirmReasoned}>
                {busy ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        ) : pending === "restore" ? (
          <div>
            <p className="foundationnote">Restore returns this Partner to its previous status ({partner.previousStatus ? STATUS_LABELS[partner.previousStatus] : "—"}). This never requires a dependency check.</p>
            {error && (
              <div className="banner" role="alert" style={{ marginTop: 10 }}>
                {error}
              </div>
            )}
            <div className="actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={confirmRestore}>
                {busy ? "Restoring…" : "Confirm restore"}
              </button>
            </div>
          </div>
        ) : (
          <div className="actions">
            {!isGovernance && (
              <>
                <button type="button" className="btn" disabled={busy} onClick={toggleActiveInactive}>
                  {busy ? "Saving…" : partner.status === "ACTIVE" ? "Deactivate" : "Activate"}
                </button>
                <button type="button" className="btn" onClick={() => startAction("BLACKLISTED")}>
                  Blacklist
                </button>
                <button type="button" className="btn" onClick={() => startAction("ARCHIVED")}>
                  Archive
                </button>
              </>
            )}
            {isGovernance && (
              <button type="button" className="btn primary" onClick={() => startAction("restore")}>
                <Icon name="check" /> Restore
              </button>
            )}
            {error && (
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
