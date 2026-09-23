"use client";

// EXECUTE_HARD_RESET Section 15: Step 2 - Review & Verify. Three-way mismatch (Use CreatorOps / Use Agreement /
// Enter corrected value, no default), a separate dialog-gated "Update Partner/Vendor" for identity/contact
// fields only (never commercial terms), and review-by-exception (Section 15's own rule): a Match stays compact,
// a Mismatch/Missing/low-confidence/unresolved field is what actually needs the person's attention.
import { useState } from "react";

import { buildCrossVerificationRows, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { buildMasterDataRequest, correctedValueSeed, groupCrossVerificationRows, validateCorrectedText } from "../agreement-intake-logic/cross-verification-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";

export function VerificationStep() {
  const { reconciliation, permissions } = useIntake();
  const rows = reconciliation ? buildCrossVerificationRows(reconciliation, { canManage: permissions.canManage }) : [];
  const groups = groupCrossVerificationRows(rows);
  const [showAll, setShowAll] = useState(false);

  return (
    <section className="panel">
      <div className="panelhead">
        <h2>Review &amp; Verify</h2>
        <p>CreatorOps value | Agreement value | Status | Your decision</p>
      </div>
      <div className="panelbody">
        {groups.length === 0 && <p className="muted">No reconciliation data yet - upload and extract the Agreement first.</p>}
        {groups.map((group) => {
          const attention = group.rows.filter((r) => r.state === "MISMATCH" || r.state === "MISSING_IN_CREATOROPS" || r.needsResolution);
          const resolved = group.rows.filter((r) => !attention.includes(r));
          return (
            <div key={group.key} style={{ marginBottom: 18 }}>
              <h3>{group.title}</h3>
              <div className="recordgrid" style={{ padding: 0, marginTop: 8 }}>
                {attention.map((row) => (
                  <VerificationRow key={row.fieldKey} row={row} />
                ))}
                {showAll && resolved.map((row) => <VerificationRow key={row.fieldKey} row={row} />)}
              </div>
              {resolved.length > 0 && !showAll && (
                <button type="button" className="btn ghost" style={{ marginTop: 8 }} onClick={() => setShowAll(true)}>
                  Show all extracted fields ({resolved.length} matched/resolved)
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function VerificationRow({ row }: { row: CrossVerificationRow }) {
  const { decideField, updateCounterpartyContact, applyExtractedKyc, isBusy, notify } = useIntake();
  const [correcting, setCorrecting] = useState(false);
  const [text, setText] = useState(() => correctedValueSeed(row));
  const [dialogAction, setDialogAction] = useState<CrossVerificationAction | null>(null);
  const [reason, setReason] = useState("");

  const run = async (action: CrossVerificationAction, value?: unknown) => {
    if (action.decision) {
      const result = await decideField({ fieldKey: row.fieldKey, decision: action.decision, value: value ?? action.value });
      if (!result.ok && !result.aborted) notify("error", result.message);
      return;
    }
    if (action.masterData) {
      const built = buildMasterDataRequest({ masterData: action.masterData }, { reason: action.masterData.requiresReason ? reason : null, expectedCounterpartyVersion: null });
      if (!built.ok) {
        notify("error", built.message);
        return;
      }
      const result = built.request.via === "contact" ? await updateCounterpartyContact(built.request.input) : await applyExtractedKyc(built.request.input);
      if (!result.ok && !result.aborted) notify("error", result.message);
      setDialogAction(null);
    }
  };

  return (
    <div className="record" style={{ borderColor: row.highlight ? "var(--red)" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{row.label}</b>
        <span className={`pill${row.stateChip.tone === "default" ? "" : ` ${row.stateChip.tone}`}`}>{row.stateChip.label}</span>
      </div>
      <div className="kv"><span>CreatorOps</span><b>{row.creatorOpsText}</b></div>
      <div className="kv"><span>Agreement</span><b>{row.agreementText}</b></div>
      {row.confirmedText && <div className="kv"><span>Your decision</span><b>{row.confirmedText}</b></div>}
      {correcting && (
        <div className="field" style={{ marginTop: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} />
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                const checked = validateCorrectedText(row.fieldKey, text);
                if (!checked.ok) {
                  notify("error", checked.errors[0]!);
                  return;
                }
                void decideField({ fieldKey: row.fieldKey, decision: "CORRECTED", value: checked.value });
                setCorrecting(false);
              }}
            >
              Save corrected value
            </button>
            <button type="button" className="btn ghost" onClick={() => setCorrecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        {row.actions.map((action) =>
          action.kind === "ENTER_VALUE" ? (
            <button key={action.kind} type="button" className="btn" disabled={isBusy()} onClick={() => setCorrecting(true)}>
              {action.label}
            </button>
          ) : action.requiresDialog ? (
            <button key={action.kind} type="button" className={`btn${action.primary ? " primary" : ""}`} disabled={isBusy()} onClick={() => setDialogAction(action)}>
              {action.label}
            </button>
          ) : (
            <button key={action.kind} type="button" className={`btn${action.primary ? " primary" : ""}`} disabled={isBusy()} onClick={() => void run(action)}>
              {action.label}
            </button>
          ),
        )}
      </div>
      {dialogAction && (
        <div className="scopebox" style={{ marginTop: 10 }}>
          <p>{dialogAction.label} on the Partner/Vendor record? This never happens automatically when you save the Agreement.</p>
          {dialogAction.masterData?.requiresReason && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" style={{ marginBottom: 8 }} />}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn primary" onClick={() => void run(dialogAction)}>
              Confirm
            </button>
            <button type="button" className="btn ghost" onClick={() => setDialogAction(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
