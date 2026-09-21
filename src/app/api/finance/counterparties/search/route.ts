import { searchCounterparties } from "@/server/finance-agreements";
import { optionalIntegerParam, optionalStringParam, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/counterparties/search?counterpartyType=PARTNER|VENDOR&q=&limit= - authorized, ACTIVE Partners / Vendors
// (scope-first, display identity only, limit 1-10). `type` is accepted as an alias of `counterpartyType`.
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await searchCounterparties(actor, {
    type: optionalStringParam(searchParams, "counterpartyType") ?? optionalStringParam(searchParams, "type"),
    q: optionalStringParam(searchParams, "q"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toFinanceAgreementsHttpResponse(result);
}
