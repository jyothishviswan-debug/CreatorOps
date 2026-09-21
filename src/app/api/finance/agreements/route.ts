import { NextResponse } from "next/server";

import { createAgreementDraft, listAgreementsForCounterparty } from "@/server/finance-agreements";
import { newRequestId, optionalStringParam, parseJsonBody, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";

// GET /api/finance/agreements?counterpartyType=PARTNER|VENDOR&ref= - the Agreement heads of ONE
// Partner or Vendor (scope-checked live against that counterparty; bounded, no cursor).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listAgreementsForCounterparty(actor, { counterpartyType: optionalStringParam(searchParams, "counterpartyType"), ref: optionalStringParam(searchParams, "ref") });
  return toFinanceAgreementsHttpResponse(result);
}

// POST /api/finance/agreements {clientRequestId, counterparty, sourceMode?} - create the Agreement
// head + version 1 (DRAFT). 201 when this call created it, 200 when the same clientRequestId had
// already created it (idempotent retry); the same fact is sent as
// `X-Finance-Agreement-Outcome: created | existing`.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createAgreementDraft(actor, body, newRequestId());
  if (!result.ok) return toFinanceAgreementsHttpResponse(result);
  return NextResponse.json(result.data.agreement, { status: result.data.outcome === "created" ? 201 : 200, headers: { "X-Finance-Agreement-Outcome": result.data.outcome } });
}
