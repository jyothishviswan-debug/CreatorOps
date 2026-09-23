"use client";

import { Pill } from "@/ui/Badge";
import { Skeleton } from "@/ui/States";
import type { InvoiceVersionDto } from "@/server/finance-invoices/client-dto";

import { arithmeticWarning, reconciliationComparisonRows, reconciliationReadinessRows } from "../reconciliation-view";

const READINESS_LABEL: Record<"ready" | "needs_review" | "blocked", string> = { ready: "Ready", needs_review: "Needs review", blocked: "Blocked" };
const READINESS_TONE: Record<"ready" | "needs_review" | "blocked", "default" | "orange" | "red"> = { ready: "default", needs_review: "orange", blocked: "red" };

// Step 16B: Create Invoice - Stage 3 (Reconciliation). Approx 8/12 left (comparison table), 4/12
// right (readiness / blockers). The Invoice is still DRAFT at this point, so no mismatch-override
// action is offered here (the backend only accepts an override on a SUBMITTED Invoice, immediately
// before approval - see the Invoice detail's own Reconciliation tab for that action).
export function ReconciliationStep({ version, loading, error, amountsVisible }: { version: InvoiceVersionDto | null; loading: boolean; error: string | null; amountsVisible: boolean }) {
  if (loading) {
    return (
      <section className="panel">
        <div className="panelbody">
          <Skeleton lines={6} />
        </div>
      </section>
    );
  }

  if (error || !version) {
    return (
      <section className="panel">
        <div className="panelbody">
          <div className="banner" role="alert">
            {error ?? "Could not compute reconciliation."}
          </div>
        </div>
      </section>
    );
  }

  const rows = reconciliationComparisonRows({
    pin: version.payablePin,
    declared: { currency: version.currency, declaredTotalMinor: version.declaredTotalMinor, externalInvoiceNumber: version.externalInvoiceNumber },
    reconciliation: version.reconciliation,
    documentPresent: version.document !== null,
    amountsVisible,
  });
  const readiness = reconciliationReadinessRows({
    declared: { currency: version.currency, declaredTotalMinor: version.declaredTotalMinor, externalInvoiceNumber: version.externalInvoiceNumber },
    documentPresent: version.document !== null,
    reconciliation: version.reconciliation,
    mismatchAcceptedForThisVersion: false,
  });
  const warning = arithmeticWarning(version.reconciliation);

  return (
    <div className="grid">
      <section className="panel s8">
        <div className="panelhead">
          <div>
            <h2>Reconciliation</h2>
            <p>Compare the Invoice with the pinned Payable</p>
          </div>
        </div>
        <div className="panelbody">
          {warning && (
            <div className="banner" role="alert" style={{ marginBottom: 14 }} data-testid="arithmetic-warning">
              <b>Arithmetic inconsistency:</b> {warning}
            </div>
          )}
          <div className="tablewrap">
            <table className="compact">
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Payable</th>
                  <th scope="col">Invoice</th>
                  <th scope="col">Result</th>
                  <th scope="col">Resolution</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} data-testid={`reconciliation-row-${row.key}`}>
                    <td>{row.field}</td>
                    <td>{row.payableValue}</td>
                    <td>{row.invoiceValue}</td>
                    <td>
                      <Pill tone={row.result.tone}>{row.result.label}</Pill>
                    </td>
                    <td style={{ whiteSpace: "normal" }}>{row.resolution}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                <Pill tone={READINESS_TONE[item.state]}>{READINESS_LABEL[item.state]}</Pill>
                <span>{item.label}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
