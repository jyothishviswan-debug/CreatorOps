"use client";

// Step 14C.3, IA section 4 "KYC": status by component; action only on a Missing/Incomplete component. Values/documents
// stay canonical in the Partner/Vendor restricted-identity boundary - this page only ever shows status, never a value.
import { useEffect, useMemo, useRef, useState } from "react";

import { DISABLED_BUTTON_STYLE, kycStateChip } from "../format";
import { KycDialog } from "./KycDialog";
import { buildKycRows, isKycActionKind, kycAttentionSummary, kycSectionHeadline, type KycDialogKind } from "../agreement-intake-logic/kyc-ui";
import { useIntake } from "../agreement-intake-logic/intake-context";
import type { KycComponentKey } from "../format";

import { SectionCard } from "./SectionCard";

export function KycSection() {
  const intake = useIntake();
  const { kyc, preview, counterparty, flags, hasDraft, agreementRef, refreshKyc } = intake;
  const [dialog, setDialog] = useState<{ component: KycComponentKey; kind: KycDialogKind } | null>(null);
  const [load, setLoad] = useState<{ status: "idle" | "loading" | "error"; message?: string }>({ status: "idle" });
  const requestedFor = useRef<string | null>(null);

  const status = useMemo(() => kyc ?? (preview ? { state: preview.kyc.state, components: preview.kyc.components } : null), [kyc, preview]);
  const counterpartyType = counterparty?.type ?? null;
  const rows = useMemo(() => (counterpartyType ? buildKycRows({ counterpartyType, kyc: status, canViewIdentity: flags.canViewIdentity, canManageKyc: flags.canManageCounterpartyKyc }) : []), [counterpartyType, status, flags.canViewIdentity, flags.canManageCounterpartyKyc]);

  const refresh = () => {
    setLoad({ status: "loading" });
    void refreshKyc().then((result) => setLoad(result.ok || result.aborted ? { status: "idle" } : { status: "error", message: result.message }));
  };

  useEffect(() => {
    if (!hasDraft || !agreementRef || kyc || requestedFor.current === agreementRef) return;
    requestedFor.current = agreementRef;
    setLoad({ status: "loading" });
    void refreshKyc().then((result) => setLoad(result.ok || result.aborted ? { status: "idle" } : { status: "error", message: result.message }));
  }, [agreementRef, hasDraft, kyc, refreshKyc]);

  if (!counterpartyType) return null;
  const busy = intake.isBusy();
  const attention = kycAttentionSummary(rows);

  return (
    <SectionCard sectionKey="kyc" title="KYC" description="Kept once, in the Partner or Vendor record. This Agreement only shows its status." chip={status ? kycStateChip(status.state) : undefined}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <small>{load.status === "loading" && !status ? "Checking KYC status…" : kycSectionHeadline(status, rows)}</small>
        <button type="button" className="btn ghost" onClick={refresh} disabled={busy || load.status === "loading"} style={busy || load.status === "loading" ? DISABLED_BUTTON_STYLE : undefined}>
          Refresh status
        </button>
      </div>

      {load.status === "error" && !status && (
        <div className="banner" role="alert" style={{ margin: "0 0 8px" }}>
          <span>
            <b>Couldn&rsquo;t read the KYC status.</b> {load.message}
          </span>
        </div>
      )}
      {attention && (
        <p className="foundationnote" style={{ margin: "0 0 6px" }}>
          {attention}
        </p>
      )}
      {!flags.canViewIdentity && <p className="foundationnote">You can see the overall KYC status only. Component detail and uploads need KYC access.</p>}

      <div>
        {rows.map((row) => (
          <div key={row.component} className="kv" style={{ gridTemplateColumns: "110px 1fr auto" }}>
            <span>{row.label}</span>
            <b style={{ fontWeight: 500 }}>
              {row.chip.label} · {row.message}
            </b>
            {row.canUpload && isKycActionKind(row.kind) && (
              <button type="button" className="btn" onClick={() => setDialog({ component: row.component, kind: row.kind as KycDialogKind })} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                {row.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>

      {dialog && <KycDialog key={dialog.component} component={dialog.component} kind={dialog.kind} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}
