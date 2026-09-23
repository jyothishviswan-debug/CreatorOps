"use client";

// EXECUTE_HARD_RESET Section 16/17: Parties & KYC. Repeatable named-party rows (role + mapping, never forcing
// every named person into a Partner/Vendor record) with an activation-ambiguity warning, account/channel scope,
// and a compact KYC matrix - action only for a missing/incomplete component, via a focused dialog.
import { useState } from "react";

import type { AgreementParty, AgreementPartyRole } from "@/server/finance-agreements/types";

import { useIntake } from "../agreement-intake-logic/intake-context";
import { buildKycRows, isKycActionKind, owningRecordHref, type KycDialogKind } from "../agreement-intake-logic/kyc-ui";
import type { KycComponentKey } from "../format";

import { accountViews } from "./agreement-create-adapter";
import { SecureKycDialog } from "./SecureKycDialog";

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

export function PartiesKycStep() {
  const { counterparty, version, kyc, flags, setParties, isBusy, notify } = useIntake();
  const [dialog, setDialog] = useState<{ component: KycComponentKey; kind: KycDialogKind } | null>(null);

  if (!version || !counterparty) return null;
  const payeeCount = version.parties.filter((p) => p.role === "PAYEE").length;
  const primaryCount = version.parties.filter((p) => p.role === "PRIMARY_COUNTERPARTY").length;
  const ambiguous = payeeCount > 1 || (payeeCount === 0 && primaryCount > 1);
  const accounts = accountViews(counterparty);
  const kycRows = buildKycRows({ counterpartyType: counterparty.type, kyc, canViewIdentity: flags.canViewIdentity, canManageKyc: flags.canManageCounterpartyKyc });

  return (
    <>
      <div className="grid">
        <div className="s7">
          <section className="panel">
            <div className="panelhead">
              <h2>Agreement Parties</h2>
              <p>{counterparty.displayName} is the primary Finance-authoritative counterparty. Add any other named party from the contract text below.</p>
            </div>
            <div className="panelbody">
              <PartiesTable primaryPartyName={counterparty.displayName} parties={version.parties} onSave={(parties) => void setParties(parties).then((r) => notify(r.ok ? "success" : "error", r.ok ? "Agreement parties saved." : r.message))} busy={isBusy()} />
              {ambiguous && (
                <p className="scopebox" style={{ marginTop: 12, color: "var(--red)" }}>
                  More than one party could be the primary counterparty or payee. Mark exactly one Payee (or, if none, exactly one Primary counterparty) before this Agreement can be activated.
                </p>
              )}
            </div>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panelhead">
              <h2>Partner Accounts</h2>
              <p>Platform-level, or specific accounts/channels this Agreement covers.</p>
            </div>
            <div className="panelbody">
              {accounts.length === 0 ? (
                <p className="muted">No account scope recorded for this counterparty.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((account) => (
                      <tr key={account.id}>
                        <td style={{ textTransform: "capitalize" }}>{account.platform}</td>
                        <td>{account.state === "PARTNER_LEVEL" ? "Partner-level (no specific account)" : "Specific account"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </div>

        <div className="s5">
          <section className="panel">
            <div className="panelhead">
              <h2>KYC</h2>
              <p>Complete components show Available with no action; only missing or incomplete need one.</p>
            </div>
            <div className="panelbody">
              <table>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {kycRows.map((row) => {
                    const dialogKind = isKycActionKind(row.kind) ? row.kind : null;
                    return (
                      <tr key={row.component}>
                        <td>{row.label}</td>
                        <td>
                          <span className={`pill${row.chip.tone === "default" ? "" : ` ${row.chip.tone}`}`}>{row.chip.label}</span>
                        </td>
                        <td>
                          {row.canUpload && dialogKind ? (
                            <button type="button" className="btn" aria-label={row.actionAriaLabel ?? undefined} onClick={() => setDialog({ component: row.component, kind: dialogKind })}>
                              {row.actionLabel}
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <a className="btn ghost" style={{ marginTop: 10, display: "inline-flex" }} href={owningRecordHref(counterparty.type, counterparty.ref)} target="_blank" rel="noreferrer">
                Open {counterparty.type === "PARTNER" ? "Partner" : "Vendor"} record
              </a>
            </div>
          </section>
        </div>
      </div>

      {dialog && <SecureKycDialog component={dialog.component} kind={dialog.kind} onClose={() => setDialog(null)} />}
    </>
  );
}

function PartiesTable({ primaryPartyName, parties, onSave, busy }: { primaryPartyName: string; parties: AgreementParty[]; onSave: (parties: AgreementParty[]) => void; busy: boolean }) {
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
          <tr>
            <td>
              <span className="pill orange">{ROLE_LABEL.PRIMARY_COUNTERPARTY}</span>
            </td>
            <td>
              <b>{primaryPartyName}</b>
            </td>
            <td className="muted">Linked Partner/Vendor</td>
            <td />
          </tr>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No other named parties recorded yet.
              </td>
            </tr>
          )}
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
