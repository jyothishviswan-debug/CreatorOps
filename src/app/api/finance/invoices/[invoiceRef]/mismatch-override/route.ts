import { NextResponse } from "next/server";

import { acceptInvoiceMismatch } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/mismatch-override {expectedDocVersion, reason}
// Accepts a legitimate Invoice/Payable amount mismatch on a SUBMITTED invoice so it can be
// approved. Needs the exact override_invoice_mismatch action + finance_amounts (Partnership Head /
// Super Admin only in this phase's grants - never role rank). Requires a reason; preserves both the
// pinned Payable's expected amount and the Invoice's declared amount unchanged.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await acceptInvoiceMismatch(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
