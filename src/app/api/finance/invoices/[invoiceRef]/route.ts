import { getInvoice } from "@/server/finance-invoices";
import { optionalIntegerParam, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// GET /api/finance/invoices/[invoiceRef]?version= - the head, bounded version summaries and one
// immutable version's full detail (default: the latest). Live Record Scope on every read; knowing
// an invoiceRef grants nothing. Every money figure is withheld (null, with amountsVisible:false)
// unless the actor holds the finance_amounts sensitive category.
export async function GET(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const version = optionalIntegerParam(new URL(request.url).searchParams, "version");

  const result = await getInvoice(actor, invoiceRef, version === undefined ? {} : { version });
  return toFinanceInvoicesHttpResponse(result);
}
