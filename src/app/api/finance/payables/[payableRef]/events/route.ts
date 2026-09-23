import { listPayableEvents } from "@/server/finance-payables";
import { optionalIntegerParam, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// GET /api/finance/payables/[payableRef]/events?limit= - the append-only audit trail, newest first,
// one bounded page. Event metadata is allowlist-redacted by the service and carries no amount at
// all (amounts are sensitive; the figures live on the version documents behind finance_amounts).
export async function GET(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const limit = optionalIntegerParam(new URL(request.url).searchParams, "limit");

  const result = await listPayableEvents(actor, payableRef, limit === undefined ? {} : { limit });
  return toFinancePayablesHttpResponse(result);
}
