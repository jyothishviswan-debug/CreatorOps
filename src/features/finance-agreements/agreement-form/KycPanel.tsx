"use client";

// FINAL_EXECUTION Panel 3 - KYC. Section 14: a compact component-status matrix; action only for missing/incomplete
// components; canonical values/documents stay in the owning Partner/Vendor record - this panel never shows one.
import { useIntake } from "../agreement-intake-logic/intake-context";
import { buildKycRows, owningRecordHref } from "../agreement-intake-logic/kyc-ui";

import { SectionCard } from "./SectionCard";

export function KycPanel() {
  const { hasDraft, kyc, counterparty, flags } = useIntake();
  if (!hasDraft || !counterparty) return null;

  const rows = buildKycRows({ counterpartyType: counterparty.type, kyc, canViewIdentity: flags.canViewIdentity, canManageKyc: flags.canManageCounterpartyKyc });

  return (
    <SectionCard title="KYC" description="Complete components show Available with no action; only missing or incomplete components need one.">
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.component}>
              <td>{row.label}</td>
              <td>
                <span className={`pill${row.chip.tone === "default" ? "" : ` ${row.chip.tone}`}`}>{row.chip.label}</span>
                <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{row.message}</div>
              </td>
              <td>
                {row.canUpload ? (
                  <a className="btn" href={owningRecordHref(counterparty.type, counterparty.ref)} target="_blank" rel="noreferrer" aria-label={row.actionAriaLabel ?? undefined}>
                    {row.actionLabel}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SectionCard>
  );
}
