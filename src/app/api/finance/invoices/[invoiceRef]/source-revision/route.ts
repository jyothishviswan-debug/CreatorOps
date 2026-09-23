import { getInvoiceSourceRevision } from "@/server/finance-invoices";
import { resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// GET /api/finance/invoices/[invoiceRef]/source-revision - read-only comparison of the invoice's
// pinned Payable version against the Payable's current latest version (section 15). Never writes,
// never recalculates, never re-pins.
export async function GET(_request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getInvoiceSourceRevision(actor, invoiceRef);
  return toFinanceInvoicesHttpResponse(result);
}
