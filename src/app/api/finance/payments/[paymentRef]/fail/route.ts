import { NextResponse } from "next/server";

import { failPayment } from "@/server/finance-payments";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// POST /api/finance/payments/[paymentRef]/fail {expectedDocVersion, reason}
// RECORDED -> FAILED; needs manage_payments. A failed payment never counts toward settlement and
// may be reopened into a new draft.
export async function POST(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await failPayment(actor, { ...(body as object), paymentRef }, newRequestId());
  return toFinancePaymentsHttpResponse(result);
}
