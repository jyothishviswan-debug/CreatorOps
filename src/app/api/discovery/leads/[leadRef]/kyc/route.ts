import { NextResponse } from "next/server";

import { getLeadKyc, saveLeadKyc } from "@/server/discovery/kyc-service";
import { newRequestId, parseJsonBody, resolveRequestActor, toDiscoveryHttpResponse } from "@/server/discovery/http";

type RouteParams = { params: Promise<{ leadRef: string }> };

// GET /api/discovery/leads/[leadRef]/kyc - restricted, gated by BOTH the
// manage_kyc action and the discovery_kyc Sensitive Access category.
export async function GET(_request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const result = await getLeadKyc(actor, leadRef);
  return toDiscoveryHttpResponse(result);
}

// PUT /api/discovery/leads/[leadRef]/kyc - saves the full restricted KYC
// package (body: { email, aadhaar, pan, bank, gst, expectedKycVersion,
// expectedLeadVersion }).
export async function PUT(request: Request, { params }: RouteParams) {
  const { leadRef } = await params;
  const actor = await resolveRequestActor();
  const body = await parseJsonBody(request);
  if (body === undefined) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const result = await saveLeadKyc(actor, leadRef, body, newRequestId());
  return toDiscoveryHttpResponse(result);
}
