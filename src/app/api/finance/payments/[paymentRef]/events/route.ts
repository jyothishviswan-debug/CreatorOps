import { listPaymentEvents } from "@/server/finance-payments";
import { optionalIntegerParam, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// GET /api/finance/payments/[paymentRef]/events?limit= - one bounded, newest-first page of the
// Payment's audit trail. Metadata is allowlist-redacted on the way out and carries no amount at all.
export async function GET(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const limit = optionalIntegerParam(new URL(request.url).searchParams, "limit");

  const result = await listPaymentEvents(actor, paymentRef, limit === undefined ? {} : { limit });
  return toFinancePaymentsHttpResponse(result);
}
