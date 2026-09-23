import { reconcileInvoice } from "@/server/finance-invoices";
import { resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/reconcile - recomputes the reconciliation of the current
// latest version fresh (including a fresh duplicate-invoice-number check) WITHOUT writing anything.
// Needs manage_invoices + finance_amounts.
export async function POST(_request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();

  const result = await reconcileInvoice(actor, { invoiceRef });
  return toFinanceInvoicesHttpResponse(result);
}
