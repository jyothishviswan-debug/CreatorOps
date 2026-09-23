import { NextResponse } from "next/server";

import { createPayable, listPayablesWorkspace } from "@/server/finance-payables";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toFinancePayablesHttpResponse } from "@/server/finance-payables/http";

// GET /api/finance/payables?status=&counterpartyType=&counterpartyRef=&commercialPeriod=&cursor=&limit=
// The Payables workspace list: scope-first, bounded, deterministic (last updated desc, then period,
// then payableRef), paged with a deterministic offset cursor. `totalInBoundedSet` is exact only
// while `disclosure.headsTruncated` is false. Requires the finance feature; amounts additionally
// require the finance_amounts sensitive category (otherwise every figure is null).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listPayablesWorkspace(actor, {
    status: optionalStringParam(searchParams, "status"),
    counterpartyType: optionalStringParam(searchParams, "counterpartyType"),
    counterpartyRef: optionalStringParam(searchParams, "counterpartyRef"),
    commercialPeriod: optionalStringParam(searchParams, "commercialPeriod"),
    cursor: optionalStringParam(searchParams, "cursor"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toFinancePayablesHttpResponse(result);
}

// POST /api/finance/payables {counterpartyType, counterpartyRef, commercialPeriod, agreementRef?}
// Creates the canonical Payable for that commercial basis (head + immutable version 1); needs
// manage_payables. IDEMPOTENT: 201 when this call created it, 200 when the canonical Payable for
// the same basis and the same pinned source versions already existed. The same fact is sent as
// `X-Finance-Payable-Outcome: created | existing`. A different valid source version for the same
// basis is a 409 naming the explicit revision path - never a second Payable.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPayable(actor, body, newRequestId());
  if (!result.ok) return toFinancePayablesHttpResponse(result);
  return NextResponse.json(result.data.payable, { status: result.data.outcome === "created" ? 201 : 200, headers: { "X-Finance-Payable-Outcome": result.data.outcome } });
}
