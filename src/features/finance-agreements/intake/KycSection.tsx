"use client";

// Step 14B intake, section 8 `KYC & restricted details` (Step 14B.1: per-COMPONENT actions, for existing AND new counterparties).
// Per component (PAN, Aadhaar for Partners, Bank details, GST certificate) a status chip - Available / Missing / Incomplete / Restricted /
// Unavailable / Not applicable. KYC that already exists in the Partner / Vendor record is shown as such and offers NO action. Only a MISSING or
// INCOMPLETE component offers `Upload / Update` (bank: `Complete bank details` when a document is on file), and only to a person who holds the
// identity category AND the owning KYC action; it opens a dialog scoped to THAT component. When every component is available there is no KYC
// upload action anywhere and the section reads `KYC available in Partner/Vendor record`. Without sensitive access this section shows safe status
// text and no action. Values are never read or shown here, and the owning restricted-identity record is never read just to show presence.
import { useEffect, useMemo, useRef, useState } from "react";

import { StatusChip } from "../components/StatusChip";
import { DISABLED_BUTTON_STYLE, kycStateChip, type KycComponentKey } from "../format";
import { useIntake } from "./intake-context";
import { KycDialog } from "./KycDialog";
import { buildKycRows, isKycActionKind, kycAttentionSummary, kycSectionHeadline, type KycDialogKind } from "./kyc-ui";
import { SectionCard } from "./SectionCard";

export function KycSection() {
  const intake = useIntake();
  const { kyc, preview, counterparty, flags, hasDraft, agreementRef, refreshKyc } = intake;
  const [dialog, setDialog] = useState<{ component: KycComponentKey; kind: KycDialogKind } | null>(null);
  const [load, setLoad] = useState<{ status: "idle" | "loading" | "error"; message?: string }>({ status: "idle" });
  const requestedFor = useRef<string | null>(null);

  // The status arrives from the Agreement's own status route; the CreatorOps preview (status only as well) fills in while it loads.
  const status = useMemo(() => kyc ?? (preview ? { state: preview.kyc.state, components: preview.kyc.components } : null), [kyc, preview]);
  const counterpartyType = counterparty?.type ?? null;
  const rows = useMemo(() => (counterpartyType ? buildKycRows({ counterpartyType, kyc: status, canViewIdentity: flags.canViewIdentity, canManageKyc: flags.canManageCounterpartyKyc }) : []), [counterpartyType, status, flags.canViewIdentity, flags.canManageCounterpartyKyc]);

  const refresh = () => {
    setLoad({ status: "loading" });
    void refreshKyc().then((result) => {
      if (result.ok || result.aborted) setLoad({ status: "idle" });
      else setLoad({ status: "error", message: result.message });
    });
  };

  useEffect(() => {
    if (!hasDraft || !agreementRef || kyc || requestedFor.current === agreementRef) return;
    requestedFor.current = agreementRef;
    setLoad({ status: "loading" });
    void refreshKyc().then((result) => {
      if (result.ok || result.aborted) setLoad({ status: "idle" });
      else setLoad({ status: "error", message: result.message });
    });
  }, [agreementRef, hasDraft, kyc, refreshKyc]);

  if (!counterpartyType) return null;
  const busy = intake.isBusy();
  const attention = kycAttentionSummary(rows);

  return (
    <SectionCard
      sectionKey="kyc"
      description="KYC is kept once, in the Partner or Vendor record. This Agreement only shows its status."
      chip={status ? kycStateChip(status.state) : undefined}
    >
      <div role="status" aria-live="polite" data-testid="kyc-headline" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, minWidth: 0, overflowWrap: "anywhere" }}>{load.status === "loading" && !status ? "Checking KYC status…" : kycSectionHeadline(status, rows)}</span>
        <button type="button" className="btn ghost" onClick={refresh} disabled={busy || load.status === "loading"} style={busy || load.status === "loading" ? DISABLED_BUTTON_STYLE : undefined}>
          Refresh status
        </button>
      </div>

      {load.status === "error" && !status && (
        <div className="banner" role="alert" style={{ margin: "0 0 8px" }}>
          <span>
            <b>Couldn’t read the KYC status.</b> {load.message}
          </span>
        </div>
      )}

      {attention && (
        <p className="foundationnote" data-testid="kyc-attention" style={{ margin: "0 0 6px" }}>
          {attention}
        </p>
      )}

      {!flags.canViewIdentity && <p className="foundationnote">You can see the overall KYC status only. Component detail and uploads need KYC access.</p>}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="KYC components">
        {rows.map((row) => (
          <li key={row.component} data-kyc-component={row.component} data-kind={row.kind} style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center", padding: "12px 0", borderTop: "1px solid #edf0f3" }}>
            <b style={{ fontSize: 12, minWidth: 110 }}>{row.label}</b>
            <StatusChip chip={row.chip} status={row.kind} />
            <span style={{ flex: "1 1 200px", fontSize: 11, color: "var(--muted)", minWidth: 0, overflowWrap: "anywhere" }}>{row.message}</span>
            {row.canUpload && isKycActionKind(row.kind) && (
              <button type="button" className="btn" aria-label={row.actionAriaLabel ?? undefined} onClick={() => setDialog({ component: row.component, kind: row.kind as KycDialogKind })} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                {row.actionLabel}
              </button>
            )}
          </li>
        ))}
      </ul>

      {dialog && <KycDialog key={dialog.component} component={dialog.component} kind={dialog.kind} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}
