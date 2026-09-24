import { Pill } from "@/ui/Badge";
import type { InvoiceDetailDto } from "@/server/finance-invoices/client-dto";
import type { InvoiceSourceRevisionDto } from "@/server/finance-invoices/invoice-lifecycle-service";

import { sourceRevisionMessage } from "../format";
import { approvalReadinessView, summaryRows } from "./detail-view";

// Step 16B section 12: Invoice detail - Summary tab. Left: dense 3-4 column key/value Invoice
// summary. Right: approval/readiness. Below, spanning both: the source Payable summary.
export function SummaryTab({ detail, revision }: { detail: InvoiceDetailDto; revision: InvoiceSourceRevisionDto | null }) {
  const readiness = approvalReadinessView(detail, revision);
  const rows = summaryRows(detail);
  const pin = detail.selectedVersion?.payablePin;

  return (
    <>
      {readiness.sourceRevisionState && (
        <div className="banner" role="status" style={{ marginBottom: 18 }} data-testid="source-revision-banner">
          {sourceRevisionMessage(readiness.sourceRevisionState)}
        </div>
      )}

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
          </div>
        </section>

        <section className="panel s4">
          <div className="panelhead">
            <div>
              <h2>Approval / readiness</h2>
            </div>
          </div>
          <div className="panelbody">
            <div className="kv">
              <span>Lifecycle</span>
              <b>
                <Pill tone={readiness.lifecycle.tone}>{readiness.lifecycle.label}</Pill>
              </b>
            </div>
            <div className="kv">
              <span>Reconciliation</span>
              <b>
                <Pill tone={readiness.reconciliation.tone}>{readiness.reconciliation.label}</Pill>
              </b>
            </div>
            <div className="kv">
              <span>Document</span>
              <b>{readiness.documentAttached ? "Attached" : "Not attached"}</b>
            </div>
            <div className="kv">
              <span>Mismatch override</span>
              <b>{readiness.mismatchOverrideStatus}</b>
            </div>
            <div className="kv" data-testid="summary-payee-identity">
              <span>Payee identity</span>
              <b>{readiness.payeeIdentity ? <Pill tone={readiness.payeeIdentity.tone}>{readiness.payeeIdentity.label}</Pill> : "Not yet checked"}</b>
            </div>
            <div className="kv">
              <span>Source revision</span>
              <b>{readiness.sourceRevisionState ?? "Current"}</b>
            </div>
            <div className="kv">
              <span>Eligible for approval</span>
              <b>{readiness.eligibleForApproval ? "Yes" : "No"}</b>
            </div>
          </div>
        </section>

        {pin && (
          <section className="panel s12">
            <div className="panelhead">
              <div>
                <h2>Source Payable summary</h2>
              </div>
            </div>
            <div className="panelbody">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px 24px" }}>
                <div className="kv" style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                  <span>Payable ref / version</span>
                  <b>
                    {pin.payableRef} · v{pin.payableVersion}
                  </b>
                </div>
                <div className="kv" style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                  <span>Agreement ref / version</span>
                  <b>
                    {pin.agreementRef} · v{pin.agreementVersion}
                  </b>
                </div>
                <div className="kv" style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                  <span>Currency</span>
                  <b>{pin.payableCurrency}</b>
                </div>
                <div className="kv" style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                  <span>Commercial period</span>
                  <b>{pin.commercialPeriod.periodKey}</b>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
