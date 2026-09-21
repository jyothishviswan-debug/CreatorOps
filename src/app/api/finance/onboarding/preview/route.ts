import { NextResponse } from "next/server";

import { previewOnboardingFromContract } from "@/server/finance-agreements";
import { newRequestId, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";
import { readOnboardingPreviewRequest } from "@/server/finance-agreements/upload-request";

// POST /api/finance/onboarding/preview - multipart/form-data {file, counterpartyType}. Reads the signed Agreement's PDF (<= 10 MB) with the same
// pure extraction as the normal flow and answers a SAFE proposal for a NEW counterparty: proposed profile fields with confidence, extraction
// status / reasons, identity PRESENCE flags only (never a value), raw snippets only with finance_contracts. It persists NOTHING - no file, no
// artifact, no record. After the counterparty exists the same file goes through the normal upload + extraction.
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  // Do not buffer a body for a caller with no session; the service still runs the full chain.
  if (!actor) return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  const upload = await readOnboardingPreviewRequest(request);
  if (!upload.ok) return NextResponse.json({ error: upload.error }, { status: upload.status });

  // The audit request id is minted for parity with the other POST routes; a preview appends no event.
  void newRequestId();
  const result = await previewOnboardingFromContract(actor, upload.input);
  return toFinanceAgreementsHttpResponse(result);
}
