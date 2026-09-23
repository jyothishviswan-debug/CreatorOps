import { listInvoiceEvents } from "@/server/finance-invoices";
import { optionalIntegerParam, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// GET /api/finance/invoices/[invoiceRef]/events?limit= - one bounded, newest-first page of the
// Invoice's audit trail. Metadata is allowlist-redacted on the way out and carries no amount at all.
export async function GET(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const limit = optionalIntegerParam(new URL(request.url).searchParams, "limit");

  const result = await listInvoiceEvents(actor, invoiceRef, limit === undefined ? {} : { limit });
  return toFinanceInvoicesHttpResponse(result);
}
