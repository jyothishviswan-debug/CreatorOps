import { NextResponse } from "next/server";

import { resolveInvoicePayeeMismatch } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/resolve-payee-mismatch {expectedDocVersion, reason}
// Step 16C section 11: accepts the Invoice as belonging to the expected Payable counterparty
// despite a payee identity MISMATCH/REVIEW_REQUIRED result. Needs the exact
// resolve_invoice_payee_mismatch action + finance_amounts (Partnership Head / Super Admin only in
// this phase's grants - never role rank). Requires a reason; never mutates the Payable counterparty
// or any Partner/Vendor master data, and never rewrites the original mismatch evidence.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await resolveInvoicePayeeMismatch(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
