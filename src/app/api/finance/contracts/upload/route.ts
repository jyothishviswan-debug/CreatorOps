import { NextResponse } from "next/server";

import { uploadContractArtifact } from "@/server/finance-agreements";
import { newRequestId, resolveRequestActor, toFinanceAgreementsHttpResponse } from "@/server/finance-agreements/http";
import { readContractUploadRequest } from "@/server/finance-agreements/upload-request";

// POST /api/finance/contracts/upload - multipart/form-data {file, counterpartyType, counterpartyRef}.
// Stores one contract PDF (<= 10 MB) as a restricted artifact and answers safe metadata only (never a
// path, bucket, locator or URL). Non-multipart => 415; a body over the cap is refused before it is
// buffered (413); the service validates the PDF itself. 201 when this call stored it, 200 when the
// same bytes were already uploaded for that counterparty (`X-Finance-Contract-Outcome: created | existing`).
// The Next proxy buffer that fronts this route is raised to 11 MB in next.config.ts (see there).
export async function POST(request: Request) {
  const actor = await resolveRequestActor();
  // Do not buffer a body for a caller with no session; the service still runs the full chain.
  if (!actor) return NextResponse.json({ error: "Forbidden." }, { status: 401 });
  const upload = await readContractUploadRequest(request);
  if (!upload.ok) return NextResponse.json({ error: upload.error }, { status: upload.status });

  const result = await uploadContractArtifact(actor, upload.input, newRequestId());
  if (!result.ok) return toFinanceAgreementsHttpResponse(result);
  return NextResponse.json(result.data.artifact, { status: result.data.created ? 201 : 200, headers: { "X-Finance-Contract-Outcome": result.data.created ? "created" : "existing" } });
}
