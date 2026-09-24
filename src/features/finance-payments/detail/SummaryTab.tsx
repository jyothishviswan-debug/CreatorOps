import { Pill } from "@/ui/Badge";
import type { PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { sourceRevisionMessage } from "../format";
import { statusPayeePanelView, summaryRows } from "./detail-view";

// Step 17B section 11: Payment detail - Summary tab. Left: dense Payment summary. Right: compact
// status/payee panel (lifecycle, settlement state comes from the Settlement tab - this panel shows
// only payee identity at approval and the source-revision warning, never a raw bank number).
export function SummaryTab({ detail, revisionState }: { detail: PaymentDetailDto; revisionState: string | null }) {
  const rows = summaryRows(detail);
  const status = statusPayeePanelView(detail, revisionState);

  return (
    <>
      {status.hasSourceRevisionWarning && revisionState && (
        <div className="banner" role="status" style={{ marginBottom: 18 }} data-testid="source-revision-banner">
          {sourceRevisionMessage(revisionState)}
        </div>
      )}

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
              <h2>Status / payee</h2>
            </div>
          </div>
          <div className="panelbody">
            <div className="kv">
              <span>Lifecycle</span>
              <b>
                <Pill tone={status.lifecycle.tone}>{status.lifecycle.label}</Pill>
              </b>
            </div>
            <div className="kv" data-testid="summary-payee-identity">
              <span>Payee identity at approval</span>
              <b>{status.payeeIdentityStatus}</b>
            </div>
            <div className="kv" data-testid="summary-bank-safe-display">
              <span>Destination (masked)</span>
              <b>{status.bankSafeDisplay}</b>
            </div>
            <div className="kv">
              <span>Source revision</span>
              <b>{status.hasSourceRevisionWarning ? "Newer source available" : "Current"}</b>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
