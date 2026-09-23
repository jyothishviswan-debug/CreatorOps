import { NextResponse } from "next/server";

import { voidInvoice } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/void {expectedDocVersion, reason}
// Any non-void state -> VOID; needs void_invoices. Requires a non-empty reason, is terminal for
// ordinary processing, and deletes nothing.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await voidInvoice(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
