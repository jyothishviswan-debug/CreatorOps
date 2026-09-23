import { NextResponse } from "next/server";

import { reviseInvoiceDraft } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/revise
//   {expectedDocVersion, externalInvoiceNumber?, invoiceDate?, receivedDate?, currency?,
//    subtotalMinor?, taxLines?, declaredTotalMinor?, dueDate?, reason}
// Updates the declared fields of a DRAFT invoice as the NEXT immutable version. Needs
// manage_invoices + finance_amounts. An omitted field keeps its previous value; an explicit `null`
// clears it. The URL's invoiceRef always wins over anything in the body.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await reviseInvoiceDraft(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
