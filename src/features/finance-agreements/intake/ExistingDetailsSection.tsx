"use client";

// Step 14B intake, section 3 `Existing CreatorOps details`: what CreatorOps master data already holds for the chosen Partner / Vendor.
// Ordinary facts + KYC STATUS only (no restricted value is ever in the DTO). Labelled `CreatorOps master data`. Read-only.
import { KeyValueRow } from "../components/KeyValueRow";
import { StatusChip } from "../components/StatusChip";
import { KYC_AVAILABLE_NOTE, MASTER_DATA_SOURCE_LABEL } from "../format";
import { accountRows, contactRows, gstinStatusChip, kycRows, overallKycChip } from "./existing-details-logic";
import { useIntake } from "./intake-context";
import { SectionCard } from "./SectionCard";

const GRID = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", columnGap: 28 } as const;

export function ExistingDetailsSection() {
  const { preview, previewLoad, counterparty } = useIntake();

  return (
    <SectionCard sectionKey="existing_details" description="Shown for reference while you review the Agreement. Saving an Agreement never changes this record." chip={{ label: MASTER_DATA_SOURCE_LABEL, tone: "blue" }}>
      {!preview && previewLoad.status === "loading" && (
        <div role="status" aria-live="polite">
          <small className="muted">Loading CreatorOps details…</small>
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "40%" }} />
        </div>
      )}
      {!preview && previewLoad.status === "error" && (
        <div className="banner" role="alert" style={{ margin: 0 }}>
          <span>
            <b>Couldn’t load the CreatorOps details.</b> {previewLoad.message}
          </span>
        </div>
      )}
      {!preview && previewLoad.status === "idle" && (
        <p className="foundationnote">{counterparty ? "CreatorOps master data is not shown for your access." : "Choose a Partner or Vendor above to see what CreatorOps already holds for them."}</p>
      )}

      {preview && <PreviewBody preview={preview} />}
    </SectionCard>
  );
}

function PreviewBody({ preview }: { preview: NonNullable<ReturnType<typeof useIntake>["preview"]> }) {
  const contact = contactRows(preview);
  const accounts = accountRows(preview);
  const kyc = kycRows(preview);
  const gstin = gstinStatusChip(preview.gstinStatus);

  return (
    <div data-testid="existing-details">
      <div style={GRID}>
        {contact.map((row) => (
          <KeyValueRow key={row.key} label={row.label}>
            {row.muted ? <span className="muted">{row.value}</span> : row.value}
          </KeyValueRow>
        ))}
        <KeyValueRow label="GSTIN">
          <StatusChip chip={gstin} status={preview.gstinStatus} />
        </KeyValueRow>
      </div>

      {preview.type === "PARTNER" && (
        <div style={{ marginTop: 14 }}>
          <b style={{ fontSize: 11, fontWeight: 550 }}>Partner Accounts</b>
          {accounts.length === 0 ? (
            <p className="foundationnote" style={{ marginTop: 4 }}>
              No Partner Accounts are recorded for this Partner.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "grid", gap: 6 }} aria-label="Partner Accounts">
              {accounts.map((account) => (
                <li key={account.key} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 11 }}>
                  <StatusChip label={account.platform} tone="gray" />
                  <b style={{ overflowWrap: "anywhere" }}>{account.title}</b>
                  {account.detail && <span className="muted">{account.detail}</span>}
                  {account.inactive && <StatusChip label="Inactive" tone="gray" />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <b style={{ fontSize: 11, fontWeight: 550 }}>KYC status</b>
          <StatusChip chip={overallKycChip(preview)} status={preview.kyc.state} testId="existing-kyc-state" />
        </div>
        <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, display: "flex", gap: 14, flexWrap: "wrap" }} aria-label="KYC components">
          {kyc.map((row) => (
            <li key={row.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11 }}>
              <span>{row.label}</span>
              <StatusChip chip={row.chip} status={row.key} />
            </li>
          ))}
        </ul>
        {preview.kyc.state === "AVAILABLE" && (
          <p className="foundationnote" style={{ marginTop: 6 }}>
            {KYC_AVAILABLE_NOTE}
          </p>
        )}
        {!preview.kyc.valuesVisible && (
          <p className="foundationnote" style={{ marginTop: 6 }}>
            Detailed KYC status is restricted for your role. No KYC value is shown here.
          </p>
        )}
      </div>
    </div>
  );
}
