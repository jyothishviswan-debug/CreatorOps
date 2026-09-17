"use client";

import { useState } from "react";

import { Panel, PanelBody, PanelHead } from "@/ui/Panel";
import { Icon } from "@/ui/icons";
import type { VendorDto } from "@/server/vendors/client-dto";
import { archiveVendor, restoreVendor, setVendorStatus, type ReadinessIssue } from "./api-client";
import { STATUS_LABELS } from "./format";

type PendingAction = "toggle" | "ARCHIVED" | "restore" | null;

// Governance/lifecycle UI over the real trusted endpoints - purely a
// convenience, never a second authority. Mirrors Partners' own
// PartnerLifecyclePanel exactly, minus Blacklist (Vendors has no
// governance state beyond ACTIVE/INACTIVE/ARCHIVED). ACTIVE<->INACTIVE
// is a freely reversible operational toggle (no reason); ARCHIVED is a
// reasoned governance transition whose dependency check (active Partner
// relationships) only runs server-side on the actual attempt - an
// "unready" result is shown inline without losing the reason the
// operator already typed.
export function VendorLifecyclePanel({ vendor, onSaved }: { vendor: VendorDto; onSaved: (vendor: VendorDto) => void }) {
  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockers, setBlockers] = useState<ReadinessIssue[]>([]);

  const isGovernance = vendor.status === "ARCHIVED";

  function startAction(action: PendingAction) {
    setPending(action);
    setReason("");
    setError(null);
    setBlockers([]);
  }

  async function toggleActiveInactive() {
    setBusy(true);
    setError(null);
    const nextStatus = vendor.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const result = await setVendorStatus(vendor.vendorRef, { status: nextStatus, expectedVersion: vendor.version });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.data);
  }

  async function confirmArchive() {
    if (!reason.trim()) return;
    setBusy(true);
    setError(null);
    setBlockers([]);
    const result = await archiveVendor(vendor.vendorRef, { reason: reason.trim(), expectedVersion: vendor.version });
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
    const result = await restoreVendor(vendor.vendorRef, { expectedVersion: vendor.version });
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
            <b>{STATUS_LABELS[vendor.status]}.</b> {vendor.statusReason ?? "No reason recorded."}
          </div>
        )}

        {pending === "ARCHIVED" ? (
          <div>
            <div className="field full">
              <label htmlFor="vendor-lifecycle-reason">Reason for archiving (required)</label>
              <textarea id="vendor-lifecycle-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
              <button type="button" className="btn primary" disabled={busy || !reason.trim()} onClick={confirmArchive}>
                {busy ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        ) : pending === "restore" ? (
          <div>
            <p className="foundationnote">Restore returns this Vendor to its previous status ({vendor.previousStatus ? STATUS_LABELS[vendor.previousStatus] : "—"}). This never requires a dependency check.</p>
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
                  {busy ? "Saving…" : vendor.status === "ACTIVE" ? "Deactivate" : "Activate"}
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
