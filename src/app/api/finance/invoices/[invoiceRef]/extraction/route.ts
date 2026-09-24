import { NextResponse } from "next/server";

import { previewInvoiceExtraction } from "@/server/finance-invoices/extraction-preview-service";
import { parseJsonBody, resolveRequestActor, toFinanceInvoicesHttpResponse } from "@/server/finance-invoices/http";

type RouteParams = { params: Promise<{ invoiceRef: string }> };

// POST /api/finance/invoices/[invoiceRef]/extraction {contentBase64}
// Step 15C section 19/24/26: previews local, deterministic PDF extraction over the EXACT bytes the
// browser already has staged (the same bytes a subsequent /document call would attach) - never
// reads anything back from storage, never writes anything, never confirms a value. One-shot
// request/response (no polling - extraction is synchronous local parsing, same contract as
// Agreements' own /api/finance/contracts/extract). Needs manage_invoices.
export async function POST(request: Request, { params }: RouteParams) {
  const { invoiceRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await previewInvoiceExtraction(actor, { ...(body as object), invoiceRef });
  return toFinanceInvoicesHttpResponse(result);
}
