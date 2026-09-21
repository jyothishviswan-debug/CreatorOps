"use client";

// Step 14B intake, section 8 `KYC & restricted details`: per component (PAN, Aadhaar for Partners, Bank details, GST certificate) a
// status chip - Available / Missing / Restricted / Unavailable, with the overall Incomplete state above. KYC that already exists in the
// Partner / Vendor record is shown as such (no duplicate upload). A missing component offers `Upload / Update KYC` ONLY to a person
// who is authorized for the owning record. Without sensitive access this section shows safe status text and no action.
// Values are never read or shown here.
import { useEffect, useMemo, useRef, useState } from "react";

import { StatusChip } from "../components/StatusChip";
import { DISABLED_BUTTON_STYLE, kycStateChip, type KycComponentKey } from "../format";
import { useIntake } from "./intake-context";
import { KycDialog } from "./KycDialog";
import { buildKycRows, kycHeadline } from "./kyc-ui";
import { SectionCard } from "./SectionCard";

export function KycSection() {
  const intake = useIntake();
  const { kyc, preview, counterparty, flags, hasDraft, agreementRef, refreshKyc } = intake;
  const [dialog, setDialog] = useState<KycComponentKey | null>(null);
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

  return (
    <SectionCard
      sectionKey="kyc"
      description="KYC is kept once, in the Partner or Vendor record. This Agreement only shows its status."
      chip={status ? kycStateChip(status.state) : undefined}
    >
      <div role="status" aria-live="polite" data-testid="kyc-headline" style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, minWidth: 0, overflowWrap: "anywhere" }}>{load.status === "loading" && !status ? "Checking KYC status…" : kycHeadline(status)}</span>
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

      {!flags.canViewIdentity && <p className="foundationnote">You can see the overall KYC status only. Component detail and uploads need KYC access.</p>}

      <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="KYC components">
        {rows.map((row) => (
          <li key={row.component} data-kyc-component={row.component} data-kind={row.kind} style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", alignItems: "center", padding: "12px 0", borderTop: "1px solid #edf0f3" }}>
            <b style={{ fontSize: 12, minWidth: 110 }}>{row.label}</b>
            <StatusChip chip={row.chip} status={row.kind} />
            <span style={{ flex: "1 1 200px", fontSize: 11, color: "var(--muted)", minWidth: 0, overflowWrap: "anywhere" }}>{row.message}</span>
            {row.canUpload && (
              <button type="button" className="btn" aria-label={`Upload / Update KYC for ${row.label}`} onClick={() => setDialog(row.component)} disabled={busy} style={busy ? DISABLED_BUTTON_STYLE : undefined}>
                Upload / Update KYC
              </button>
            )}
          </li>
        ))}
      </ul>

      {dialog && <KycDialog key={dialog} component={dialog} onClose={() => setDialog(null)} />}
    </SectionCard>
  );
}
