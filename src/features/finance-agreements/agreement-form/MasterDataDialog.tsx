"use client";

// Step 14C.3: the explicit, separate master-data update dialog - only identity/contact/KYC fields ever reach this (never
// commercial terms). Built on DialogShell (the Foundation `.dialoghead`/`.dialogbody`/`.dialogfoot` archetype).
import { useId, useState } from "react";

import { DialogShell } from "@/ui/Dialog";

import type { CrossVerificationAction, CrossVerificationRow } from "../cross-verification";
import { buildMasterDataRequest, describeMasterDataAction } from "../agreement-intake-logic/cross-verification-ui";
import { readCounterpartyVersion } from "../agreement-intake-logic/owning-versions";
import { useIntake } from "../agreement-intake-logic/intake-context";
import { DISABLED_BUTTON_STYLE } from "../format";

export function MasterDataDialog({ row, action, onClose }: { row: CrossVerificationRow; action: CrossVerificationAction; onClose: () => void }) {
  const intake = useIntake();
  const id = useId();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const counterparty = intake.counterparty;
  if (!counterparty) return null;
  const copy = describeMasterDataAction(row, action, counterparty.type);
  if (!copy) return null;

  const confirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      let expectedCounterpartyVersion: number | null = null;
      if (action.masterData?.target.via === "contact") {
        const versionRead = await readCounterpartyVersion(counterparty.type, counterparty.ref);
        if (!versionRead.ok) {
          setError(versionRead.message);
          return;
        }
        expectedCounterpartyVersion = versionRead.version;
      }
      const built = buildMasterDataRequest(action, { reason: copy.requiresReason ? reason : null, expectedCounterpartyVersion });
      if (!built.ok) {
        setError(built.message);
        return;
      }
      const outcome = built.request.via === "contact" ? await intake.updateCounterpartyContact(built.request.input) : await intake.applyExtractedKyc(built.request.input);
      if (outcome.ok) {
        void intake.refreshReconciliation();
        onClose();
      } else if (!outcome.aborted) setError(outcome.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogShell
      open
      title={copy.title}
      onClose={submitting ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn ghost" disabled={submitting} style={submitting ? DISABLED_BUTTON_STYLE : undefined} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={submitting} style={submitting ? DISABLED_BUTTON_STYLE : undefined} onClick={() => void confirm()}>
            {submitting ? "Saving…" : copy.confirmLabel}
          </button>
        </>
      }
    >
      <p className="detailcopy">{copy.lead}</p>
      <ul style={{ margin: "0 0 16px", paddingLeft: 18, fontSize: 12, color: "var(--muted)", display: "grid", gap: 4 }}>
        {copy.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {copy.requiresReason && (
        <div className="field">
          <label htmlFor={`${id}-reason`}>{copy.reasonLabel}</label>
          <textarea id={`${id}-reason`} rows={3} style={{ width: "100%" }} disabled={submitting} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
      )}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 12 }}>
          <span>{error}</span>
        </div>
      )}
    </DialogShell>
  );
}
