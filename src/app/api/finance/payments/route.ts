import { NextResponse } from "next/server";

import { createPaymentDraft, listPaymentsWorkspace } from "@/server/finance-payments";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toFinancePaymentsHttpResponse } from "@/server/finance-payments/http";

// GET /api/finance/payments?status=&invoiceRef=&counterpartyType=&counterpartyRef=&cursor=&limit=
// The Payments workspace list: scope-first, bounded, deterministic (last updated desc, then
// paymentRef), paged with a deterministic offset cursor. Requires the finance feature; amounts
// additionally require the finance_amounts sensitive category (otherwise every figure is null).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listPaymentsWorkspace(actor, {
    status: optionalStringParam(searchParams, "status"),
    invoiceRef: optionalStringParam(searchParams, "invoiceRef"),
    counterpartyType: optionalStringParam(searchParams, "counterpartyType"),
    counterpartyRef: optionalStringParam(searchParams, "counterpartyRef"),
    cursor: optionalStringParam(searchParams, "cursor"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toFinancePaymentsHttpResponse(result);
}

// POST /api/finance/payments {invoiceRef}
// Creates a NEW Payment draft (head + immutable, fully-undeclared version 1) against an APPROVED
// invoice; needs manage_payments + finance_amounts. NOT idempotent by design - section 4 requires
// one approved Invoice -> one OR MORE Payment records (partial payments, split transfers, retries).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createPaymentDraft(actor, body, newRequestId());
  if (!result.ok) return toFinancePaymentsHttpResponse(result);
  return NextResponse.json(result.data.payment, { status: 201 });
}
