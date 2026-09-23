// Step 16B: the Invoice detail page (/finance/invoices/[invoiceRef]). The server page resolves the
// actor, reads the Invoice and the source-revision check, computes permissions, then renders this
// client component.
export { InvoiceDetail } from "./InvoiceDetail";
export { parseDetailTab } from "./detail-view";
