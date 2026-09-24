import { NextResponse } from "next/server";

import { confirmPayment } from "@/server/finance-payments";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

type RouteParams = { params: Promise<{ paymentRef: string }> };

// POST /api/finance/payments/[paymentRef]/confirm {expectedDocVersion, overrideOverageReason?}
// RECORDED -> CONFIRMED; needs confirm_payments. The ONLY transition that counts toward Invoice
// settlement. Blocked (409) when it would overpay the invoice's expected net payment, unless the
// actor supplies overrideOverageReason and holds the exact override_payment_overage action.
// Concurrency-safe: two racing confirmations of the same invoice can never together exceed the
// expected net payment without an explicit, authorized override (section 8/19).
export async function POST(request: Request, { params }: RouteParams) {
  const { paymentRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await confirmPayment(actor, { ...(body as object), paymentRef }, newRequestId());
  return toFinancePaymentsHttpResponse(result);
}
