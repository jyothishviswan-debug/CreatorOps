import { getAgreementReconciliation } from "@/server/finance-agreements";
import { optionalIntegerParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

type RouteParams = { params: Promise<{ agreementRef: string }> };

// GET /api/finance/agreements/[agreementRef]/reconciliation?version= - the per-field comparison of
// the Agreement against CreatorOps master data. Read-only; values only where the actor may see them.
export async function GET(request: Request, { params }: RouteParams) {
  const { agreementRef } = await params;
  const actor = await resolveRequestActor();
  const version = optionalIntegerParam(new URL(request.url).searchParams, "version");

  const result = await getAgreementReconciliation(actor, { agreementRef, ...(version === undefined ? {} : { version }) });
  return toFinanceAgreementsHttpResponse(result);
}
