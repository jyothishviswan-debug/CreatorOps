import { getPayment } from "@/server/finance-payments";
import { optionalIntegerParam, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// GET /api/finance/payments/[paymentRef]?version= - the head, bounded version summaries and one
// immutable version's full detail (default: the latest). Live Record Scope on every read; knowing a
// paymentRef grants nothing. Every money figure is withheld (null, with amountsVisible:false)
// unless the actor holds the finance_amounts sensitive category.
export async function GET(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const version = optionalIntegerParam(new URL(request.url).searchParams, "version");

  const result = await getPayment(actor, paymentRef, version === undefined ? {} : { version });
  return toFinancePaymentsHttpResponse(result);
}
