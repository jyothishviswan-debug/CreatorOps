"use client";

// FINAL_EXECUTION Panel 2 - Parties, Accounts & Verification. Section 10's three-way mismatch (Use CreatorOps /
// Use Agreement / Enter corrected value, no default), Section 10's separate `Update Partner/Vendor` action
// (identity/contact/KYC fields only - never commercial terms), and Section 10's repeatable named-party rows
// (role + mapping), which stay purely additive metadata - never a second commercial source of truth.
import { useState } from "react";

import type { AgreementParty, AgreementPartyRole } from "@/server/finance-agreements/types";

import { buildCrossVerificationRows, type CrossVerificationAction, type CrossVerificationRow } from "../cross-verification";
import { buildMasterDataRequest, correctedValueSeed, groupCrossVerificationRows, validateCorrectedText } from "../agreement-intake-logic/cross-verification-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";

import { SectionCard } from "./SectionCard";

const PARTY_ROLES: AgreementPartyRole[] = ["PRIMARY_COUNTERPARTY", "CO_SERVICE_PROVIDER", "PAYEE", "PRESENTER", "SIGNATORY", "NOTICE_CONTACT", "OTHER"];
const ROLE_LABEL: Record<AgreementPartyRole, string> = {
  PRIMARY_COUNTERPARTY: "Primary counterparty",
  CO_SERVICE_PROVIDER: "Co-service provider",
  PAYEE: "Payee",
  PRESENTER: "Presenter",
  SIGNATORY: "Signatory",
  NOTICE_CONTACT: "Notice contact",
  OTHER: "Other contract party",
};

export function PartiesVerificationPanel() {
  const { hasDraft, reconciliation, permissions, version, setParties, isBusy, notify } = useIntake();
  if (!hasDraft || !version) return null;

  const rows = reconciliation ? buildCrossVerificationRows(reconciliation, { canManage: permissions.canManage }) : [];
  const groups = groupCrossVerificationRows(rows);
  const payeeCount = version.parties.filter((p) => p.role === "PAYEE").length;
  const primaryCount = version.parties.filter((p) => p.role === "PRIMARY_COUNTERPARTY").length;
  const ambiguous = payeeCount > 1 || (payeeCount === 0 && primaryCount > 1);

  return (
    <>
      <SectionCard title="Agreement Parties" description="The contract's other named parties - additive metadata alongside the one Finance-authoritative counterparty above.">
        <PartiesTable parties={version.parties} onSave={(parties) => void setParties(parties).then((r) => notify(r.ok ? "success" : "error", r.ok ? "Agreement parties saved." : r.message))} busy={isBusy()} />
        {ambiguous && (
          <p className="scopebox" style={{ marginTop: 12, color: "var(--red)" }}>
            More than one party could be the primary counterparty or payee. Mark exactly one Payee (or, if none, exactly one Primary counterparty) before this Agreement can be activated.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Parties, Accounts &amp; Verification" description="CreatorOps value | Agreement value | Status | Your decision - review by exception.">
        {groups.length === 0 && <p className="muted">No reconciliation data yet - upload and extract the Agreement first.</p>}
        {groups.map((group) => (
          <div key={group.key} style={{ marginBottom: 18 }}>
            <h3>{group.title}</h3>
            <div className="recordgrid" style={{ padding: 0, marginTop: 8 }}>
              {group.rows.map((row) => (
                <VerificationRow key={row.fieldKey} row={row} />
              ))}
            </div>
          </div>
        ))}
      </SectionCard>
    </>
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
    <div className={`record${row.highlight ? "" : ""}`} style={{ borderColor: row.highlight ? "var(--red)" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <b>{row.label}</b>
        <span className={`pill${row.stateChip.tone === "default" ? "" : ` ${row.stateChip.tone}`}`}>{row.stateChip.label}</span>
      </div>
      <div className="kv"><span>CreatorOps</span><b>{row.creatorOpsText}</b></div>
      <div className="kv"><span>Agreement</span><b>{row.agreementText}</b></div>
      {row.confirmedText && (
        <div className="kv"><span>Your decision</span><b>{row.confirmedText}</b></div>
      )}
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
          {dialogAction.masterData?.requiresReason && (
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" style={{ marginBottom: 8 }} />
          )}
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

function PartiesTable({ parties, onSave, busy }: { parties: AgreementParty[]; onSave: (parties: AgreementParty[]) => void; busy: boolean }) {
  const [rows, setRows] = useState<AgreementParty[]>(parties);

  return (
    <div>
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Contract name</th>
            <th>Mapping</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.partyRef}>
              <td>
                <select value={row.role} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, role: e.target.value as AgreementPartyRole } : r)))}>
                  {PARTY_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABEL[role]}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <input value={row.contractName} onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, contractName: e.target.value } : r)))} />
              </td>
              <td>
                <select
                  value={row.mapping.kind}
                  onChange={(e) => {
                    const kind = e.target.value as AgreementParty["mapping"]["kind"];
                    const mapping: AgreementParty["mapping"] = kind === "CONTRACT_ONLY" || kind === "UNRESOLVED" ? { kind } : kind === "PARTNER" ? { kind, partnerRef: "" } : { kind, vendorRef: "" };
                    setRows(rows.map((r, j) => (j === i ? { ...r, mapping } : r)));
                  }}
                >
                  <option value="UNRESOLVED">Not yet mapped</option>
                  <option value="CONTRACT_ONLY">Contract-only (no CreatorOps record)</option>
                  <option value="PARTNER">Existing Partner</option>
                  <option value="VENDOR">Existing Vendor</option>
                </select>
                {(row.mapping.kind === "PARTNER" || row.mapping.kind === "VENDOR") && (
                  <input
                    style={{ marginTop: 4 }}
                    placeholder="Partner/Vendor ref"
                    value={row.mapping.kind === "PARTNER" ? row.mapping.partnerRef : row.mapping.vendorRef}
                    onChange={(e) =>
                      setRows(
                        rows.map((r, j) => (j === i && (r.mapping.kind === "PARTNER" || r.mapping.kind === "VENDOR") ? { ...r, mapping: r.mapping.kind === "PARTNER" ? { kind: "PARTNER", partnerRef: e.target.value } : { kind: "VENDOR", vendorRef: e.target.value } } : r)),
                      )
                    }
                  />
                )}
              </td>
              <td>
                <button type="button" className="btn ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="button" className="btn" onClick={() => setRows([...rows, { partyRef: `pty_${rows.length + 1}_${Date.now()}`, role: "OTHER", contractName: "", mapping: { kind: "UNRESOLVED" } }])}>
          Add party
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => onSave(rows)}>
          Save parties
        </button>
      </div>
    </div>
  );
}
