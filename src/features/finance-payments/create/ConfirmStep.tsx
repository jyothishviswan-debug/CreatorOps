"use client";

import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { confirmSettlementImpactRows, DRAFT_LIFECYCLE_WORDING, paymentSummaryRows } from "./create-view";

// Step 17B: Record Payment - Stage 3 (Confirm). Two balanced columns, never one long summary card:
// left (Payment summary), right (settlement impact + lifecycle outcome + the primary action).
// Lifecycle wording never invents "Recorded"/"Confirmed" - only what this stage actually leaves
// behind: a Draft (the Draft itself was already created transitioning from Stage 1 -> Stage 2, per
// the Step 17A backend's own createPaymentDraft contract - see PaymentCreatePage.tsx's own comment).
export function ConfirmStep({ detail, settlementBefore, onFinish, navigating }: { detail: PaymentDetailDto; settlementBefore: InvoicePaymentSettlementDto | null; onFinish: () => void; navigating: boolean }) {
  const rows = paymentSummaryRows(detail);
  const impactRows = confirmSettlementImpactRows(detail, settlementBefore);

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Payment summary</h2>
          </div>
        </div>
        <div className="panelbody">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "4px 24px" }}>
            {rows.map((row) => (
              <div className="kv" key={row.label} style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                <span>{row.label}</span>
                <b>{row.value}</b>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Settlement impact</h2>
          </div>
        </div>
        <div className="panelbody">
          {impactRows.map((row) => (
            <div className="kv" key={row.label}>
              <span>{row.label}</span>
              <b>{row.value}</b>
            </div>
          ))}

          <p className="foundationnote" style={{ margin: "16px 0" }} data-testid="draft-lifecycle-note">
            {DRAFT_LIFECYCLE_WORDING}
          </p>

          <button type="button" className="btn primary" style={{ width: "100%" }} disabled={navigating} onClick={onFinish} data-testid="create-payment-action">
            {navigating ? "Opening…" : "Create Payment"}
          </button>
        </div>
      </section>
    </div>
  );
}
