import { listAgreementEvents } from "@/server/finance-agreements";
import { optionalIntegerParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/events?limit= - the audit trail, newest first, one
// bounded page; event metadata is allowlist-redacted by the service.
export async function GET(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const limit = optionalIntegerParam(new URL(request.url).searchParams, "limit");

  const result = await listAgreementEvents(actor, agreementRef, limit === undefined ? {} : { limit });
  return toFinanceAgreementsHttpResponse(result);
}
