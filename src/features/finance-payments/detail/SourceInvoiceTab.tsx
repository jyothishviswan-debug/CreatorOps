import Link from "next/link";

import type { PaymentDetailDto } from "@/server/finance-payments/client-dto";

import { sourceInvoiceRows } from "./detail-view";

// Step 17B section 13: Payment detail - Source Invoice tab. Read-only pinned evidence only - no raw
// restricted extraction, no editing the Invoice/Payable from here (a Payment reads an Invoice, never
// the other way round - see payment-source.ts's own comment).
export function SourceInvoiceTab({ detail }: { detail: PaymentDetailDto }) {
  const rows = sourceInvoiceRows(detail);

  return (
    <section className="panel">
      <div className="panelhead">
        <div>
          <h2>Source Invoice</h2>
        </div>
        <Link className="textlink" href={`/finance/invoices/${encodeURIComponent(detail.head.invoiceRef)}`}>
          Open Invoice
        </Link>
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
  );
}
