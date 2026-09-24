import { NextResponse } from "next/server";

import { revisePaymentDraft } from "@/server/finance-payments";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// POST /api/finance/payments/[paymentRef]/revise {expectedDocVersion, amountMinor?, paymentDate?,
// method?, externalReference?, memo?, reason} - DRAFT only; needs manage_payments. An omitted field
// keeps its previous value; an explicit null clears it. The amount is never silently capped.
export async function POST(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await revisePaymentDraft(actor, { ...(body as object), paymentRef }, newRequestId());
  return toFinancePaymentsHttpResponse(result);
}
