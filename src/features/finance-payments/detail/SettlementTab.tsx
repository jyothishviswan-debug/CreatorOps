"use client";

import { useEffect, useState } from "react";

import { Pill } from "@/ui/Badge";
import { Skeleton } from "@/ui/States";
import type { InvoicePaymentSettlementDto, PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { getInvoicePaymentSettlement } from "../api-client";
import { relatedPaymentRows, settlementStateView, settlementSummaryRows } from "./detail-view";

// Step 17B section 12: Payment detail - Settlement tab. Invoice-level settlement (fetched on demand,
// only when this tab is viewed), then a compact related-Payments table. Only CONFIRMED Payments
// reduce `remaining` - this is the same read-only projection the workspace and the Create flow read
// (getInvoicePaymentSettlement), so the numbers can never drift from what those screens show.
export function SettlementTab({ detail }: { detail: PaymentDetailDto }) {
  const invoiceRef = detail.head.invoiceRef;
  const [settlement, setSettlement] = useState<InvoicePaymentSettlementDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void getInvoicePaymentSettlement(invoiceRef, { signal: controller.signal }).then((result) => {
      if (!result.ok) {
        if (!result.aborted) setError(result.message);
        return;
      }
      setSettlement(result.data);
    });
    return () => controller.abort();
  }, [invoiceRef]);

  return (
    <div className="grid">
      <section className="panel s12">
        <div className="panelhead">
          <div>
            <h2>Invoice settlement</h2>
          </div>
          {settlement && (
            <span data-testid="settlement-state-pill">
              <Pill tone={settlementStateView(settlement).tone}>{settlementStateView(settlement).label}</Pill>
            </span>
          )}
        </div>
        <div className="panelbody">
          {error && (
            <div className="banner" role="alert">
              {error}
            </div>
          )}
          {!error && !settlement && <Skeleton lines={4} />}
          {settlement && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "4px 24px" }}>
              {settlementSummaryRows(settlement).map((row) => (
                <div className="kv" key={row.label} style={{ gridTemplateColumns: "1fr", gap: 2 }}>
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {settlement && (
        <section className="panel s12">
          <div className="panelhead">
            <div>
              <h2>Payments against this Invoice</h2>
            </div>
          </div>
          <div className="panelbody" style={{ padding: 0 }}>
            <div className="tablewrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Payment ref</th>
                    <th scope="col">Date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Method</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {relatedPaymentRows(settlement).map((row) => (
                    <tr key={row.key} data-testid="related-payment-row" data-payment-ref={row.paymentRef} className={row.paymentRef === detail.head.paymentRef ? "active" : undefined}>
                      <td>
                        <a className="textlink" href={row.detailHref}>
                          {row.paymentRef}
                        </a>
                      </td>
                      <td>{row.date}</td>
                      <td>{row.amountText}</td>
                      <td>{row.methodText}</td>
                      <td>
                        <Pill tone={row.status.tone}>{row.status.label}</Pill>
                      </td>
                    </tr>
                  ))}
                  {relatedPaymentRows(settlement).length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No Payments yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
