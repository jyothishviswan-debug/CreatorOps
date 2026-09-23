"use client";

import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";

import { confirmBlockers, confirmReadiness, DRAFT_LIFECYCLE_WORDING, invoiceSummaryRows } from "./create-view";

// Step 16B: Create Invoice - Stage 4 (Confirm). A balanced two-column review, never one long
// summary card: left ~8/12 (Invoice summary), right ~4/12 (readiness + lifecycle outcome +
// blockers + the primary action). Lifecycle wording never invents "Submitted"/"Approved" - only
// what this stage actually leaves behind: a Draft.
export function ConfirmStep({ detail, onFinish, navigating }: { detail: InvoiceDetailDto; onFinish: () => void; navigating: boolean }) {
  const rows = invoiceSummaryRows(detail);
  const readiness = confirmReadiness(detail);
  const blockers = confirmBlockers(detail);

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Invoice summary</h2>
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

          <h3 style={{ margin: "18px 0 8px" }}>Reconciliation summary</h3>
          <div className="kv">
            <span>Reconciliation state</span>
            <b>{detail.head.reconciliationState}</b>
          </div>
          <div className="kv">
            <span>Document</span>
            <b>{detail.selectedVersion?.document ? "Attached" : "Not attached"}</b>
          </div>
          <div className="kv">
            <span>Mismatch override</span>
            <b>{detail.head.mismatchOverride ? "Accepted" : "None"}</b>
          </div>
        </div>
      </section>

      <section className="panel s4">
        <div className="panelhead">
          <div>
            <h2>Readiness</h2>
          </div>
        </div>
        <div className="panelbody">
          <ul className="checklist">
            {readiness.map((item) => (
              <li key={item.label}>
                <span aria-hidden="true">{item.met ? "✓" : "•"}</span>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>

          {blockers.length > 0 && (
            <div className="banner" role="alert" style={{ margin: "14px 0" }} data-testid="confirm-blockers">
              <b>Outstanding items:</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {blockers.map((blocker) => (
                  <li key={blocker.code}>{blocker.message}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="foundationnote" style={{ margin: "16px 0" }}>
            {DRAFT_LIFECYCLE_WORDING}
          </p>

          <button type="button" className="btn primary" style={{ width: "100%" }} disabled={navigating} onClick={onFinish} data-testid="create-invoice-action">
            {navigating ? "Opening…" : "Create Invoice"}
          </button>
        </div>
      </section>
    </div>
  );
}
