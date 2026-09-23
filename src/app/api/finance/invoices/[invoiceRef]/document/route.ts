import { NextResponse } from "next/server";

import { attachInvoiceDocument } from "@/server/finance-invoices";
import { newRequestId, parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/document {expectedDocVersion, fileName, contentBase64}
// Attaches or replaces the original Invoice document (PDF only, max 10MB) on a DRAFT invoice, as
// the NEXT immutable version - the exact original bytes, never a generated replacement. Needs
// manage_invoices + finance_amounts. No real external storage call is ever made in an automated
// test run (see src/server/finance-invoices/document-storage).
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await attachInvoiceDocument(actor, { ...(body as object), invoiceRef }, newRequestId());
  return toFinanceInvoicesHttpResponse(result);
}
