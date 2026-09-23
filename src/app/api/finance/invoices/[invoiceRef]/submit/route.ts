import { NextResponse } from "next/server";

import { submitInvoice } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/submit {expectedDocVersion}
// DRAFT -> SUBMITTED; needs manage_invoices. Refused as 409 with per-item blockers when the
// declared number/date/currency/total or the original document is missing.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await submitInvoice(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
