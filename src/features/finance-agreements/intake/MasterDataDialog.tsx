"use client";

import { useId, useRef, useState } from "react";

import { DialogShell } from "@/ui/Dialog";

import type { CrossVerificationAction, CrossVerificationRow } from "../cross-verification";
import { DISABLED_BUTTON_STYLE } from "../format";
import { buildMasterDataRequest, describeMasterDataAction, validateReason } from "./cross-verification-ui";
import { useIntake } from "./intake-context";
import { readCounterpartyVersion } from "./owning-versions";

// Step 14B intake: the explicit confirmation of ONE master-data command - `Update Partner/Vendor` (fill an empty value) or
// `Update Partner/Vendor after confirmation` (replace a different value, with an acknowledged reason). Saving an Agreement never
// gets here: the person chose this button and confirms it in this dialog. The write goes through the owning module.
export function MasterDataDialog({ row, action, onClose }: { row: CrossVerificationRow; action: CrossVerificationAction; onClose: () => void }) {
  const intake = useIntake();
  const { counterparty } = intake;
  const base = useId();
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const copy = counterparty ? describeMasterDataAction(row, action, counterparty.type) : null;
  if (!copy || !counterparty) return null;
  const via = action.masterData?.target.via;
  const busy = submitting || intake.isBusy();
  const reasonCheck = copy.requiresReason ? validateReason(reason) : null;
  const canSubmit = !busy && (!copy.requiresReason || (acknowledged && !!reasonCheck && reasonCheck.ok));

  const close = () => {
    if (submittingRef.current) return;
    onClose();
  };

  const submit = async () => {
    if (submittingRef.current || !canSubmit) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      // The counterparty's own version is read at the moment of confirming (a contact command needs it; the KYC command reads its own).
      let expected: number | null = null;
      if (via === "contact") {
        const version = await readCounterpartyVersion(counterparty.type, counterparty.ref);
        if (!version.ok) {
          setError(version.message);
          return;
        }
        expected = version.version;
      }
      const built = buildMasterDataRequest(action, { reason: copy.requiresReason ? reason : null, expectedCounterpartyVersion: expected });
      if (!built.ok) {
        setError(built.message);
        return;
      }
      const result = built.request.via === "contact" ? await intake.updateCounterpartyContact(built.request.input) : await intake.applyExtractedKyc(built.request.input);
      if (result.ok) onClose();
      else if (!result.aborted) setError(result.message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <DialogShell
      open
      title={copy.title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" onClick={close} disabled={submitting} style={submitting ? DISABLED_BUTTON_STYLE : undefined}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void submit()} disabled={!canSubmit} aria-disabled={!canSubmit} style={!canSubmit ? DISABLED_BUTTON_STYLE : undefined}>
            {submitting ? "Updating…" : copy.confirmLabel}
          </button>
        </>
      }
    >
      <p className="detailcopy">{copy.lead}</p>
      {via === "contact" && (
        <div className="scopebox" style={{ marginTop: 0, marginBottom: 12, display: "grid", gap: 6 }}>
          <span style={{ overflowWrap: "anywhere" }}>
            <b>CreatorOps now:</b> {row.creatorOpsText}
          </span>
          <span style={{ overflowWrap: "anywhere" }}>
            <b>From the Agreement:</b> {row.agreementText}
          </span>
        </div>
      )}
      <ul className="detailcopy" style={{ margin: "0 0 14px", paddingLeft: 18 }}>
        {copy.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      {copy.requiresReason && (
        <div style={{ display: "grid", gap: 12 }}>
          <div className="field">
            <label htmlFor={`${base}-reason`}>{copy.reasonLabel}</label>
            <textarea id={`${base}-reason`} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} disabled={submitting} style={{ width: "100%", minHeight: 70 }} aria-describedby={`${base}-reason-hint`} />
            <small id={`${base}-reason-hint`} className="muted">
              Recorded in the Agreement activity. At least 3 characters.
            </small>
          </div>
          <label htmlFor={`${base}-ack`} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12 }}>
            <input id={`${base}-ack`} type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={submitting} style={{ marginTop: 2 }} />
            <span>I understand this replaces the value CreatorOps holds and I confirm the Agreement value is correct.</span>
          </label>
        </div>
      )}
      {error && (
        <div className="banner" role="alert" style={{ marginTop: 14, marginBottom: 0 }}>
          <span>
            <b>Couldn’t update.</b> {error}
          </span>
        </div>
      )}
    </DialogShell>
  );
}
