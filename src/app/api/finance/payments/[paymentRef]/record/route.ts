import { NextResponse } from "next/server";

import { recordPayment } from "@/server/finance-payments";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// POST /api/finance/payments/[paymentRef]/record {expectedDocVersion}
// DRAFT -> RECORDED; needs manage_payments. Refused as 409 with per-item blockers when the amount,
// date or method is missing. Claims the external reference transactionally when one is declared.
export async function POST(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await recordPayment(actor, { ...(body as object), paymentRef }, newRequestId());
  return toFinancePaymentsHttpResponse(result);
}
