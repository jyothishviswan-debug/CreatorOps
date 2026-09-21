import { getFinanceAgreementPermissions } from "@/server/finance-agreements";
import { optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/permissions?counterpartyType=PARTNER|VENDOR (optional) - the signed-in actor's OWN Finance capabilities
// as booleans computed from real grants (never role names). These decide which buttons a page renders; every command
// re-checks server-side. Unauthenticated: 401.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await getFinanceAgreementPermissions(actor, optionalStringParam(searchParams, "counterpartyType"));
  return toFinanceAgreementsHttpResponse(result);
}
