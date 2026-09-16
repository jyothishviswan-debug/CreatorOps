"use client";

import { useState } from "react";

import { DialogShell } from "@/ui/Dialog";
import { Pill } from "@/ui/Badge";
import type { LeadDto } from "@/server/discovery/client-dto";
import type { ConversionDto } from "@/server/discovery/conversion-service";
import type { ReadinessResult } from "@/server/discovery/types";
import { convertLead, transitionLifecycle } from "./api-client";
import { DuplicateStatusBanner } from "./DuplicateStatus";
import { absoluteTime } from "./format";

type Props = {
  lead: LeadDto;
  readiness: (ReadinessResult & { leadRef: string; version: number; lifecycle: LeadDto["lifecycle"] }) | null;
  onSaved: (lead: LeadDto) => void;
};

export function ReadyStage({ lead, readiness, onSaved }: Props) {
  const [markingReady, setMarkingReady] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  async function handleMarkReady() {
    setMarkingReady(true);
    setMarkError(null);
    const result = await transitionLifecycle(lead.leadRef, { to: "CONVERSION_READY", expectedVersion: lead.version });
    setMarkingReady(false);
    if (!result.ok) {
      setMarkError(result.error);
      return;
    }
    onSaved({ ...lead, lifecycle: result.data.lifecycle, version: result.data.version });
  }

  if (!readiness) {
    return <p className="foundationnote">Loading readiness…</p>;
  }

  const alreadyReadyOrBeyond = lead.lifecycle === "CONVERSION_READY" || lead.lifecycle === "CONVERTED";

  return (
    <div>
      <div className="kv">
        <span>Readiness</span>
        <Pill tone={readiness.ready ? "default" : "red"}>{readiness.ready ? "Ready" : "Not ready"}</Pill>
      </div>

      {readiness.blockers.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Blockers</h3>
          <ul className="checklist">
            {readiness.blockers.map((b) => (
              <li key={b.code}>
                <span style={{ color: "var(--red)" }}>✕</span> {b.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {readiness.warnings.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>Warnings</h3>
          <ul className="checklist">
            {readiness.warnings.map((w) => (
              <li key={w.code}>
                <span style={{ color: "var(--orange)" }}>!</span> {w.message}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 style={{ marginTop: 18 }}>Duplicate status</h3>
      <DuplicateStatusBanner result={lead.duplicateCheck} />

      <h3 style={{ marginTop: 18 }}>Manager / KYC</h3>
      <div className="kv">
        <span>Manager</span>
        <b>{lead.managerDisplayName ?? "Unassigned"}</b>
      </div>
      <div className="kv">
        <span>KYC package</span>
        <Pill tone={lead.kycPackageComplete ? "default" : "red"}>{lead.kycPackageComplete ? "Complete" : "Incomplete"}</Pill>
      </div>

      {markError && (
        <div className="banner" role="alert" style={{ marginTop: 14 }}>
          {markError}
        </div>
      )}

      <div className="actions" style={{ marginTop: 18 }}>
        {!alreadyReadyOrBeyond && (
          <button type="button" className="btn" disabled={!readiness.ready || markingReady} onClick={handleMarkReady}>
            {markingReady ? "Marking…" : "Mark conversion ready"}
          </button>
        )}
        <button type="button" className="btn primary" disabled={lead.lifecycle !== "CONVERSION_READY"} onClick={() => setDialogOpen(true)}>
          Convert to Partner
        </button>
      </div>
      {!readiness.ready && <small style={{ display: "block", marginTop: 8 }}>Resolve every blocker above before this Lead can be marked conversion ready.</small>}

      <ConversionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} lead={lead} readiness={readiness} onConverted={onSaved} />
    </div>
  );
}

function ConversionDialog({
  open,
  onClose,
  lead,
  readiness,
  onConverted,
}: {
  open: boolean;
  onClose: () => void;
  lead: LeadDto;
  readiness: ReadinessResult;
  onConverted: (lead: LeadDto) => void;
}) {
  const [converting, setConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConversionDto | null>(null);
  const [idempotencyKey] = useState(() => `${lead.leadRef}-${Date.now()}`);

  async function handleConfirm() {
    setConverting(true);
    setError(null);
    const response = await convertLead(lead.leadRef, { idempotencyKey, expectedVersion: lead.version });
    setConverting(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
    onConverted({ ...lead, lifecycle: "CONVERTED", conversion: { convertedAt: response.data.convertedAt, convertedByUserRef: "", partnerRef: response.data.partnerRef, partnerAccountRef: response.data.partnerAccountRef, idempotencyKey } });
  }

  // Not rendered at all while closed - a native <dialog> that's merely
  // "closed" still keeps its children in the DOM/accessibility tree,
  // which would otherwise duplicate this dialog's own readiness/status
  // text alongside the same text on the underlying Ready stage panel.
  if (!open) return null;

  return (
    <DialogShell open={open} title="Convert to Partner" onClose={onClose}>
      {result ? (
        <div>
          <div className="banner" role="status">
            <b>Converted.</b> This Lead is now linked to a canonical Partner.
          </div>
          <div className="kv">
            <span>Partner reference</span>
            <b style={{ fontFamily: "monospace", fontSize: 11 }}>{result.partnerRef}</b>
          </div>
          <div className="kv">
            <span>Partner Account</span>
            <b>{result.partnerAccountRef ? <span style={{ fontFamily: "monospace", fontSize: 11 }}>{result.partnerAccountRef}</span> : result.pendingPartnerAccountSetup ? "Setup pending (New Account)" : "None"}</b>
          </div>
          <button type="button" className="btn primary" style={{ marginTop: 16 }} onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        <div>
          <p>Review before confirming - this action is trusted-server-authoritative and idempotent.</p>
          <div className="kv">
            <span>Readiness</span>
            <Pill tone={readiness.ready ? "default" : "red"}>{readiness.ready ? "Ready" : "Not ready"}</Pill>
          </div>
          {readiness.blockers.length > 0 && (
            <div className="kv">
              <span>Blockers</span>
              <b>{readiness.blockers.map((b) => b.message).join("; ")}</b>
            </div>
          )}
          {readiness.warnings.length > 0 && (
            <div className="kv">
              <span>Warnings</span>
              <b>{readiness.warnings.map((w) => w.message).join("; ")}</b>
            </div>
          )}
          <div className="kv">
            <span>Duplicate status</span>
            <b>{lead.duplicateCheck?.status ?? "unknown"}</b>
          </div>
          <div className="kv">
            <span>Identity</span>
            <b>
              {lead.displayName} · {lead.email ?? "no email"} · {lead.profileUrl ?? "no profile URL"}
            </b>
          </div>
          <div className="kv">
            <span>Asset decision</span>
            <b>{lead.assetDecision?.decision ?? "None"}{lead.assetDecision?.decision === "NEW_ACCOUNT" ? " (no Partner Account created yet - pending setup)" : ""}</b>
          </div>
          <div className="kv">
            <span>Manager</span>
            <b>{lead.managerDisplayName ?? "Unassigned"}</b>
          </div>
          <div className="kv">
            <span>Provenance</span>
            <b>
              Source: {lead.source.type} · Created {absoluteTime(lead.createdAt)}
            </b>
          </div>

          {error && (
            <div className="banner" role="alert" style={{ marginTop: 14 }}>
              {error}
            </div>
          )}

          <div className="actions" style={{ marginTop: 18 }}>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={converting} onClick={handleConfirm}>
              {converting ? "Converting…" : "Confirm conversion"}
            </button>
          </div>
        </div>
      )}
    </DialogShell>
  );
}

export function ConvertedStage({ lead }: { lead: LeadDto }) {
  if (!lead.conversion) {
    return <p className="foundationnote">Not yet converted.</p>;
  }
  return (
    <div>
      <div className="banner" role="status">
        <b>This Lead has been converted.</b> Discovery history remains fully accessible below.
      </div>
      <div className="kv">
        <span>Partner reference</span>
        <b style={{ fontFamily: "monospace", fontSize: 11 }}>{lead.conversion.partnerRef}</b>
      </div>
      <div className="kv">
        <span>Partner Account</span>
        <b>{lead.conversion.partnerAccountRef ? <span style={{ fontFamily: "monospace", fontSize: 11 }}>{lead.conversion.partnerAccountRef}</span> : "Pending setup (New Account)"}</b>
      </div>
      <div className="kv">
        <span>Converted</span>
        <b>{absoluteTime(lead.conversion.convertedAt)}</b>
      </div>
      <p className="foundationnote" style={{ marginTop: 12 }}>
        A dedicated Partners workspace isn&rsquo;t built yet - this reference is the canonical link. No Vendor is created by this ordinary individual-Partner conversion.
      </p>
    </div>
  );
}
