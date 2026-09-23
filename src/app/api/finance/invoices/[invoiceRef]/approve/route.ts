import { NextResponse } from "next/server";

import { approveInvoice } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/approve {expectedDocVersion}
// SUBMITTED -> APPROVED; needs approve_invoices + finance_amounts. Refused as 409 with per-item
// blockers when a reconciliation BLOCKER is unresolved (an amount mismatch is only bypassed by a
// prior, explicit mismatch-override acceptance).
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await approveInvoice(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
