import { NextResponse } from "next/server";

import { voidPayment } from "@/server/finance-payments";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// POST /api/finance/payments/[paymentRef]/void {expectedDocVersion, reason}
// Reachable from DRAFT/RECORDED/FAILED (ordinary cancel) and from CONFIRMED (an explicit,
// reasoned correction/reversal that atomically releases the amount from Invoice settlement); needs
// void_payments. Terminal - nothing leaves VOID.
export async function POST(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await voidPayment(actor, { ...(body as object), paymentRef }, newRequestId());
  return toFinancePaymentsHttpResponse(result);
}
