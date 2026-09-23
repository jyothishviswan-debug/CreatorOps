import { NextResponse } from "next/server";

import { createInvoiceDraft, listInvoicesWorkspace } from "@/server/finance-invoices";
import { newRequestId, optionalIntegerParam, optionalStringParam, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

// GET /api/finance/invoices?status=&counterpartyType=&counterpartyRef=&commercialPeriod=&reconciliationState=&cursor=&limit=
// The Invoices workspace list: scope-first, bounded, deterministic (last updated desc, then period,
// then invoiceRef), paged with a deterministic offset cursor. Requires the finance feature; amounts
// additionally require the finance_amounts sensitive category (otherwise every figure is null).
export async function GET(request: Request) {
  const actor = await resolveRequestActor();
  const { searchParams } = new URL(request.url);

  const result = await listInvoicesWorkspace(actor, {
    status: optionalStringParam(searchParams, "status"),
    counterpartyType: optionalStringParam(searchParams, "counterpartyType"),
    counterpartyRef: optionalStringParam(searchParams, "counterpartyRef"),
    commercialPeriod: optionalStringParam(searchParams, "commercialPeriod"),
    reconciliationState: optionalStringParam(searchParams, "reconciliationState"),
    cursor: optionalStringParam(searchParams, "cursor"),
    limit: optionalIntegerParam(searchParams, "limit"),
  });
  return toFinanceInvoicesHttpResponse(result);
}

// POST /api/finance/invoices {payableRef}
// Creates the canonical Invoice for that Payable (head + immutable, fully-undeclared version 1);
// needs manage_invoices + finance_amounts. IDEMPOTENT: 201 when this call created it, 200 when the
// canonical Invoice for the same Payable already existed. The same fact is sent as
// `X-Finance-Invoice-Outcome: created | existing`.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await createInvoiceDraft(actor, body, newRequestId());
  if (!result.ok) return toFinanceInvoicesHttpResponse(result);
  return NextResponse.json(result.data.invoice, { status: result.data.outcome === "created" ? 201 : 200, headers: { "X-Finance-Invoice-Outcome": result.data.outcome } });
}
