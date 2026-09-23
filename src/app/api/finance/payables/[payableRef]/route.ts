import { getPayable } from "@/server/finance-payables";
import { optionalIntegerParam, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

type RouteParams = { params: Promise<{ payableRef: string }> };

// GET /api/finance/payables/[payableRef]?version= - the head, bounded version summaries and one
// immutable version's full detail (default: the latest). Live Record Scope on every read; knowing
// a payableRef grants nothing. Every money figure is withheld (null, with amountsVisible:false)
// unless the actor holds the finance_amounts sensitive category.
export async function GET(request: Request, { params }: RouteParams) {
  const { payableRef } = await params;
  const actor = await resolveRequestActor();
  const version = optionalIntegerParam(new URL(request.url).searchParams, "version");

  const result = await getPayable(actor, payableRef, version === undefined ? {} : { version });
  return toFinancePayablesHttpResponse(result);
}
