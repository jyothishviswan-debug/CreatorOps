import { getInvoicePaymentSettlement } from "@/server/finance-payments";
import { resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// GET /api/finance/payments/invoices/[invoiceRef]/settlement - the read-only Invoice settlement
// projection (section 13/17): expected net payment, confirmed/recorded/failed totals, remaining
// amount, settlement state and warnings, plus the bounded list of Payments for this invoice. Never
// mutates the Invoice or any Payment. Requires the finance feature; amounts additionally require
// the finance_amounts sensitive category.
export async function GET(_request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();

  const result = await getInvoicePaymentSettlement(actor, invoiceRef);
  return toFinancePaymentsHttpResponse(result);
}
