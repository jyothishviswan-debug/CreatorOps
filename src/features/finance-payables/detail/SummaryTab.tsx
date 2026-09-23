import type { PayableDetailDto, PayableSourceRevisionDto } from "@/server/finance-payables/client-dto";

import { sourceRevisionMessage } from "../format";
import { breakdownRows, breakdownTotalText } from "../create/create-view";
import { readinessView, summaryRows } from "./detail-view";

// Step 15B: Payable detail - Summary tab. Left: dense 3-4-column key/value payable summary. Right:
// readiness/status. Below, spanning both: a compact amount preview (same visual language as create).
export function SummaryTab({ detail, revision }: { detail: PayableDetailDto; revision: PayableSourceRevisionDto | null }) {
  const readiness = readinessView(detail, revision);
  const rows = summaryRows(detail);
  const breakdown = detail.selectedVersion ? breakdownRows({ lines: detail.selectedVersion.lines, unresolved: detail.selectedVersion.unresolved, currency: detail.head.currency, amountsVisible: detail.amountsVisible }) : [];

  return (
    <>
      {readiness.sourceRevisionState && (
        <div className="banner" role="status" style={{ marginBottom: 18 }} data-testid="source-revision-banner">
          {sourceRevisionMessage(readiness.sourceRevisionState as Parameters<typeof sourceRevisionMessage>[0])}
        </div>
      )}

      <div className="grid">
        <section className="panel s8">
          <div className="panelhead">
            <div>
              <h2>Payable summary</h2>
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
              <h2>Readiness / status</h2>
            </div>
          </div>
          <div className="panelbody">
            <div className="kv">
              <span>Lifecycle</span>
              <b>{readiness.lifecycle}</b>
            </div>
            <div className="kv">
              <span>Unresolved review items</span>
              <b>{readiness.unresolvedCount}</b>
            </div>
            <div className="kv">
              <span>Eligible for invoice</span>
              <b>{readiness.eligibleForInvoice ? "Yes" : "No"}</b>
            </div>
          </div>
        </section>

        <section className="panel s12">
          <div className="panelhead">
            <div>
              <h2>Amount breakdown preview</h2>
            </div>
          </div>
          <div className="panelbody">
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Component</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {breakdown.map((row) => (
                    <tr key={row.key}>
                      <td>{row.component}</td>
                      <td>{row.amountText}</td>
                      <td>
                        <span className={row.status.tone === "default" ? "pill" : `pill ${row.status.tone}`}>{row.status.label}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>
                      <b>Total</b>
                    </td>
                    <td>
                      <b>{breakdownTotalText(detail.selectedVersion?.totalAmountMinorSigned ?? null, detail.head.currency, detail.amountsVisible)}</b>
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
